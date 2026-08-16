// SPDX-License-Identifier: Apache-2.0
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_TTL_MS = 5 * 60 * 1000;

type BootstrapRecord = Readonly<{ schemaVersion: 1; sessionId: string; secret: string; expiresAt: number }>;

export function sessionBootstrapPath(stateDir: string, sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return join(stateDir, "credential-bootstrap", `${key}.json`);
}

export class SessionProofBootstrap {
  constructor(
    private readonly stateDir: string,
    eligibleSessionIds: readonly string[],
    private readonly clock: () => number = Date.now,
    private readonly ttlMs = DEFAULT_TTL_MS,
  ) {
    const directory = join(stateDir, "credential-bootstrap");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    for (const sessionId of eligibleSessionIds) this.prepare(sessionId);
  }

  consume(sessionId: string, suppliedSecret: string): boolean {
    const path = sessionBootstrapPath(this.stateDir, sessionId);
    if (!suppliedSecret || !existsSync(path)) return false;
    let record: BootstrapRecord;
    try {
      assertOwnerFile(path);
      record = parseRecord(readFileSync(path, "utf8"));
    } catch { return false; }
    if (record.sessionId !== sessionId || record.expiresAt <= this.clock()) return false;
    const supplied = Buffer.from(suppliedSecret, "base64url");
    const expected = Buffer.from(record.secret, "base64url");
    if (supplied.byteLength !== 32 || expected.byteLength !== supplied.byteLength || !timingSafeEqual(supplied, expected)) return false;
    const used = `${path}.used`;
    renameSync(path, used);
    writeFileSync(used, JSON.stringify({ schemaVersion: 1, sessionId, usedAt: this.clock() }) + "\n", { mode: 0o600 });
    chmodSync(used, 0o600);
    return true;
  }

  rearm(sessionId: string): void {
    const path = sessionBootstrapPath(this.stateDir, sessionId);
    try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { unlinkSync(`${path}.used`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.prepare(sessionId);
  }

  private prepare(sessionId: string): void {
    const path = sessionBootstrapPath(this.stateDir, sessionId);
    if (existsSync(`${path}.used`)) return;
    if (existsSync(path)) {
      try {
        assertOwnerFile(path);
        if (parseRecord(readFileSync(path, "utf8")).expiresAt > this.clock()) return;
      } catch { /* replace only this bounded bootstrap file */ }
      unlinkSync(path);
    }
    const record: BootstrapRecord = { schemaVersion: 1, sessionId, secret: randomBytes(32).toString("base64url"), expiresAt: this.clock() + this.ttlMs };
    writeFileSync(path, JSON.stringify(record) + "\n", { mode: 0o600, flag: "wx" });
    chmodSync(path, 0o600);
  }
}

export function readSessionBootstrap(stateDir: string, sessionId: string): string | null {
  const path = sessionBootstrapPath(stateDir, sessionId);
  try {
    assertOwnerFile(path);
    const record = parseRecord(readFileSync(path, "utf8"));
    if (record.sessionId !== sessionId || record.expiresAt <= Date.now()) return null;
    return record.secret;
  } catch { return null; }
}

function assertOwnerFile(path: string): void {
  const stat = lstatSync(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || (uid !== undefined && stat.uid !== uid)) throw new Error("unsafe bootstrap file");
}

function parseRecord(text: string): BootstrapRecord {
  const value = JSON.parse(text) as Partial<BootstrapRecord>;
  if (value.schemaVersion !== 1 || typeof value.sessionId !== "string" || typeof value.secret !== "string" || typeof value.expiresAt !== "number") throw new Error("invalid bootstrap record");
  return value as BootstrapRecord;
}

// SPDX-License-Identifier: Apache-2.0
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A durable, owner-only operator credential. Unlike the one-shot session proof
// bootstrap, this secret survives daemon restarts, so a trusted local operator
// client (Packy, Mycelia) can re-authenticate after every restart without a
// launched runtime. Possession of the owner-only secret is the possession
// proof: it never restores "session id equals credential", because the 32-byte
// secret lives only in a mode-0600 file the owner user can read.

type OperatorCredentialRecord = Readonly<{ schemaVersion: 1; sessionId: string; secret: string; issuedAt: number }>;

const DIRECTORY = "operator-credentials";

export function operatorCredentialPath(stateDir: string, sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return join(stateDir, DIRECTORY, `${key}.json`);
}

/**
 * Create the durable operator credential file for an operator session. Idempotent:
 * an existing, well-formed, owner-only record is kept so the secret stays stable
 * across setup runs. Pass rotate to replace the secret. The secret is returned to
 * the caller only through the file; it is never logged or placed in arguments.
 */
export function mintOperatorCredential(
  stateDir: string,
  sessionId: string,
  options: { rotate?: boolean; clock?: () => number } = {},
): void {
  const clock = options.clock ?? Date.now;
  const directory = join(stateDir, DIRECTORY);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = operatorCredentialPath(stateDir, sessionId);
  if (!options.rotate && existsSync(path)) {
    try {
      assertOwnerFile(path);
      if (parseRecord(readFileSync(path, "utf8")).sessionId === sessionId) return;
    } catch { /* replace only this malformed credential file */ }
  }
  const record: OperatorCredentialRecord = { schemaVersion: 1, sessionId, secret: randomBytes(32).toString("base64url"), issuedAt: clock() };
  const temporary = `${path}.mint`;
  writeFileSync(temporary, JSON.stringify(record) + "\n", { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

/** Read the owner-only operator secret for a session, or null when it is absent or unsafe. */
export function readOperatorCredentialSecret(stateDir: string, sessionId: string): string | null {
  const path = operatorCredentialPath(stateDir, sessionId);
  try {
    assertOwnerFile(path);
    const record = parseRecord(readFileSync(path, "utf8"));
    return record.sessionId === sessionId ? record.secret : null;
  } catch { return null; }
}

/** Daemon-side verifier. Confirms a supplied secret matches the stored operator credential. */
export class OperatorCredentialStore {
  constructor(private readonly stateDir: string) {}

  verify(sessionId: string, suppliedSecret: Uint8Array | string): boolean {
    if (!sessionId) return false;
    const expectedSecret = readOperatorCredentialSecret(this.stateDir, sessionId);
    if (!expectedSecret) return false;
    const supplied = typeof suppliedSecret === "string" ? Buffer.from(suppliedSecret, "base64url") : Buffer.from(suppliedSecret);
    const expected = Buffer.from(expectedSecret, "base64url");
    if (supplied.byteLength !== 32 || expected.byteLength !== supplied.byteLength) return false;
    return timingSafeEqual(supplied, expected);
  }
}

function assertOwnerFile(path: string): void {
  const stat = lstatSync(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || (uid !== undefined && stat.uid !== uid)) throw new Error("unsafe operator credential file");
}

function parseRecord(text: string): OperatorCredentialRecord {
  const value = JSON.parse(text) as Partial<OperatorCredentialRecord>;
  if (value.schemaVersion !== 1 || typeof value.sessionId !== "string" || typeof value.secret !== "string" || typeof value.issuedAt !== "number") throw new Error("invalid operator credential record");
  return value as OperatorCredentialRecord;
}

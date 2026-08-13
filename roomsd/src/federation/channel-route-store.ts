// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AuthorityId } from "./contracts.js";
import { readActivePeerTrust } from "./peer-trust.js";
import { readMachineIdentityStatus, resolveRoomsStateDir } from "../identity/machine-identity.js";
import { parseSshTarget } from "./ssh-command-adapter.js";

const VERSION = 1;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export type FederatedChannelRoute = Readonly<{
  version: 1;
  homeAuthorityId: AuthorityId;
  channelId: string;
  localSessionId: string;
  sshHost: string;
  remoteStateDir: string | null;
  cursor: string;
  createdAt: string;
  updatedAt: string;
}>;

/** Persist the minimum local routing state needed to consume a channel homed by a peer. */
export function upsertFederatedChannelRoute(input: Readonly<{
  stateDir?: string;
  homeAuthorityId: AuthorityId;
  channelId: string;
  localSessionId: string;
  sshHost: string;
  remoteStateDir?: string;
  cursor?: string;
}>): FederatedChannelRoute {
  const stateDir = requireIdentity(input.stateDir);
  if (!readActivePeerTrust(input.homeAuthorityId, stateDir)) throw new Error("channel home peer is not actively enrolled");
  const channelId = bounded(input.channelId, "channelId", 256);
  const localSessionId = bounded(input.localSessionId, "localSessionId", 512);
  const sshHost = parseSshTarget(input.sshHost).target;
  const remoteStateDir = input.remoteStateDir ? boundedAbsolute(input.remoteStateDir, "remoteStateDir") : null;
  const initialCursor = input.cursor ?? "0";
  if (!/^\d+$/.test(initialCursor)) throw new Error("invalid federated channel cursor");
  const directory = ensureDirectory(stateDir);
  const path = routePath(directory, input.homeAuthorityId, channelId, localSessionId);
  const existing = tryRead(path);
  if (existing && (existing.homeAuthorityId !== input.homeAuthorityId || existing.channelId !== channelId || existing.localSessionId !== localSessionId)) throw new Error("federated channel route identity mismatch");
  const now = new Date().toISOString();
  const route: FederatedChannelRoute = {
    version: VERSION,
    homeAuthorityId: input.homeAuthorityId,
    channelId,
    localSessionId,
    sshHost,
    remoteStateDir,
    cursor: existing?.cursor ?? initialCursor,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  writeRecord(path, route);
  return route;
}

export function listFederatedChannelRoutes(stateDirInput?: string): readonly FederatedChannelRoute[] {
  const directory = ensureDirectory(requireIdentity(stateDirInput));
  return readdirSync(directory).filter((name) => name.endsWith(".json")).sort().map((name) => readRecord(join(directory, name)));
}

export function advanceFederatedChannelRouteCursor(route: FederatedChannelRoute, cursor: string, stateDirInput?: string): FederatedChannelRoute {
  if (!/^\d+$/.test(cursor)) throw new Error("invalid federated channel cursor");
  const directory = ensureDirectory(requireIdentity(stateDirInput));
  const path = routePath(directory, route.homeAuthorityId, route.channelId, route.localSessionId);
  const current = readRecord(path);
  if (current.homeAuthorityId !== route.homeAuthorityId || current.channelId !== route.channelId || current.localSessionId !== route.localSessionId) throw new Error("federated channel route changed while advancing cursor");
  if (BigInt(cursor) <= BigInt(current.cursor)) return current;
  const next: FederatedChannelRoute = { ...current, cursor, updatedAt: new Date().toISOString() };
  writeRecord(path, next);
  return next;
}

export function removeFederatedChannelRoute(input: Readonly<{ stateDir?: string; homeAuthorityId: AuthorityId; channelId: string; localSessionId: string }>): void {
  const directory = ensureDirectory(requireIdentity(input.stateDir));
  const path = routePath(directory, input.homeAuthorityId, input.channelId, input.localSessionId);
  try {
    const record = readRecord(path);
    if (record.homeAuthorityId !== input.homeAuthorityId || record.channelId !== input.channelId || record.localSessionId !== input.localSessionId) throw new Error("federated channel route identity mismatch");
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function requireIdentity(input?: string): string {
  const stateDir = resolveRoomsStateDir(input);
  readMachineIdentityStatus(stateDir);
  return stateDir;
}

function ensureDirectory(stateDir: string): string {
  const federation = join(stateDir, "federation");
  const directory = join(federation, "channel-routes");
  for (const path of [stateDir, federation, directory]) {
    mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE });
    const value = lstatSync(path);
    if (value.isSymbolicLink() || !value.isDirectory() || (value.mode & 0o777) !== DIRECTORY_MODE || (typeof process.getuid === "function" && value.uid !== process.getuid())) throw new Error(`refusing insecure channel route directory: ${path}`);
  }
  return directory;
}

function routePath(directory: string, authorityId: string, channelId: string, sessionId: string): string {
  const digest = createHash("sha256").update(`${authorityId}\0${channelId}\0${sessionId}`).digest("hex");
  return join(directory, `${digest}.json`);
}

function readRecord(path: string): FederatedChannelRoute {
  const value = lstatSync(path);
  if (value.isSymbolicLink() || !value.isFile() || (value.mode & 0o777) !== FILE_MODE || (typeof process.getuid === "function" && value.uid !== process.getuid())) throw new Error(`refusing insecure channel route record: ${path}`);
  const raw = readFileSync(path, "utf8");
  if (Buffer.byteLength(raw) > 16 * 1024) throw new Error("channel route record is oversized");
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid channel route record");
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ["channelId", "createdAt", "cursor", "homeAuthorityId", "localSessionId", "remoteStateDir", "sshHost", "updatedAt", "version"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error("channel route record has unknown or missing fields");
  if (record.version !== VERSION || typeof record.homeAuthorityId !== "string" || typeof record.channelId !== "string" || typeof record.localSessionId !== "string" || typeof record.sshHost !== "string" || (record.remoteStateDir !== null && typeof record.remoteStateDir !== "string") || typeof record.cursor !== "string" || !/^\d+$/.test(record.cursor) || typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") throw new Error("invalid channel route record fields");
  parseSshTarget(record.sshHost);
  return record as unknown as FederatedChannelRoute;
}

function tryRead(path: string): FederatedChannelRoute | null {
  try { return readRecord(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

function writeRecord(path: string, record: FederatedChannelRoute): void {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", FILE_MODE);
  try {
    fchmodSync(fd, FILE_MODE);
    writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
  const saved = statSync(path);
  if ((saved.mode & 0o777) !== FILE_MODE) throw new Error("channel route record mode changed during write");
}

function bounded(value: string, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maximum) throw new Error(`invalid ${field}`);
  return value;
}

function boundedAbsolute(value: string, field: string): string {
  if (!value.startsWith("/") || value.includes("\0") || Buffer.byteLength(value) > 2048) throw new Error(`invalid ${field}`);
  return value;
}

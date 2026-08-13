// SPDX-License-Identifier: Apache-2.0
/** Rooms-owned, local-only persistence for peer enrollment and revocation trust records. */

import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { authorityId as toAuthorityId, validateTransportPolicy, FederationCodecError } from "./codec.js";
import { readMachineIdentityStatus, resolveRoomsStateDir } from "../identity/machine-identity.js";
import type { AuthorityId, FederationTransportPolicy } from "./contracts.js";

const RECORD_VERSION = 1;
const PEERS_DIRECTORY = join("federation", "peers");
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const AUTHORITY_ID_PATTERN = /^authority-[0-9a-f]{64}$/;

/**
 * `pending`: a self-asserted candidate created by `prepare`, not yet cryptographically
 * proven. `confirming`: this store has cryptographically verified the peer's Ed25519
 * proof-of-possession and durably recorded it, but has not yet received the peer's
 * closing acknowledgement that its own store did the same — an explicit, intentional
 * half-enrolled stage. `active`: both this store's verification of the peer AND the
 * peer's acknowledgement of completion have been verified and durably recorded here;
 * `readActivePeerTrust` never returns `pending` or `confirming`. `revoked`: terminal,
 * never re-enters any other state.
 */
export type PeerTrustState = "pending" | "confirming" | "active" | "revoked";

export type PeerTrustRecord = Readonly<{
  version: 1;
  authorityId: AuthorityId;
  publicKeyPem: string;
  fingerprint: string;
  transportPolicy: FederationTransportPolicy;
  state: PeerTrustState;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}>;

export class PeerTrustError extends Error {
  constructor(message: string) {
    super(`Rooms peer trust: ${message}`);
    this.name = "PeerTrustError";
  }
}

export function preparePeerTrust(input: Readonly<{ stateDir?: string; authorityId: string; publicKeyPem: string; transportPolicy: unknown }>): PeerTrustRecord {
  const stateDir = requireIdentity(input.stateDir);
  const { authorityId, fingerprint, publicKeyPem } = boundPeerKey(input.authorityId, input.publicKeyPem);
  const transportPolicy = boundTransportPolicy(input.transportPolicy, authorityId);
  const peersDir = ensurePeersDir(stateDir);
  const path = recordPath(peersDir, authorityId);

  const existing = tryReadRecord(path, authorityId);
  if (existing) {
    if (existing.state === "revoked") throw new PeerTrustError(`authority ${authorityId} is durably revoked; re-enrollment is not permitted`);
    if (existing.fingerprint === fingerprint && existing.publicKeyPem === publicKeyPem && sameTransportPolicy(existing.transportPolicy, transportPolicy)) {
      return existing;
    }
    throw new PeerTrustError(`authority ${authorityId} is already pinned to different key material or transport policy; revoke it before re-enrolling`);
  }

  const now = new Date().toISOString();
  const record: PeerTrustRecord = {
    version: RECORD_VERSION,
    authorityId,
    publicKeyPem,
    fingerprint,
    transportPolicy,
    state: "pending",
    createdAt: now,
    updatedAt: now,
    revokedAt: null,
    revokedReason: null,
  };
  writeRecord(path, record);
  return record;
}

/**
 * Proof-gated state advance for the mutual enrollment protocol (enrollment.ts). This is
 * the ONLY way a peer trust record may reach `confirming` or `active`: the caller must
 * have already verified an Ed25519 signature over a canonical enrollment transcript
 * before calling this, and `publicKeyPem`/`transportPolicy` must come from that verified
 * transcript, never from a raw CLI flag. There is no CLI command that calls this
 * directly with self-asserted fields.
 */
export function advancePeerTrustFromEnrollmentProof(input: Readonly<{
  stateDir?: string;
  authorityId: string;
  publicKeyPem: string;
  transportPolicy: unknown;
  toState: Extract<PeerTrustState, "confirming" | "active">;
}>): PeerTrustRecord {
  const stateDir = requireIdentity(input.stateDir);
  const { authorityId, fingerprint, publicKeyPem } = boundPeerKey(input.authorityId, input.publicKeyPem);
  const transportPolicy = boundTransportPolicy(input.transportPolicy, authorityId);
  const peersDir = ensurePeersDir(stateDir);
  const path = recordPath(peersDir, authorityId);
  const existing = tryReadRecord(path, authorityId);

  if (existing) {
    if (existing.state === "revoked") throw new PeerTrustError(`authority ${authorityId} is durably revoked; enrollment is not permitted`);
    if (existing.fingerprint !== fingerprint || existing.publicKeyPem !== publicKeyPem || !sameTransportPolicy(existing.transportPolicy, transportPolicy)) {
      throw new PeerTrustError(`authority ${authorityId} is already pinned to different key material or transport policy; revoke it before re-enrolling`);
    }
    if (existing.state === "active" || existing.state === input.toState) return existing;
  }

  const now = new Date().toISOString();
  const record: PeerTrustRecord = existing
    ? { ...existing, state: input.toState, updatedAt: now }
    : {
        version: RECORD_VERSION,
        authorityId,
        publicKeyPem,
        fingerprint,
        transportPolicy,
        state: input.toState,
        createdAt: now,
        updatedAt: now,
        revokedAt: null,
        revokedReason: null,
      };
  writeRecord(path, record);
  return record;
}

export function revokePeerTrust(input: Readonly<{ stateDir?: string; authorityId: string; reason: string }>): PeerTrustRecord {
  const stateDir = requireIdentity(input.stateDir);
  const authorityId = boundAuthorityId(input.authorityId);
  const reason = nonBlank(input.reason, "revocation reason");
  const peersDir = ensurePeersDir(stateDir);
  const path = recordPath(peersDir, authorityId);
  const existing = readRecordOrThrow(path, authorityId, "revoke");

  if (existing.state === "revoked") return existing;

  const now = new Date().toISOString();
  const record: PeerTrustRecord = { ...existing, state: "revoked", updatedAt: now, revokedAt: now, revokedReason: reason };
  writeRecord(path, record);
  return record;
}

export function listPeerTrust(stateDirInput?: string): readonly PeerTrustRecord[] {
  const stateDir = requireIdentity(stateDirInput);
  const peersDir = ensurePeersDir(stateDir);
  const entries = readdirSync(peersDir).filter((entry) => entry.endsWith(".json")).sort();
  return entries.map((entry) => {
    const authorityId = boundAuthorityId(basename(entry, ".json"));
    return readRecordOrThrow(join(peersDir, entry), authorityId, "inspect");
  });
}

export function readPeerTrust(authorityIdInput: string, stateDirInput?: string): PeerTrustRecord {
  const stateDir = requireIdentity(stateDirInput);
  const authorityId = boundAuthorityId(authorityIdInput);
  const peersDir = ensurePeersDir(stateDir);
  return readRecordOrThrow(recordPath(peersDir, authorityId), authorityId, "inspect");
}

/** Never returns a revoked (or pending) record: the durable active-trust lookup used before trusting a peer. */
export function readActivePeerTrust(authorityIdInput: string, stateDirInput?: string): PeerTrustRecord | null {
  const stateDir = requireIdentity(stateDirInput);
  const authorityId = boundAuthorityId(authorityIdInput);
  const peersDir = ensurePeersDir(stateDir);
  const record = tryReadRecord(recordPath(peersDir, authorityId), authorityId);
  return record && record.state === "active" ? record : null;
}

function requireIdentity(stateDirInput?: string): string {
  const stateDir = resolveRoomsStateDir(stateDirInput);
  readMachineIdentityStatus(stateDir);
  return stateDir;
}

function boundPeerKey(authorityIdInput: string, publicKeyPemInput: string): { authorityId: AuthorityId; fingerprint: string; publicKeyPem: string } {
  const publicKeyPem = nonBlank(publicKeyPemInput, "peer public key");
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    throw new PeerTrustError("peer public key is not a valid PEM-encoded key");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") throw new PeerTrustError("peer public key must be Ed25519");
  const fingerprint = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
  const authorityId = boundAuthorityId(authorityIdInput);
  if (authorityId !== `authority-${fingerprint}`) {
    throw new PeerTrustError(`authority id ${authorityId} does not match the fingerprint of the supplied public key; authority mismatch`);
  }
  return { authorityId, fingerprint, publicKeyPem };
}

/** Shared authority id well-formedness check, reused by the enrollment stage machine. */
export function assertWellFormedAuthorityId(value: string): AuthorityId {
  return boundAuthorityId(value);
}

function boundAuthorityId(value: string): AuthorityId {
  const authorityId = toAuthorityId(nonBlank(value, "authority id"));
  if (!AUTHORITY_ID_PATTERN.test(authorityId)) throw new PeerTrustError(`authority id ${authorityId} is not a well-formed Rooms authority id`);
  return authorityId;
}

function boundTransportPolicy(value: unknown, authorityId: AuthorityId): FederationTransportPolicy {
  try {
    validateTransportPolicy(value);
  } catch (error) {
    throw new PeerTrustError(error instanceof FederationCodecError ? error.message : "transport policy is invalid");
  }
  const policy = value as FederationTransportPolicy;
  if ((policy.kind === "loopbackSsh" || policy.kind === "tailscalePeer") && policy.peerAuthorityId !== authorityId) {
    throw new PeerTrustError("transport policy peerAuthorityId does not match the pinned peer authority id; authority mismatch");
  }
  return policy;
}

function sameTransportPolicy(left: FederationTransportPolicy, right: FederationTransportPolicy): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function ensurePeersDir(stateDir: string): string {
  const federationDir = join(stateDir, "federation");
  const peersDir = join(federationDir, "peers");
  assertSafePath(peersDir);
  if (!existsAsAny(peersDir)) mkdirSync(peersDir, { mode: DIRECTORY_MODE });
  assertRegularDirectory(peersDir, "federation peers directory");
  assertMode(peersDir, DIRECTORY_MODE, "federation peers directory");
  return peersDir;
}

function recordPath(peersDir: string, authorityId: AuthorityId): string {
  return join(peersDir, `${authorityId}.json`);
}

function readRecordOrThrow(path: string, authorityId: AuthorityId, action: "enroll" | "revoke" | "inspect"): PeerTrustRecord {
  const record = tryReadRecord(path, authorityId);
  if (!record) throw new PeerTrustError(`no local trust record for authority ${authorityId}; nothing to ${action}`);
  return record;
}

function tryReadRecord(path: string, authorityId: AuthorityId): PeerTrustRecord | null {
  assertSafePath(path);
  if (!existsAsAny(path)) return null;
  assertRegularNonSymlink(path, "peer trust record");
  assertMode(path, FILE_MODE, "peer trust record");
  return parseRecord(readFileSync(path, "utf8"), authorityId);
}

function parseRecord(serialized: string, expectedAuthorityId: AuthorityId): PeerTrustRecord {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new PeerTrustError("peer trust record is malformed JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PeerTrustError("peer trust record must be an object");
  const record = value as Record<string, unknown>;
  const expected = ["version", "authorityId", "publicKeyPem", "fingerprint", "transportPolicy", "state", "createdAt", "updatedAt", "revokedAt", "revokedReason"];
  if (Object.keys(record).some((key) => !expected.includes(key)) || expected.some((key) => !(key in record))) {
    throw new PeerTrustError("peer trust record fields are malformed");
  }
  if (record.version !== RECORD_VERSION) throw new PeerTrustError("peer trust record version is unsupported");
  if (record.authorityId !== expectedAuthorityId) throw new PeerTrustError("peer trust record authority id does not match its storage location");
  if (record.state !== "pending" && record.state !== "confirming" && record.state !== "active" && record.state !== "revoked") throw new PeerTrustError("peer trust record state is invalid");
  for (const field of ["createdAt", "updatedAt"] as const) {
    if (typeof record[field] !== "string" || !Number.isFinite(Date.parse(record[field] as string))) throw new PeerTrustError(`peer trust record ${field} is invalid`);
  }
  const isRevoked = record.state === "revoked";
  if (isRevoked && (typeof record.revokedAt !== "string" || !Number.isFinite(Date.parse(record.revokedAt)) || typeof record.revokedReason !== "string" || record.revokedReason.trim() === "")) {
    throw new PeerTrustError("revoked peer trust record must carry a revocation timestamp and reason");
  }
  if (!isRevoked && (record.revokedAt !== null || record.revokedReason !== null)) {
    throw new PeerTrustError("non-revoked peer trust record must not carry revocation fields");
  }
  const { authorityId, fingerprint } = boundPeerKey(record.authorityId as string, record.publicKeyPem as string);
  if (fingerprint !== record.fingerprint) throw new PeerTrustError("peer trust record fingerprint does not match its stored public key");
  const transportPolicy = boundTransportPolicy(record.transportPolicy, authorityId);
  return {
    version: RECORD_VERSION,
    authorityId,
    publicKeyPem: record.publicKeyPem as string,
    fingerprint,
    transportPolicy,
    state: record.state,
    createdAt: record.createdAt as string,
    updatedAt: record.updatedAt as string,
    revokedAt: (record.revokedAt as string | null) ?? null,
    revokedReason: (record.revokedReason as string | null) ?? null,
  };
}

function writeRecord(path: string, record: PeerTrustRecord): void {
  const dir = dirname(path);
  const temporary = join(dir, `.${basename(path)}.tmp-${randomUUID()}`);
  const fd = openSync(temporary, "wx", FILE_MODE);
  try {
    fchmodSync(fd, FILE_MODE);
    writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8" });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  assertMode(path, FILE_MODE, "peer trust record");
}

function nonBlank(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new PeerTrustError(`${field} must be non-blank`);
  return value;
}

function assertSafePath(path: string): void {
  const absolute = resolve(path);
  let current = "/";
  for (const component of absolute.split("/").filter(Boolean)) {
    current = join(current, component);
    if (!existsAsAny(current)) break;
    if (lstatSync(current).isSymbolicLink()) throw new PeerTrustError(`path contains a symlink: ${current}`);
  }
}

function existsAsAny(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertRegularNonSymlink(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new PeerTrustError(`${label} must not be a symlink`);
  if (!stat.isFile()) throw new PeerTrustError(`${label} must be a regular file`);
}

function assertRegularDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new PeerTrustError(`${label} must not be a symlink`);
  if (!stat.isDirectory()) throw new PeerTrustError(`${label} must be a directory`);
}

function assertMode(path: string, mode: number, label: string): void {
  const actual = statSync(path).mode & 0o777;
  if (actual !== mode) throw new PeerTrustError(`${label} permissions must be ${mode.toString(8)}, found ${actual.toString(8)}`);
}

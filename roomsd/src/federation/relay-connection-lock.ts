// SPDX-License-Identifier: Apache-2.0
/**
 * Advisory, filesystem-based single-active-connection lock for the outbound (dialing) side
 * of a Rooms relay connection: enforces "only one active connection per peer/direction" and
 * gives a deterministic tie-break for two nearly simultaneous dial attempts to the same
 * peer — whichever process wins the exclusive (`wx`) file create holds the lock for the
 * lifetime of its connect/reconnect loop; the loser fails closed immediately rather than
 * racing a second SSH child against the first. A lock left behind by a process that is no
 * longer alive is reclaimed automatically (checked via a zero-signal `kill`, never assumed
 * from the file's age alone).
 *
 * The responder (inbound/serve-stdio) side of this same policy is not enforced by this
 * checkpoint: each inbound SSH session is already its own independent process, and
 * multi-session admission control for a single peer authority is deferred to a later
 * routing/session-management unit (see docs/rooms-design-baseline.md).
 */

import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthorityId } from "./contracts.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export class RelayConnectionLockError extends Error {
  constructor(message: string) {
    super(`Rooms relay connection lock: ${message}`);
    this.name = "RelayConnectionLockError";
  }
}

type LockRecord = Readonly<{ pid: number; acquiredAt: string }>;

/** Acquires the outbound relay lock for `peerAuthorityId` under `stateDir`, or throws RelayConnectionLockError if another live process already holds it. Returns a release function. */
export function acquireOutboundRelayLock(stateDir: string, peerAuthorityId: AuthorityId): () => void {
  const dir = join(stateDir, "federation", "relay", "outbound");
  ensureDirectory(dir);
  const path = join(dir, `${peerAuthorityId}.lock`);
  return acquire(path, peerAuthorityId, "outbound");
}

function acquire(path: string, peerAuthorityId: AuthorityId, direction: "outbound", alreadyReclaimed = false): () => void {
  try {
    const fd = openSync(path, "wx", FILE_MODE);
    try {
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() } satisfies LockRecord)}\n`, { encoding: "utf8" });
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readLockRecord(path);
    if (existing && isPidAlive(existing.pid)) {
      throw new RelayConnectionLockError(`another active ${direction} relay connection to ${peerAuthorityId} already holds the lock (pid ${existing.pid})`);
    }
    if (alreadyReclaimed) throw new RelayConnectionLockError(`could not reclaim stale ${direction} relay lock for ${peerAuthorityId}`);
    try { unlinkSync(path); } catch { /* another process may have already cleaned it up */ }
    return acquire(path, peerAuthorityId, direction, true);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { unlinkSync(path); } catch { /* already gone */ }
  };
}

function readLockRecord(path: string): LockRecord | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockRecord>;
    if (typeof parsed.pid !== "number" || typeof parsed.acquiredAt !== "string") return null;
    return { pid: parsed.pid, acquiredAt: parsed.acquiredAt };
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function ensureDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE });
  const stat = statSync(path);
  if (!stat.isDirectory()) throw new RelayConnectionLockError(`${path} exists and is not a directory`);
}

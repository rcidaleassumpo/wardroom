import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeIdentity } from "../contracts.js";

const defaultSocketDirectory = join(homedir(), ".rooms", "s");

/** Keep the Unix endpoint below sockaddr_un limits while retaining full identity entropy. */
export function runtimeSocketPath(identity: RuntimeIdentity, socketDirectory = defaultSocketDirectory): string {
  const digest = createHash("sha256")
    .update(`${identity.homeAuthorityId}\0${identity.sessionId}\0${identity.runtimeId}\0${identity.generation}`)
    // 128 bits is ample collision resistance for a per-user runtime socket
    // directory and keeps the complete path below macOS sockaddr_un limits
    // even when ROOMS_STATE_DIR itself is a long temporary/install path.
    .digest("hex")
    .slice(0, 32);
  return join(socketDirectory, `r-${digest}.sock`);
}

export function ensureRuntimeSocketDirectory(socketDirectory = defaultSocketDirectory): string {
  mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  chmodSync(socketDirectory, 0o700);
  return socketDirectory;
}

export function runtimeHandleRef(socketPath: string, stateDir: string): string {
  return `unix:${encodeURIComponent(socketPath)};state:${encodeURIComponent(stateDir)}`;
}

export function parseRuntimeHandle(handleRef: string): { socketPath: string; stateDir: string } | null {
  const match = /^unix:([^;]+);state:([^;]+)$/.exec(handleRef);
  if (!match) return null;
  try { return { socketPath: decodeURIComponent(match[1]), stateDir: decodeURIComponent(match[2]) }; }
  catch { return null; }
}

// SPDX-License-Identifier: Apache-2.0
/**
 * Transport-neutral port for running a single bounded remote Rooms CLI command and
 * getting back its stdout/stderr. `ssh-command-adapter.ts` is the only implementation
 * today (the system OpenSSH client); a later Tailscale/direct adapter can implement this
 * same port so `ssh-connect.ts`'s orchestration state machine needs no changes to gain a
 * second transport.
 */

export type RemoteCommandErrorCode =
  | "sshClientMissing"
  | "connectionFailed"
  | "hostKeyFailure"
  | "timeout"
  | "signaled"
  | "nonzeroExit"
  | "oversizeStdout"
  | "oversizeStderr"
  | "missingRemoteCli"
  | "disallowedRemoteCommand";

export class RemoteCommandError extends Error {
  readonly code: RemoteCommandErrorCode;
  constructor(code: RemoteCommandErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "RemoteCommandError";
    this.code = code;
  }
}

export type RemoteCommandOutput = Readonly<{ stdout: string; stderr: string }>;
export type RemoteCommandOptions = Readonly<{ stdin?: string; timeoutMs?: number }>;

export interface RemoteCommandPort {
  /** Runs one fixed-vocabulary remote command to completion and returns its bounded stdout/stderr, or rejects with a RemoteCommandError. */
  run(remoteArgv: readonly string[], options?: RemoteCommandOptions): Promise<RemoteCommandOutput>;
}

// The installer owns this fixed per-user path. Non-interactive SSH shells do
// not reliably include ~/.local/bin in PATH (notably on a clean macOS user),
// so invoking a bare `rooms` makes an otherwise-correct installation
// unreachable. Keep the token literal and allowlisted: the remote login shell
// expands $HOME, while no caller-controlled command text enters the argv.
export const ROOMS_REMOTE_BINARY = "$HOME/.local/bin/rooms";
const REMOTE_ABSOLUTE_PATH_MAX_LENGTH = 1024;
const REMOTE_ABSOLUTE_PATH_PATTERN = /^\/[A-Za-z0-9._\-/]*$/;

/**
 * Validates a hostile remote path before any use: no whitespace, quotes, shell
 * metacharacters, or `..` traversal segment. Shared by the SSH argv boundary,
 * callers validating `--remote-state-dir`, and the pre-authentication relay Init parser.
 */
export function assertSafeRemoteAbsolutePath(value: string, label = "remote path"): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-blank string`);
  if (value.length > REMOTE_ABSOLUTE_PATH_MAX_LENGTH) throw new Error(`${label} must be at most ${REMOTE_ABSOLUTE_PATH_MAX_LENGTH} characters`);
  if (!REMOTE_ABSOLUTE_PATH_PATTERN.test(value)) throw new Error(`${label} must be an absolute path using only letters, digits, '.', '_', '-', and '/'`);
  if (value.split("/").includes("..")) throw new Error(`${label} must not contain '..'`);
  return value;
}

/**
 * The ONLY remote command shapes any RemoteCommandPort implementation may ever hand to a
 * transport adapter's process: `rooms setup [--state-dir <safe-absolute-path>]`, `rooms
 * federation enroll remote-step`, or `rooms federation relay serve-stdio` (no extra
 * arguments for either fixed shape). Enforced here, at the port boundary itself, rather than
 * only by caller convention in ssh-connect.ts/ssh-relay-transport.ts, so that a future
 * caller/adapter bug — or a later transport reusing this same port contract — cannot turn
 * an arbitrary `remoteArgv` into a remote shell command: `ssh` (and any similar remote-exec
 * transport) joins argv into a single command-line string interpreted by the remote shell,
 * so passing through an unvalidated token here would be a real command-injection surface.
 */
export function assertAllowedRemoteArgv(remoteArgv: readonly string[]): readonly string[] {
  if (remoteArgv.length === 2 && remoteArgv[0] === ROOMS_REMOTE_BINARY && remoteArgv[1] === "setup") return remoteArgv;
  if (remoteArgv.length === 4 && remoteArgv[0] === ROOMS_REMOTE_BINARY && remoteArgv[1] === "setup" && remoteArgv[2] === "--state-dir") {
    try {
      assertSafeRemoteAbsolutePath(remoteArgv[3]!, "--state-dir");
    } catch (error) {
      throw new RemoteCommandError("disallowedRemoteCommand", error instanceof Error ? error.message : String(error));
    }
    return remoteArgv;
  }
  if (remoteArgv.length === 4 && remoteArgv[0] === ROOMS_REMOTE_BINARY && remoteArgv[1] === "federation" && remoteArgv[2] === "enroll" && remoteArgv[3] === "remote-step") {
    return remoteArgv;
  }
  if (remoteArgv.length === 4 && remoteArgv[0] === ROOMS_REMOTE_BINARY && remoteArgv[1] === "federation" && remoteArgv[2] === "relay" && remoteArgv[3] === "serve-stdio") {
    return remoteArgv;
  }
  throw new RemoteCommandError("disallowedRemoteCommand", `remote command ${JSON.stringify(remoteArgv)} is not in the fixed Rooms remote command vocabulary`);
}

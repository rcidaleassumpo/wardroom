// SPDX-License-Identifier: Apache-2.0
/**
 * SSH-specific implementation of the RemoteCommandPort: runs one bounded, fixed-vocabulary
 * remote command through the system OpenSSH client via argv-safe `spawn` (never a shell,
 * never `sh -c`, never string interpolation into a shell command line). It consumes the
 * user's own SSH config and known_hosts trust as-is: no `-o StrictHostKeyChecking`, no
 * `-o UserKnownHostsFile`, no `accept-new`, no password on argv, and no Rooms-managed SSH
 * config edits. `-o BatchMode=yes` is passed so a host that would otherwise prompt for a
 * password or passphrase fails closed immediately instead of hanging; this does not weaken
 * host-key or credential trust decisions, which remain entirely the user's own SSH config.
 */

import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import type { RemoteCommandOptions, RemoteCommandOutput, RemoteCommandPort } from "./remote-command-port.js";
import { assertAllowedRemoteArgv, RemoteCommandError } from "./remote-command-port.js";

export const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
export const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
export const MAX_STDOUT_BYTES = 65_536;
export const MAX_STDERR_BYTES = 16_384;

const SSH_TARGET_MAX_LENGTH = 255;
const SSH_TOKEN_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export class SshTargetError extends Error {
  constructor(message: string) {
    super(`Rooms SSH target: ${message}`);
    this.name = "SshTargetError";
  }
}

export type ParsedSshTarget = Readonly<{ target: string; sshUser: string; sshDestination: string }>;

/**
 * Validates a `--ssh-host` token strictly enough that it can only ever be interpreted by
 * `ssh` as a plain `[user@]host` destination positional argument: rejects a leading dash
 * (option injection, e.g. a crafted `-oProxyCommand=...`), any whitespace or control
 * character, a URL/scheme (`://`), an embedded port or option (`:`, `/`, spaces), and more
 * than one `@`. Port/config behaviors beyond this are only ever resolved by the user's own
 * trusted SSH config in v1 (an alias with a `Port`/`ProxyJump`/etc. entry), never parsed or
 * reinterpreted by Rooms.
 */
export function parseSshTarget(value: string): ParsedSshTarget {
  if (typeof value !== "string" || value.length === 0) throw new SshTargetError("--ssh-host must be a non-blank string");
  if (value.length > SSH_TARGET_MAX_LENGTH) throw new SshTargetError(`--ssh-host must be at most ${SSH_TARGET_MAX_LENGTH} characters`);
  if (value !== value.trim()) throw new SshTargetError("--ssh-host must not have leading or trailing whitespace");
  if (value.startsWith("-")) throw new SshTargetError("--ssh-host must not start with '-' (rejected to prevent SSH option injection)");
  if (value.includes("://")) throw new SshTargetError("--ssh-host must not be a URL");
  if (/[\s\x00-\x1f\x7f]/.test(value)) throw new SshTargetError("--ssh-host must not contain whitespace or control characters");
  if (value.includes("/")) throw new SshTargetError("--ssh-host must not contain '/'");
  if (value.includes(":")) throw new SshTargetError("--ssh-host must not embed a port or option; use an SSH config alias instead");

  const parts = value.split("@");
  if (parts.length > 2) throw new SshTargetError("--ssh-host must contain at most one '@'");
  if (parts.length === 2) {
    const [user, host] = parts as [string, string];
    if (!SSH_TOKEN_PATTERN.test(user)) throw new SshTargetError("--ssh-host user part is not a well-formed SSH user");
    if (!SSH_TOKEN_PATTERN.test(host)) throw new SshTargetError("--ssh-host host part is not a well-formed SSH host or config alias");
    return { target: value, sshUser: user, sshDestination: host };
  }
  if (!SSH_TOKEN_PATTERN.test(value)) throw new SshTargetError("--ssh-host is not a well-formed SSH host or config alias");
  return { target: value, sshUser: userInfo().username, sshDestination: value };
}

/** Strips likely key/secret-shaped substrings and bounds length before any remote stderr is surfaced in an error. */
export function redactStderr(text: string): string {
  const bounded = text.length > MAX_STDERR_BYTES ? `${text.slice(0, MAX_STDERR_BYTES)}...[truncated]` : text;
  return bounded
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[redacted-key-material]")
    .replace(/[0-9a-fA-F]{40,}/g, "[redacted-hex]")
    .replace(/[A-Za-z0-9+/]{80,}={0,2}/g, "[redacted-base64]");
}

export function createSshCommandPort(sshHost: string, options?: Readonly<{ connectTimeoutSeconds?: number }>): RemoteCommandPort {
  const parsed = parseSshTarget(sshHost);
  const connectTimeoutSeconds = options?.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS;
  return {
    async run(remoteArgv: readonly string[], runOptions?: RemoteCommandOptions): Promise<RemoteCommandOutput> {
      assertAllowedRemoteArgv(remoteArgv);
      return runSshCommand(parsed.target, remoteArgv, connectTimeoutSeconds, runOptions);
    },
  };
}

function runSshCommand(
  target: string,
  remoteArgv: readonly string[],
  connectTimeoutSeconds: number,
  runOptions?: RemoteCommandOptions,
): Promise<RemoteCommandOutput> {
  return new Promise((resolvePromise, rejectPromise) => {
    const argv = ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${connectTimeoutSeconds}`, target, ...remoteArgv];
    const child = spawn("ssh", argv, { stdio: ["pipe", "pipe", "pipe"] });

    let settled = false;
    let timedOut = false;
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stdoutOversized = false;
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let stderrOversized = false;

    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    };
    const settleResolve = (output: RemoteCommandOutput): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(output);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, runOptions?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        settleReject(new RemoteCommandError("sshClientMissing", "system ssh client not found on PATH"));
      } else {
        settleReject(new RemoteCommandError("connectionFailed", `failed to launch ssh: ${error.message}`));
      }
    });

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutOversized) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        stdoutOversized = true;
        child.kill("SIGKILL");
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrOversized) return;
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) {
        stderrOversized = true;
        child.kill("SIGKILL");
        return;
      }
      stderrChunks.push(chunk);
    });

    if (runOptions?.stdin !== undefined) {
      child.stdin.end(runOptions.stdin, "utf8");
    } else {
      child.stdin.end();
    }

    child.on("close", (code, signal) => {
      const stderrText = redactStderr(Buffer.concat(stderrChunks).toString("utf8"));
      if (stdoutOversized) {
        settleReject(new RemoteCommandError("oversizeStdout", `remote stdout exceeded ${MAX_STDOUT_BYTES} bytes`));
        return;
      }
      if (stderrOversized) {
        settleReject(new RemoteCommandError("oversizeStderr", `remote stderr exceeded ${MAX_STDERR_BYTES} bytes`));
        return;
      }
      if (timedOut) {
        settleReject(new RemoteCommandError("timeout", `ssh command timed out after ${runOptions?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS}ms`));
        return;
      }
      if (signal) {
        settleReject(new RemoteCommandError("signaled", `ssh process terminated by signal ${signal}`));
        return;
      }
      if (code === 255) {
        if (/host key verification failed/i.test(stderrText) || /remote host identification has changed/i.test(stderrText)) {
          settleReject(new RemoteCommandError("hostKeyFailure", `ssh host-key verification failed: ${stderrText}`));
        } else {
          settleReject(new RemoteCommandError("connectionFailed", `ssh connection failed: ${stderrText}`));
        }
        return;
      }
      if (code === 127 || /command not found/i.test(stderrText)) {
        settleReject(new RemoteCommandError("missingRemoteCli", `remote Rooms CLI not found: ${stderrText}`));
        return;
      }
      if (code !== 0) {
        settleReject(new RemoteCommandError("nonzeroExit", `remote command exited with code ${code}: ${stderrText}`));
        return;
      }
      settleResolve({ stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderr: stderrText });
    });
  });
}

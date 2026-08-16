// SPDX-License-Identifier: Apache-2.0
/**
 * SSH-specific `RelayByteDuplex` and initiator-side `PeerConnectionFactory`: spawns the
 * system OpenSSH client via argv-safe `spawn` (never a shell) to run exactly one fixed
 * remote command, `rooms federation relay serve-stdio`, and wires its stdin/stdout as a
 * bounded byte duplex for `RelayConnection` (relay-connection.ts). This is a long-lived
 * process, unlike `ssh-command-adapter.ts`'s run-to-completion `RemoteCommandPort`: the SSH
 * child stays alive for the lifetime of the connection, carrying framed Rooms relay traffic
 * over its stdio instead of a single bounded stdout/stderr result. No port-forward, TCP
 * socket, or network listener is ever opened; the only channel is this process's own stdio
 * pipes to a child `ssh` process.
 *
 * Reuses unit 7's OpenSSH safety exactly: system `ssh`, the user's own known_hosts/config,
 * `-o BatchMode=yes` (fail closed instead of hanging on a prompt), a bounded
 * `-o ConnectTimeout`, and `-o ServerAliveInterval`/`-o ServerAliveCountMax` so a silently
 * dead network path is detected and the child exits instead of hanging forever. The fixed
 * remote argv is validated by the same port-boundary allowlist
 * (`assertAllowedRemoteArgv` in remote-command-port.ts) used for every other Rooms SSH
 * invocation, so this transport cannot be coaxed into running anything else.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { assertAllowedRemoteArgv, ROOMS_REMOTE_BINARY } from "./remote-command-port.js";
import { parseSshTarget, redactStderr } from "./ssh-command-adapter.js";
import { RelayConnection, type RelayByteDuplex, type RelayConnectionInput, type RelayTransportCloseInfo } from "./relay-connection.js";
import type { AuthorityId } from "./contracts.js";

export const DEFAULT_SSH_RELAY_CONNECT_TIMEOUT_SECONDS = 10;
export const DEFAULT_SSH_RELAY_SERVER_ALIVE_INTERVAL_SECONDS = 5;
export const DEFAULT_SSH_RELAY_SERVER_ALIVE_COUNT_MAX = 3;
export const MAX_SSH_RELAY_STDERR_BYTES = 16_384;
const SSH_RELAY_REMOTE_ARGV = [ROOMS_REMOTE_BINARY, "federation", "relay", "serve-stdio"] as const;
const KILL_GRACE_MS = 500;

export type SshRelayTransportOptions = Readonly<{
  connectTimeoutSeconds?: number;
  serverAliveIntervalSeconds?: number;
  serverAliveCountMax?: number;
}>;

/** Spawns the fixed remote relay entry point over SSH and returns a duplex plus the underlying child (for tests/process inspection only; production callers only need the duplex). */
export function createSshRelayDuplex(sshHost: string, options?: SshRelayTransportOptions): Readonly<{ duplex: RelayByteDuplex; child: ChildProcessWithoutNullStreams }> {
  const parsed = parseSshTarget(sshHost);
  assertAllowedRemoteArgv(SSH_RELAY_REMOTE_ARGV);

  const connectTimeoutSeconds = options?.connectTimeoutSeconds ?? DEFAULT_SSH_RELAY_CONNECT_TIMEOUT_SECONDS;
  const serverAliveIntervalSeconds = options?.serverAliveIntervalSeconds ?? DEFAULT_SSH_RELAY_SERVER_ALIVE_INTERVAL_SECONDS;
  const serverAliveCountMax = options?.serverAliveCountMax ?? DEFAULT_SSH_RELAY_SERVER_ALIVE_COUNT_MAX;

  const argv = [
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${connectTimeoutSeconds}`,
    "-o", `ServerAliveInterval=${serverAliveIntervalSeconds}`,
    "-o", `ServerAliveCountMax=${serverAliveCountMax}`,
    parsed.target,
    ...SSH_RELAY_REMOTE_ARGV,
  ];
  const child = spawn("ssh", argv, { stdio: ["pipe", "pipe", "pipe"] });

  let onDataCb: ((chunk: Buffer) => void) | null = null;
  let onDrainCb: (() => void) | null = null;
  let onCloseCb: ((info: RelayTransportCloseInfo) => void) | null = null;
  let destroyedByUs = false;
  let settled = false;
  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;

  const settleClose = (info: RelayTransportCloseInfo): void => {
    if (settled) return;
    settled = true;
    onCloseCb?.(info);
  };

  child.stdout.on("data", (chunk: Buffer) => onDataCb?.(chunk));
  child.stdin.on("drain", () => onDrainCb?.());
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    settleClose({ reason: "transportError", message: `ssh relay input closed: ${error.message}` });
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrBytes >= MAX_SSH_RELAY_STDERR_BYTES) return;
    stderrBytes += chunk.length;
    stderrChunks.push(chunk);
  });

  child.on("error", (error: NodeJS.ErrnoException) => {
    settleClose({ reason: "childSpawnFailed", message: error.code === "ENOENT" ? "system ssh client not found on PATH" : `failed to launch ssh: ${error.message}` });
  });

  child.on("close", (code, signal) => {
    const stderrText = redactStderr(Buffer.concat(stderrChunks).toString("utf8"));
    if (destroyedByUs) {
      settleClose({ reason: "gracefulClose", message: "ssh relay transport closed locally" });
      return;
    }
    if (signal) {
      settleClose({ reason: "childSignaled", message: `ssh relay child terminated by signal ${signal}${stderrText ? `: ${stderrText}` : ""}` });
      return;
    }
    if (code !== 0) {
      settleClose({ reason: "childExited", message: `ssh relay child exited with code ${code}${stderrText ? `: ${stderrText}` : ""}` });
      return;
    }
    settleClose({ reason: "childExited", message: "ssh relay child exited unexpectedly with code 0" });
  });

  const duplex: RelayByteDuplex = {
    write: (data: string) => child.stdin.write(data, "utf8"),
    onData: (cb) => { onDataCb = cb; },
    onDrain: (cb) => { onDrainCb = cb; },
    onceClose: (cb) => { onCloseCb = cb; },
    destroy: () => {
      if (destroyedByUs) return;
      destroyedByUs = true;
      try { child.stdin.end(); } catch { /* already closed */ }
      const killTimer = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, KILL_GRACE_MS);
      child.once("exit", () => clearTimeout(killTimer));
      child.kill("SIGTERM");
    },
  };

  return { duplex, child };
}

export type SshRelayConnectInput = Readonly<{
  sshHost: string;
  peerAuthorityId: AuthorityId;
  localStateDir?: string;
  remoteStateDir?: string;
  transportOptions?: SshRelayTransportOptions;
}> & Omit<RelayConnectionInput, "role" | "duplex" | "peerAuthorityId" | "remoteStateDirForPeer" | "localStateDir">;

/**
 * The initiator-side `PeerConnectionFactory` for the SSH transport: dials the fixed remote
 * relay entry point and returns an unstarted `RelayConnection` (call `.start()` to begin the
 * handshake). A future Tailscale/direct transport implements the same shape against its own
 * duplex without any change to `RelayConnection` itself.
 */
export function createSshRelayConnection(input: SshRelayConnectInput): RelayConnection {
  const { duplex } = createSshRelayDuplex(input.sshHost, input.transportOptions);
  return new RelayConnection({
    ...input,
    role: "initiator",
    duplex,
    localStateDir: input.localStateDir,
    peerAuthorityId: input.peerAuthorityId,
    remoteStateDirForPeer: input.remoteStateDir,
  });
}

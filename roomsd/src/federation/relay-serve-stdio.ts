// SPDX-License-Identifier: Apache-2.0
/**
 * Remote acceptor entry point for `rooms federation relay serve-stdio` (the fixed remote
 * command `ssh-relay-transport.ts` invokes). Wires this process's own stdin/stdout as a
 * `RelayByteDuplex` to Rooms. The fixed CLI call, with no options, is a byte proxy to the
 * daemon's private 0600 Unix socket; roomsd runs the authenticated connection and injects
 * its terminal, channel-home, and inventory handlers. Explicit options construct a responder
 * in this process for tests or embedding and default to the neutral echo/status handler when
 * no handler is supplied. Status/diagnostic lines never share stdout with the framed relay
 * protocol bytes an SSH peer expects.
 */

import { RelayConnection, neutralRelayApplicationHandler, type RelayApplicationHandler, type RelayByteDuplex, type RelayConnectionStatus, type RelayTransportCloseInfo } from "./relay-connection.js";
import { createConnection } from "node:net";
import { roomsPaths } from "../provisioning/paths.js";

export type RelayServeStdioStreams = Readonly<{
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}>;

export type RelayServeStdioOptions = Readonly<{
  streams?: RelayServeStdioStreams;
  localStateDir?: string;
  handler?: RelayApplicationHandler;
  heartbeatIntervalMs?: number;
  idleTimeoutMs?: number;
  handshakeTimeoutMs?: number;
}>;

const GRACEFUL_REASONS: ReadonlySet<string> = new Set(["gracefulClose", "peerClosed", "peerDrained"]);

export function isGracefulRelayDisconnect(reason: string | null): boolean {
  return reason !== null && GRACEFUL_REASONS.has(reason);
}

/** Runs one relay session to completion over the given (or real process) stdio streams and resolves with the final connection status. */
export function runRelayServeStdio(options?: RelayServeStdioOptions): Promise<RelayConnectionStatus> {
  if (!options) return proxyRelayStdioToDaemon();
  const stdin = options?.streams?.stdin ?? process.stdin;
  const stdout = options?.streams?.stdout ?? process.stdout;
  const stderr = options?.streams?.stderr ?? process.stderr;

  return new Promise((resolve) => {
    let onDataCb: ((chunk: Buffer) => void) | null = null;
    let onDrainCb: (() => void) | null = null;
    let onCloseCb: ((info: RelayTransportCloseInfo) => void) | null = null;
    let closed = false;

    stdin.on("data", (chunk: Buffer) => onDataCb?.(chunk));
    stdin.on("end", () => onCloseCb?.({ reason: "peerClosed", message: "stdin closed (remote session ended)" }));
    stdin.on("error", (error: Error) => onCloseCb?.({ reason: "transportError", message: error.message }));
    stdout.on("drain", () => onDrainCb?.());

    const duplex: RelayByteDuplex = {
      write: (data: string) => stdout.write(data, "utf8"),
      onData: (cb) => { onDataCb = cb; },
      onDrain: (cb) => { onDrainCb = cb; },
      onceClose: (cb) => { onCloseCb = cb; },
      destroy: () => {
        if (closed) return;
        closed = true;
        try { stdout.end(); } catch { /* already ending */ }
      },
    };

    const connection = new RelayConnection({
      role: "responder",
      duplex,
      localStateDir: options?.localStateDir,
      handler: options?.handler ?? neutralRelayApplicationHandler,
      heartbeatIntervalMs: options?.heartbeatIntervalMs,
      idleTimeoutMs: options?.idleTimeoutMs,
      handshakeTimeoutMs: options?.handshakeTimeoutMs,
      onStatusChange: (status) => {
        try {
          stderr.write(`${JSON.stringify({ event: "relayServeStdioStatus", ...status })}\n`);
        } catch {
          // best-effort diagnostic only; never let a stderr write failure affect the connection
        }
        if (status.state === "closed") resolve(status);
      },
    });
    connection.start();
  });
}

/** The SSH child owns no Rooms state: it only proxies stdio to roomsd's private 0600 relay socket. */
function proxyRelayStdioToDaemon(): Promise<RelayConnectionStatus> {
  const endpoint = roomsPaths(process.env.ROOMS_STATE_DIR).federationRelayEndpoint;
  return new Promise((resolve) => {
    const socket = createConnection(endpoint);
    let connected = false;
    const finish = (reason: string, message: string) => resolve({ state: "closed", role: "responder", authorityId: null, peerAuthorityId: null, connectionId: null, connectedAt: null, lastHeartbeatSentAt: null, lastHeartbeatReceivedAt: null, outgoingSeq: 0, incomingSeq: 0, disconnectReason: reason as RelayConnectionStatus["disconnectReason"], disconnectMessage: message });
    socket.once("connect", () => {
      connected = true;
      process.stdin.pipe(socket);
      socket.pipe(process.stdout);
    });
    socket.once("error", (error) => finish("transportError", `local Rooms relay unavailable: ${error.message}`));
    socket.once("close", () => finish(connected ? "peerClosed" : "transportError", connected ? "local Rooms relay closed" : "local Rooms relay failed before connect"));
    process.stdin.once("error", (error) => { socket.destroy(); finish("transportError", error.message); });
    process.stdout.once("error", (error) => { socket.destroy(); finish("transportError", error.message); });
  });
}

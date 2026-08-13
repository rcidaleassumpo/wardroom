// SPDX-License-Identifier: Apache-2.0
import { Buffer } from "node:buffer";
import { createPublicKey, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { createSshRelayConnection } from "../federation/ssh-relay-transport.js";
import { neutralRelayApplicationHandler, type RelayConnection } from "../federation/relay-connection.js";
import type { AuthorityId } from "../federation/contracts.js";
import type { RelayTerminalFrame } from "../federation/relay-protocol.js";
import { encodeTerminalCapability, parseTerminalCapability, verifyTerminalCapability } from "../federation/terminal-capability.js";
import { readActivePeerTrust } from "../federation/peer-trust.js";
import { readMachineIdentityStatus } from "../identity/machine-identity.js";

type Terminal = {
  stdin: NodeJS.ReadStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
  stdout: NodeJS.WriteStream & { isTTY?: boolean; columns?: number; rows?: number };
  stderr: NodeJS.WriteStream;
};

export type RemoteRuntimeAttachInput = Readonly<{
  sessionId: string;
  sshHost: string;
  peerAuthorityId: AuthorityId;
  capabilityFile: string;
  localStateDir?: string;
  remoteStateDir?: string;
  mode: "observe" | "controller";
  outputCursor: string;
}>;

/** Interactive terminal whose only network path is the authenticated Rooms SSH-stdio relay. */
export async function runInteractiveRemoteRuntimeAttach(input: RemoteRuntimeAttachInput, terminal: Terminal = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }): Promise<void> {
  if (!terminal.stdin.isTTY || !terminal.stdout.isTTY) throw new Error("remote session attach requires an interactive terminal");
  const streamId = `terminal-${randomUUID()}`;
  const capabilityStat = lstatSync(input.capabilityFile);
  if (capabilityStat.isSymbolicLink() || !capabilityStat.isFile()) throw new Error("terminal capability file must be a regular non-symlink file");
  if ((capabilityStat.mode & 0o077) !== 0) throw new Error("terminal capability file must not be accessible by group or other users");
  const capability = parseTerminalCapability(readFileSync(input.capabilityFile, "utf8"));
  const localAuthorityId = readMachineIdentityStatus(input.localStateDir).authorityId as AuthorityId;
  const homePeer = readActivePeerTrust(input.peerAuthorityId, input.localStateDir);
  if (!homePeer) throw new Error("terminal capability issuer is not an active enrolled peer");
  verifyTerminalCapability({ capability, publicKey: createPublicKey(homePeer.publicKeyPem), issuer: input.peerAuthorityId, audience: localAuthorityId, sessionId: input.sessionId, mode: input.mode });
  const encodedCapability = encodeTerminalCapability(capability);
  let connection!: RelayConnection;
  let authorityId: AuthorityId | undefined;
  let runtimeId: string | undefined;
  let generation: number | undefined;
  let inputSeq = 0n;
  let opened = false;
  let finished = false;
  let finish!: (error?: Error) => void;
  const done = new Promise<void>((resolve, reject) => { finish = (error) => { if (finished) return; finished = true; error ? reject(error) : resolve(); }; });

  const sendResize = (): void => {
    if (!opened || !runtimeId || generation === undefined || !authorityId) return;
    const columns = terminal.stdout.columns; const rows = terminal.stdout.rows;
    if (!Number.isInteger(columns) || !Number.isInteger(rows) || !columns || !rows) return;
    connection.sendTerminal({ kind: "terminalResize", streamId, homeAuthorityId: input.peerAuthorityId, sessionId: input.sessionId, runtimeId, generation, capabilityId: capability.capabilityId, columns, rows });
  };
  const onInput = (chunk: Buffer | string): void => {
    if (!opened || !runtimeId || generation === undefined || !authorityId) return;
    inputSeq += 1n;
    connection.sendTerminal({ kind: "terminalInput", streamId, homeAuthorityId: input.peerAuthorityId, sessionId: input.sessionId, runtimeId, generation, capabilityId: capability.capabilityId, inputSeq: inputSeq.toString(), bytes: Buffer.from(chunk).toString("base64") });
  };

  const handler = {
    ...neutralRelayApplicationHandler,
    handleTerminal(frame: RelayTerminalFrame) {
      if (frame.streamId !== streamId) throw new Error("unexpected terminal stream");
      if (frame.kind === "terminalOpenAck") {
        if (frame.homeAuthorityId !== input.peerAuthorityId || frame.sessionId !== input.sessionId) throw new Error("remote runtime binding mismatch");
        runtimeId = frame.runtimeId; generation = frame.generation; opened = true;
        if (input.mode === "controller") {
          if (!terminal.stdin.setRawMode) throw new Error("controller attach requires a raw-mode terminal");
          terminal.stdin.setRawMode(true); terminal.stdin.resume(); terminal.stdin.on("data", onInput);
        }
        terminal.stdout.on("resize", sendResize); sendResize();
      } else if (frame.kind === "terminalOutput") {
        if (!opened || frame.runtimeId !== runtimeId || frame.generation !== generation) throw new Error("stale remote terminal output");
        terminal.stdout.write(Buffer.from(frame.bytes, "base64"));
      } else if (frame.kind === "terminalGap") {
        terminal.stderr.write(`rooms: remote runtime output gap; replay begins at ${frame.replayFrom}, head ${frame.head}\n`);
      } else if (frame.kind === "terminalClose") finish(frame.reason.startsWith("exit:") || frame.reason === "detached" ? undefined : new Error(`remote terminal closed: ${frame.reason}`));
    },
  };
  connection = createSshRelayConnection({
    sshHost: input.sshHost, peerAuthorityId: input.peerAuthorityId, localStateDir: input.localStateDir, remoteStateDir: input.remoteStateDir, handler,
    onStatusChange: (status) => {
      if (status.state === "connected" && !opened) {
        authorityId = status.authorityId ?? undefined;
        if (!authorityId) return finish(new Error("local Rooms authority is unavailable"));
        connection.sendTerminal({ kind: "terminalOpen", streamId, homeAuthorityId: input.peerAuthorityId, sessionId: input.sessionId, capability: encodedCapability, mode: input.mode, outputCursor: input.outputCursor });
      } else if (status.state === "closed" && !finished) finish(new Error(`Rooms relay closed: ${status.disconnectReason ?? "unknown"}: ${status.disconnectMessage ?? ""}`));
    },
  });
  const stop = () => finish();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  connection.start();
  try { await done; }
  finally {
    terminal.stdout.removeListener("resize", sendResize); terminal.stdin.removeListener("data", onInput);
    if (input.mode === "controller" && terminal.stdin.setRawMode) {
      terminal.stdin.setRawMode(false);
      terminal.stdin.pause();
    }
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    if (opened && runtimeId && generation !== undefined) connection.sendTerminal({ kind: "terminalDetach", streamId, homeAuthorityId: input.peerAuthorityId, sessionId: input.sessionId, runtimeId, generation });
    connection.close("gracefulClose", "terminal detached");
  }
}

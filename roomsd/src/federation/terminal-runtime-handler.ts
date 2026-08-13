// SPDX-License-Identifier: Apache-2.0
import { Buffer } from "node:buffer";
import { loadMachineSigningKeys } from "../identity/machine-identity.js";
import type { RuntimeActor } from "../runtime/contracts.js";
import type { RuntimeAttachSession, RoomsRuntimeService } from "../runtime/service.js";
import { neutralRelayApplicationHandler, type RelayApplicationHandler, type RelayConnection } from "./relay-connection.js";
import type { AuthorityId } from "./contracts.js";
import type { RelayTerminalFrame } from "./relay-protocol.js";
import { decodeTerminalCapability, verifyTerminalCapability, type TerminalCapability, type TerminalCapabilityAction } from "./terminal-capability.js";

const MAX_RAW_OUTPUT_BYTES = 6_000;

type OpenFrame = Extract<RelayTerminalFrame, { kind: "terminalOpen" }>;
type StreamState = {
  open: OpenFrame;
  capability: TerminalCapability;
  runtimeId: string;
  generation: number;
  session: RuntimeAttachSession;
  connection: RelayConnection;
  ready: boolean;
  pending: Array<{ cursor: bigint; bytes: Buffer }>;
};

/**
 * Bridges an authenticated federation peer to the canonical local runtime service.
 * Peer enrollment authenticates only the machine. A home-issued one-use capability grants
 * one peer access to one runtime generation and an explicit set of terminal actions.
 */
export function createTerminalRuntimeHandler(runtimeService: RoomsRuntimeService, homeAuthorityId: string, stateDir: string): RelayApplicationHandler {
  const streams = new Map<string, StreamState>();
  const signingKeys = loadMachineSigningKeys(stateDir);
  if (signingKeys.authorityId !== homeAuthorityId) throw new Error("terminal capability issuer does not match the runtime home authority");

  const actorFor = (connection: RelayConnection, capability: TerminalCapability): RuntimeActor => {
    const peer = connection.status().peerAuthorityId;
    if (!peer) throw new Error("terminal relay peer is not authenticated");
    return {
      sessionId: `federation:${peer}`,
      role: "worker",
      credentialId: `federation-capability:${capability.capabilityId}`,
      capability: {
        capabilityId: capability.capabilityId,
        runtimeId: capability.runtimeId,
        generation: capability.generation,
        sessionId: capability.sessionId,
        channelId: capability.channelId,
        actions: capability.actions,
        expiresAt: capability.expiresAt,
      },
    };
  };

  const assertCommon = (frame: { homeAuthorityId: string }, connection: RelayConnection): void => {
    if (frame.homeAuthorityId !== homeAuthorityId) throw new Error("wrong terminal home authority");
    if (connection.status().state !== "connected") throw new Error("terminal relay is not connected");
  };

  const assertCapability = (frame: Extract<RelayTerminalFrame, { kind: "terminalInput" | "terminalResize" }>, state: StreamState, connection: RelayConnection, action: TerminalCapabilityAction): void => {
    assertCommon(frame, connection);
    if (frame.capabilityId !== state.capability.capabilityId) throw new Error("terminal capability mismatch");
    if (frame.runtimeId !== state.runtimeId || frame.sessionId !== state.open.sessionId || frame.generation !== state.generation) throw new Error("stale terminal stream binding");
    if (!state.capability.actions.includes(action)) throw new Error("terminal capability action mismatch");
    if (Date.parse(state.capability.expiresAt) <= Date.now()) throw new Error("terminal capability expired");
  };

  const sendOutput = (state: StreamState, cursor: bigint, bytes: Buffer): void => {
    for (let offset = 0; offset < bytes.length; offset += MAX_RAW_OUTPUT_BYTES) {
      const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + MAX_RAW_OUTPUT_BYTES));
      state.connection.sendTerminal({ kind: "terminalOutput", streamId: state.open.streamId, homeAuthorityId: state.open.homeAuthorityId, sessionId: state.open.sessionId, runtimeId: state.runtimeId, generation: state.generation, outputCursor: (cursor + BigInt(offset)).toString(), bytes: chunk.toString("base64") });
    }
  };

  const detach = async (streamId: string): Promise<void> => {
    const state = streams.get(streamId);
    if (!state) return;
    streams.delete(streamId);
    await state.session.detach();
  };

  return {
    ...neutralRelayApplicationHandler,
    async handleTerminal(frame, connection) {
      if (frame.kind === "terminalOpen") {
        assertCommon(frame, connection);
        const peer = connection.status().peerAuthorityId;
        if (!peer) throw new Error("terminal relay peer is not authenticated");
        const capability = decodeTerminalCapability(frame.capability);
        verifyTerminalCapability({ capability, publicKey: signingKeys.publicKey, issuer: homeAuthorityId as AuthorityId, audience: peer, sessionId: frame.sessionId, mode: frame.mode });
        if (streams.has(frame.streamId)) throw new Error("duplicate terminal stream");
        const actor = actorFor(connection, capability);
        const runtime = runtimeService.resolveActiveSessionRuntime(frame.sessionId, actor, frame.mode === "controller" ? "controller" : "observe");
        if (runtime.runtimeId !== capability.runtimeId || runtime.generation !== capability.generation) throw new Error("stale terminal capability binding");
        if (runtimeService.federatedTerminalBindingChannel(runtime.runtimeId, runtime.generation) !== capability.channelId) throw new Error("terminal capability channel binding mismatch");
        if (runtime.homeAuthorityId !== frame.homeAuthorityId) throw new Error("session runtime is homed by another authority");
        runtimeService.consumeFederatedTerminalCapability({ runtimeId: runtime.runtimeId, generation: runtime.generation, capabilityId: capability.capabilityId, nonce: capability.nonce, expiresAt: capability.expiresAt });
        const pending: StreamState["pending"] = [];
        let state: StreamState | undefined;
        const session = await runtimeService.attachInteractive({ runtimeId: runtime.runtimeId, homeAuthorityId: runtime.homeAuthorityId, sessionId: runtime.sessionId, generation: runtime.generation, viewerId: `federation:${peer}`, mode: frame.mode, outputCursor: frame.outputCursor, leaseExpiresAt: capability.expiresAt }, actor, {
          onOutput: (output) => {
            const value = { cursor: output.cursor, bytes: Buffer.from(output.bytes) };
            if (!state?.ready) pending.push(value); else sendOutput(state, value.cursor, value.bytes);
          },
          onExit: (exit) => connection.sendTerminal({ kind: "terminalClose", streamId: frame.streamId, reason: `exit:${exit.code}` }),
          onError: (error) => connection.sendTerminal({ kind: "terminalClose", streamId: frame.streamId, reason: `host:${error.code}` }),
          onClose: () => { streams.delete(frame.streamId); },
        });
        state = { open: frame, capability, runtimeId: runtime.runtimeId, generation: runtime.generation, session, connection, ready: true, pending };
        streams.set(frame.streamId, state);
        if (session.hello.gap) connection.sendTerminal({ kind: "terminalGap", streamId: frame.streamId, homeAuthorityId: frame.homeAuthorityId, sessionId: frame.sessionId, runtimeId: runtime.runtimeId, generation: runtime.generation, replayFrom: session.hello.replayFrom.toString(), head: session.hello.head.toString() });
        connection.sendTerminal({ kind: "terminalOpenAck", streamId: frame.streamId, homeAuthorityId: frame.homeAuthorityId, sessionId: frame.sessionId, runtimeId: runtime.runtimeId, generation: runtime.generation, outputCursor: session.hello.head.toString() });
        for (const output of pending) sendOutput(state, output.cursor, output.bytes);
        pending.length = 0;
        return;
      }
      const state = streams.get(frame.streamId);
      if (!state) throw new Error("unknown terminal stream");
      if (state.connection !== connection) throw new Error("terminal stream belongs to another relay connection");
      if (frame.kind === "terminalInput") {
        assertCapability(frame, state, connection, "input");
        await state.session.input(Buffer.from(frame.bytes, "base64"));
        connection.sendTerminal({ kind: "terminalInputAck", streamId: frame.streamId, inputSeq: frame.inputSeq, outcome: "written" });
      } else if (frame.kind === "terminalResize") {
        assertCapability(frame, state, connection, "resize");
        await state.session.resize(frame.columns, frame.rows);
        connection.sendTerminal({ kind: "terminalResizeAck", streamId: frame.streamId });
      } else if (frame.kind === "terminalDetach") {
        assertCommon(frame, connection);
        await detach(frame.streamId);
        connection.sendTerminal({ kind: "terminalClose", streamId: frame.streamId, reason: "detached" });
      }
    },
    async connectionClosed() {
      await Promise.allSettled([...streams.keys()].map(detach));
    },
  };
}

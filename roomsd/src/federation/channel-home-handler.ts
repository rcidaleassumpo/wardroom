// SPDX-License-Identifier: Apache-2.0
import { Buffer } from "node:buffer";
import type { RoomsApplication } from "../domain/application.js";
import type { Change, RoomsRepository } from "../storage/repository.js";
import { encodeProviderSubmission, type RoomsRuntimeService } from "../runtime/service.js";
import type { RuntimeActor } from "../runtime/contracts.js";
import type { RelayApplicationHandler, RelayConnection } from "./relay-connection.js";
import type { RelayChannelFrame } from "./relay-protocol.js";
import { stampRoomsProvenance } from "../domain/message-provenance.js";
import { sendChannelResult } from "./channel-result.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const MAX_BODY_BYTES = 64 * 1024;
const MESSAGE_PAGE_LIMIT = 20;
const MESSAGE_PAGE_BYTES = 64 * 1024;

function decodePayload(encoded: string): Record<string, Json> {
  const raw = Buffer.from(encoded, "base64").toString("utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("channel payload must be an object");
  return parsed as Record<string, Json>;
}

function requiredString(value: Json | undefined, field: string, max = 512): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > max) throw new Error(`invalid ${field}`);
  return value;
}

function canonicalRemoteSession(peerAuthorityId: string, localSessionId: string): string {
  return `federation:${peerAuthorityId}:${localSessionId}`;
}

/**
 * Adds durable channel routing to the terminal relay handler. The receiving daemon is
 * authoritative only for channels whose homeAuthorityId is its own identity. Remote
 * session ids are namespaced by the authenticated peer, so a peer cannot impersonate a
 * session belonging to this or another machine. The channel owner must also maintain an
 * active channel-and-peer admission before registration or channel data access succeeds.
 */
export function withChannelHomeRouting(input: {
  base: RelayApplicationHandler;
  database: RoomsRepository;
  application: RoomsApplication;
  runtimeService: RoomsRuntimeService;
  homeAuthorityId: string;
}): RelayApplicationHandler {
  const reply = (connection: RelayConnection, requestId: string, ok: boolean, value: unknown): void => {
    sendChannelResult(connection, requestId, ok, value);
  };

  const deliverLocalRuntimes = async (event: { id: string; body: string; deliveredRecipientSessionIds?: string[] }, actor: RuntimeActor): Promise<void> => {
    for (const recipient of event.deliveredRecipientSessionIds ?? []) {
      // Federated recipients consume the canonical event from their home peer. Only
      // runtimes physically hosted by this Rooms daemon are injected here.
      if (recipient.startsWith("federation:")) continue;
      try {
        const runtime = input.runtimeService.resolveCanonicalMessageRecipientRuntime(recipient, event.id);
        const submission = encodeProviderSubmission(event.body);
        await input.runtimeService.deliverMessage({ runtimeId: runtime.runtimeId, generation: runtime.generation, messageId: event.id, frames: submission.frames, delaysMs: submission.delaysMs }, actor);
      } catch (error) {
        if ((error as { code?: string }).code !== "runtimeNotFound") throw error;
      }
    }
  };

  return {
    ...input.base,
    async handleChannel(frame: RelayChannelFrame, connection: RelayConnection): Promise<void> {
      if (frame.kind === "channelResult") {
        await input.base.handleChannel?.(frame, connection);
        return;
      }
      const peer = connection.status().peerAuthorityId;
      if (!peer || connection.status().state !== "connected") throw new Error("channel relay peer is not authenticated");
      if (frame.homeAuthorityId !== input.homeAuthorityId) throw new Error("channel is homed by another authority");
      const actorSessionId = canonicalRemoteSession(peer, frame.actorSessionId);
      const payload = decodePayload(frame.payload);
      try {
        if (frame.operation === "register") {
          const channelId = requiredString(payload.channelId, "channelId", 256);
          if (!input.database.isFederatedPeerAdmitted(channelId, peer)) throw new Error("federation peer is not admitted to this channel");
          const existing = input.database.currentSession(actorSessionId);
          const registered = input.database.registerSession(channelId, actorSessionId, "worker", `federation:${peer}`);
          reply(connection, frame.requestId, true, { sessionId: actorSessionId, channelId, joined: true, registered: !existing, idempotent: registered.idempotent, cursor: input.database.currentCursor() });
          return;
        }
        if (frame.operation === "directSend") {
          const targetSessionId = requiredString(payload.targetSessionId, "targetSessionId", 512);
          const target = input.database.currentSession(targetSessionId);
          if (!target || target.endedAt) throw new Error("unknown Rooms recipient session");
          const body = stampRoomsProvenance(actorSessionId, requiredString(payload.body, "body", MAX_BODY_BYTES));
          if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw new Error("invalid body");
          // Direct delivery is global across Rooms channels. The authenticated
          // peer and authority-namespaced actor establish provenance; requiring
          // sender and recipient to share a channel would make cross-channel
          // direct messages fail even though the local direct-send contract
          // permits them. Keep the canonical event channel-less and inject only
          // the exact local target runtime.
          const receipt = input.application.commitMessage({ channelId: null, senderSessionId: actorSessionId, body, target: { kind: "direct", sessionId: targetSessionId, sessionIds: [targetSessionId] }, replyToEventId: payload.replyToEventId as string | undefined, correlation: payload.correlation });
          const event = receipt.event as { id: string; body: string; deliveredRecipientSessionIds?: string[] };
          await deliverLocalRuntimes(event, { sessionId: actorSessionId, role: "worker", credentialId: `federation:${peer}` });
          reply(connection, frame.requestId, true, { event, cursor: receipt.cursor, wasDeduplicated: receipt.wasDeduplicated ?? false });
          return;
        }
        const actor = input.database.currentSession(actorSessionId);
        if (!actor || actor.endedAt || !actor.role) throw new Error("remote session is not active");
        const context = { credentialId: `federation:${peer}`, actorSessionId, role: actor.role };
        const channelId = requiredString(payload.channelId, "channelId", 256);
        if (!input.database.isActiveMember(channelId, actorSessionId)) throw new Error("remote session is not an active channel member");
        if (frame.operation === "leave") {
          const receipt = input.application.leave(channelId, actorSessionId, context);
          reply(connection, frame.requestId, true, { cursor: receipt.cursor });
          return;
        }
        if (!input.database.isFederatedPeerAdmitted(channelId, peer)) throw new Error("federation peer admission is not active");
        if (frame.operation === "snapshot") {
          reply(connection, frame.requestId, true, input.database.snapshot(channelId));
          return;
        }
        if (frame.operation === "messages") {
          const afterCursor = typeof payload.afterCursor === "string" ? payload.afterCursor : "0";
          const changes = input.database.replayChannelMessages(afterCursor, channelId, MESSAGE_PAGE_LIMIT + 1);
          reply(connection, frame.requestId, true, channelMessagePage(changes, afterCursor));
          return;
        }
        const body = stampRoomsProvenance(actorSessionId, requiredString(payload.body, "body", MAX_BODY_BYTES));
        if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw new Error("invalid body");
        const recipientIds = input.database.roster(channelId).map((member: any) => member.sessionId as string).filter((id) => id !== actorSessionId);
        const receipt = input.application.commitMessage({ channelId, senderSessionId: actorSessionId, body, target: { kind: "broadcast", sessionIds: recipientIds }, replyToEventId: payload.replyToEventId as string | undefined, correlation: payload.correlation });
        const event = receipt.event as { id: string; body: string; deliveredRecipientSessionIds?: string[] };
        await deliverLocalRuntimes(event, { sessionId: actorSessionId, role: actor.role, credentialId: `federation:${peer}` });
        reply(connection, frame.requestId, true, { event, cursor: receipt.cursor, wasDeduplicated: receipt.wasDeduplicated ?? false });
      } catch (error) {
        reply(connection, frame.requestId, false, { code: (error as { code?: string }).code ?? "channelCommandFailed", message: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}

export function channelMessagePage(changes: readonly Change[], afterCursor: string): Readonly<{ cursor: string; messages: unknown[]; hasMore: boolean }> {
  const page: Change[] = [];
  for (const change of changes.slice(0, MESSAGE_PAGE_LIMIT)) {
    const candidate = [...page, change];
    const bytes = Buffer.byteLength(JSON.stringify({ cursor: change.cursor, messages: candidate.map(item => item.payload), hasMore: true }), "utf8");
    if (page.length > 0 && bytes > MESSAGE_PAGE_BYTES) break;
    page.push(change);
  }
  return {
    cursor: page.at(-1)?.cursor ?? afterCursor,
    messages: page.map(change => change.payload),
    hasMore: changes.length > page.length,
  };
}

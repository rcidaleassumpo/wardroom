import { describe, expect, it, vi } from "vitest";
import { ChannelResultAssembler, sendChannelResult } from "../src/federation/channel-result.js";
import { encodeNextSequencedRelayFrame } from "../src/federation/relay-connection.js";
import type { RelayConnection } from "../src/federation/relay-connection.js";
import type { RelayChannelFrame } from "../src/federation/relay-protocol.js";
import { channelMessagePage, withChannelHomeRouting } from "../src/federation/channel-home-handler.js";
import type { Change } from "../src/domain/contracts.js";
import { RoomsRepository } from "../src/storage/repository.js";
import { RoomsApplication } from "../src/domain/application.js";

const connectionId = "00000000-0000-0000-0000-000000000001";

function assembledResult(sent: unknown[]): ReturnType<ChannelResultAssembler["accept"]> {
  const assembler = new ChannelResultAssembler();
  let assembled;
  for (const [index, frame] of sent.entries()) {
    assembled = assembler.accept({ ...(frame as object), connectionId, direction: "responderToInitiator", seq: index + 1 } as RelayChannelFrame);
  }
  return assembled;
}

describe("federated channel result framing", () => {
  it("chunks and reconstructs a logical result larger than one relay payload", () => {
    const sent: Array<Omit<Extract<RelayChannelFrame, { kind: "channelResult" }>, "connectionId" | "direction" | "seq">> = [];
    const connection = { sendChannel: (frame: typeof sent[number]) => sent.push(frame) } as unknown as RelayConnection;
    const value = { messages: [{ body: "x".repeat(24_000) }] };
    sendChannelResult(connection, "request-1", true, value);
    expect(sent.length).toBeGreaterThan(1);

    const assembler = new ChannelResultAssembler();
    let assembled;
    for (const [index, frame] of sent.entries()) {
      assembled = assembler.accept({ ...frame, connectionId, direction: "responderToInitiator", seq: index + 1 });
    }
    expect(assembled).toEqual({ ok: true, value });
  });

  it("rejects missing or reordered chunks", () => {
    const assembler = new ChannelResultAssembler();
    expect(() => assembler.accept({ kind: "channelResult", connectionId, direction: "responderToInitiator", seq: 1, requestId: "request-1", ok: true, chunkIndex: 1, final: true, payload: Buffer.from("{}").toString("base64") })).toThrow("invalid channel result chunk sequence");
  });

  it("does not consume a relay sequence when strict encoding rejects a frame", () => {
    expect(() => encodeNextSequencedRelayFrame(0, (seq) => ({ kind: "echoRequest", connectionId, direction: "initiatorToResponder", seq, payload: "x".repeat(20_000) }))).toThrow();
    const encoded = encodeNextSequencedRelayFrame(0, (seq) => ({ kind: "echoRequest", connectionId, direction: "initiatorToResponder", seq, payload: "ok" }));
    expect(encoded.seq).toBe(1);
  });

  it("bounds a channel replay page and advertises the remaining history", () => {
    const changes = Array.from({ length: 21 }, (_, index) => ({
      cursor: String(index + 1), kind: "message.sent", channelId: "channel-a",
      occurredAt: new Date(index * 1_000).toISOString(),
      payload: { id: `event-${index}`, body: "x".repeat(4_000), deliveredRecipientSessionIds: ["recipient"], occurredAt: new Date(index * 1_000).toISOString() },
    })) as unknown as Change[];
    const page = channelMessagePage(changes, "0");
    expect(page.messages.length).toBeGreaterThan(0);
    expect(page.messages.length).toBeLessThan(21);
    expect(page.hasMore).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(128 * 1024);
  });

  it("accepts an authenticated federated direct send across channel boundaries", async () => {
    const database = new RoomsRepository(":memory:");
    try {
      const peerAuthorityId = "authority-peer";
      const remoteActor = `federation:${peerAuthorityId}:remote-actor`;
      database.insertSession({ id: "local-target", role: "worker" });
      const root = database.commitMessage({
        channelId: null,
        senderSessionId: "local-target",
        body: "root",
        target: { kind: "direct", sessionId: "local-target", sessionIds: ["local-target"] },
      }).event as { id: string };
      const sent: unknown[] = [];
      const connection = {
        status: () => ({ state: "connected", peerAuthorityId }),
        sendChannel: (frame: unknown) => sent.push(frame),
      } as unknown as RelayConnection;
      const legacyOperatorResolution = vi.fn();
      const handler = withChannelHomeRouting({
        base: {},
        database,
        application: new RoomsApplication(database),
        runtimeService: {
          resolveCanonicalMessageRecipientRuntime: () => { throw Object.assign(new Error("missing"), { code: "runtimeNotFound" }); },
          resolveActiveSessionRuntime: legacyOperatorResolution,
        } as never,
        homeAuthorityId: "authority-home",
      });
      await handler.handleChannel?.({
        kind: "channelCommand", connectionId, direction: "initiatorToResponder", seq: 1,
        requestId: "request-direct", homeAuthorityId: "authority-home", operation: "directSend",
        actorSessionId: "remote-actor",
        payload: Buffer.from(JSON.stringify({ targetSessionId: "local-target", body: "hello", replyToEventId: root.id }), "utf8").toString("base64"),
      }, connection);
      const event = database.replay("0").filter((change) => change.kind === "message.sent").at(-1);
      expect(event?.channelId).toBeNull();
      expect(event?.payload).toMatchObject({ senderSessionId: remoteActor, body: "@remote-actor hello", deliveredRecipientSessionIds: ["local-target"], replyToEventId: root.id, threadRootEventId: root.id });
      expect(legacyOperatorResolution).not.toHaveBeenCalled();
      expect(sent.length).toBeGreaterThan(0);
    } finally { database.close(); }
  });

  it("rejects unauthenticated peers and commands addressed to another channel home", async () => {
    const database = new RoomsRepository(":memory:");
    try {
      const handler = withChannelHomeRouting({
        base: {}, database, application: new RoomsApplication(database), runtimeService: {} as never, homeAuthorityId: "authority-home",
      });
      const command = {
        kind: "channelCommand", connectionId, direction: "initiatorToResponder", seq: 1,
        requestId: "request-auth", homeAuthorityId: "authority-home", operation: "snapshot",
        actorSessionId: "remote-actor", payload: Buffer.from(JSON.stringify({ channelId: "channel-a" })).toString("base64"),
      } as const;
      const unauthenticated = { status: () => ({ state: "authenticating", peerAuthorityId: null }), sendChannel: vi.fn() } as unknown as RelayConnection;
      await expect(handler.handleChannel?.(command, unauthenticated)).rejects.toThrow("not authenticated");
      expect(unauthenticated.sendChannel).not.toHaveBeenCalled();

      const authenticated = { status: () => ({ state: "connected", peerAuthorityId: "authority-peer" }), sendChannel: vi.fn() } as unknown as RelayConnection;
      await expect(handler.handleChannel?.({ ...command, homeAuthorityId: "authority-other" }, authenticated)).rejects.toThrow("homed by another authority");
      expect(authenticated.sendChannel).not.toHaveBeenCalled();
    } finally { database.close(); }
  });

  it("denies channel state and messages to an authenticated peer without membership", async () => {
    const database = new RoomsRepository(":memory:");
    try {
      const peerAuthorityId = "authority-peer";
      database.insertChannel({ id: "channel-a" });
      database.insertSession({ id: `federation:${peerAuthorityId}:remote-actor`, role: "worker", externalId: `federation:${peerAuthorityId}` });
      const cursor = database.currentCursor();
      const sent: unknown[] = [];
      const connection = { status: () => ({ state: "connected", peerAuthorityId }), sendChannel: (frame: unknown) => sent.push(frame) } as unknown as RelayConnection;
      const handler = withChannelHomeRouting({ base: {}, database, application: new RoomsApplication(database), runtimeService: {} as never, homeAuthorityId: "authority-home" });
      await handler.handleChannel?.({
        kind: "channelCommand", connectionId, direction: "initiatorToResponder", seq: 1,
        requestId: "request-snapshot", homeAuthorityId: "authority-home", operation: "snapshot",
        actorSessionId: "remote-actor", payload: Buffer.from(JSON.stringify({ channelId: "channel-a" })).toString("base64"),
      }, connection);
      expect(assembledResult(sent)).toEqual({ ok: false, value: { code: "channelCommandFailed", message: "remote session is not an active channel member" } });
      expect(database.currentCursor()).toBe(cursor);
    } finally { database.close(); }
  });

  it("namespaces registered remote actors to the authenticated peer and grants only worker authority", async () => {
    const database = new RoomsRepository(":memory:");
    try {
      database.insertSession({ id: "owner", role: "operator" });
      database.insertChannel({ id: "channel-a", ownerOperatorSessionId: "owner" });
      database.insertSession({ id: "shared-name", role: "operator" });
      const handler = withChannelHomeRouting({ base: {}, database, application: new RoomsApplication(database), runtimeService: {} as never, homeAuthorityId: "authority-home" });
      for (const peerAuthorityId of ["authority-a", "authority-b"]) {
        database.grantFederatedChannelAdmission("channel-a", peerAuthorityId, "owner");
        const sent: unknown[] = [];
        const connection = { status: () => ({ state: "connected", peerAuthorityId }), sendChannel: (frame: unknown) => sent.push(frame) } as unknown as RelayConnection;
        await handler.handleChannel?.({
          kind: "channelCommand", connectionId, direction: "initiatorToResponder", seq: 1,
          requestId: `request-register-${peerAuthorityId}`, homeAuthorityId: "authority-home", operation: "register",
          actorSessionId: "shared-name", payload: Buffer.from(JSON.stringify({ channelId: "channel-a" })).toString("base64"),
        }, connection);
        expect(assembledResult(sent)).toMatchObject({ ok: true, value: { sessionId: `federation:${peerAuthorityId}:shared-name`, channelId: "channel-a" } });
        expect(database.currentSession(`federation:${peerAuthorityId}:shared-name`)).toMatchObject({ role: "worker" });
        expect(database.sessionsForExternalId(`federation:${peerAuthorityId}`)).toEqual([`federation:${peerAuthorityId}:shared-name`]);
      }
      expect(database.currentSession("shared-name")).toMatchObject({ role: "operator" });
    } finally { database.close(); }
  });

  it("requires owner admission before registration and rechecks it before channel data access", async () => {
    const database = new RoomsRepository(":memory:");
    try {
      const peerAuthorityId = "authority-peer";
      database.insertSession({ id: "owner", role: "operator" });
      database.insertChannel({ id: "channel-a", ownerOperatorSessionId: "owner" });
      const sent: unknown[] = [];
      const connection = { status: () => ({ state: "connected", peerAuthorityId }), sendChannel: (frame: unknown) => sent.push(frame) } as unknown as RelayConnection;
      const handler = withChannelHomeRouting({ base: {}, database, application: new RoomsApplication(database), runtimeService: {} as never, homeAuthorityId: "authority-home" });
      const command = (operation: "register" | "snapshot", requestId: string) => ({
        kind: "channelCommand", connectionId, direction: "initiatorToResponder", seq: 1,
        requestId, homeAuthorityId: "authority-home", operation,
        actorSessionId: "remote-actor", payload: Buffer.from(JSON.stringify({ channelId: "channel-a" })).toString("base64"),
      } as const);

      await handler.handleChannel?.(command("register", "request-denied"), connection);
      expect(assembledResult(sent.splice(0))).toEqual({ ok: false, value: { code: "channelCommandFailed", message: "federation peer is not admitted to this channel" } });
      expect(database.currentSession(`federation:${peerAuthorityId}:remote-actor`)).toBeNull();

      database.grantFederatedChannelAdmission("channel-a", peerAuthorityId, "owner");
      await handler.handleChannel?.(command("register", "request-admitted"), connection);
      expect(assembledResult(sent.splice(0))).toMatchObject({ ok: true });

      database.updateChannelLabel("channel-a", "Shared investigation");
      await handler.handleChannel?.(command("snapshot", "request-labeled"), connection);
      expect(assembledResult(sent.splice(0))).toMatchObject({
        ok: true,
        value: { channel: { id: "channel-a", label: "Shared investigation" } },
      });

      database.revokeFederatedChannelAdmission("channel-a", peerAuthorityId, "owner");
      await handler.handleChannel?.(command("snapshot", "request-revoked"), connection);
      expect(assembledResult(sent)).toEqual({ ok: false, value: { code: "channelCommandFailed", message: "federation peer admission is not active" } });
    } finally { database.close(); }
  });
});

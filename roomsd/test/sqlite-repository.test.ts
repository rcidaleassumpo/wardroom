import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RoomsApplication, RoomsCommandError, RoomsRepository, RoomsStoreError } from "../src/index.js";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "rooms-ts-"));
  const store = new RoomsRepository(join(dir, "rooms.sqlite"));
  return { store, dir };
}

describe("SQLite Rooms repository", () => {
  it("creates WAL schema with foreign keys and forward user_version", () => {
    const { store, dir } = tempStore();
    try {
      expect(store.pragma("journal_mode")).toBe("wal");
      expect(store.pragma("foreign_keys")).toBe(1);
      expect(store.userVersion()).toBeGreaterThanOrEqual(1);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("commits canonical mutations with monotonic cursors and stable snapshots", () => {
    const { store, dir } = tempStore();
    try {
      const app = new RoomsApplication(store);
      const auth = { credentialId: "cred", actorSessionId: "operator", role: "operator" as const };
      const session = app.registerSession({ id: "operator" }, auth);
      const channel = app.registerChannel({ id: "build" }, auth);
      app.join("build", "operator", auth);
      expect(session.cursor).toMatch(/^1$/);
      expect(channel.cursor).toMatch(/^2$/);
      expect(store.snapshot("build")).toEqual({
        cursor: "3", channel: expect.objectContaining({ id: "build" }),
        sessions: [expect.objectContaining({ id: "operator" })], memberships: [expect.objectContaining({ sessionId: "operator" })], events: []
      });
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("enforces server-owned preconditions inside the write transaction", () => {
    const { store, dir } = tempStore();
    try {
      const app = new RoomsApplication(store);
      const operator = { credentialId: "cred", actorSessionId: "operator", role: "operator" as const };
      app.registerSession({ id: "operator" }, operator);
      app.registerSession({ id: "worker" }, { credentialId: "cred2", actorSessionId: "worker", role: "worker" });
      app.registerChannel({ id: "build" }, operator);
      expect(() => app.join("build", "worker", operator)).toThrow(RoomsCommandError);
      expect(() => app.endSession("operator", operator)).not.toThrow();
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("reopens without losing history and replays after a cursor", () => {
    const { store, dir } = tempStore();
    const path = join(dir, "rooms.sqlite");
    try {
      const app = new RoomsApplication(store);
      const auth = { credentialId: "cred", actorSessionId: "operator", role: "operator" as const };
      app.registerSession({ id: "operator" }, auth);
      const first = app.registerChannel({ id: "build" }, auth);
      store.close();
      const reopened = new RoomsRepository(path);
      const next = new RoomsApplication(reopened).registerSession({ id: "worker" }, { credentialId: "cred2", actorSessionId: "worker", role: "worker" });
      expect(next.cursor).toBe("3");
      expect(reopened.replay(first.cursor).map((change) => change.cursor)).toEqual(["3"]);
      reopened.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("replays only bounded messages from the requested federated channel", () => {
    const { store, dir } = tempStore();
    try {
      store.insertSession({ id: "sender", role: "worker" });
      store.insertSession({ id: "recipient", role: "worker" });
      store.insertChannel({ id: "channel-a" });
      store.insertChannel({ id: "channel-b" });
      store.commitMessage({ channelId: null, senderSessionId: "sender", body: "global", target: { kind: "direct", sessionId: "recipient" } });
      store.commitMessage({ channelId: "channel-b", senderSessionId: "sender", body: "other", target: { kind: "broadcast", sessionIds: ["recipient"] } });
      store.commitMessage({ channelId: "channel-a", senderSessionId: "sender", body: "first", target: { kind: "broadcast", sessionIds: ["recipient"] } });
      store.commitMessage({ channelId: "channel-a", senderSessionId: "sender", body: "second", target: { kind: "broadcast", sessionIds: ["recipient"] } });

      expect(store.replayChannelMessages("0", "channel-a", 1).map((change) => (change.payload as { body: string }).body)).toEqual(["first"]);
      expect(store.replayChannelMessages("0", "channel-a", 10).map((change) => (change.payload as { body: string }).body)).toEqual(["first", "second"]);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("does not mark a runtime-less recipient delivered", () => {
    const { store, dir } = tempStore();
    try {
      store.insertSession({ id: "sender", role: "worker" });
      store.insertSession({ id: "recipient", role: "worker" });
      const receipt = store.commitMessage({
        channelId: null, senderSessionId: "sender", body: "hello",
        target: { kind: "direct", sessionId: "recipient" },
        deliveryStatuses: { recipient: "undeliverable" },
      });
      expect(receipt.event).toMatchObject({ deliveredRecipientSessionIds: [], recipientStatuses: { recipient: "undeliverable" } });
      expect(store.replay()[2]?.payload).toMatchObject({ deliveredRecipientSessionIds: [] });
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("folds delivery events without rewriting replay history", () => {
    const { store, dir } = tempStore();
    try {
      store.insertSession({ id: "sender", role: "worker" });
      store.insertSession({ id: "recipient", role: "worker" });
      store.insertChannel({ id: "build" });
      const sent = store.commitMessage({ channelId: "build", senderSessionId: "sender", body: "hello", target: { kind: "direct", sessionId: "recipient" }, deliveryStatuses: { recipient: "queued" } });
      const sentPayload = JSON.stringify(sent.event);
      store.appendMessageDelivery((sent.event as any).id, { recipient: "delivered" });
      expect(JSON.stringify(store.replay("0")[3]?.payload)).toBe(sentPayload);
      expect(store.snapshot("build").events).toEqual([expect.objectContaining({ id: (sent.event as any).id, recipientStatuses: { recipient: "delivered" } })]);
      expect(store.listMessages("recipient", "0", "build").messages).toEqual([expect.objectContaining({ message: expect.objectContaining({ recipientStatuses: { recipient: "delivered" } }) })]);
      expect(store.replay(sent.cursor, "build").map((change) => change.kind)).toEqual(["message.delivery"]);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("imports lossless canonical events in one transaction and rejects duplicate digests", () => {
    const { store, dir } = tempStore();
    try {
      store.begin("sha256:fixture", 3);
      expect(() => store.append({
        kind: "message.sent", channelId: null, sourceOrdinal: 17,
        occurredAt: "2024-01-02T03:04:05.000Z",
        payload: { id: "legacy-event", target: { kind: "directToSession", sessionID: "worker" }, deliveredRecipientSessionIDs: ["worker"], body: "#build hello" }
      })).toThrow(RoomsStoreError);
      expect(() => store.commit()).toThrow(RoomsStoreError);
      store.rollback();
      expect(store.replay()).toEqual([]);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("rolls back imported records and digest metadata together", () => {
    const { store, dir } = tempStore();
    try {
      store.begin("sha256:rollback", 1);
      expect(() => store.append({ kind: "legacy.unknown", channelId: null, sourceOrdinal: 0, occurredAt: "2024-01-01T00:00:00.000Z", payload: { raw: "preserved" } })).toThrow(RoomsStoreError);
      store.rollback();
      expect(store.replay()).toEqual([]);
      store.begin("sha256:rollback", 1);
      store.rollback();
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("materializes canonical session/channel/membership history on a fresh target", () => {
    const { store, dir } = tempStore();
    try {
      store.begin("sha256:materialized", 14);
      expect(() => store.append({ kind: "session.registered", channelId: null, sourceOrdinal: 0, occurredAt: "2024-01-01T00:00:00.000Z", payload: { id: "operator" } })).toThrow(RoomsStoreError);
      store.rollback();
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps cursors opaque above MAX_SAFE_INTEGER", () => {
    const { store, dir } = tempStore();
    try {
      store.insertSession({ id: "seed", role: "worker" });
      store.db.exec("UPDATE sqlite_sequence SET seq = 9007199254740991 WHERE name = 'changes'");
      const receipt = store.insertSession({ id: "large-cursor", role: "worker" });
      expect(receipt.cursor).toBe("9007199254740992");
      expect(store.replay("9007199254740991").at(-1)?.cursor).toBe(receipt.cursor);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("fails closed on a future schema version", () => {
    const { store, dir } = tempStore();
    store.close();
    const path = join(dir, "rooms.sqlite");
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version=99");
    db.close();
    expect(() => new RoomsRepository(path)).toThrow(/unsupported Rooms schema version/);
    rmSync(dir, { recursive: true, force: true });
  });
});

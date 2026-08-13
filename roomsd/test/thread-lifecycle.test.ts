import { describe, expect, it } from "vitest";
import { RoomsRepository, RoomsStoreError } from "../src/storage/repository.js";

describe("canonical thread lifecycle", () => {
  it("rejects replies after resolve until an active member reopens the root", () => {
    const store = new RoomsRepository();
    try {
      store.insertSession({ id: "operator", role: "operator", deliveryMode: "log" });
      store.insertSession({ id: "worker", role: "worker" });
      store.insertChannel({ id: "proof", ownerOperatorSessionId: "operator" });
      store.insertMembership("proof", "operator", "operator");
      store.insertMembership("proof", "worker", "worker");
      const root = store.commitMessage({ channelId: "proof", senderSessionId: "worker", body: "root", target: { kind: "broadcast", sessionIds: ["operator"] } }).event as { id: string };

      expect(store.threadLifecycle(root.id, "proof")).toMatchObject({ threadRootEventId: root.id, state: "open", updatedAt: null });
      expect(store.resolveThread(root.id, "operator", "proof").thread).toMatchObject({ state: "resolved", resolvedBySessionId: "operator" });
      expect(() => store.commitMessage({ channelId: "proof", senderSessionId: "worker", body: "late reply", target: { kind: "broadcast", sessionIds: ["operator"] }, replyToEventId: root.id }))
        .toThrowError(expect.objectContaining({ code: "threadResolved" }));

      expect(store.reopenThread(root.id, "worker", "proof").thread).toMatchObject({ state: "open", reopenedBySessionId: "worker" });
      expect(store.commitMessage({ channelId: "proof", senderSessionId: "worker", body: "new reply", target: { kind: "broadcast", sessionIds: ["operator"] }, replyToEventId: root.id }).event)
        .toMatchObject({ replyToEventId: root.id, threadRootEventId: root.id });
    } finally {
      store.close();
    }
  });

  it("keeps lifecycle authority on root events and active channel members", () => {
    const store = new RoomsRepository();
    try {
      store.insertSession({ id: "member", role: "worker" });
      store.insertSession({ id: "outsider", role: "worker" });
      store.insertChannel({ id: "proof" });
      store.insertMembership("proof", "member", "worker");
      const root = store.commitMessage({ channelId: "proof", senderSessionId: "member", body: "root", target: { kind: "broadcast", sessionIds: [] } }).event as { id: string };
      const child = store.commitMessage({ channelId: "proof", senderSessionId: "member", body: "child", target: { kind: "broadcast", sessionIds: [] }, replyToEventId: root.id }).event as { id: string };

      expect(() => store.resolveThread(child.id, "member", "proof")).toThrowError(expect.objectContaining({ code: "notThreadRoot" }));
      expect(() => store.resolveThread(root.id, "outsider", "proof")).toThrowError(RoomsStoreError);
    } finally {
      store.close();
    }
  });
});

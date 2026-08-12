import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeComposition } from "../src/runtime/native/composition.js";
import { setupMachineIdentity } from "../src/identity/machine-identity.js";

describe("GetEvents reconciled contract", () => {
  it("honors the legacy event boundary and session paging fields", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-get-events-contract-"));
    setupMachineIdentity(stateDir);
    const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
    try {
      for (const id of ["sender", "target"]) composition.database.insertSession({ id });
      composition.database.insertChannel({ id: "proof" });
      const first = composition.database.commitMessage({
        channelId: "proof", senderSessionId: "sender", body: "first",
        target: { kind: "direct", sessionId: "target", sessionIds: ["target"] },
        deliveryStatuses: { target: "delivered" },
      }).event as { id: string };
      composition.database.commitMessage({
        channelId: "proof", senderSessionId: "sender", body: "second",
        target: { kind: "direct", sessionId: "target", sessionIds: ["target"] },
        deliveryStatuses: { target: "delivered" },
      });

      const afterEvent = await composition.handler.getEvents({ channelId: "proof", afterEventId: first.id });
      expect(afterEvent.events.map((event) => event.body)).toEqual(["second"]);
      expect(afterEvent.hasMore).toBe(false);

      const sessionPage = await composition.handler.getEvents({ channelId: "proof", sessionId: "target", limit: 1 });
      expect(sessionPage.events.map((event) => event.body)).toEqual(["second"]);
      expect(sessionPage.hasMore).toBe(true);
    } finally {
      composition.database.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("bounds search, orders newest first, and validates scope and limit", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-search-contract-"));
    setupMachineIdentity(stateDir);
    const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
    try {
      composition.database.insertSession({ id: "sender" });
      for (const channelId of ["one", "two"]) composition.database.insertChannel({ id: channelId });
      for (const [channelId, body] of [["one", "match-old"], ["two", "match-other"], ["one", "match-new"]]) {
        composition.database.commitMessage({
          channelId, senderSessionId: "sender", body,
          target: { kind: "direct", sessionId: "sender", sessionIds: ["sender"] },
          deliveryStatuses: { sender: "delivered" },
        });
      }

      const page = await composition.handler.search({ query: "match", scope: "channel", channelId: "one", limit: 1 });
      expect(page.events.map((event) => event.body)).toEqual(["match-new"]);
      const all = await composition.handler.search({ query: "match", scope: "all", limit: 50 });
      expect(all.events.map((event) => event.body)).toEqual(["match-new", "match-other", "match-old"]);
      await expect(composition.handler.search({ query: "match", scope: "channel", limit: 1 })).rejects.toThrow("channel search requires channelId");
      await expect(composition.handler.search({ query: "match", scope: "all", limit: 501 })).rejects.toThrow("between 1 and 500");
    } finally {
      composition.database.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("fails a Watch stream when 128 pending deltas do not drain", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-watch-backpressure-"));
    setupMachineIdentity(stateDir);
    const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
    try {
      composition.database.insertSession({ id: "sender" });
      composition.database.insertChannel({ id: "proof" });
      const cursor = composition.database.snapshot("proof").cursor;
      const iterator = composition.handler.watch({ channelId: "proof", afterCursor: cursor })[Symbol.asyncIterator]();
      const pending = iterator.next();
      for (let index = 0; index < 129; index += 1) {
        composition.database.commitMessage({
          channelId: "proof", senderSessionId: "sender", body: `message-${index}`,
          target: { kind: "direct", sessionId: "sender", sessionIds: ["sender"] },
          deliveryStatuses: { sender: "delivered" },
        });
      }
      await expect(pending).rejects.toThrow("watch buffered more than 128 deltas");
    } finally {
      composition.database.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

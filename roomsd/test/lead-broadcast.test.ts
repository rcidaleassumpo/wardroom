import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setupMachineIdentity } from "../src/identity/machine-identity.js";
import { createNativeComposition } from "../src/runtime/native/composition.js";
import { runRoomsCLI } from "../src/cli/main.js";

describe("lead-scoped multi-channel broadcast", () => {
  it("returns per-channel results, resolves current leads, deduplicates success, and retries only failure", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-lead-broadcast-"));
    try {
      setupMachineIdentity(stateDir);
      const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
      const db = composition.database;
      db.insertSession({ id: "operator", role: "operator", deliveryMode: "log" });
      db.insertSession({ id: "lead-a-old", role: "planner" });
      db.insertSession({ id: "lead-a", role: "planner" });
      db.insertSession({ id: "lead-b", role: "planner" });
      db.insertSession({ id: "lead-c", role: "planner" });
      db.insertSession({ id: "lead-missing", role: "planner" });
      db.insertSession({ id: "other-owner", role: "operator" });
      for (const [channelId, owner] of [["alpha", "operator"], ["beta", "operator"], ["gamma", "operator"], ["missing", "operator"], ["private", "other-owner"]] as const) {
        db.insertChannel({ id: channelId, ownerOperatorSessionId: owner });
      }
      db.insertMembership("alpha", "operator", "operator");
      db.insertMembership("beta", "operator", "operator");
      db.insertMembership("missing", "operator", "operator");
      db.insertMembership("gamma", "operator", "operator");
      db.insertMembership("alpha", "lead-a-old", "planner");
      db.leaveMembership("alpha", "lead-a-old");
      db.insertMembership("alpha", "lead-a", "planner");
      db.insertMembership("beta", "lead-b", "planner");
      db.insertMembership("missing", "lead-missing", "planner");
      db.insertMembership("gamma", "lead-c", "planner");

      const connection = { authenticatedSessionId: "operator", credentials: new Map([["credential", "operator"]]), onClose: new Set<() => void>() };
      const authenticated = { context: { credential: "credential" }, __connection: connection };
      const available = new Set(["lead-a"]);
      const failed = new Set(["lead-c"]);
      const deliveries: Array<{ sessionId: string; messageId: string }> = [];
      composition.runtimeService.resolveActiveSessionRuntimeForDelivery = ((sessionId: string, actor: any) => {
        if (failed.has(sessionId)) throw Object.assign(new Error(`${sessionId} transport broke`), { code: "transportBroken" });
        if (!available.has(sessionId)) throw Object.assign(new Error(`${sessionId} offline`), { code: "runtimeNotFound" });
        return { runtime: { runtimeId: `runtime-${sessionId}`, generation: 1 }, actor: { ...actor, sessionId } };
      }) as any;
      composition.runtimeService.deliverMessage = (async (request: any) => {
        deliveries.push({ sessionId: request.runtimeId.replace("runtime-", ""), messageId: request.messageId });
        return { ok: true } as any;
      }) as any;

      const first = await composition.handler.leadBroadcast!({
        ...authenticated,
        idempotencyKey: "request-1",
        body: "# Release\n\nShip it.",
        channelIds: ["alpha", "beta", "gamma", "missing", "private"],
        attachmentReferences: ["rooms-attachment:diagram-1"],
      } as never);
      expect(first.results).toEqual([
        expect.objectContaining({ channelId: "alpha", status: "sent", leadSessionId: "lead-a", wasDeduplicated: false }),
        expect.objectContaining({ channelId: "beta", status: "unavailable", leadSessionId: "lead-b" }),
        expect.objectContaining({ channelId: "gamma", status: "failed", leadSessionId: "lead-c" }),
        expect.objectContaining({ channelId: "missing", status: "unavailable", leadSessionId: "lead-missing" }),
        expect.objectContaining({ channelId: "private", status: "unauthorized" }),
      ]);
      expect(deliveries.map(item => item.sessionId)).toEqual(["lead-a"]);
      const alphaEvent = db.messageById(first.results[0]!.eventId!, "alpha").event as any;
      expect(alphaEvent).toMatchObject({
        channelId: "alpha",
        target: { kind: "direct", sessionId: "lead-a" },
        attachmentReferences: ["rooms-attachment:diagram-1"],
        correlation: { purpose: "leadScopedMultiChannelBroadcast" },
      });
      expect(alphaEvent.body).toContain("# Release\n\nShip it.");

      available.add("lead-b");
      available.add("lead-c");
      failed.delete("lead-c");
      const retry = await composition.handler.leadBroadcast!({
        ...authenticated,
        idempotencyKey: "request-1",
        body: "# Release\n\nShip it.",
        channelIds: ["beta", "gamma"],
        attachmentReferences: ["rooms-attachment:diagram-1"],
      } as never);
      expect(retry.results).toEqual([
        expect.objectContaining({ channelId: "beta", status: "sent", leadSessionId: "lead-b", wasDeduplicated: false }),
        expect.objectContaining({ channelId: "gamma", status: "sent", leadSessionId: "lead-c", wasDeduplicated: false }),
      ]);

      const deduped = await composition.handler.leadBroadcast!({
        ...authenticated,
        idempotencyKey: "request-1",
        body: "# Release\n\nShip it.",
        channelIds: ["alpha", "beta"],
        attachmentReferences: ["rooms-attachment:diagram-1"],
      } as never);
      expect(deduped.results.map(result => [result.channelId, result.status, result.wasDeduplicated])).toEqual([
        ["alpha", "sent", true], ["beta", "sent", true],
      ]);
      expect(deliveries.map(item => item.sessionId)).toEqual(["lead-a", "lead-b", "lead-c"]);
      expect(db.replay("0").filter(change => change.kind === "message.sent")).toHaveLength(3);

      db.insertSession({ id: "lead-a-new", role: "planner" });
      db.leaveMembership("alpha", "lead-a");
      db.insertMembership("alpha", "lead-a-new", "planner");
      available.add("lead-a-new");
      const afterLeadChange = await composition.handler.leadBroadcast!({
        ...authenticated, idempotencyKey: "request-2", body: "new lead", channelIds: ["alpha"],
      } as never);
      expect(afterLeadChange.results).toEqual([expect.objectContaining({ status: "sent", leadSessionId: "lead-a-new" })]);
      db.closeChannel("beta");
      const afterChannelChange = await composition.handler.leadBroadcast!({
        ...authenticated, idempotencyKey: "request-3", body: "closed", channelIds: ["beta"],
      } as never);
      expect(afterChannelChange.results).toEqual([expect.objectContaining({ status: "unavailable", error: { code: "channelClosed", message: expect.any(String) } })]);
      composition.database.close();
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  it("exposes the private CLI request without resolving or caching lead ids", async () => {
    let captured: unknown;
    const output = await runRoomsCLI([
      "channel", "lead-broadcast", "--credential", "operator", "--idempotency-key", "request-9",
      "--channels-json", '["alpha","beta"]', "--body", "**hello**", "--attachments-json", '["attachment:a"]', "--json",
    ], {
      async createChannel() {}, async listChannels() {}, async channelStatus() {}, async suspendChannel() {}, async resumeChannel() {},
      async createSession() {}, async commitMessage() {}, async sendPrompt() {},
      async leadBroadcast(input) { captured = input; return { results: [] }; },
    });
    expect(captured).toEqual({ credential: "operator", idempotencyKey: "request-9", body: "**hello**", channelIds: ["alpha", "beta"], attachmentReferences: ["attachment:a"] });
    expect(JSON.parse(output)).toEqual({ results: [] });
  });
});

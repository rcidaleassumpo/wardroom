import { describe, expect, it } from "vitest";
import { AgentRotationService, RotationError } from "../src/rotation/service.js";
import type { RotationAudit, RotationRuntime, RotationStore } from "../src/rotation/contracts.js";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/storage/migrations.js";
import { SQLiteRotationRepository } from "../src/rotation/repository.js";
import { createNativeComposition } from "../src/runtime/native/composition.js";
import { setupMachineIdentity } from "../src/identity/machine-identity.js";

const launch = { provider: "neutral-provider", model: "model-a", reasoning: "high", launchOptions: { mode: "safe", temperature: 0 } };
const worker = (id = "old", runtimeId = "runtime-old", generation = 4): RotationRuntime => ({ runtimeId, sessionId: id, generation, state: "running", providerThreadId: `thread-${id}`, providerTurn: { phase: "idle", reason: "awaiting-input" }, role: "worker", launch });

function harness() {
  const runtimes = new Map<string, RotationRuntime>([["old", worker()], ["planner", { ...worker("planner", "runtime-planner", 1), role: "planner" }]]);
  const audits = new Map<string, RotationAudit>();
  const calls: string[] = [];
  const store: RotationStore = {
    inspect: (_channel, session) => runtimes.get(session) ?? null,
    actorRole: (_channel, session) => runtimes.get(session)?.role ?? null,
    insert: audit => { audits.set(audit.rotationId, audit); },
    get: id => audits.get(id) ?? null,
    update: (id, patch) => { const next = { ...audits.get(id)!, ...patch }; audits.set(id, next); return next; },
    swapWorker: ({ oldSessionId, replacementSessionId, expectedOldGeneration }) => {
      const old = runtimes.get(oldSessionId)!;
      if (old.generation !== expectedOldGeneration) throw new Error("stale generation");
      calls.push(`swap:${oldSessionId}:${replacementSessionId}`);
      runtimes.delete(oldSessionId);
    },
  };
  let failLaunch = false;
  let failOldTermination = false;
  let dishonestLaunch = false;
  const authority = {
    sendPrepare: async ({ sessionId, nonce }: any) => { calls.push(`prepare:${sessionId}:${nonce}`); },
    launchReplacement: async ({ prior }: any) => { if (failLaunch) throw new Error("launch failed"); const next = worker("new", "runtime-new", prior.generation + 1); runtimes.set("new", dishonestLaunch ? { ...next, providerThreadId: null } : next); calls.push("launch:new"); return dishonestLaunch ? { ...next, providerThreadId: "claimed-without-proof" } : next; },
    inspectRuntime: async (id: string) => [...runtimes.values()].find(runtime => runtime.runtimeId === id) ?? null,
    terminate: async ({ runtimeId }: any) => { calls.push(`terminate:${runtimeId}`); if (runtimeId === "runtime-old" && failOldTermination) { failOldTermination = false; throw new Error("old runtime unavailable"); } },
  };
  return { service: new AgentRotationService(store, authority, () => "2026-08-12T00:00:00.000Z"), runtimes, audits, calls, fail: () => { failLaunch = true; }, failOldTermination: () => { failOldTermination = true; }, dishonestLaunch: () => { dishonestLaunch = true; } };
}

describe("neutral safe agent rotation", () => {
  it("persists audit state through a repository restart", () => {
    const path = join(mkdtempSync(join(tmpdir(), "rooms-rotation-")), "rooms.sqlite");
    const first = new DatabaseSync(path); migrate(first);
    first.exec(`INSERT INTO channels(id,registered_at) VALUES ('channel','now');
      INSERT INTO sessions(id,registered_at,role) VALUES ('old','now','worker'),('planner','now','planner');
      INSERT INTO runtimes(runtime_id,home_authority_id,session_id,generation,protocol_version,transport_kind,state,machine_id,reconnect_secret_hash,created_at,updated_at)
        VALUES ('runtime-old','home','old',4,1,'localPty','running','machine','hash','now','now');`);
    const audit: RotationAudit = { rotationId:"rotation",channelId:"channel",oldSessionId:"old",replacementSessionId:null,actorSessionId:"planner",nonce:"nonce",state:"prepared",reason:null,oldRuntimeId:"runtime-old",oldGeneration:4,replacementRuntimeId:null,replacementGeneration:null,createdAt:"now",updatedAt:"now" };
    new SQLiteRotationRepository(first, () => worker()).insert(audit); first.close();
    const second = new DatabaseSync(path); migrate(second);
    expect(new SQLiteRotationRepository(second, () => worker()).get("rotation")).toEqual(audit);
    second.close();
  });

  it("exposes authenticated daemon inspection and protects planner targets", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-rotation-api-"));
    setupMachineIdentity(stateDir);
    const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
    const db = composition.database.db;
    db.exec(`INSERT INTO channels(id,registered_at) VALUES ('channel','now');
      INSERT INTO sessions(id,registered_at,role) VALUES ('worker','now','worker'),('planner','now','planner');
      INSERT INTO memberships(channel_id,session_id,joined_at,role) VALUES ('channel','worker','now','worker'),('channel','planner','now','planner');
      INSERT INTO runtimes(runtime_id,home_authority_id,session_id,generation,protocol_version,transport_kind,state,machine_id,reconnect_secret_hash,provider_thread_id,created_at,updated_at)
        VALUES ('runtime-worker','home','worker',3,1,'localPty','running','machine','hash','thread-worker','now','now'),
          ('runtime-planner','home','planner',1,1,'localPty','running','machine','hash','thread-planner','now','now');
      INSERT INTO runtime_bindings(binding_id,runtime_id,home_authority_id,session_id,generation,channel_id,adapter_kind,handle_ref,launch_policy_ref,bound_at)
        VALUES ('binding-worker','runtime-worker','home','worker',3,'channel','neutral','handle','{"command":["neutral"],"cwd":"/tmp","model":"m","reasoning":"high"}','now'),
          ('binding-planner','runtime-planner','home','planner',1,'channel','neutral','handle2','{"command":["neutral"],"cwd":"/tmp"}','now');`);
    const connection = { authenticatedSessionId: "planner", credentials: new Map([["credential", "planner"]]), onClose: new Set() };
    await expect(composition.handler.rotationInspect!({ channelId: "channel", sessionId: "worker", context: { credential: "credential" }, __connection: connection } as any)).resolves.toMatchObject({ runtimeId: "runtime-worker", generation: 3, launch: { provider: "neutral", model: "m", reasoning: "high" } });
    await expect(composition.handler.rotationInspect!({ channelId: "channel", sessionId: "planner", context: { credential: "credential" }, __connection: connection } as any)).rejects.toMatchObject({ code: "rotationWorkerRequired" });
    await expect(composition.handler.rotationInspect!({ channelId: "channel", sessionId: "worker", context: { credential: "bad" }, __connection: { credentials: new Map(), onClose: new Set() } } as any)).rejects.toThrow("invalid or missing credential");
    composition.database.close();
  });
  it("exposes exact preflight and refuses planner, operator, or active workers", async () => {
    const h = harness();
    expect(h.service.inspect("channel", "old")).toMatchObject({ runtimeId: "runtime-old", generation: 4, role: "worker", providerTurn: { phase: "idle" }, launch, readiness: "ready" });
    expect(() => h.service.inspect("channel", "planner")).toThrowError(new RotationError("rotationWorkerRequired"));
    h.runtimes.set("old", { ...worker(), providerTurn: { phase: "tool", reason: "tool-call" } });
    await expect(h.service.prepare({ channelId: "channel", sessionId: "old", actorSessionId: "planner" })).rejects.toMatchObject({ code: "rotationRuntimeActive" });
  });

  it("requires the nonce-bound worker acknowledgement", async () => {
    const h = harness();
    const audit = await h.service.prepare({ channelId: "channel", sessionId: "old", actorSessionId: "planner" });
    expect(h.calls[0]).toBe(`prepare:old:${audit.nonce}`);
    expect(() => h.service.acknowledge({ rotationId: audit.rotationId, sessionId: "old", nonce: "wrong" })).toThrowError(new RotationError("rotationAcknowledgementInvalid"));
    expect(h.service.acknowledge({ rotationId: audit.rotationId, sessionId: "old", nonce: audit.nonce }).state).toBe("acknowledged");
  });

  it("runs two runtimes, verifies identity, swaps atomically, then ends the old generation", async () => {
    const h = harness();
    const audit = await h.service.prepare({ channelId: "channel", sessionId: "old", actorSessionId: "planner" });
    h.service.acknowledge({ rotationId: audit.rotationId, sessionId: "old", nonce: audit.nonce });
    const committed = await h.service.commit({ rotationId: audit.rotationId, actorSessionId: "planner" });
    expect(committed).toMatchObject({ state: "committed", oldRuntimeId: "runtime-old", oldGeneration: 4, replacementRuntimeId: "runtime-new", replacementGeneration: 5 });
    expect(h.calls.slice(1)).toEqual(["launch:new", "swap:old:new", "terminate:runtime-old"]);
  });

  it("preserves the old worker and audits rollback when replacement launch fails", async () => {
    const h = harness();
    const audit = await h.service.prepare({ channelId: "channel", sessionId: "old", actorSessionId: "planner" });
    h.service.acknowledge({ rotationId: audit.rotationId, sessionId: "old", nonce: audit.nonce });
    h.fail();
    await expect(h.service.commit({ rotationId: audit.rotationId, actorSessionId: "planner" })).rejects.toThrow("launch failed");
    expect(h.runtimes.has("old")).toBe(true);
    expect(h.audits.get(audit.rotationId)).toMatchObject({ state: "rolled_back", reason: "launch failed" });
    expect(h.calls.some(call => call.startsWith("swap:"))).toBe(false);
  });

  it("re-inspects canonical runtime state instead of trusting launch output", async () => {
    const h = harness();
    const audit = await h.service.prepare({ channelId: "channel", sessionId: "old", actorSessionId: "planner" });
    h.service.acknowledge({ rotationId: audit.rotationId, sessionId: "old", nonce: audit.nonce });
    h.dishonestLaunch();
    await expect(h.service.commit({ rotationId: audit.rotationId, actorSessionId: "planner" })).rejects.toMatchObject({ code: "rotationReplacementUnverified" });
    expect(h.calls.some(call => call.startsWith("swap:"))).toBe(false);
  });

  it("keeps the verified replacement after swap and retries old-runtime cleanup", async () => {
    const h = harness();
    const audit = await h.service.prepare({ channelId: "channel", sessionId: "old", actorSessionId: "planner" });
    h.service.acknowledge({ rotationId: audit.rotationId, sessionId: "old", nonce: audit.nonce });
    h.failOldTermination();
    await expect(h.service.commit({ rotationId: audit.rotationId, actorSessionId: "planner" })).rejects.toThrow("old runtime unavailable");
    expect(h.audits.get(audit.rotationId)).toMatchObject({ state: "cleanup_pending", replacementRuntimeId: "runtime-new" });
    expect(h.calls).not.toContain("terminate:runtime-new");
    expect(await h.service.commit({ rotationId: audit.rotationId, actorSessionId: "planner" })).toMatchObject({ state: "committed", replacementRuntimeId: "runtime-new" });
  });

  it("supports audited cancel and rejects non-planner actors", async () => {
    const h = harness();
    await expect(h.service.prepare({ channelId: "channel", sessionId: "old", actorSessionId: "old" })).rejects.toMatchObject({ code: "rotationPlannerRequired" });
    const audit = await h.service.prepare({ channelId: "channel", sessionId: "old", actorSessionId: "planner" });
    expect(h.service.cancel({ rotationId: audit.rotationId, actorSessionId: "planner", reason: "operator deferred" })).toMatchObject({ state: "cancelled", reason: "operator deferred" });
  });
});

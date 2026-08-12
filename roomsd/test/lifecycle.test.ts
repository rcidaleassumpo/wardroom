import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SQLiteBlueprintStore } from "../src/storage/blueprint-repository.js";
import { migrate } from "../src/storage/migrations.js";
import { DurableChannelLifecycle, type ProviderConversationPort, type RuntimeGenerationPort } from "../src/lifecycle/suspend-resume.js";
import type { ResumableChannelBlueprint } from "../src/blueprints/resumable.js";

const blueprint: ResumableChannelBlueprint = {
  version: 1, channelId: "channel-id", channelName: "general", goal: "goal", suspendedAt: "now", historyCursor: "7",
  members: [{ channelId: "channel-id", priorSessionId: "old-session", intent: { role: "worker", workUnitId: "unit" }, launch: { executable: "codex", args: [], cwd: "/tmp" }, layout: { terminalColumns: null, terminalRows: null, layoutVersion: "1" }, adapterKind: "codex", lastAcknowledgedDeliveryCursor: "7", role: "worker", joinedAt: "now", processGeneration: 2, provider: { conversationId: "opaque-conversation", resumeDescriptor: { opaque: true } } }],
};
const canonical = { reattachMembers: async () => {}, rollbackGeneration: async () => {} };
const sqlitePath = (name: string): string => join(tmpdir(), `rooms-${name}-${randomUUID()}.sqlite`);

describe("durable suspend and resume", () => {
  it("tears down the old generation, preserves provider identity, and serializes resume claims", async () => {
    const db = new DatabaseSync(":memory:"); migrate(db); db.prepare("INSERT INTO channels(id, registered_at) VALUES (?, ?)").run("channel-id", "now"); const store = new SQLiteBlueprintStore(db);
    const stopped: string[] = []; const resumed: string[] = []; let launches = 0;
    const runtime: RuntimeGenerationPort = { launch: async () => { launches++; return { sessionId: "fresh-session", runtimeId: "fresh-runtime" }; }, stop: async () => {}, stopGeneration: async input => { stopped.push(`${input.priorSessionId}:${input.generation}`); } };
    const provider: ProviderConversationPort = { stop: async ref => { stopped.push(`provider:${ref.conversationId}`); }, stopRollback: async () => {}, resume: async ref => { resumed.push(ref.conversationId); } };
    const delivery = { deliver: async () => true };
    const lifecycle = new DurableChannelLifecycle(store, runtime, provider, delivery, canonical);
    await lifecycle.suspend("channel-id", "suspend-1", blueprint);
    expect(stopped).toEqual(["old-session:2", "provider:opaque-conversation"]);
    await lifecycle.suspend("channel-id", "suspend-1", blueprint);
    expect(stopped).toEqual(["old-session:2", "provider:opaque-conversation"]);
    const [first, second] = await Promise.all([lifecycle.resume("channel-id", "resume-1", 3), lifecycle.resume("channel-id", "resume-1", 3)]);
    expect(launches).toBe(1); expect(first).toHaveLength(1); expect(second).toEqual(first); expect(resumed).toEqual(["opaque-conversation"]);
    const nextBlueprint: ResumableChannelBlueprint = { ...blueprint, suspendedAt: "later", members: [{ ...blueprint.members[0]!, priorSessionId: "fresh-session", processGeneration: 3 }] };
    await lifecycle.suspend("channel-id", "suspend-next", nextBlueprint);
    expect(stopped).toContain("fresh-session:3");
    db.close();
  });

  it("reclaims a completed suspension when a later generation or member is live", async () => {
    const db = new DatabaseSync(":memory:"); migrate(db); db.prepare("INSERT INTO channels(id, registered_at) VALUES (?, ?)").run("channel-id", "now"); const store = new SQLiteBlueprintStore(db);
    const active = new Set(["old-session:2"]); const stopped: string[] = [];
    const runtime: RuntimeGenerationPort = {
      activeGenerations: members => new Set(members.map(member => `${member.priorSessionId}:${member.generation}`).filter(key => active.has(key))),
      launch: async () => ({ sessionId: "unused", runtimeId: "unused" }),
      stop: async () => {},
      stopGeneration: async input => { const key = `${input.priorSessionId}:${input.generation}`; stopped.push(key); active.delete(key); },
    };
    const provider: ProviderConversationPort = { stop: async () => {}, stopRollback: async () => {}, resume: async () => {} };
    const lifecycle = new DurableChannelLifecycle(store, runtime, provider, { deliver: async () => true }, canonical);
    await lifecycle.suspend("channel-id", "same-key", blueprint);
    expect(stopped).toEqual(["old-session:2"]);

    const nextBlueprint: ResumableChannelBlueprint = {
      ...blueprint,
      members: [
        { ...blueprint.members[0]!, processGeneration: 3 },
        { ...blueprint.members[0]!, priorSessionId: "new-session", processGeneration: 1 },
      ],
    };
    db.prepare("UPDATE channel_blueprints SET blueprint_json=? WHERE channel_id=?").run(JSON.stringify(nextBlueprint), "channel-id");
    active.add("old-session:3"); active.add("new-session:1");
    await lifecycle.suspend("channel-id", "same-key", nextBlueprint);

    expect(stopped).toEqual(["old-session:2", "old-session:3", "new-session:1"]);
    expect((store.status("channel-id") as { state: string }).state).toBe("suspended");
    expect(store.suspensionComplete("channel-id")).toBe(true);
    db.close();
  });

  it("rolls back a fresh runtime when provider reattachment fails", async () => {
    const db = new DatabaseSync(":memory:"); migrate(db); db.prepare("INSERT INTO channels(id, registered_at) VALUES (?, ?)").run("channel-id", "now"); const store = new SQLiteBlueprintStore(db);
    const stopped: string[] = [];
    const runtime: RuntimeGenerationPort = { launch: async () => ({ sessionId: "fresh-session", runtimeId: "fresh-runtime" }), stop: async input => { stopped.push(input.runtimeId); }, stopGeneration: async () => {} };
    const provider: ProviderConversationPort = { stop: async () => {}, stopRollback: async () => {}, resume: async () => { throw new Error("provider unavailable"); } };
    const lifecycle = new DurableChannelLifecycle(store, runtime, provider, { deliver: async () => true }, canonical);
    await lifecycle.suspend("channel-id", "suspend-2", blueprint);
    await expect(lifecycle.resume("channel-id", "resume-2", 3)).rejects.toThrow("provider unavailable");
    expect(stopped).toEqual(["fresh-runtime"]);
    expect(store.resumeLaunches("channel-id", 3)[0]?.providerPhase).toBe("provider_resuming");
    expect((store.status("channel-id") as { state: string }).state).toBe("resuming");
    db.close();
  });

  it("validates provider identity before launching a replacement runtime", async () => {
    const db = new DatabaseSync(":memory:"); migrate(db); db.prepare("INSERT INTO channels(id, registered_at) VALUES (?, ?)").run("channel-id", "now"); const store = new SQLiteBlueprintStore(db);
    let launches = 0;
    const runtime: RuntimeGenerationPort = { launch: async () => { launches++; return { sessionId: "never", runtimeId: "never" }; }, stop: async () => {}, stopGeneration: async () => {} };
    const provider: ProviderConversationPort = { stop: async () => {}, stopRollback: async () => {}, validateResume: async () => { throw new Error("provider identity is not resumable"); }, resume: async () => {} };
    const lifecycle = new DurableChannelLifecycle(store, runtime, provider, { deliver: async () => true }, canonical);
    await lifecycle.suspend("channel-id", "suspend-validation", blueprint);
    await expect(lifecycle.resume("channel-id", "resume-validation", 3)).rejects.toThrow("provider identity is not resumable");
    expect(launches).toBe(0);
    db.close();
  });

  it("resumes runtime-owned provider threads through the replacement process", async () => {
    const db = new DatabaseSync(":memory:"); migrate(db); db.prepare("INSERT INTO channels(id, registered_at) VALUES (?, ?)").run("channel-id", "now"); const store = new SQLiteBlueprintStore(db);
    const runtimeBlueprint: ResumableChannelBlueprint = { ...blueprint, members: [{ ...blueprint.members[0]!, launch: { executable: "/opt/homebrew/bin/codex", args: ["--yolo"], cwd: "/work" }, provider: { conversationId: "thread-id", resumeDescriptor: { provider: "codex", mode: "runtime", cwd: "/work" } } }] };
    let launched: unknown; let providerCalls = 0;
    const runtime: RuntimeGenerationPort = { launch: async input => { launched = input.launch; return { sessionId: input.priorSessionId, runtimeId: "fresh-runtime" }; }, stop: async () => {}, stopGeneration: async () => {} };
    const provider: ProviderConversationPort = { stop: async () => {}, stopRollback: async () => {}, validateResume: async () => { providerCalls++; }, resume: async () => { providerCalls++; } };
    const lifecycle = new DurableChannelLifecycle(store, runtime, provider, { deliver: async () => true }, canonical);
    await lifecycle.suspend("channel-id", "suspend-runtime", runtimeBlueprint);
    await lifecycle.resume("channel-id", "resume-runtime", 3);
    expect(launched).toEqual({ executable: "/opt/homebrew/bin/codex", args: ["resume", "thread-id", "--yolo"], cwd: "/work" });
    expect(providerCalls).toBe(0);
    db.close();
  });

  it.each(["claude", "grok"])("wakes a sleeping %s conversation through the provider port", async providerName => {
    const db = new DatabaseSync(":memory:"); migrate(db); db.prepare("INSERT INTO channels(id, registered_at) VALUES (?, ?)").run("channel-id", "now"); const store = new SQLiteBlueprintStore(db);
    const headlessBlueprint: ResumableChannelBlueprint = { ...blueprint, members: [{ ...blueprint.members[0]!, adapterKind: providerName, provider: { conversationId: `${providerName}-conversation`, resumeDescriptor: { provider: providerName, cwd: "/work", prompt: `wake ${providerName}` } } }] };
    const resumed: string[] = [];
    const runtime: RuntimeGenerationPort = { launch: async () => ({ sessionId: "fresh-session", runtimeId: "fresh-runtime" }), stop: async () => {}, stopGeneration: async () => {} };
    const provider: ProviderConversationPort = { stop: async () => {}, stopRollback: async () => {}, validateResume: async () => {}, resume: async ref => { resumed.push(ref.conversationId); } };
    const lifecycle = new DurableChannelLifecycle(store, runtime, provider, { deliver: async () => true }, canonical);
    await lifecycle.suspend("channel-id", `suspend-${providerName}`, headlessBlueprint);
    await lifecycle.resume("channel-id", `resume-${providerName}`, 3);
    expect(resumed).toEqual([`${providerName}-conversation`]);
    db.close();
  });

  it("deduplicates a delivery observed before acknowledgement across retry", async () => {
    const db = new DatabaseSync(":memory:"); migrate(db); db.prepare("INSERT INTO channels(id, registered_at) VALUES (?, ?)").run("channel-id", "now"); const store = new SQLiteBlueprintStore(db);
    const runtime: RuntimeGenerationPort = { launch: async () => ({ sessionId: "fresh-session", runtimeId: "fresh-runtime" }), stop: async () => {}, stopGeneration: async () => {} };
    const provider: ProviderConversationPort = { stop: async () => {}, stopRollback: async () => {}, resume: async () => {} };
    await new DurableChannelLifecycle(store, runtime, provider, { deliver: async () => true }, canonical, "suspend-owner").suspend("channel-id", "suspend", blueprint);
    store.transaction(() => store.queue("channel-id", { channelId: "channel-id", deliveryId: "delivery-once", cursor: "8", event: { body: "once" } }));
    const recipientPath = sqlitePath("recipient");
    let recipientDB = new DatabaseSync(recipientPath); recipientDB.exec("CREATE TABLE seen_delivery (delivery_id TEXT PRIMARY KEY)"); let calls = 0;
    const recipient = { deliver: async (delivery: { deliveryId: string }) => { calls++; const inserted = Number(recipientDB.prepare("INSERT OR IGNORE INTO seen_delivery(delivery_id) VALUES (?)").run(delivery.deliveryId).changes) === 1; if (inserted) { recipientDB.close(); recipientDB = new DatabaseSync(recipientPath); throw new Error("crash after recipient observation"); } return true; } };
    const lifecycle = new DurableChannelLifecycle(store, runtime, provider, recipient, canonical, "resume-owner");
    await expect(lifecycle.resume("channel-id", "resume-1", 3)).rejects.toThrow("crash after recipient observation");
    await lifecycle.resume("channel-id", "resume-1", 3);
    expect(calls).toBe(2);
    expect(recipientDB.prepare("SELECT COUNT(*) AS count FROM seen_delivery WHERE delivery_id='delivery-once'").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM delivery_acknowledgements WHERE channel_id='channel-id' AND delivery_id='delivery-once'").get()).toMatchObject({ count: 1 });
    recipientDB.close(); db.close();
  });

  it("renews and fences a blocked coordinator without wall-clock lease races", async () => {
    const path = sqlitePath("slow");
    const firstDB = new DatabaseSync(path); const secondDB = new DatabaseSync(path); migrate(firstDB); migrate(secondDB);
    firstDB.prepare("INSERT INTO channels(id, registered_at) VALUES (?, ?)").run("channel-id", "now");
    const firstStore = new SQLiteBlueprintStore(firstDB, 5_000); const secondStore = new SQLiteBlueprintStore(secondDB, 5_000);
    firstStore.suspendLeaseHeartbeatMs = () => 1;
    const originalRenew = firstStore.renewSuspend.bind(firstStore);
    let renewals = 0; let heartbeatResolve!: () => void;
    const heartbeatObserved = new Promise<void>(resolve => { heartbeatResolve = resolve; });
    firstStore.renewSuspend = (channelId, key, ownerId) => { const result = originalRenew(channelId, key, ownerId); if (++renewals === 4) heartbeatResolve(); return result; };
    let releaseRuntime!: () => void;
    const runtimeBlocked = new Promise<void>(resolve => { releaseRuntime = resolve; });
    let runtimeStops = 0; let providerStops = 0;
    const slowRuntime: RuntimeGenerationPort = { launch: async () => ({ sessionId: "unused", runtimeId: "unused" }), stop: async () => {}, stopGeneration: async () => { runtimeStops++; await runtimeBlocked; } };
    const fastRuntime: RuntimeGenerationPort = { launch: async () => ({ sessionId: "unused", runtimeId: "unused" }), stop: async () => {}, stopGeneration: async () => {} };
    const firstProvider: ProviderConversationPort = { stop: async () => { providerStops++; }, stopRollback: async () => {}, resume: async () => {} };
    const secondProvider: ProviderConversationPort = { stop: async () => { throw new Error("duplicate provider teardown"); }, stopRollback: async () => {}, resume: async () => {} };
    const first = new DurableChannelLifecycle(firstStore, slowRuntime, firstProvider, { deliver: async () => true }, canonical, "owner-a");
    const second = new DurableChannelLifecycle(secondStore, fastRuntime, secondProvider, { deliver: async () => true }, canonical, "owner-b");
    const stale = first.suspend("channel-id", "same-key", blueprint);
    await heartbeatObserved;
    await expect(second.suspend("channel-id", "same-key", blueprint)).rejects.toThrow("suspend claim is owned by another coordinator");
    releaseRuntime();
    await stale;
    expect(runtimeStops).toBe(1); expect(providerStops).toBe(1);
    expect(firstStore.suspensionComplete("channel-id")).toBe(true);
    firstDB.close(); secondDB.close();
  });

  it("does not stop the provider after a real takeover during runtime teardown", async () => {
    const path = sqlitePath("provider-fence");
    const firstDB = new DatabaseSync(path); const secondDB = new DatabaseSync(path); migrate(firstDB); migrate(secondDB);
    firstDB.prepare("INSERT INTO channels(id, registered_at) VALUES (?, ?)").run("channel-id", "now");
    const firstStore = new SQLiteBlueprintStore(firstDB, 1000); const secondStore = new SQLiteBlueprintStore(secondDB, 1000);
    let startedResolve!: () => void; let finishResolve!: () => void;
    const started = new Promise<void>(resolve => { startedResolve = resolve; });
    const finish = new Promise<void>(resolve => { finishResolve = resolve; });
    let providerStops = 0;
    const runtime: RuntimeGenerationPort = { launch: async () => ({ sessionId: "unused", runtimeId: "unused" }), stop: async () => {}, stopGeneration: async () => { startedResolve(); await finish; } };
    const provider: ProviderConversationPort = { stop: async () => { providerStops++; }, stopRollback: async () => {}, resume: async () => {} };
    const lifecycle = new DurableChannelLifecycle(firstStore, runtime, provider, { deliver: async () => true }, canonical, "owner-a");
    const stale = lifecycle.suspend("channel-id", "same-key", blueprint);
    await started;
    firstDB.prepare("UPDATE channel_blueprints SET lease_until=? WHERE channel_id=?").run("1970-01-01T00:00:00.000Z", "channel-id");
    expect(secondStore.transaction(() => secondStore.claimSuspend("channel-id", "same-key", blueprint, "owner-b"))).toBe(true);
    finishResolve();
    await expect(stale).rejects.toThrow("suspend lease lost");
    expect(providerStops).toBe(0);
    firstDB.close(); secondDB.close();
  });

  it("rechecks ownership before the provider teardown scope", async () => {
    const path = sqlitePath("provider-boundary");
    const firstDB = new DatabaseSync(path); const secondDB = new DatabaseSync(path); migrate(firstDB); migrate(secondDB);
    firstDB.prepare("INSERT INTO channels(id, registered_at) VALUES (?, ?)").run("channel-id", "now");
    const firstStore = new SQLiteBlueprintStore(firstDB);
    const originalRenew = firstStore.renewSuspend.bind(firstStore); let renewals = 0; let takeover = false;
    firstStore.renewSuspend = (channelId, key, ownerId) => {
      renewals++;
      if (renewals === 3) {
        firstDB.prepare("UPDATE channel_blueprints SET owner_id=?, lease_until=? WHERE channel_id=?").run("owner-b", new Date(Date.now() + 1000).toISOString(), channelId);
        takeover = true;
      }
      return originalRenew(channelId, key, ownerId);
    };
    let providerStops = 0;
    const runtime: RuntimeGenerationPort = { launch: async () => ({ sessionId: "unused", runtimeId: "unused" }), stop: async () => {}, stopGeneration: async () => {} };
    const provider: ProviderConversationPort = { stop: async () => { providerStops++; }, stopRollback: async () => {}, resume: async () => {} };
    const lifecycle = new DurableChannelLifecycle(firstStore, runtime, provider, { deliver: async () => true }, canonical, "owner-a");
    await expect(lifecycle.suspend("channel-id", "same-key", blueprint)).rejects.toThrow("suspend lease lost");
    expect(takeover).toBe(true); expect(providerStops).toBe(0);
    firstDB.close(); secondDB.close();
  });

  it("reports an in-progress same-key follower across two coordinators", async () => {
    const path = sqlitePath("resume-follower");
    const firstDB = new DatabaseSync(path); const secondDB = new DatabaseSync(path); migrate(firstDB); migrate(secondDB);
    firstDB.prepare("INSERT INTO channels(id, registered_at) VALUES (?, ?)").run("channel-id", "now");
    const firstStore = new SQLiteBlueprintStore(firstDB, 5_000); const secondStore = new SQLiteBlueprintStore(secondDB, 5_000);
    const provider: ProviderConversationPort = { stop: async () => {}, stopRollback: async () => {}, resume: async () => {} };
    const suspendRuntime: RuntimeGenerationPort = { launch: async () => ({ sessionId: "unused", runtimeId: "unused" }), stop: async () => {}, stopGeneration: async () => {} };
    await new DurableChannelLifecycle(firstStore, suspendRuntime, provider, { deliver: async () => true }, canonical, "suspend-owner").suspend("channel-id", "suspend", blueprint);
    let launchStarted!: () => void; let releaseLaunch!: () => void;
    const started = new Promise<void>(resolve => { launchStarted = resolve; }); const blocked = new Promise<void>(resolve => { releaseLaunch = resolve; });
    const firstRuntime: RuntimeGenerationPort = { launch: async () => { launchStarted(); await blocked; return { sessionId: "fresh", runtimeId: "runtime" }; }, stop: async () => {}, stopGeneration: async () => {} };
    const secondRuntime: RuntimeGenerationPort = { launch: async () => { throw new Error("duplicate launch"); }, stop: async () => {}, stopGeneration: async () => {} };
    const first = new DurableChannelLifecycle(firstStore, firstRuntime, provider, { deliver: async () => true }, canonical, "resume-owner-a");
    const second = new DurableChannelLifecycle(secondStore, secondRuntime, provider, { deliver: async () => true }, canonical, "resume-owner-b");
    const owner = first.resume("channel-id", "resume", 3); await started;
    await expect(second.resume("channel-id", "resume", 3)).rejects.toThrow("resume is in progress");
    releaseLaunch(); await owner;
    firstDB.close(); secondDB.close();
  });

  it("takes over an expired failed rollback before relaunching", async () => {
    const path = sqlitePath("resume-recovery");
    const firstDB = new DatabaseSync(path); const secondDB = new DatabaseSync(path); migrate(firstDB); migrate(secondDB);
    firstDB.prepare("INSERT INTO channels(id, registered_at) VALUES (?, ?)").run("channel-id", "now");
    const firstStore = new SQLiteBlueprintStore(firstDB); const secondStore = new SQLiteBlueprintStore(secondDB);
    const suspendProvider: ProviderConversationPort = { stop: async () => {}, stopRollback: async () => {}, resume: async () => {} };
    const suspendRuntime: RuntimeGenerationPort = { launch: async () => ({ sessionId: "unused", runtimeId: "unused" }), stop: async () => {}, stopGeneration: async () => {} };
    await new DurableChannelLifecycle(firstStore, suspendRuntime, suspendProvider, { deliver: async () => true }, canonical, "suspend-owner").suspend("channel-id", "suspend", blueprint);
    firstStore.transaction(() => firstStore.queue("channel-id", { channelId: "channel-id", deliveryId: "queued-8", cursor: "8", event: {} }));
    const failedRuntime: RuntimeGenerationPort = { launch: async () => ({ sessionId: "old-fresh", runtimeId: "old-runtime" }), stop: async () => { throw new Error("stop failed"); }, stopGeneration: async () => {} };
    const failedProvider: ProviderConversationPort = { stop: async () => {}, stopRollback: async () => { throw new Error("provider rollback failed"); }, resume: async () => {} };
    await expect(new DurableChannelLifecycle(firstStore, failedRuntime, failedProvider, { deliver: async () => { throw new Error("delivery failed"); } }, canonical, "owner-a").resume("channel-id", "resume", 3)).rejects.toThrow("delivery failed");
    expect(firstStore.resumeLaunches("channel-id", 3)).toHaveLength(1);
    firstDB.prepare("UPDATE channel_blueprints SET resume_lease_until='1970-01-01T00:00:00.000Z' WHERE channel_id='channel-id'").run();
    const recovered: string[] = [];
    const recoveryRuntime: RuntimeGenerationPort = { launch: async () => ({ sessionId: "new-fresh", runtimeId: "new-runtime" }), stop: async input => { recovered.push(`stop:${input.runtimeId}`); }, stopGeneration: async () => {} };
    const recoveryProvider: ProviderConversationPort = { stop: async () => {}, stopRollback: async ref => { recovered.push(`provider:${ref.conversationId}`); }, resume: async () => {} };
    const result = await new DurableChannelLifecycle(secondStore, recoveryRuntime, recoveryProvider, { deliver: async () => true }, canonical, "owner-b").resume("channel-id", "resume", 3);
    expect(recovered).toEqual(["stop:old-runtime", "provider:opaque-conversation"]);
    expect(result[0]?.runtimeId).toBe("new-runtime");
    expect(secondStore.resumeLaunches("channel-id", 3)).toEqual([]);
    expect(secondDB.prepare("SELECT left_at FROM memberships WHERE channel_id='channel-id' AND session_id='old-fresh'").get()).toBeUndefined();
    expect(secondDB.prepare("SELECT session_id FROM resumed_members WHERE channel_id='channel-id'").get()).toMatchObject({ session_id: "new-fresh" });
    firstDB.close(); secondDB.close();
  });

  it("suspends after mass runtime termination when ownership is already gone", async () => {
    const db = new DatabaseSync(":memory:"); migrate(db); db.prepare("INSERT INTO channels(id, registered_at) VALUES (?, ?)").run("channel-id", "now"); const store = new SQLiteBlueprintStore(db);
    let stopCalls = 0;
    const runtime: RuntimeGenerationPort = {
      launch: async () => ({ sessionId: "fresh-session", runtimeId: "fresh-runtime" }),
      stop: async () => {},
      stopGeneration: async () => { stopCalls++; throw new Error("runtime ownership is not durably proven"); },
    };
    const provider: ProviderConversationPort = { stop: async () => { throw new Error("runtime ownership is not durably proven"); }, stopRollback: async () => {}, resume: async () => {} };
    const lifecycle = new DurableChannelLifecycle(store, runtime, provider, { deliver: async () => true }, canonical);
    const captured = await lifecycle.suspend("channel-id", "suspend-dead", blueprint);
    expect(stopCalls).toBe(1);
    expect(captured.members[0]?.provider?.conversationId).toBe("opaque-conversation");
    expect((store.status("channel-id") as { state: string }).state).toBe("suspended");
    const result = await lifecycle.resume("channel-id", "resume-dead", 3);
    expect(result[0]?.outcome).toBe("resumed");
    db.close();
  });

  it("reclaims an expired incomplete resume under the same generation key", async () => {
    const path = sqlitePath("resume-same-generation");
    const firstDB = new DatabaseSync(path); const secondDB = new DatabaseSync(path); migrate(firstDB); migrate(secondDB);
    firstDB.prepare("INSERT INTO channels(id, registered_at) VALUES (?, ?)").run("channel-id", "now");
    const firstStore = new SQLiteBlueprintStore(firstDB); const secondStore = new SQLiteBlueprintStore(secondDB);
    const noop: RuntimeGenerationPort = { launch: async () => ({ sessionId: "unused", runtimeId: "unused" }), stop: async () => {}, stopGeneration: async () => {} };
    const provider: ProviderConversationPort = { stop: async () => {}, stopRollback: async () => {}, resume: async () => {} };
    await new DurableChannelLifecycle(firstStore, noop, provider, { deliver: async () => true }, canonical, "suspend-owner").suspend("channel-id", "suspend", blueprint);
    await expect(new DurableChannelLifecycle(firstStore, {
      launch: async () => { throw new Error("launch failed after terminate"); },
      stop: async () => {},
      stopGeneration: async () => {},
    }, provider, { deliver: async () => true }, canonical, "owner-a").resume("channel-id", "cli-resume-channel-id-3", 3)).rejects.toThrow("launch failed after terminate");
    expect((firstStore.status("channel-id") as { state: string; generation: number }).state).toBe("suspended");
    // Simulate a stuck resuming lease from a crash that did not release cleanly.
    firstDB.prepare("UPDATE channel_blueprints SET state='resuming', resume_key='cli-resume-channel-id-3', resume_owner_id='owner-a', resume_lease_until='1970-01-01T00:00:00.000Z', generation=3, resume_recovery_known=1 WHERE channel_id='channel-id'").run();
    const result = await new DurableChannelLifecycle(secondStore, {
      launch: async () => ({ sessionId: "recovered", runtimeId: "recovered-runtime" }),
      stop: async () => {},
      stopGeneration: async () => {},
    }, provider, { deliver: async () => true }, canonical, "owner-b").resume("channel-id", "cli-resume-channel-id-3", 3);
    expect(result[0]?.runtimeId).toBe("recovered-runtime");
    expect((secondStore.status("channel-id") as { state: string }).state).toBe("active");
    firstDB.close(); secondDB.close();
  });

  it("fails closed on takeover at an ambiguous provider resume boundary", async () => {
    const path = sqlitePath("provider-resume-boundary");
    const firstDB = new DatabaseSync(path); const secondDB = new DatabaseSync(path); migrate(firstDB); migrate(secondDB);
    firstDB.prepare("INSERT INTO channels(id, registered_at) VALUES (?, ?)").run("channel-id", "now");
    const firstStore = new SQLiteBlueprintStore(firstDB); const secondStore = new SQLiteBlueprintStore(secondDB);
    const noopRuntime: RuntimeGenerationPort = { launch: async () => ({ sessionId: "unused", runtimeId: "unused" }), stop: async () => {}, stopGeneration: async () => {} };
    const noopProvider: ProviderConversationPort = { stop: async () => {}, stopRollback: async () => {}, resume: async () => {} };
    await new DurableChannelLifecycle(firstStore, noopRuntime, noopProvider, { deliver: async () => true }, canonical, "suspend-owner").suspend("channel-id", "suspend", blueprint);
    expect(firstStore.transaction(() => firstStore.claimResume("channel-id", "resume", 3, "owner-a"))).toBe(true);
    const token = firstStore.currentResumeFenceToken("channel-id", "resume", "owner-a")!;
    const record = { channelId: "channel-id", priorSessionId: "old-session", sessionId: "uncertain-session", runtimeId: "uncertain-runtime", generation: 3, role: "worker", provider: blueprint.members[0]!.provider };
    expect(firstStore.transaction(() => firstStore.recordResumeLaunch(record, "resume", "owner-a", token))).toBe(true);
    expect(firstStore.transaction(() => firstStore.setResumeProviderPhase("channel-id", "old-session", 3, "provider_resuming", "resume", "owner-a", token))).toBe(true);
    firstDB.prepare("UPDATE channel_blueprints SET resume_lease_until='1970-01-01T00:00:00.000Z' WHERE channel_id='channel-id'").run();
    let runtimeStops = 0; let providerStops = 0; let launches = 0;
    const recoveryRuntime: RuntimeGenerationPort = { launch: async () => { launches++; return { sessionId: "new", runtimeId: "new" }; }, stop: async () => { runtimeStops++; }, stopGeneration: async () => {} };
    const recoveryProvider: ProviderConversationPort = { stop: async () => {}, stopRollback: async () => { providerStops++; }, resume: async () => {} };
    await expect(new DurableChannelLifecycle(secondStore, recoveryRuntime, recoveryProvider, { deliver: async () => true }, canonical, "owner-b").resume("channel-id", "resume", 3)).rejects.toThrow("resume recovery is ambiguous at provider boundary");
    expect({ runtimeStops, providerStops, launches }).toEqual({ runtimeStops: 0, providerStops: 0, launches: 0 });
    expect(secondStore.resumeLaunches("channel-id", 3)[0]?.providerPhase).toBe("provider_resuming");
    firstDB.close(); secondDB.close();
  });
});

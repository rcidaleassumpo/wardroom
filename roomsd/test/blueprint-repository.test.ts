import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate, SUPPORTED_SCHEMA_VERSION } from "../src/storage/migrations.js";
import { SQLiteBlueprintStore } from "../src/storage/blueprint-repository.js";
import type { ResumableChannelBlueprint } from "../src/blueprints/resumable.js";

function expireLease(db: DatabaseSync, channelId: string): void {
  db.prepare("UPDATE channel_blueprints SET lease_until=? WHERE channel_id=?").run("1970-01-01T00:00:00.000Z", channelId);
}

const blueprint: ResumableChannelBlueprint = {
  version: 1, channelId: "channel-id", channelName: "general", goal: "keep history",
  suspendedAt: "2026-07-30T00:00:00.000Z", historyCursor: "7",
  members: [{ channelId: "channel-id", priorSessionId: "old-session", intent: { role: "worker", workUnitId: "unit" }, launch: { executable: "codex", args: ["resume"], cwd: "/tmp/rooms", }, layout: { terminalColumns: 100, terminalRows: 30, layoutVersion: "1" }, adapterKind: "codex", lastAcknowledgedDeliveryCursor: "7", role: "worker", joinedAt: "2026-07-30T00:00:00.000Z", processGeneration: 2, provider: { conversationId: "opaque-conversation", resumeDescriptor: { token: "opaque" } } }],
};
const sqlitePath = (name: string): string => join(tmpdir(), `rooms-${name}-${randomUUID()}.sqlite`);

describe("SQLite blueprint store", () => {
  it("removes ended channel members and stale outcomes from the restore blueprint", () => {
    const db = new DatabaseSync(":memory:"); migrate(db);
    db.prepare("INSERT INTO channels(id, registered_at) VALUES (?, ?)").run("channel-id", "now");
    const store = new SQLiteBlueprintStore(db);
    const ended = { ...blueprint.members[0]!, priorSessionId: "ended-session", adapterKind: "claude" };
    const current = { ...blueprint.members[0]!, priorSessionId: "current-session" };
    const captured = { ...blueprint, members: [ended, current] };
    db.prepare("INSERT INTO channel_blueprints(channel_id, blueprint_json, state, updated_at) VALUES (?, ?, 'suspended', ?)").run("channel-id", JSON.stringify(captured), "now");
    db.prepare("INSERT INTO blueprint_member_outcomes(channel_id, prior_session_id, outcome, updated_at) VALUES (?, ?, 'stopped', ?), (?, ?, 'stopped', ?)").run("channel-id", "ended-session", "now", "channel-id", "current-session", "now");

    const reconciled = store.retainMembers("channel-id", new Set(["current-session"]));

    expect(reconciled?.members.map(member => member.priorSessionId)).toEqual(["current-session"]);
    expect(db.prepare("SELECT prior_session_id FROM blueprint_member_outcomes WHERE channel_id=?").all("channel-id")).toEqual([{ prior_session_id: "current-session" }]);
    db.close();
  });

  it("persists opaque identity and atomically claims one resume lease", () => {
    const db = new DatabaseSync(":memory:"); migrate(db);
    const store = new SQLiteBlueprintStore(db);
    store.transaction(() => store.claimSuspend("channel-id", "suspend-1", blueprint, "owner-a"));
    store.transaction(() => store.capture("channel-id", blueprint, "owner-a"));
    store.transaction(() => store.markSuspended("channel-id", "suspend-1", "owner-a"));
    expect(store.read("channel-id")).toEqual(blueprint);
    expect(store.transaction(() => store.claimResume("channel-id", "resume-1", 3, "owner-a"))).toBe(true);
    expect(store.transaction(() => store.claimResume("channel-id", "resume-2", 4, "owner-b"))).toBe(false);
    const resumeToken = store.currentResumeFenceToken("channel-id", "resume-1", "owner-a")!;
    store.transaction(() => store.releaseResume("channel-id", "resume-1", "owner-a", resumeToken));
    expect(store.transaction(() => store.claimResume("channel-id", "resume-2", 4, "owner-b"))).toBe(true);
    const replacementToken = store.currentResumeFenceToken("channel-id", "resume-2", "owner-b")!;
    store.transaction(() => store.queue("channel-id", { channelId: "channel-id", deliveryId: "d-8", cursor: "8", event: { cursor: "8", body: "queued" } }));
    expect(store.pendingAfter("channel-id", "7", "old-session", "resume-2", "owner-b", replacementToken).map(delivery => delivery.deliveryId)).toEqual(["d-8"]);
    store.transaction(() => store.acknowledge("channel-id", "old-session", "d-8", "resume-2", "owner-b", replacementToken));
    expect(store.pendingAfter("channel-id", "7", "old-session", "resume-2", "owner-b", replacementToken)).toEqual([]);
    db.close();
  });

  it("allows only one owner across two SQLite connections", () => {
    const path = sqlitePath("race");
    const firstDB = new DatabaseSync(path); const secondDB = new DatabaseSync(path); migrate(firstDB); migrate(secondDB);
    const first = new SQLiteBlueprintStore(firstDB); const second = new SQLiteBlueprintStore(secondDB);
    const firstClaim = first.transaction(() => first.claimSuspend("race-channel", "same-key", blueprint, "owner-a"));
    const secondClaim = second.transaction(() => second.claimSuspend("race-channel", "same-key", blueprint, "owner-b"));
    expect([firstClaim, secondClaim].filter(Boolean)).toHaveLength(1);
    expireLease(firstDB, "race-channel");
    expect(second.transaction(() => second.claimSuspend("race-channel", "same-key", blueprint, "owner-b"))).toBe(true);
    firstDB.close(); secondDB.close();
  });

  it("fences stale suspend owners from release and outcome writes", () => {
    const path = sqlitePath("fence");
    const firstDB = new DatabaseSync(path); const secondDB = new DatabaseSync(path); migrate(firstDB); migrate(secondDB);
    // Lease expiry is always forced by SQL below, never awaited, so the default
    // lease duration applies. A short real-time lease made owner-b's own lease
    // expire while the intervening assertions ran, which failed under load.
    const first = new SQLiteBlueprintStore(firstDB); const second = new SQLiteBlueprintStore(secondDB);
    expect(first.transaction(() => first.claimSuspend("fence-channel", "same-key", blueprint, "owner-a"))).toBe(true);
    first.transaction(() => first.capture("fence-channel", blueprint, "owner-a"));
    expireLease(firstDB, "fence-channel");
    expect(second.transaction(() => second.claimSuspend("fence-channel", "same-key", blueprint, "owner-b"))).toBe(true);
    expect(first.transaction(() => first.recordMemberOutcome("fence-channel", "old-session", "failed", "owner-a", "stale"))).toBe(false);
    expect(first.transaction(() => first.releaseSuspend("fence-channel", "same-key", "owner-a"))).toBe(false);
    expect(second.transaction(() => second.renewSuspend("fence-channel", "same-key", "owner-b"))).toBe(true);

    // The holder cannot renew once its own lease has lapsed. Forcing expiry keeps
    // this deterministic instead of depending on how long the assertions above took.
    expireLease(secondDB, "fence-channel");
    expect(second.transaction(() => second.renewSuspend("fence-channel", "same-key", "owner-b"))).toBe(false);
    firstDB.close(); secondDB.close();
  });

  it("upgrades an exact legacy v2 database before claiming", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE channel_blueprints (channel_id TEXT PRIMARY KEY, blueprint_json TEXT NOT NULL, state TEXT NOT NULL, idempotency_key TEXT, owner_id TEXT, lease_until TEXT, generation INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL); PRAGMA user_version=2;");
    migrate(db);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SUPPORTED_SCHEMA_VERSION);
    expect(db.prepare("SELECT fence_epoch FROM channel_blueprints").all()).toEqual([]);
    const store = new SQLiteBlueprintStore(db);
    expect(store.transaction(() => store.claimSuspend("upgrade-channel", "key", blueprint, "owner"))).toBe(true);
    expect(store.currentSuspendFenceToken("upgrade-channel", "key", "owner")).toBe("owner:key:1");
    db.close();
  });

  it("rejects a released fence token and cannot renew it", () => {
    const db = new DatabaseSync(":memory:"); migrate(db);
    const store = new SQLiteBlueprintStore(db);
    expect(store.transaction(() => store.claimSuspend("release-channel", "key", blueprint, "owner"))).toBe(true);
    const token = store.currentSuspendFenceToken("release-channel", "key", "owner");
    expect(token).toBe("owner:key:1");
    expect(store.verifySuspendFenceToken("release-channel", "key", "owner", token!)).toBe(true);
    expect(store.verifyFenceToken(token!)).toBe(true);
    expect(store.transaction(() => store.releaseSuspend("release-channel", "key", "owner"))).toBe(true);
    expect(store.verifySuspendFenceToken("release-channel", "key", "owner", token!)).toBe(false);
    expect(store.verifyFenceToken(token!)).toBe(false);
    expect(store.transaction(() => store.renewSuspend("release-channel", "key", "owner"))).toBe(false);
    db.close();
  });

  it("rotates a new suspend attempt after an active resume generation", () => {
    const db = new DatabaseSync(":memory:"); migrate(db);
    const store = new SQLiteBlueprintStore(db);
    expect(store.transaction(() => store.claimSuspend("rotate-channel", "suspend-1", blueprint, "owner"))).toBe(true);
    store.transaction(() => store.capture("rotate-channel", blueprint, "owner"));
    store.transaction(() => store.markSuspended("rotate-channel", "suspend-1", "owner"));
    db.prepare("UPDATE channel_blueprints SET state='active', resume_key='resume-1' WHERE channel_id=?").run("rotate-channel");
    expect(db.prepare("SELECT idempotency_key, resume_key FROM channel_blueprints WHERE channel_id=?").get("rotate-channel")).toMatchObject({ idempotency_key: "suspend-1", resume_key: "resume-1" });
    expect(store.suspendIdempotencyKey("rotate-channel")).toBeNull();
    expect(store.transaction(() => store.claimSuspend("rotate-channel", "suspend-2", blueprint, "owner-2"))).toBe(true);
    expect(store.currentSuspendFenceToken("rotate-channel", "suspend-2", "owner-2")).toBe("owner-2:suspend-2:2");
    db.close();
  });

  it.each(["resuming", "active"] as const)("fails closed for an unrecoverable legacy v3 %s suspend key", state => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE channel_blueprints (channel_id TEXT PRIMARY KEY, blueprint_json TEXT NOT NULL, state TEXT NOT NULL, idempotency_key TEXT, owner_id TEXT, lease_until TEXT, fence_epoch INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
      INSERT INTO channel_blueprints(channel_id, blueprint_json, state, idempotency_key, generation, updated_at) VALUES ('legacy', '{}', '${state}', 'legacy-resume-key', 4, 'now');
      PRAGMA user_version=3;`);
    migrate(db);
    const row = db.prepare("SELECT idempotency_key, resume_key, suspend_key_known FROM channel_blueprints WHERE channel_id='legacy'").get() as Record<string, unknown>;
    expect(row).toMatchObject({ idempotency_key: null, resume_key: "legacy-resume-key", suspend_key_known: 0 });
    const store = new SQLiteBlueprintStore(db);
    expect(store.suspendIdempotencyKey("legacy")).toBeNull();
    if (state === "resuming") {
      expect(store.transaction(() => store.claimResume("legacy", "legacy-resume-key", 4, "recovery-owner"))).toBe(false);
      expect(store.suspendIdempotencyKey("legacy")).toBeNull();
    }
    db.close();
  });

  it("fails closed for a populated v4 released-resume row", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE channel_blueprints (channel_id TEXT PRIMARY KEY, blueprint_json TEXT NOT NULL, state TEXT NOT NULL, idempotency_key TEXT, owner_id TEXT, lease_until TEXT, fence_epoch INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, resume_key TEXT);
      INSERT INTO channel_blueprints(channel_id, blueprint_json, state, idempotency_key, generation, updated_at, resume_key) VALUES ('legacy-v4', '{}', 'suspended', 'resume-old', 4, 'now', NULL);
      PRAGMA user_version=4;`);
    migrate(db);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SUPPORTED_SCHEMA_VERSION);
    expect(db.prepare("SELECT idempotency_key, resume_key, suspend_key_known FROM channel_blueprints WHERE channel_id='legacy-v4'").get()).toMatchObject({ idempotency_key: "resume-old", resume_key: null, suspend_key_known: 0 });
    expect(new SQLiteBlueprintStore(db).suspendIdempotencyKey("legacy-v4")).toBeNull();
    db.close();
  });

  it("preserves a known suspended key when upgrading from v5", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE channel_blueprints (channel_id TEXT PRIMARY KEY, blueprint_json TEXT NOT NULL, state TEXT NOT NULL, idempotency_key TEXT, owner_id TEXT, lease_until TEXT, fence_epoch INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, resume_key TEXT, suspend_key_known INTEGER NOT NULL DEFAULT 1);
      INSERT INTO channel_blueprints(channel_id, blueprint_json, state, idempotency_key, generation, updated_at, suspend_key_known) VALUES ('known-v5', '{}', 'suspended', 'suspend-known', 4, 'now', 1);
      PRAGMA user_version=5;`);
    migrate(db);
    expect(new SQLiteBlueprintStore(db).suspendIdempotencyKey("known-v5")).toBe("suspend-known");
    db.close();
  });

  it("allows expired resume-owner takeover across two connections", () => {
    const path = sqlitePath("resume-takeover");
    const firstDB = new DatabaseSync(path); const secondDB = new DatabaseSync(path); migrate(firstDB); migrate(secondDB);
    const first = new SQLiteBlueprintStore(firstDB); const second = new SQLiteBlueprintStore(secondDB);
    first.transaction(() => first.claimSuspend("resume-channel", "suspend", blueprint, "suspend-owner"));
    first.transaction(() => first.capture("resume-channel", blueprint, "suspend-owner"));
    first.transaction(() => first.markSuspended("resume-channel", "suspend", "suspend-owner"));
    expect(first.transaction(() => first.claimResume("resume-channel", "resume", 3, "owner-a"))).toBe(true);
    const staleToken = first.currentResumeFenceToken("resume-channel", "resume", "owner-a")!;
    expect(first.verifyFenceToken(staleToken)).toBe(true);
    expect(second.transaction(() => second.claimResume("resume-channel", "resume", 3, "owner-b"))).toBe(false);
    firstDB.prepare("UPDATE channel_blueprints SET resume_lease_until='1970-01-01T00:00:00.000Z' WHERE channel_id='resume-channel'").run();
    expect(second.transaction(() => second.claimResume("resume-channel", "resume", 3, "owner-b"))).toBe(true);
    expect(first.transaction(() => first.renewResume("resume-channel", "resume", "owner-a", staleToken))).toBe(false);
    expect(first.verifyFenceToken(staleToken)).toBe(false);
    firstDB.close(); secondDB.close();
  });

  it("fences every stale post-claim write by owner and resume epoch", () => {
    const path = sqlitePath("resume-write-fence");
    const firstDB = new DatabaseSync(path); const secondDB = new DatabaseSync(path); migrate(firstDB); migrate(secondDB);
    firstDB.prepare("INSERT INTO channels(id, registered_at) VALUES ('channel-id', 'now')").run();
    const first = new SQLiteBlueprintStore(firstDB); const second = new SQLiteBlueprintStore(secondDB);
    first.transaction(() => first.claimSuspend("channel-id", "suspend", blueprint, "suspend-owner"));
    first.transaction(() => first.capture("channel-id", blueprint, "suspend-owner"));
    first.transaction(() => first.markSuspended("channel-id", "suspend", "suspend-owner"));
    expect(first.transaction(() => first.claimResume("channel-id", "resume", 3, "owner-a"))).toBe(true);
    const staleToken = first.currentResumeFenceToken("channel-id", "resume", "owner-a")!;
    const staleRecord = { channelId: "channel-id", priorSessionId: "old-session", sessionId: "stale-session", runtimeId: "stale-runtime", generation: 3, role: "worker", provider: blueprint.members[0]!.provider };
    expect(first.transaction(() => first.recordResumeLaunch(staleRecord, "resume", "owner-a", staleToken))).toBe(true);
    firstDB.prepare("UPDATE channel_blueprints SET resume_lease_until='1970-01-01T00:00:00.000Z' WHERE channel_id='channel-id'").run();
    expect(second.transaction(() => second.claimResume("channel-id", "resume", 3, "owner-b"))).toBe(true);
    first.transaction(() => first.queue("channel-id", { channelId: "channel-id", deliveryId: "delivery-9", cursor: "9", event: { body: "queued" } }));
    expect(first.transaction(() => first.acknowledge("channel-id", "old-session", "delivery-9", "resume", "owner-a", staleToken))).toBe(false);
    const replacementToken = second.currentResumeFenceToken("channel-id", "resume", "owner-b")!;
    expect(second.pendingAfter("channel-id", "7", "old-session", "resume", "owner-b", replacementToken).map(delivery => delivery.deliveryId)).toEqual(["delivery-9"]);
    expect(first.transaction(() => first.setResumeProviderPhase("channel-id", "old-session", 3, "provider_resumed", "resume", "owner-a", staleToken))).toBe(false);
    expect(first.transaction(() => first.installResumedMember(staleRecord, "resume", "owner-a", staleToken))).toBe(false);
    expect(first.transaction(() => first.clearResumeLaunches("channel-id", 3, "resume", "owner-a", staleToken))).toBe(false);
    expect(first.transaction(() => first.rollbackResumedMembers("channel-id", 3, "resume", "owner-a", staleToken))).toBe(false);
    expect(first.transaction(() => first.saveResumeResult("channel-id", "resume", "owner-a", staleToken, []))).toBe(false);
    expect(first.transaction(() => first.markActive("channel-id", "resume", "owner-a", staleToken))).toBe(false);
    first.transaction(() => first.releaseResume("channel-id", "resume", "owner-a", staleToken));
    expect(secondDB.prepare("SELECT state, resume_owner_id FROM channel_blueprints WHERE channel_id='channel-id'").get()).toMatchObject({ state: "resuming", resume_owner_id: "owner-b" });
    expect(secondDB.prepare("SELECT COUNT(*) AS count FROM memberships WHERE session_id='stale-session'").get()).toMatchObject({ count: 0 });
    expect(second.resumeLaunches("channel-id", 3)).toHaveLength(1);
    firstDB.close(); secondDB.close();
  });

  it("fails closed when a legacy v6 resume has no durable launch phase", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE channel_blueprints (channel_id TEXT PRIMARY KEY, blueprint_json TEXT NOT NULL, state TEXT NOT NULL, idempotency_key TEXT, owner_id TEXT, lease_until TEXT, generation INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, fence_epoch INTEGER NOT NULL DEFAULT 0, resume_key TEXT, suspend_key_known INTEGER NOT NULL DEFAULT 1);
      INSERT INTO channel_blueprints(channel_id, blueprint_json, state, idempotency_key, generation, updated_at, resume_key, suspend_key_known) VALUES ('legacy-v6', '{}', 'resuming', NULL, 3, 'now', 'resume-old', 0);
      PRAGMA user_version=6;`);
    migrate(db);
    expect(db.prepare("SELECT resume_recovery_known FROM channel_blueprints WHERE channel_id='legacy-v6'").get()).toMatchObject({ resume_recovery_known: 0 });
    const store = new SQLiteBlueprintStore(db);
    expect(store.transaction(() => store.claimResume("legacy-v6", "resume-old", 3, "owner"))).toBe(false);
    db.close();
  });

  it("fails closed when a populated legacy v7 launch has no provider phase", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE channel_blueprints (channel_id TEXT PRIMARY KEY, blueprint_json TEXT NOT NULL, state TEXT NOT NULL, idempotency_key TEXT, owner_id TEXT, lease_until TEXT, generation INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, fence_epoch INTEGER NOT NULL DEFAULT 0, resume_key TEXT, suspend_key_known INTEGER NOT NULL DEFAULT 1, resume_owner_id TEXT, resume_lease_until TEXT);
      CREATE TABLE resume_launches (channel_id TEXT NOT NULL, prior_session_id TEXT NOT NULL, session_id TEXT NOT NULL, runtime_id TEXT NOT NULL, generation INTEGER NOT NULL, role TEXT, provider_json TEXT, PRIMARY KEY(channel_id, prior_session_id, generation));
      INSERT INTO channel_blueprints(channel_id, blueprint_json, state, generation, updated_at, resume_key, resume_owner_id, resume_lease_until) VALUES ('legacy-v7', '{}', 'resuming', 3, 'now', 'resume-old', 'legacy-owner', '1970-01-01T00:00:00.000Z');
      INSERT INTO resume_launches(channel_id, prior_session_id, session_id, runtime_id, generation, provider_json) VALUES ('legacy-v7', 'prior', 'session', 'runtime', 3, '{"conversationId":"opaque"}');
      PRAGMA user_version=7;`);
    migrate(db);
    expect(db.prepare("SELECT resume_recovery_known FROM channel_blueprints WHERE channel_id='legacy-v7'").get()).toMatchObject({ resume_recovery_known: 0 });
    const store = new SQLiteBlueprintStore(db);
    expect(store.transaction(() => store.claimResume("legacy-v7", "resume-old", 3, "owner"))).toBe(false);
    db.close();
  });
});

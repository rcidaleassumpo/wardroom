import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateBlueprint, type ResumableChannelBlueprint } from "../src/blueprints/resumable.js";
import { planSessionResume } from "../src/cli/session-resume.js";
import { setupMachineIdentity } from "../src/identity/machine-identity.js";
import { migrate } from "../src/storage/migrations.js";
import { SQLiteBlueprintStore } from "../src/storage/blueprint-repository.js";
import { RoomsRepository } from "../src/storage/repository.js";
import { RuntimeRepository } from "../src/storage/runtime-repository.js";

const THREAD = "019ff017-2ace-7b73-b2c6-ca6e51f5f4f2";

function resumeState(options: { blueprintHome?: string | null; runtimeHome?: string | null }): { stateDir: string; cleanup(): void } {
  const stateDir = mkdtempSync(join(tmpdir(), "rooms-resume-home-"));
  setupMachineIdentity(stateDir);
  const database = new RoomsRepository(join(stateDir, "rooms.sqlite"));
  database.insertSession({ id: "lead", role: "planner" });
  const runtimes = new RuntimeRepository(database.db);
  runtimes.create({ runtimeId: "lead-g1", homeAuthorityId: "authority-local", sessionId: "lead", generation: 1, protocolVersion: 1, transportKind: "localPty", machineId: "local", reconnectSecret: Buffer.alloc(32, 7), providerThreadId: THREAD, effectiveHome: options.runtimeHome ?? null });
  runtimes.markState("lead-g1", 1, "running");
  runtimes.markState("lead-g1", 1, "terminated", "upgrade-drain");
  const launch: Record<string, unknown> = { executable: "/opt/homebrew/bin/codex", args: ["--yolo"], cwd: "/work/mycelia" };
  if (options.blueprintHome !== undefined) launch.home = options.blueprintHome;
  const blueprint = { members: [{ priorSessionId: "lead", adapterKind: "codex", launch, provider: { conversationId: THREAD, resumeDescriptor: { provider: "codex", mode: "runtime" } } }] };
  database.db.prepare("INSERT INTO channel_blueprints(channel_id, blueprint_json, state, updated_at) VALUES(?,?,?,?)").run("mycelia-lead", JSON.stringify(blueprint), "suspended", new Date(0).toISOString());
  database.close();
  return { stateDir, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}

describe("resume keeps the session generated home", () => {
  it("plans a session resume with the blueprint member's home", () => {
    const fixture = resumeState({ blueprintHome: "/rooms/controlled/lead/home", runtimeHome: "/rooms/stale/home" });
    try {
      const plan = planSessionResume("lead", fixture.stateDir);
      expect(plan.effectiveHome).toBe("/rooms/controlled/lead/home");
      expect(plan.command).toEqual(["/opt/homebrew/bin/codex", "resume", THREAD, "--yolo"]);
    } finally { fixture.cleanup(); }
  });

  it("falls back to the newest runtime row's home when the blueprint has none", () => {
    const fixture = resumeState({ runtimeHome: "/rooms/controlled/lead/home" });
    try {
      expect(planSessionResume("lead", fixture.stateDir).effectiveHome).toBe("/rooms/controlled/lead/home");
    } finally { fixture.cleanup(); }
  });

  it("plans a null home for ambient sessions", () => {
    const fixture = resumeState({});
    try {
      expect(planSessionResume("lead", fixture.stateDir).effectiveHome).toBeNull();
    } finally { fixture.cleanup(); }
  });

  it("round-trips launch.home through the blueprint store and validation", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    db.prepare("INSERT INTO channels(id, registered_at) VALUES (?, ?)").run("channel-id", "now");
    const blueprint: ResumableChannelBlueprint = {
      version: 1, channelId: "channel-id", channelName: "general", goal: "keep history",
      suspendedAt: "2026-08-14T00:00:00.000Z", historyCursor: "7",
      members: [{ channelId: "channel-id", priorSessionId: "old-session", intent: { role: "worker", workUnitId: null }, launch: { executable: "codex", args: ["resume"], cwd: "/tmp/rooms", home: "/rooms/controlled/old-session/home" }, layout: { terminalColumns: 100, terminalRows: 30, layoutVersion: "1" }, adapterKind: "codex", lastAcknowledgedDeliveryCursor: "7", role: "worker", joinedAt: "2026-08-14T00:00:00.000Z", processGeneration: 2, provider: { conversationId: THREAD, resumeDescriptor: { token: "opaque" } } }],
    };
    validateBlueprint(blueprint);
    db.prepare("INSERT INTO channel_blueprints(channel_id, blueprint_json, state, updated_at) VALUES (?, ?, 'suspended', ?)").run("channel-id", JSON.stringify(blueprint), "now");
    const stored = new SQLiteBlueprintStore(db).read("channel-id");
    expect(stored?.members[0]?.launch.home).toBe("/rooms/controlled/old-session/home");
    db.close();
  });
});

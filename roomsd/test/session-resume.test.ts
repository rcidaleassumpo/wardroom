import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planSessionResume } from "../src/cli/session-resume.js";
import { setupMachineIdentity } from "../src/identity/machine-identity.js";
import { RoomsRepository } from "../src/storage/repository.js";
import { RuntimeRepository } from "../src/storage/runtime-repository.js";

const THREAD = "019ff017-2ace-7b73-b2c6-ca6e51f5f4f2";

function resumeState(options: { latestState?: "terminated" | "running"; withProof?: boolean; executable?: string; adapterKind?: string } = {}): { stateDir: string; cleanup(): void } {
  const { latestState = "terminated", withProof = true, executable = "/opt/homebrew/bin/codex", adapterKind = "codex" } = options;
  const stateDir = mkdtempSync(join(tmpdir(), "rooms-session-resume-"));
  setupMachineIdentity(stateDir);
  const database = new RoomsRepository(join(stateDir, "rooms.sqlite"));
  database.insertSession({ id: "lead", role: "planner" });
  const runtimes = new RuntimeRepository(database.db);
  runtimes.create({ runtimeId: "lead-g1", homeAuthorityId: "authority-local", sessionId: "lead", generation: 1, protocolVersion: 1, transportKind: "localPty", machineId: "local", reconnectSecret: Buffer.alloc(32, 7), providerThreadId: THREAD });
  runtimes.markState("lead-g1", 1, "running");
  runtimes.markState("lead-g1", 1, "terminated", "upgrade-drain");
  runtimes.create({ runtimeId: "lead-g2", homeAuthorityId: "authority-local", sessionId: "lead", generation: 2, protocolVersion: 1, transportKind: "localPty", machineId: "local", reconnectSecret: Buffer.alloc(32, 8), sessionProof: withProof ? Buffer.alloc(32, 9) : undefined, providerThreadId: THREAD });
  runtimes.markState("lead-g2", 2, "running");
  if (latestState === "terminated") runtimes.markState("lead-g2", 2, "terminated", "upgrade-drain");
  const blueprint = { members: [{ priorSessionId: "lead", adapterKind, launch: { executable, args: ["--yolo"], cwd: "/work/mycelia" }, provider: { conversationId: THREAD, resumeDescriptor: { provider: adapterKind, mode: "runtime" } } }] };
  database.db.prepare("INSERT INTO channel_blueprints(channel_id, blueprint_json, state, updated_at) VALUES(?,?,?,?)").run("mycelia-lead", JSON.stringify(blueprint), "suspended", new Date(0).toISOString());
  database.close();
  return { stateDir, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}

describe("planSessionResume", () => {
  it("preserves generation and builds the codex resume command from the blueprint", () => {
    const fixture = resumeState();
    try {
      const plan = planSessionResume("lead", fixture.stateDir);
      expect(plan.alreadyRunning).toBe(false);
      expect(plan.generation).toBe(3); // max stored generation is 2
      expect(plan.providerThreadId).toBe(THREAD);
      expect(plan.channelId).toBe("mycelia-lead");
      expect(plan.cwd).toBe("/work/mycelia");
      expect(plan.command).toEqual(["/opt/homebrew/bin/codex", "resume", THREAD, "--yolo"]);
    } finally { fixture.cleanup(); }
  });

  it("is idempotent when the newest generation is already a live proof-bound runtime", () => {
    const fixture = resumeState({ latestState: "running", withProof: true });
    try {
      const plan = planSessionResume("lead", fixture.stateDir);
      expect(plan.alreadyRunning).toBe(true);
      expect(plan.generation).toBe(2);
      expect(plan.command).toEqual([]);
    } finally { fixture.cleanup(); }
  });

  // Claude deletes the previous versions/<version> binary on upgrade, so a
  // stored launch path can stop existing between a launch and its resume.
  it("falls back to the provider name when the stored executable is gone", () => {
    const fixture = resumeState({ executable: "/Users/nobody/.local/share/claude/versions/2.1.227", adapterKind: "claude" });
    try {
      const plan = planSessionResume("lead", fixture.stateDir);
      expect(plan.command).toEqual(["claude", "--resume", THREAD, "--yolo"]);
    } finally { fixture.cleanup(); }
  });

  it("refuses a missing session", () => {
    const fixture = resumeState();
    try {
      expect(() => planSessionResume("ghost", fixture.stateDir)).toThrow("not an active Rooms session");
    } finally { fixture.cleanup(); }
  });
});

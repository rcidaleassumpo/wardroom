import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { RoomsRepository } from "../src/storage/repository.js";
import { RuntimeRepository } from "../src/storage/runtime-repository.js";
import { RoomsRuntimeService } from "../src/runtime/service.js";
import { createDefaultRoomsCLIBackend } from "../src/cli/default-backend.js";
import { setupMachineIdentity } from "../src/identity/machine-identity.js";
import { runRoomsCLI } from "../src/cli/main.js";

describe("planner worker-runtime launch authorization", () => {
  it("recognizes only an active planner and worker in the same active channel", () => {
    const database = new RoomsRepository(":memory:");
    database.insertChannel({ id: "proof" });
    database.insertChannel({ id: "other" });
    database.insertSession({ id: "planner", role: "planner" });
    database.insertSession({ id: "worker", role: "worker" });
    database.insertSession({ id: "reviewer", role: "reviewer" });
    database.insertMembership("proof", "planner", "planner");
    database.insertMembership("proof", "worker", "worker");
    database.insertMembership("proof", "reviewer", "reviewer");
    const runtimes = new RuntimeRepository(database.db);

    expect(runtimes.plannerCanLaunchWorker("planner", "worker", "proof")).toBe(true);
    expect(runtimes.plannerCanLaunchWorker("planner", "reviewer", "proof")).toBe(false);
    expect(runtimes.plannerCanLaunchWorker("planner", "worker", "other")).toBe(false);
    database.leaveMembership("proof", "planner");
    expect(runtimes.plannerCanLaunchWorker("planner", "worker", "proof")).toBe(false);
    database.close();
  });

  it("lists, observes, and terminates a same-channel worker runtime for its planner only", async () => {
    const database = new RoomsRepository(":memory:");
    database.insertChannel({ id: "proof" });
    database.insertChannel({ id: "other" });
    database.insertSession({ id: "planner", role: "planner" });
    database.insertSession({ id: "worker", role: "worker" });
    database.insertSession({ id: "reviewer", role: "reviewer" });
    database.insertSession({ id: "stranger", role: "planner" });
    database.insertMembership("proof", "planner", "planner");
    database.insertMembership("proof", "worker", "worker");
    database.insertMembership("proof", "reviewer", "reviewer");
    // Wrong-channel planner: active planner elsewhere must not see proof workers.
    database.insertMembership("other", "stranger", "planner");
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-planner-list-"));
    const socketDirectory = mkdtempSync(join(tmpdir(), "rooms-planner-sock-"));
    const runtimes = new RuntimeRepository(database.db);
    const service = new RoomsRuntimeService(runtimes, {
      machineId: "machine",
      defaultHomeAuthorityId: "authority-test",
      stateDir,
      socketDirectory,
    });
    const secret = randomBytes(32);
    const runtime = runtimes.create({
      runtimeId: "runtime-worker-1",
      homeAuthorityId: "authority-test",
      sessionId: "worker",
      generation: 1,
      protocolVersion: 1,
      transportKind: "localPty",
      machineId: "machine",
      providerThreadId: null,
      reconnectSecret: secret,
    });
    runtimes.bind({
      bindingId: "binding-worker-1",
      runtimeId: runtime.runtimeId,
      homeAuthorityId: runtime.homeAuthorityId,
      sessionId: runtime.sessionId,
      generation: runtime.generation,
      channelId: "proof",
      adapterKind: "claude",
      handleRef: "unix:/tmp/x.sock;state:/tmp/state",
      launchPolicyRef: null,
    });
    runtimes.markState(runtime.runtimeId, runtime.generation, "running");
    const planner = { sessionId: "planner", role: "planner" as const, credentialId: "planner" };

    expect(service.list({}, planner).runtimes.map((item) => item.runtimeId)).toEqual(["runtime-worker-1"]);
    expect(service.list({}, { sessionId: "stranger", role: "planner", credentialId: "stranger" }).runtimes).toEqual([]);
    expect(service.list({}, { sessionId: "reviewer", role: "reviewer", credentialId: "reviewer" }).runtimes).toEqual([]);

    expect(service.resolveActiveSessionRuntime("worker", planner, "observe").runtimeId).toBe("runtime-worker-1");
    expect(service.resolveActiveSessionRuntime("worker", planner, "terminate").runtimeId).toBe("runtime-worker-1");
    expect(() => service.resolveActiveSessionRuntime("worker", planner, "controller")).toThrow(/runtimeUnauthorized/);
    expect(() => service.resolveActiveSessionRuntime("worker", { sessionId: "stranger", role: "planner", credentialId: "stranger" }, "observe"))
      .toThrow(/runtimeUnauthorized|runtimeNotFound/);
    expect(() => service.resolveActiveSessionRuntime("worker", { sessionId: "reviewer", role: "reviewer", credentialId: "reviewer" }, "observe"))
      .toThrow(/runtimeUnauthorized|runtimeNotFound/);

    // Absent host: terminate still marks the supervised worker runtime ended.
    await expect(service.terminate(
      { runtimeId: "runtime-worker-1", generation: 1 },
      planner,
    )).resolves.toMatchObject({ ok: true });
    expect(runtimes.get("runtime-worker-1")?.state).toBe("terminated");

    database.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(socketDirectory, { recursive: true, force: true });
  });

  it("completes planner launch readiness and prompt delivery without rolling back", async () => {
    const calls: string[] = [];
    const output = await runRoomsCLI([
      "session", "launch",
      "--credential", "planner-1",
      "--channel", "proof",
      "--name", "session-worker-ready",
      "--agent", "claude",
      "--role", "worker",
      "--cwd", "/tmp/target",
      "--prompt", "do the work",
    ], {
      suspendChannel: async () => ({}),
      resumeChannel: async () => ({}),
      createSession: async () => {
        calls.push("create");
        return { session: { id: "session-worker-ready", role: "worker" }, runtime: { runtimeId: "runtime-ready" } };
      },
      registerSession: async () => ({}),
      sendPrompt: async (input) => {
        calls.push(`prompt:${input.credential}:${input.session}`);
        return { event: { recipientStatuses: { "session-worker-ready": "delivered" } } };
      },
      runtimeResolveSessionAttach: async (session, credential) => {
        calls.push(`resolve:${session}:${credential}`);
        return {
          credential,
          runtimeId: "runtime-ready",
          homeAuthorityId: "authority-1",
          sessionId: session,
          generation: 1,
          viewerId: credential,
          mode: "observe" as const,
        };
      },
      runtimeAttachInteractive: async (_input, handlers) => {
        calls.push("attach");
        queueMicrotask(() => {
          handlers.onOutput({ cursor: "0", bytes: new TextEncoder().encode("x".repeat(600)) });
        });
        return { hello: { replayFrom: "0", head: "0", gap: false }, input: async () => ({}), resize: async () => ({}), detach: async () => { calls.push("detach"); return {}; } };
      },
      runtimeTerminateSession: async () => { calls.push("terminate"); return {}; },
      endSession: async () => { calls.push("end"); return {}; },
    } as never);

    expect(JSON.parse(output)).toMatchObject({
      session: { id: "session-worker-ready", role: "worker" },
      promptDelivered: true,
      promptAccepted: true,
      providerReady: { settled: true, byteCount: 600 },
    });
    expect(calls).toEqual([
      "create",
      "resolve:session-worker-ready:planner-1",
      "attach",
      "detach",
      "prompt:planner-1:session-worker-ready",
      "resolve:session-worker-ready:planner-1",
      "attach",
      "detach",
    ]);
    expect(calls).not.toContain("terminate");
    expect(calls).not.toContain("end");
  });

  it("rolls a failed planner launch back with the planner credential", async () => {
    const cleanup: string[] = [];
    await expect(runRoomsCLI([
      "session", "launch",
      "--credential", "planner-1",
      "--channel", "proof",
      "--name", "session-worker-roll",
      "--agent", "claude",
      "--role", "worker",
      "--cwd", "/tmp/target",
      "--prompt", "do the work",
    ], {
      suspendChannel: async () => ({}),
      resumeChannel: async () => ({}),
      createSession: async () => ({}),
      registerSession: async () => ({}),
      sendPrompt: async () => ({}),
      runtimeResolveSessionAttach: async () => { throw new Error("session session-worker-roll has no active Rooms runtime"); },
      runtimeAttachInteractive: async () => { throw new Error("attach must not run when resolve fails"); },
      runtimeTerminateSession: async (session, credential) => { cleanup.push(`terminate:${session}:${credential}`); return {}; },
      endSession: async (session, credential) => { cleanup.push(`end:${session}:${credential}`); return {}; },
    } as never)).rejects.toThrow("has no active Rooms runtime");
    expect(cleanup).toEqual([
      "terminate:session-worker-roll:planner-1",
      "end:session-worker-roll:planner-1",
    ]);
  });

  it("rejects an unauthorized planner before creating the target session", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-planner-launch-preflight-"));
    const previousState = process.env.ROOMS_STATE_DIR;
    try {
      process.env.ROOMS_STATE_DIR = stateDir;
      setupMachineIdentity(stateDir);
      const database = new RoomsRepository(join(stateDir, "rooms.sqlite"));
      database.insertChannel({ id: "proof" });
      database.insertSession({ id: "planner", role: "planner", externalId: "planner" });
      database.insertMembership("proof", "planner", "planner");
      database.close();

      const backend = createDefaultRoomsCLIBackend();
      await expect(backend.createSession({
        credential: "planner", channel: "proof", name: "partial-reviewer", agent: "codex",
        role: "reviewer", cwd: stateDir, prompt: "review",
      })).rejects.toThrow("session launch requires an operator or the channel's active planner launching a worker");

      const reopened = new RoomsRepository(join(stateDir, "rooms.sqlite"), { schemaPolicy: "require-current", schemaActor: "test" });
      expect(reopened.currentSession("partial-reviewer")).toBeNull();
      reopened.close();
    } finally {
      if (previousState === undefined) delete process.env.ROOMS_STATE_DIR; else process.env.ROOMS_STATE_DIR = previousState;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

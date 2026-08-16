// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { RoomsRepository } from "../src/storage/repository.js";
import { RuntimeRepository } from "../src/storage/runtime-repository.js";
import type { RoomsRuntimeService } from "../src/runtime/service.js";
import { HOST_ABSENT_REASON } from "../src/runtime/service.js";
import { restoreInterruptedSessions } from "../src/runtime/native/restore.js";
import type { SessionResumePlan } from "../src/cli/session-resume.js";

const authority = "authority-home";

function plan(sessionId: string, overrides: Partial<SessionResumePlan> = {}): SessionResumePlan {
  return {
    sessionId,
    channelId: "proof",
    generation: 2,
    adapterKind: "codex",
    providerThreadId: `thread-${sessionId}`,
    cwd: "/work/proof",
    effectiveHome: null,
    command: ["codex", "resume", `thread-${sessionId}`],
    alreadyRunning: false,
    ...overrides,
  };
}

function store(): { database: RoomsRepository; runtimes: RuntimeRepository } {
  const database = new RoomsRepository(":memory:");
  database.insertChannel({ id: "proof" });
  database.insertChannel({ id: "closed-channel" });
  database.closeChannel("closed-channel");
  const runtimes = new RuntimeRepository(database.db);
  return { database, runtimes };
}

function deadRuntime(database: RoomsRepository, runtimes: RuntimeRepository, input: { sessionId: string; runtimeId: string; channelId?: string; reason?: string; homeAuthorityId?: string; generation?: number }): void {
  if (!database.currentSession(input.sessionId)) database.insertSession({ id: input.sessionId, role: "worker" });
  const generation = input.generation ?? 1;
  const runtime = runtimes.create({
    runtimeId: input.runtimeId,
    homeAuthorityId: input.homeAuthorityId ?? authority,
    sessionId: input.sessionId,
    generation,
    protocolVersion: 1,
    transportKind: "localPty",
    machineId: "machine",
    providerThreadId: `thread-${input.sessionId}`,
    reconnectSecret: randomBytes(32),
  });
  runtimes.bind({
    bindingId: `binding-${input.runtimeId}`,
    runtimeId: runtime.runtimeId,
    homeAuthorityId: runtime.homeAuthorityId,
    sessionId: runtime.sessionId,
    generation,
    channelId: input.channelId ?? "proof",
    adapterKind: "codex",
    handleRef: "unix:%2Ftmp%2Fx.sock;state:%2Ftmp%2Fstate",
    launchPolicyRef: null,
  });
  runtimes.markState(input.runtimeId, generation, "crashed", input.reason ?? HOST_ABSENT_REASON);
}

function service(create = vi.fn(async () => ({ runtime: { runtimeId: "runtime-new" } }))): { runtimeService: RoomsRuntimeService; create: ReturnType<typeof vi.fn> } {
  return { runtimeService: { create } as Partial<RoomsRuntimeService> as RoomsRuntimeService, create };
}

describe("restoring sessions after a runtime host outage", () => {
  it("resumes each interrupted session onto its own provider thread", async () => {
    const { database, runtimes } = store();
    deadRuntime(database, runtimes, { sessionId: "worker-one", runtimeId: "runtime-one" });
    deadRuntime(database, runtimes, { sessionId: "worker-two", runtimeId: "runtime-two" });
    const { runtimeService, create } = service();

    const outcome = await restoreInterruptedSessions({
      runtimeService, runtimes, database, homeAuthorityId: authority, stateDir: "/state", log: () => {},
      plan: (sessionId) => plan(sessionId),
    });

    expect([...outcome.restored].sort()).toEqual(["worker-one", "worker-two"]);
    expect(outcome.failed).toEqual([]);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0]).toMatchObject({
      sessionId: "worker-one",
      generation: 2,
      channelId: "proof",
      adapterKind: "codex",
      providerThreadId: "thread-worker-one",
      cwd: "/work/proof",
      command: ["codex", "resume", "thread-worker-one"],
    });
    // The session speaks for itself, so restore needs no operator escalation.
    expect(create.mock.calls[0][1]).toMatchObject({ sessionId: "worker-one", role: "worker" });
  });

  it("leaves alone what was put down on purpose", async () => {
    const { database, runtimes } = store();
    deadRuntime(database, runtimes, { sessionId: "ended-worker", runtimeId: "runtime-ended" });
    database.markSessionEnded("ended-worker");
    deadRuntime(database, runtimes, { sessionId: "closed-worker", runtimeId: "runtime-closed", channelId: "closed-channel" });
    deadRuntime(database, runtimes, { sessionId: "quit-worker", runtimeId: "runtime-quit", reason: "exit:0" });
    deadRuntime(database, runtimes, { sessionId: "remote-worker", runtimeId: "runtime-remote", homeAuthorityId: "authority-other" });
    const { runtimeService, create } = service();

    const outcome = await restoreInterruptedSessions({
      runtimeService, runtimes, database, homeAuthorityId: authority, stateDir: "/state", log: () => {},
      plan: (sessionId) => plan(sessionId),
    });

    expect(outcome.restored).toEqual([]);
    expect(create).not.toHaveBeenCalled();
    expect([...outcome.skipped].map((item) => item.sessionId).sort()).toEqual(["closed-worker", "ended-worker"]);
  });

  it("reports a session that cannot come back and still restores the rest", async () => {
    const { database, runtimes } = store();
    deadRuntime(database, runtimes, { sessionId: "broken-worker", runtimeId: "runtime-broken" });
    deadRuntime(database, runtimes, { sessionId: "healthy-worker", runtimeId: "runtime-healthy" });
    const messages: string[] = [];
    const create = vi.fn(async (request: { sessionId: string }) => {
      if (request.sessionId === "broken-worker") throw new Error("spawn pty child: no such file or directory");
      return { runtime: { runtimeId: "runtime-new" } };
    });
    const { runtimeService } = service(create as never);

    const outcome = await restoreInterruptedSessions({
      runtimeService, runtimes, database, homeAuthorityId: authority, stateDir: "/state", log: (message) => messages.push(message),
      plan: (sessionId) => plan(sessionId),
    });

    expect(outcome.restored).toEqual(["healthy-worker"]);
    expect(outcome.failed).toEqual([{ sessionId: "broken-worker", reason: "spawn pty child: no such file or directory" }]);
    expect(messages.some((message) => message.includes("broken-worker"))).toBe(true);
  });

  // A restore that fails writes its own crashed generation on top of the
  // outage. The session is still down, so the next start owes it another try.
  it("tries again after a restore that could not launch", async () => {
    const { database, runtimes } = store();
    deadRuntime(database, runtimes, { sessionId: "worker-one", runtimeId: "runtime-outage" });
    deadRuntime(database, runtimes, { sessionId: "worker-one", runtimeId: "runtime-failed-restore", generation: 2, reason: "spawn pty child: no such file or directory" });
    const { runtimeService, create } = service();

    const outcome = await restoreInterruptedSessions({
      runtimeService, runtimes, database, homeAuthorityId: authority, stateDir: "/state", log: () => {},
      plan: (sessionId) => plan(sessionId, { generation: 3 }),
    });

    expect(outcome.restored).toEqual(["worker-one"]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ sessionId: "worker-one", generation: 3 });
  });

  it("stops trying once a later generation is running", async () => {
    const { database, runtimes } = store();
    deadRuntime(database, runtimes, { sessionId: "worker-one", runtimeId: "runtime-outage" });
    deadRuntime(database, runtimes, { sessionId: "worker-one", runtimeId: "runtime-back", generation: 2, reason: "unused" });
    runtimes.markState("runtime-back", 2, "running");
    const { runtimeService, create } = service();

    const outcome = await restoreInterruptedSessions({
      runtimeService, runtimes, database, homeAuthorityId: authority, stateDir: "/state", log: () => {},
      plan: (sessionId) => plan(sessionId),
    });

    expect(outcome.restored).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("does not launch a second host for a session that is already running", async () => {
    const { database, runtimes } = store();
    deadRuntime(database, runtimes, { sessionId: "worker-one", runtimeId: "runtime-one" });
    const { runtimeService, create } = service();

    const outcome = await restoreInterruptedSessions({
      runtimeService, runtimes, database, homeAuthorityId: authority, stateDir: "/state", log: () => {},
      plan: (sessionId) => plan(sessionId, { alreadyRunning: true, command: [] }),
    });

    expect(create).not.toHaveBeenCalled();
    expect(outcome.skipped).toEqual([{ sessionId: "worker-one", reason: "already running" }]);
  });
});

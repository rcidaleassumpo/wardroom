import { describe, expect, it, vi } from "vitest";
import type { RoomsCLIBackend } from "../src/cli/backend.js";
import { runRoomsCLI } from "../src/cli/main.js";
import { RoomsRepository, RoomsStoreError } from "../src/storage/repository.js";
import { RuntimeRepository } from "../src/storage/runtime-repository.js";

function backendWithInspect(inspectSession: RoomsCLIBackend["inspectSession"]): RoomsCLIBackend {
  const unused = async (): Promise<never> => { throw new Error("unused"); };
  return {
    createChannel: unused,
    listChannels: unused,
    channelStatus: unused,
    suspendChannel: unused,
    resumeChannel: unused,
    createSession: unused,
    commitMessage: unused,
    sendPrompt: unused,
    inspectSession,
  };
}

describe("rooms session inspect", () => {
  it("routes the exact session id through the public CLI", async () => {
    const inspectSession = vi.fn(async (sessionId: string) => ({
      session: { id: sessionId },
      memberships: [{ channelId: "channel-a", sessionId }],
      runtime: { adapterKind: "codex", state: "running" },
    }));

    const output = JSON.parse(await runRoomsCLI(
      ["session", "inspect", "session-a"],
      backendWithInspect(inspectSession),
    ));

    expect(inspectSession).toHaveBeenCalledExactlyOnceWith("session-a");
    expect(output).toMatchObject({
      session: { id: "session-a" },
      memberships: [{ channelId: "channel-a", sessionId: "session-a" }],
      runtime: { adapterKind: "codex", state: "running" },
    });
  });

  it("returns canonical membership and latest runtime context", () => {
    const repository = new RoomsRepository(":memory:");
    try {
      repository.insertChannel({ id: "channel-a" });
      repository.insertSession({ id: "session-a", role: "worker" });
      repository.insertMembership("channel-a", "session-a", "worker");
      const runtimes = new RuntimeRepository(repository.db);
      runtimes.create({
        runtimeId: "runtime-a",
        homeAuthorityId: "authority-a",
        sessionId: "session-a",
        generation: 1,
        protocolVersion: 1,
        transportKind: "localPty",
        machineId: "machine-a",
        providerThreadId: "provider-thread-a",
        reconnectSecret: new Uint8Array(32),
      });
      runtimes.markState("runtime-a", 1, "running");
      runtimes.bind({
        bindingId: "binding-a",
        runtimeId: "runtime-a",
        homeAuthorityId: "authority-a",
        sessionId: "session-a",
        generation: 1,
        channelId: "channel-a",
        adapterKind: "codex",
        handleRef: "unix:///tmp/runtime-a.sock",
        launchPolicyRef: null,
      });

      expect(repository.inspectSession("session-a")).toMatchObject({
        session: { id: "session-a", role: "worker", endedAt: null },
        memberships: [{ channelId: "channel-a", sessionId: "session-a", role: "worker" }],
        runtime: {
          runtimeId: "runtime-a",
          channelId: "channel-a",
          adapterKind: "codex",
          state: "running",
          providerThreadId: "provider-thread-a",
        },
      });
    } finally {
      repository.close();
    }
  });

  it("separates a pending provider identity from one that will never arrive", () => {
    const repository = new RoomsRepository(":memory:");
    try {
      repository.insertSession({ id: "session-a", role: "worker" });
      const runtimes = new RuntimeRepository(repository.db);
      runtimes.create({
        runtimeId: "runtime-a", homeAuthorityId: "authority-a", sessionId: "session-a",
        generation: 1, protocolVersion: 1, transportKind: "localPty", machineId: "machine-a",
        providerThreadId: null, reconnectSecret: new Uint8Array(32),
      });
      runtimes.markState("runtime-a", 1, "running");
      runtimes.bind({
        bindingId: "binding-a", runtimeId: "runtime-a", homeAuthorityId: "authority-a",
        sessionId: "session-a", generation: 1, channelId: null, adapterKind: "claude",
        handleRef: "unix:///tmp/runtime-a.sock", launchPolicyRef: null,
      });

      // A running provider that has not written its transcript yet is worth waiting on.
      expect(repository.inspectSession("session-a").runtime).toMatchObject({
        providerThreadId: null,
        providerThreadIdState: "pending",
      });

      // Once launch records that it gave up, the same null is a dead end.
      runtimes.appendEvent({ runtimeId: "runtime-a", generation: 1, kind: "error", outcome: "providerThreadIdUndiscovered" });
      expect(repository.inspectSession("session-a").runtime).toMatchObject({
        providerThreadId: null,
        providerThreadIdState: "unavailable",
        providerThreadIdReason: "providerThreadIdUndiscovered",
      });

      // A captured identity outranks the earlier gap.
      runtimes.setProviderThreadId("runtime-a", "claude-native-thread-1");
      expect(repository.inspectSession("session-a").runtime).toMatchObject({
        providerThreadId: "claude-native-thread-1",
        providerThreadIdState: "attached",
        providerThreadIdReason: null,
      });
    } finally {
      repository.close();
    }
  });

  it("does not promise a native identity for providers that never write one", () => {
    const repository = new RoomsRepository(":memory:");
    try {
      repository.insertSession({ id: "session-a", role: "worker" });
      const runtimes = new RuntimeRepository(repository.db);
      runtimes.create({
        runtimeId: "runtime-a", homeAuthorityId: "authority-a", sessionId: "session-a",
        generation: 1, protocolVersion: 1, transportKind: "localPty", machineId: "machine-a",
        providerThreadId: null, reconnectSecret: new Uint8Array(32),
      });
      runtimes.markState("runtime-a", 1, "running");
      runtimes.bind({
        bindingId: "binding-a", runtimeId: "runtime-a", homeAuthorityId: "authority-a",
        sessionId: "session-a", generation: 1, channelId: null, adapterKind: "localPty",
        handleRef: "unix:///tmp/runtime-a.sock", launchPolicyRef: null,
      });
      expect(repository.inspectSession("session-a").runtime).toMatchObject({ providerThreadIdState: "unsupported" });
    } finally {
      repository.close();
    }
  });

  it("treats Grok as discoverable and reports pending until its session id is bound", () => {
    const repository = new RoomsRepository(":memory:");
    try {
      repository.insertSession({ id: "session-g", role: "worker" });
      const runtimes = new RuntimeRepository(repository.db);
      runtimes.create({
        runtimeId: "runtime-g", homeAuthorityId: "authority-a", sessionId: "session-g",
        generation: 1, protocolVersion: 1, transportKind: "localPty", machineId: "machine-a",
        providerThreadId: null, reconnectSecret: new Uint8Array(32),
      });
      runtimes.markState("runtime-g", 1, "running");
      runtimes.bind({
        bindingId: "binding-g", runtimeId: "runtime-g", homeAuthorityId: "authority-a",
        sessionId: "session-g", generation: 1, channelId: null, adapterKind: "grok",
        handleRef: "unix:///tmp/runtime-g.sock", launchPolicyRef: null,
      });
      expect(repository.inspectSession("session-g").runtime).toMatchObject({
        providerThreadId: null,
        providerThreadIdState: "pending",
      });
      runtimes.setProviderThreadId("runtime-g", "grok-native-abc");
      expect(repository.inspectSession("session-g").runtime).toMatchObject({
        providerThreadId: "grok-native-abc",
        providerThreadIdState: "attached",
      });
    } finally {
      repository.close();
    }
  });

  it("fails closed for an unknown session", () => {
    const repository = new RoomsRepository(":memory:");
    try {
      expect(() => repository.inspectSession("missing")).toThrow(RoomsStoreError);
    } finally {
      repository.close();
    }
  });
});

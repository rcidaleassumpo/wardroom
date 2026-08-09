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

  it("fails closed for an unknown session", () => {
    const repository = new RoomsRepository(":memory:");
    try {
      expect(() => repository.inspectSession("missing")).toThrow(RoomsStoreError);
    } finally {
      repository.close();
    }
  });
});

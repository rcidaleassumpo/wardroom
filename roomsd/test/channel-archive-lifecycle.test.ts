import { describe, expect, it } from "vitest";
import { archiveChannelLifecycle } from "../src/lifecycle/archive-channel.js";
import { RoomsRepository } from "../src/storage/repository.js";
import { RuntimeRepository } from "../src/storage/runtime-repository.js";
import type { RoomsCLIBackend } from "../src/cli/backend.js";
import { runRoomsCLI } from "../src/cli/main.js";

function seededChannel(): { store: RoomsRepository; runtimes: RuntimeRepository } {
  const store = new RoomsRepository();
  store.insertSession({ id: "operator", role: "operator", deliveryMode: "log" });
  store.insertSession({ id: "worker", role: "worker" });
  store.insertChannel({ id: "proof", ownerOperatorSessionId: "operator" });
  store.insertMembership("proof", "operator", "operator");
  store.insertMembership("proof", "worker", "worker");
  const runtimes = new RuntimeRepository(store.db);
  runtimes.create({ runtimeId: "runtime-worker", homeAuthorityId: "authority", sessionId: "worker", generation: 1, protocolVersion: 1, transportKind: "localPty", machineId: "machine", reconnectSecret: new Uint8Array(32) });
  runtimes.bind({ bindingId: "binding-worker", runtimeId: "runtime-worker", homeAuthorityId: "authority", sessionId: "worker", generation: 1, channelId: "proof", adapterKind: "test", handleRef: "missing" });
  runtimes.markState("runtime-worker", 1, "running");
  return { store, runtimes };
}

describe("canonical channel archive lifecycle", () => {
  it("requires force, ends runtimes and memberships, closes the channel, and is safe to retry", async () => {
    const { store, runtimes } = seededChannel();
    try {
      const blocked = await archiveChannelLifecycle(store, { channelId: "proof", force: false }, {
        terminateRuntime: async () => { throw new Error("must not run"); },
        closeChannel: async () => { throw new Error("must not run"); },
      });
      expect(blocked).toMatchObject({ completed: false, error: { code: "archiveForceRequired" }, policy: { activeMemberships: 2, activeRuntimes: 1 } });
      expect(store.currentChannel("proof")?.lifecycleState).toBe("active");

      const archived = await archiveChannelLifecycle(store, { channelId: "proof", force: true }, {
        terminateRuntime: async (runtime) => runtimes.markState(runtime.runtimeId, runtime.generation, "terminated", "archive"),
        closeChannel: async () => store.closeChannel("proof"),
      });
      expect(archived).toMatchObject({ completed: true, steps: [
        { step: "runtimes", ok: true, results: [{ runtimeId: "runtime-worker", outcome: "terminated" }] },
        { step: "memberships", ok: true, ended: 2, remaining: 0 },
        { step: "channel", ok: true, state: "closed" },
      ] });
      expect(store.currentChannel("proof")?.lifecycleState).toBe("closed");
      expect(store.roster("proof")).toEqual([]);
      expect(runtimes.get("runtime-worker")).toMatchObject({ state: "terminated", endedAt: expect.any(String) });

      const retry = await archiveChannelLifecycle(store, { channelId: "proof", force: false }, {
        terminateRuntime: async () => { throw new Error("must not run"); },
        closeChannel: async () => store.closeChannel("proof"),
      });
      expect(retry).toMatchObject({ completed: true, policy: { requiresForce: false, activeMemberships: 0, activeRuntimes: 0 } });
    } finally {
      store.close();
    }
  });

  it("does not close the channel when any runtime termination fails", async () => {
    const { store } = seededChannel();
    try {
      const result = await archiveChannelLifecycle(store, { channelId: "proof", force: true }, {
        terminateRuntime: async () => { throw new Error("host refused termination"); },
        closeChannel: async () => store.closeChannel("proof"),
      });
      expect(result).toMatchObject({ completed: false, error: { code: "archiveRuntimeTerminationFailed" } });
      expect(store.currentChannel("proof")?.lifecycleState).toBe("active");
      expect(store.roster("proof")).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("routes one archive call with explicit force through the Rooms CLI", async () => {
    const calls: unknown[] = [];
    const unused = async (): Promise<never> => { throw new Error("unused"); };
    const backend: RoomsCLIBackend = {
      createChannel: unused,
      listChannels: unused,
      channelStatus: unused,
      suspendChannel: unused,
      resumeChannel: unused,
      createSession: unused,
      commitMessage: unused,
      sendPrompt: unused,
      archiveChannel: async (input) => { calls.push(input); return { completed: true }; },
    };

    expect(JSON.parse(await runRoomsCLI(["channel", "archive", "proof", "--credential", "operator", "--force"], backend))).toEqual({ completed: true });
    expect(calls).toEqual([{ channel: "proof", credential: "operator", force: true }]);
  });
});

import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { RoomsRepository } from "../src/storage/repository.js";
import { RuntimeRepository } from "../src/storage/runtime-repository.js";
import { resolveRoomsIdentity } from "../src/cli/default-backend.js";

describe("provider-native runtime identity", () => {
  it("persists and returns the provider thread id", () => {
    const database = new RoomsRepository(":memory:");
    database.insertSession({ id: "session-a", role: "worker" });
    const runtimes = new RuntimeRepository(database.db);
    const runtime = runtimes.create({
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
    expect(runtime.providerThreadId).toBe("provider-thread-a");
    expect(runtimes.get("runtime-a")?.providerThreadId).toBe("provider-thread-a");
    runtimes.setProviderThreadId("runtime-a", "provider-thread-b");
    expect(runtimes.get("runtime-a")?.providerThreadId).toBe("provider-thread-b");
    expect(database.currentSession("session-a")?.providerThreadId).toBe("provider-thread-b");
    database.close();
  });

  it("refuses a provider thread another live runtime already owns, and releases it when that runtime ends", () => {
    const database = new RoomsRepository(":memory:");
    database.insertSession({ id: "session-a", role: "worker" });
    database.insertSession({ id: "session-b", role: "worker" });
    const runtimes = new RuntimeRepository(database.db);
    const base = { homeAuthorityId: "authority-a", generation: 1, protocolVersion: 1, transportKind: "localPty" as const, machineId: "machine-a", reconnectSecret: new Uint8Array(32) };
    runtimes.create({ ...base, runtimeId: "runtime-a", sessionId: "session-a", providerThreadId: "shared-thread" });
    runtimes.markState("runtime-a", 1, "running");
    runtimes.create({ ...base, runtimeId: "runtime-b", sessionId: "session-b", providerThreadId: null });
    runtimes.markState("runtime-b", 1, "running");

    expect(runtimes.providerThreadHolder("shared-thread")).toBe("runtime-a");
    expect(() => runtimes.setProviderThreadId("runtime-b", "shared-thread")).toThrow("providerThreadIdConflict");
    expect(runtimes.get("runtime-b")?.providerThreadId).toBeNull();
    expect(database.currentSession("session-b")?.providerThreadId).toBeNull();
    // The owning runtime keeps its own identity: the guard rejects the intruder,
    // never the holder.
    expect(runtimes.get("runtime-a")?.providerThreadId).toBe("shared-thread");
    expect(runtimes.setProviderThreadId("runtime-a", "shared-thread").providerThreadId).toBe("shared-thread");

    runtimes.markState("runtime-a", 1, "exited", "exit:0");
    expect(runtimes.providerThreadHolder("shared-thread")).toBeNull();
    expect(runtimes.setProviderThreadId("runtime-b", "shared-thread").providerThreadId).toBe("shared-thread");
    database.close();
  });

  it("tryClaimProviderThreadId is atomic: one live winner, loser gets claimed=false without throwing", () => {
    const database = new RoomsRepository(":memory:");
    database.insertSession({ id: "session-a", role: "worker" });
    database.insertSession({ id: "session-b", role: "worker" });
    const runtimes = new RuntimeRepository(database.db);
    const base = { homeAuthorityId: "authority-a", generation: 1, protocolVersion: 1, transportKind: "localPty" as const, machineId: "machine-a", reconnectSecret: new Uint8Array(32) };
    runtimes.create({ ...base, runtimeId: "runtime-a", sessionId: "session-a", providerThreadId: null });
    runtimes.markState("runtime-a", 1, "running");
    runtimes.create({ ...base, runtimeId: "runtime-b", sessionId: "session-b", providerThreadId: null });
    runtimes.markState("runtime-b", 1, "running");

    const first = runtimes.tryClaimProviderThreadId("runtime-a", "candidate-1");
    const second = runtimes.tryClaimProviderThreadId("runtime-b", "candidate-1");
    expect(first).toMatchObject({ claimed: true });
    expect(second).toEqual({ claimed: false, reason: "conflict" });
    expect(runtimes.get("runtime-a")?.providerThreadId).toBe("candidate-1");
    expect(runtimes.get("runtime-b")?.providerThreadId).toBeNull();
    // Loser continues discovery and can claim a different id.
    expect(runtimes.tryClaimProviderThreadId("runtime-b", "candidate-2")).toMatchObject({ claimed: true });
    expect(runtimes.get("runtime-b")?.providerThreadId).toBe("candidate-2");
    database.close();
  });

  it("resolves tool subprocess identity from a unique provider thread", () => {
    const database = new RoomsRepository(":memory:");
    database.insertChannel({ id: "channel-a" });
    database.insertSession({ id: "session-a", role: "worker" });
    database.insertMembership("channel-a", "session-a", "worker");
    const runtimes = new RuntimeRepository(database.db);
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
      bindingId: "binding-a", runtimeId: "runtime-a", homeAuthorityId: "authority-a",
      sessionId: "session-a", generation: 1, channelId: "channel-a", adapterKind: "codex",
      handleRef: "unix:///tmp/runtime-a.sock", launchPolicyRef: null,
    });
    database.setSessionProviderThreadId("session-a", "provider-thread-a");
    expect(resolveRoomsIdentity(database, { CODEX_THREAD_ID: "provider-thread-a" }, "authority-a")).toEqual({
      sessionId: "session-a",
      channelId: "channel-a",
      provider: "codex",
      sessionThreadId: "provider-thread-a",
      machine: { id: "machine-a", authorityId: "authority-a" },
    });
    database.close();
  });
});

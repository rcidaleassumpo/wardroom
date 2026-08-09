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

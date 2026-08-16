import { describe, expect, it } from "vitest";
import { RoomsRepository } from "../src/storage/repository.js";
import { RuntimeRepository } from "../src/storage/runtime-repository.js";
import { queryMetricsSnapshot, resetQueryMetrics } from "../src/storage/query-telemetry.js";

describe("set-based channel state snapshots", () => {
  it("persists neutral session and per-generation runtime provenance in inspect and snapshots", () => {
    const database = new RoomsRepository(":memory:");
    try {
      database.insertChannel({ id: "channel-a" });
      database.registerSession("channel-a", "worker", "worker", null, "runtime", { externalOwner: "mycelia", externalAgentId: "agent-17" });
      const runtimes = new RuntimeRepository(database.db);
      for (const generation of [1, 2]) runtimes.create({
        runtimeId: `runtime-${generation}`, homeAuthorityId: "remote-authority", sessionId: "worker", generation,
        protocolVersion: 1, transportKind: "localPty", machineId: "remote-machine", reconnectSecret: new Uint8Array(32),
      });
      runtimes.bind({ bindingId: "binding-2", runtimeId: "runtime-2", homeAuthorityId: "remote-authority", sessionId: "worker", generation: 2, channelId: "channel-a", adapterKind: "codex", handleRef: "remote://runtime-2", launchPolicyRef: null });
      expect(runtimes.get("runtime-1")).toMatchObject({ externalOwner: "mycelia", externalAgentId: "agent-17", generation: 1 });
      expect(database.inspectSession("worker")).toMatchObject({
        session: { externalOwner: "mycelia", externalAgentId: "agent-17" },
        runtime: { externalOwner: "mycelia", externalAgentId: "agent-17", generation: 2 },
      });
      expect(database.channelStateSnapshots(["channel-a"]).snapshots["channel-a"]?.members[0]).toMatchObject({
        externalOwner: "mycelia", externalAgentId: "agent-17",
        runtime: { externalOwner: "mycelia", externalAgentId: "agent-17", generation: 2 },
      });
      expect(() => database.registerSession("channel-a", "worker", "worker", null, "runtime", { externalOwner: "other", externalAgentId: "agent-17" })).toThrow("externalProvenanceAlreadyBound");
    } finally { database.close(); }
  });

  it("returns many channels and latest runtimes with one SQL statement", () => {
    const database = new RoomsRepository(":memory:");
    try {
      for (const channelId of ["channel-a", "channel-b", "__proto__"]) database.insertChannel({ id: channelId });
      for (let index = 0; index < 50; index += 1) {
        const sessionId = `worker-${String(index).padStart(2, "0")}`;
        database.insertSession({ id: sessionId, role: "worker" });
        database.insertMembership(index % 2 === 0 ? "channel-a" : "channel-b", sessionId, "worker");
      }
      database.insertSession({ id: "planner", role: "planner" });
      database.insertMembership("channel-a", "planner", "planner");
      database.insertMembership("channel-b", "planner", "planner");
      const runtimes = new RuntimeRepository(database.db);
      runtimes.create({
        runtimeId: "planner-runtime-1", homeAuthorityId: "authority-a", sessionId: "planner",
        generation: 1, protocolVersion: 1, transportKind: "localPty", machineId: "machine-a",
        providerThreadId: "thread-old", reconnectSecret: new Uint8Array(32),
      });
      runtimes.markState("planner-runtime-1", 1, "exited", "replaced");
      runtimes.bind({
        bindingId: "planner-binding-1", runtimeId: "planner-runtime-1", homeAuthorityId: "authority-a",
        sessionId: "planner", generation: 1, channelId: "channel-a", adapterKind: "codex",
        handleRef: "unix:///tmp/planner-1.sock", launchPolicyRef: null,
      });
      runtimes.create({
        runtimeId: "planner-runtime-b", homeAuthorityId: "authority-a", sessionId: "planner",
        generation: 3, protocolVersion: 1, transportKind: "localPty", machineId: "machine-a",
        providerThreadId: "thread-channel-b", reconnectSecret: new Uint8Array(32),
      });
      runtimes.markState("planner-runtime-b", 3, "running");
      runtimes.bind({
        bindingId: "planner-binding-b", runtimeId: "planner-runtime-b", homeAuthorityId: "authority-a",
        sessionId: "planner", generation: 3, channelId: "channel-b", adapterKind: "codex",
        handleRef: "unix:///tmp/planner-b.sock", launchPolicyRef: null,
      });
      runtimes.create({
        runtimeId: "planner-runtime-2", homeAuthorityId: "authority-a", sessionId: "planner",
        generation: 2, protocolVersion: 1, transportKind: "localPty", machineId: "machine-a",
        providerThreadId: "thread-current", reconnectSecret: new Uint8Array(32),
      });
      runtimes.markState("planner-runtime-2", 2, "running");
      runtimes.bind({
        bindingId: "planner-binding-2", runtimeId: "planner-runtime-2", homeAuthorityId: "authority-a",
        sessionId: "planner", generation: 2, channelId: "channel-a", adapterKind: "codex",
        handleRef: "unix:///tmp/planner-2.sock", launchPolicyRef: null,
      });

      resetQueryMetrics();
      const result = database.channelStateSnapshots(["channel-a", "channel-b", "__proto__", "missing", "channel-a"]);

      expect(queryMetricsSnapshot().totalStatements).toBe(1);
      expect(Object.keys(result.snapshots)).toEqual(["channel-a", "channel-b", "__proto__"]);
      expect(result.errors).toEqual({ missing: { code: "channelNotFound" } });
      expect(result.snapshots.__proto__).toMatchObject({ channelId: "__proto__", members: [] });
      expect(result.snapshots["channel-a"]?.members).toHaveLength(26);
      expect(result.snapshots["channel-b"]?.members).toHaveLength(26);
      expect(result.snapshots["channel-a"]?.members.find((member) => member.sessionId === "planner")).toMatchObject({
        role: "planner",
        runtime: { runtimeId: "planner-runtime-2", generation: 2, state: "running", providerThreadId: "thread-current" },
      });
      expect(result.snapshots["channel-b"]?.members.find((member) => member.sessionId === "planner")).toMatchObject({
        runtime: { runtimeId: "planner-runtime-b", generation: 3, providerThreadId: "thread-channel-b" },
      });
      expect(result.snapshots["channel-a"]?.revision).toMatch(/^\d+:/);
    } finally {
      database.close();
    }
  });

  it("bounds the batch before touching SQLite", () => {
    const database = new RoomsRepository(":memory:");
    try {
      resetQueryMetrics();
      expect(() => database.channelStateSnapshots(Array.from({ length: 101 }, (_, index) => `channel-${index}`))).toThrow("snapshot batches are limited to 100 channels");
      expect(queryMetricsSnapshot().totalStatements).toBe(0);
    } finally {
      database.close();
    }
  });

  it("publishes bound runtime state changes on the channel stream", () => {
    const database = new RoomsRepository(":memory:");
    try {
      database.insertChannel({ id: "channel-a" });
      database.insertSession({ id: "worker-a", role: "worker" });
      database.insertMembership("channel-a", "worker-a", "worker");
      const seen: string[] = [];
      const stop = database.onChange((change) => { if (change.channelId === "channel-a") seen.push(`${change.kind}:${String(change.payload.state ?? "")}`); });
      const runtimes = new RuntimeRepository(database.db, { onLifecycleChange: (change) => { database.recordRuntimeLifecycle(change); } });
      runtimes.create({
        runtimeId: "runtime-a", homeAuthorityId: "authority-a", sessionId: "worker-a",
        generation: 1, protocolVersion: 1, transportKind: "localPty", machineId: "machine-a",
        reconnectSecret: new Uint8Array(32),
      });
      runtimes.bind({
        bindingId: "binding-a", runtimeId: "runtime-a", homeAuthorityId: "authority-a",
        sessionId: "worker-a", generation: 1, channelId: "channel-a", adapterKind: "codex",
        handleRef: "unix:///tmp/runtime-a.sock", launchPolicyRef: null,
      });
      runtimes.markState("runtime-a", 1, "running");
      runtimes.markState("runtime-a", 1, "exited", "exit:0");
      stop();
      expect(seen).toEqual(["runtime.lifecycle:creating", "runtime.lifecycle:running", "runtime.lifecycle:exited"]);
      expect(database.channelStateSnapshots(["channel-a"]).snapshots["channel-a"]?.members[0]?.runtime?.state).toBe("exited");
    } finally { database.close(); }
  });
});

describe("set-based channel control pages", () => {
  it("returns independently paged controls for many authorized channels with one SQL statement", () => {
    const database = new RoomsRepository(":memory:");
    try {
      for (const channelId of ["channel-a", "channel-b", "channel-private"]) database.insertChannel({ id: channelId });
      database.insertSession({ id: "operator", role: "operator" });
      database.insertMembership("channel-a", "operator", "operator");
      database.insertMembership("channel-b", "operator", "operator");
      const first = database.commitControl({ channelId: "channel-a", senderSessionId: "worker-a", kind: "task.add", payload: { taskId: "a-1" }, requestId: "a-1" });
      database.commitControl({ channelId: "channel-a", senderSessionId: "worker-a", kind: "task.add", payload: { taskId: "a-2" }, requestId: "a-2" });
      database.commitControl({ channelId: "channel-a", senderSessionId: "worker-a", kind: "task.add", payload: { taskId: "a-3" }, requestId: "a-3" });
      database.commitControl({ channelId: "channel-b", senderSessionId: "worker-b", kind: "task.claim", payload: { taskId: "b-1" }, requestId: "b-1" });
      database.commitControl({ channelId: "channel-private", senderSessionId: "worker-c", kind: "task.claim", payload: { taskId: "c-1" }, requestId: "c-1" });

      resetQueryMetrics();
      const result = database.channelControlPages([
        { channelId: "channel-a", afterCursor: first.cursor },
        { channelId: "channel-b", afterCursor: "0" },
        { channelId: "channel-private", afterCursor: "0" },
        { channelId: "missing", afterCursor: "0" },
        { channelId: "bad-cursor", afterCursor: "not-a-cursor" },
      ], "operator", 1);

      expect(queryMetricsSnapshot().totalStatements).toBe(1);
      expect(result.controls["channel-a"]?.events).toHaveLength(1);
      expect(result.controls["channel-a"]?.events[0]).toMatchObject({ requestId: "a-2", payload: { taskId: "a-2" } });
      expect(result.controls["channel-a"]?.hasMore).toBe(true);
      expect(result.controls["channel-b"]?.events[0]).toMatchObject({ requestId: "b-1" });
      expect(result.controls["channel-b"]?.hasMore).toBe(false);
      expect(result.errors).toEqual({
        "channel-private": { code: "controlReaderNotMember" },
        missing: { code: "channelNotFound" },
        "bad-cursor": { code: "invalidCursor" },
      });

      const rest = database.channelControlPages([{ channelId: "channel-a", afterCursor: result.controls["channel-a"]?.cursor }], "operator", 10);
      expect(rest.controls["channel-a"]?.events).toHaveLength(1);
      expect(rest.controls["channel-a"]?.events[0]).toMatchObject({ requestId: "a-3" });
      expect(rest.controls["channel-a"]?.hasMore).toBe(false);
    } finally { database.close(); }
  });

  it("bounds the channel batch before touching SQLite", () => {
    const database = new RoomsRepository(":memory:");
    try {
      resetQueryMetrics();
      expect(() => database.channelControlPages(Array.from({ length: 101 }, (_, index) => ({ channelId: `channel-${index}`, afterCursor: "0" })), "operator"))
        .toThrow("control batches are limited to 100 channels");
      expect(queryMetricsSnapshot().totalStatements).toBe(0);
    } finally { database.close(); }
  });
});

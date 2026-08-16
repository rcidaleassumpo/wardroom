import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startNativeRooms } from "../../src/runtime/native/runtime.js";
import { createNativeComposition } from "../../src/runtime/native/composition.js";
import { setupMachineIdentity } from "../../src/identity/machine-identity.js";
import { RuntimeRepository } from "../../src/storage/runtime-repository.js";

const options = { endpoint: { kind: "unix" as const, path: "rooms.sock" }, databasePath: "/tmp/rooms.db", installSignalHandlers: false };

describe("native Rooms runtime", () => {
  it("issues a credential only for the matching active runtime possession proof", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-native-session-proof-"));
    try {
      setupMachineIdentity(stateDir);
      const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
      composition.database.insertSession({ id: "operator", role: "operator" });
      composition.database.insertSession({ id: "worker", role: "worker" });
      composition.database.insertSession({ id: "legacy", role: "worker" });
      const runtimes = new RuntimeRepository(composition.database.db);
      const operatorProof = Buffer.alloc(32, 1);
      const workerProof = Buffer.alloc(32, 2);
      for (const [runtimeId, sessionId, proof] of [["runtime-operator", "operator", operatorProof], ["runtime-worker", "worker", workerProof]] as const) {
        runtimes.create({ runtimeId, homeAuthorityId: "authority-local", sessionId, generation: 1, protocolVersion: 1, transportKind: "localPty", machineId: "local", reconnectSecret: Buffer.alloc(32, 9), sessionProof: proof });
        runtimes.markState(runtimeId, 1, "running");
      }
      runtimes.create({ runtimeId: "runtime-legacy", homeAuthorityId: "authority-local", sessionId: "legacy", generation: 1, protocolVersion: 1, transportKind: "localPty", machineId: "local", reconnectSecret: Buffer.alloc(32, 8) });
      runtimes.markState("runtime-legacy", 1, "running");
      const connection = { credentials: new Map(), onClose: new Set() };

      await expect(composition.handler.issueCredential({ sessionId: "operator", proof: "", __connection: connection } as never)).rejects.toThrow("session possession proof is required");
      await expect(composition.handler.issueCredential({ sessionId: "operator", proof: workerProof.toString("base64url"), __connection: connection } as never)).rejects.toThrow("session possession proof is required");
      await expect(composition.handler.issueCredential({ sessionId: "legacy", proof: Buffer.alloc(32, 3).toString("base64url"), __connection: connection } as never)).rejects.toThrow("session possession proof is required");
      const issued = await composition.handler.issueCredential({ sessionId: "worker", proof: workerProof.toString("base64url"), __connection: connection } as never);

      expect(issued.credential).toMatch(/^rooms_/);
      await expect(composition.handler.authenticate({ credential: issued.credential, __connection: connection } as never)).resolves.toEqual({ authenticatedSessionId: "worker" });
      runtimes.markState("runtime-worker", 1, "terminated", "proof");
      await expect(composition.handler.issueCredential({ sessionId: "worker", proof: workerProof.toString("base64url"), __connection: { credentials: new Map(), onClose: new Set() } } as never)).rejects.toThrow("session possession proof is required");
      composition.database.close();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("opens the shared composition, binds the selected endpoint, and exposes health", async () => {
    const database = { close: vi.fn() };
    const handler = {};
    const bound = { endpoint: options.endpoint, health: vi.fn(async () => true), close: vi.fn() };
    const deps = {
      openDatabase: vi.fn(() => database),
      createServiceHandler: vi.fn(() => handler),
      bindRoomsService: vi.fn(async () => bound),
    };

    const runtime = await startNativeRooms(options, deps);

    expect(deps.openDatabase).toHaveBeenCalledWith(options.databasePath);
    expect(deps.createServiceHandler).toHaveBeenCalledWith({ database, databasePath: options.databasePath });
    expect(deps.bindRoomsService).toHaveBeenCalledWith(handler, options.endpoint);
    await expect(runtime.health()).resolves.toBe(true);

    await runtime.close();
    await runtime.close();
    expect(bound.close).toHaveBeenCalledOnce();
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("closes the database when endpoint binding fails", async () => {
    const database = { close: vi.fn() };
    await expect(startNativeRooms(options, {
      openDatabase: () => database,
      createServiceHandler: () => ({}),
      bindRoomsService: async () => { throw new Error("socket unavailable"); },
    })).rejects.toThrow("socket unavailable");
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("can restart after a clean close", async () => {
    const listeners = [
      { endpoint: options.endpoint, health: async () => true, close: vi.fn() },
      { endpoint: options.endpoint, health: async () => true, close: vi.fn() },
    ];
    const deps = {
      openDatabase: vi.fn(() => ({ close: vi.fn() })),
      createServiceHandler: vi.fn(() => ({})),
      bindRoomsService: vi.fn(async () => listeners.shift()!),
    };
    const first = await startNativeRooms(options, deps);
    await first.close();
    const second = await startNativeRooms(options, deps);
    await expect(second.health()).resolves.toBe(true);
    await second.close();
    expect(deps.bindRoomsService).toHaveBeenCalledTimes(2);
  });

  it("uses the authenticated credential to end sessions and close owned channels", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-native-auth-"));
    try {
      setupMachineIdentity(stateDir);
      const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
      composition.database.insertSession({ id: "operator", role: "operator" });
      composition.database.insertSession({ id: "worker", role: "worker" });
      composition.database.insertChannel({ id: "proof", ownerOperatorSessionId: "operator" });
      const connection = { authenticatedSessionId: "operator", credentials: new Map([["credential", "operator"]]), onClose: new Set() };
      const context = { credential: "credential" };

      await composition.handler.endSession({ sessionId: "worker", context, __connection: connection } as never);
      await composition.handler.closeChannel({ channelId: "proof", context, __connection: connection } as never);

      expect(composition.database.currentSession("worker")?.endedAt).not.toBeNull();
      expect(composition.database.currentChannel("proof")?.lifecycleState).toBe("closed");
      composition.database.close();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("serves the host-recorded remote cwd through authenticated session inspection", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-native-cwd-"));
    try {
      setupMachineIdentity(stateDir);
      const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
      composition.database.insertSession({ id: "operator", role: "operator" });
      composition.database.insertSession({ id: "remote-worker", role: "worker" });
      const runtimes = new RuntimeRepository(composition.database.db);
      runtimes.create({
        runtimeId: "remote-runtime", homeAuthorityId: "remote-authority", sessionId: "remote-worker",
        generation: 7, protocolVersion: 4, transportKind: "localPty", machineId: "remote-machine",
        effectiveCwd: "/Volumes/remote-source/project", reconnectSecret: new Uint8Array(32).fill(7),
      });
      runtimes.markState("remote-runtime", 7, "running");
      runtimes.bind({
        bindingId: "remote-binding", runtimeId: "remote-runtime", homeAuthorityId: "remote-authority",
        sessionId: "remote-worker", generation: 7, adapterKind: "codex", handleRef: "unix:///remote/runtime.sock",
        launchPolicyRef: JSON.stringify({ cwd: "/local/inference/must-not-win" }),
      });
      const connection = { authenticatedSessionId: "operator", credentials: new Map([["credential", "operator"]]), onClose: new Set() };

      await expect(composition.handler.inspectSession({ sessionId: "remote-worker", context: { credential: "credential" }, __connection: connection } as never)).resolves.toMatchObject({
        runtime: { runtimeId: "remote-runtime", generation: 7, machineId: "remote-machine", cwd: "/Volumes/remote-source/project", cwdState: "available", cwdReason: null },
      });
      composition.database.close();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reports and changes active runtime quotas only for operators", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-native-quota-"));
    try {
      setupMachineIdentity(stateDir);
      const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
      composition.database.insertSession({ id: "operator", role: "operator" });
      composition.database.insertSession({ id: "worker", role: "worker" });
      const operatorConnection = { authenticatedSessionId: "operator", credentials: new Map([["operator-credential", "operator"]]), onClose: new Set() };
      const workerConnection = { authenticatedSessionId: "worker", credentials: new Map([["worker-credential", "worker"]]), onClose: new Set() };

      const initial = await composition.handler.runtimeQuotaGet!({ machineId: "quota-machine" });
      expect(initial.quotas).toMatchObject([{ machineId: "quota-machine", source: "default", maxActiveRuntimes: 1_000_000, activeRuntimes: 0, availableRuntimes: 1_000_000 }]);
      await expect(composition.handler.runtimeQuotaSet!({ machineId: "quota-machine", limit: 48, context: { credential: "worker-credential" }, __connection: workerConnection } as never)).rejects.toMatchObject({ code: "runtimeUnauthorized" });
      const changed = await composition.handler.runtimeQuotaSet!({ machineId: "quota-machine", limit: 48, context: { credential: "operator-credential" }, __connection: operatorConnection } as never);
      expect(changed.quota).toMatchObject({ machineId: "quota-machine", source: "override", maxActiveRuntimes: 48, activeRuntimes: 0, availableRuntimes: 48 });
      const reset = await composition.handler.runtimeQuotaReset!({ machineId: "quota-machine", context: { credential: "operator-credential" }, __connection: operatorConnection } as never);
      expect(reset.quota).toMatchObject({ machineId: "quota-machine", source: "default", maxActiveRuntimes: 1_000_000 });
      composition.database.close();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reports partial broadcast delivery without blocking on a stale member", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-native-delivery-"));
    try {
      setupMachineIdentity(stateDir);
      const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
      for (const [id, role] of [["sender", "operator"], ["live", "worker"], ["dead", "worker"]] as const) composition.database.insertSession({ id, role });
      composition.database.insertChannel({ id: "proof", ownerOperatorSessionId: "sender" });
      composition.database.insertMembership("proof", "sender", "operator");
      composition.database.insertMembership("proof", "live", "worker");
      composition.database.insertMembership("proof", "dead", "worker");
      const connection = { authenticatedSessionId: "sender", credentials: new Map([["credential", "sender"]]), onClose: new Set() };
      const runtimeService = composition.runtimeService as any;
      vi.spyOn(runtimeService, "resolveActiveSessionRuntime").mockImplementation((sessionId: string) => {
        if (sessionId === "dead") throw Object.assign(new Error("missing"), { code: "runtimeNotFound" });
        return { runtimeId: "runtime-live", generation: 1 };
      });
      vi.spyOn(runtimeService, "resolveActiveSessionRuntimeForDelivery").mockImplementation((sessionId: string, actor: any) => {
        if (sessionId === "dead") throw Object.assign(new Error("missing"), { code: "runtimeNotFound" });
        return { runtime: { runtimeId: "runtime-live", generation: 1 }, actor };
      });
      vi.spyOn(runtimeService, "deliverMessage").mockResolvedValue({ ok: true, outcome: "accepted", bytesWritten: 5 });
      const result = await composition.handler.send({ senderSessionId: "sender", channelId: "proof", target: { kind: "broadcast" }, body: "hello", context: { credential: "credential" }, __connection: connection } as never) as any;
      expect(result.event.deliveredRecipientSessionIds).toEqual(["live"]);
      expect(result.event.recipientStatuses).toEqual({ live: "delivered", dead: "undeliverable" });
      composition.database.close();
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  it("rejects a direct target outside the sender's active channel", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-native-direct-auth-"));
    try {
      setupMachineIdentity(stateDir);
      const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
      for (const [id, role] of [["sender", "worker"], ["target", "worker"]] as const) composition.database.insertSession({ id, role });
      composition.database.insertChannel({ id: "proof", ownerOperatorSessionId: null });
      composition.database.insertMembership("proof", "sender", "worker");
      const connection = { authenticatedSessionId: "sender", credentials: new Map([["credential", "sender"]]), onClose: new Set() };
      await expect(composition.handler.send({ senderSessionId: "sender", channelId: "proof", target: { kind: "direct", sessionId: "target" }, body: "hello", context: { credential: "credential" }, __connection: connection } as never)).rejects.toMatchObject({ code: "unauthorizedRecipient" });
      composition.database.close();
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  it("delivers a worker direct message through scoped authority across channel contexts", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-native-cross-channel-"));
    try {
      setupMachineIdentity(stateDir);
      const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
      for (const [id, role] of [["sender", "worker"], ["target", "worker"]] as const) composition.database.insertSession({ id, role });
      for (const channel of ["sender-channel", "target-channel"]) composition.database.insertChannel({ id: channel, ownerOperatorSessionId: null });
      composition.database.insertMembership("sender-channel", "sender", "worker");
      composition.database.insertMembership("sender-channel", "target", "worker");
      composition.database.insertMembership("target-channel", "target", "worker");
      const runtimeRepository = (composition.runtimeService as any).repository;
      const runtime = runtimeRepository.create({ runtimeId: "runtime-target", homeAuthorityId: "authority", sessionId: "target", generation: 1, protocolVersion: 1, transportKind: "localPty", machineId: "machine", reconnectSecret: new Uint8Array(32) });
      runtimeRepository.markState(runtime.runtimeId, runtime.generation, "running", null);
      const connection = { authenticatedSessionId: "sender", credentials: new Map([["credential", "sender"]]), onClose: new Set() };
      vi.spyOn(composition.runtimeService as any, "deliverMessage").mockResolvedValue({ ok: true, outcome: "accepted", bytesWritten: 5 });
      const result = await composition.handler.send({ senderSessionId: "sender", channelId: "sender-channel", target: { kind: "direct", sessionId: "target" }, body: "hello", context: { credential: "credential" }, __connection: connection } as never) as any;
      expect(result.event.deliveredRecipientSessionIds).toEqual(["target"]);
      composition.database.close();
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  it("delivers a worker broadcast through scoped authority", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-native-worker-broadcast-"));
    try {
      setupMachineIdentity(stateDir);
      const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
      for (const [id, role] of [["sender", "worker"], ["target", "worker"]] as const) composition.database.insertSession({ id, role });
      composition.database.insertChannel({ id: "proof", ownerOperatorSessionId: null });
      composition.database.insertMembership("proof", "sender", "worker");
      composition.database.insertMembership("proof", "target", "worker");
      const runtimeRepository = (composition.runtimeService as any).repository;
      const runtime = runtimeRepository.create({ runtimeId: "runtime-target", homeAuthorityId: "authority", sessionId: "target", generation: 1, protocolVersion: 1, transportKind: "localPty", machineId: "machine", reconnectSecret: new Uint8Array(32) });
      runtimeRepository.markState(runtime.runtimeId, runtime.generation, "running", null);
      const connection = { authenticatedSessionId: "sender", credentials: new Map([["credential", "sender"]]), onClose: new Set() };
      vi.spyOn(composition.runtimeService as any, "deliverMessage").mockResolvedValue({ ok: true, outcome: "accepted", bytesWritten: 5 });
      const result = await composition.handler.send({ senderSessionId: "sender", channelId: "proof", target: { kind: "broadcast" }, body: "hello", context: { credential: "credential" }, __connection: connection } as never) as any;
      expect(result.event.deliveredRecipientSessionIds).toEqual(["target"]);
      composition.database.close();
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  it("delivers a direct message to a log-delivered participant without a runtime", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-native-log-direct-"));
    try {
      setupMachineIdentity(stateDir);
      const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
      composition.database.insertSession({ id: "agent", role: "worker" });
      composition.database.insertSession({ id: "ui-operator", role: "operator", deliveryMode: "log" });
      composition.database.insertChannel({ id: "proof", ownerOperatorSessionId: "ui-operator" });
      composition.database.insertMembership("proof", "agent", "worker");
      composition.database.insertMembership("proof", "ui-operator", "operator");
      const connection = { authenticatedSessionId: "agent", credentials: new Map([["credential", "agent"]]), onClose: new Set() };
      const result = await composition.handler.send({ senderSessionId: "agent", channelId: "proof", target: { kind: "direct", sessionId: "ui-operator" }, body: "hello", context: { credential: "credential" }, __connection: connection } as never) as any;
      expect(result.event.recipientStatuses).toEqual({ "ui-operator": "delivered" });
      expect(result.event.deliveredRecipientSessionIds).toEqual(["ui-operator"]);
      composition.database.close();
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  it("accepts canonical reply input and exposes derived thread metadata through the message API", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-native-reply-"));
    try {
      setupMachineIdentity(stateDir);
      const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
      composition.database.insertSession({ id: "agent", role: "worker" });
      composition.database.insertSession({ id: "ui-operator", role: "operator", deliveryMode: "log" });
      composition.database.insertChannel({ id: "proof", ownerOperatorSessionId: "ui-operator" });
      composition.database.insertMembership("proof", "agent", "worker");
      composition.database.insertMembership("proof", "ui-operator", "operator");
      const connection = { authenticatedSessionId: "agent", credentials: new Map([["credential", "agent"]]), onClose: new Set() };
      const request = { senderSessionId: "agent", channelId: "proof", target: { kind: "direct", sessionId: "ui-operator" }, context: { credential: "credential" }, __connection: connection };
      const root = await composition.handler.send({ ...request, body: "root" } as never) as any;
      expect(await composition.handler.getThreadLifecycle({ threadRootEventId: root.event.id, channelId: "proof", ...request } as never))
        .toMatchObject({ thread: { threadRootEventId: root.event.id, state: "open" } });
      expect(await composition.handler.resolveThread({ threadRootEventId: root.event.id, channelId: "proof", ...request } as never))
        .toMatchObject({ thread: { state: "resolved" } });
      await expect(composition.handler.send({ ...request, body: "blocked reply", replyToEventId: root.event.id } as never))
        .rejects.toMatchObject({ code: "threadResolved" });
      expect(await composition.handler.reopenThread({ threadRootEventId: root.event.id, channelId: "proof", ...request } as never))
        .toMatchObject({ thread: { state: "open" } });
      const reply = await composition.handler.send({ ...request, body: "reply", replyToEventId: root.event.id } as never) as any;

      expect(root.event).toMatchObject({ replyToEventId: null, threadRootEventId: null });
      expect(reply.event).toMatchObject({
        replyToEventId: root.event.id,
        threadRootEventId: root.event.id,
        correlation: { replyToEventId: root.event.id },
      });
      const history = await composition.handler.getEvents({ channelId: "proof", afterCursor: "0" });
      expect(history.events.at(-1)).toMatchObject({ id: reply.event.id, replyToEventId: root.event.id, threadRootEventId: root.event.id });
      composition.database.close();
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  it("accepts a broadcast whose only recipient is a log-delivered participant", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-native-log-broadcast-"));
    try {
      setupMachineIdentity(stateDir);
      const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
      composition.database.insertSession({ id: "agent", role: "worker" });
      composition.database.insertSession({ id: "ui-operator", role: "operator", deliveryMode: "log" });
      composition.database.insertChannel({ id: "proof", ownerOperatorSessionId: "ui-operator" });
      composition.database.insertMembership("proof", "agent", "worker");
      composition.database.insertMembership("proof", "ui-operator", "operator");
      const connection = { authenticatedSessionId: "agent", credentials: new Map([["credential", "agent"]]), onClose: new Set() };
      const result = await composition.handler.send({ senderSessionId: "agent", channelId: "proof", target: { kind: "broadcast" }, body: "done", context: { credential: "credential" }, __connection: connection } as never) as any;
      expect(result.event.recipientStatuses).toEqual({ "ui-operator": "delivered" });
      composition.database.close();
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  it("upgrades an existing session to log delivery on re-register", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-native-log-upgrade-"));
    try {
      setupMachineIdentity(stateDir);
      const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
      composition.database.insertSession({ id: "ui-operator", role: "operator" });
      composition.database.insertChannel({ id: "proof", ownerOperatorSessionId: "ui-operator" });
      composition.database.insertMembership("proof", "ui-operator", "operator");
      expect(composition.database.currentSession("ui-operator")?.deliveryMode).toBe("runtime");
      await composition.handler.registerSession({ channelId: "proof", sessionId: "ui-operator", role: "operator", deliveryMode: "log" } as never);
      expect(composition.database.currentSession("ui-operator")?.deliveryMode).toBe("log");
      composition.database.close();
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  it("blocks worker broadcasts on a privileged channel and names the alternative", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-native-policy-"));
    try {
      setupMachineIdentity(stateDir);
      const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
      for (const [id, role] of [["operator", "operator"], ["planner", "planner"], ["worker", "worker"]] as const) composition.database.insertSession({ id, role, deliveryMode: id === "operator" ? "log" : "runtime" });
      composition.database.insertChannel({ id: "proof", ownerOperatorSessionId: "operator" });
      for (const [id, role] of [["operator", "operator"], ["planner", "planner"], ["worker", "worker"]] as const) composition.database.insertMembership("proof", id, role);
      const connectionFor = (id: string) => ({ authenticatedSessionId: id, credentials: new Map([["credential", id]]), onClose: new Set() });
      const operatorContext = { context: { credential: "credential" }, __connection: connectionFor("operator") };
      await composition.handler.updateChannelBroadcastPolicy!({ channelId: "proof", broadcastPolicy: "privileged", ...operatorContext } as never);
      expect(composition.database.currentChannel("proof")?.broadcastPolicy).toBe("privileged");

      await expect(composition.handler.send({ senderSessionId: "worker", channelId: "proof", target: { kind: "broadcast" }, body: "chatter", context: { credential: "credential" }, __connection: connectionFor("worker") } as never)).rejects.toMatchObject({ code: "broadcastRestricted" });

      const fromPlanner = await composition.handler.send({ senderSessionId: "planner", channelId: "proof", target: { kind: "broadcast" }, body: "claim update", context: { credential: "credential" }, __connection: connectionFor("planner") } as never) as any;
      expect(fromPlanner.event.recipientStatuses.operator).toBe("delivered");

      // Direct sends stay open to everyone on a privileged channel.
      const direct = await composition.handler.send({ senderSessionId: "worker", channelId: "proof", target: { kind: "direct", sessionId: "operator" }, body: "status", context: { credential: "credential" }, __connection: connectionFor("worker") } as never) as any;
      expect(direct.event.recipientStatuses.operator).toBe("delivered");
      composition.database.close();
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  it("routes managed workers to the lead, then falls back to the operator", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-native-coordination-policy-"));
    try {
      setupMachineIdentity(stateDir);
      const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
      for (const [id, role] of [["operator", "operator"], ["planner", "planner"], ["worker", "worker"]] as const) {
        composition.database.insertSession({ id, role, deliveryMode: "log" });
        if (id === "operator") continue;
      }
      composition.database.insertChannel({ id: "proof", ownerOperatorSessionId: "operator" });
      for (const [id, role] of [["operator", "operator"], ["planner", "planner"], ["worker", "worker"]] as const) composition.database.insertMembership("proof", id, role);
      const connectionFor = (id: string) => ({ authenticatedSessionId: id, credentials: new Map([["credential", id]]), onClose: new Set() });
      await composition.handler.updateChannelCoordinationPolicy!({ channelId: "proof", coordinationPolicy: "lead-upstream", context: { credential: "credential" }, __connection: connectionFor("operator") } as never);

      await expect(composition.handler.send({ senderSessionId: "worker", channelId: "proof", target: { kind: "direct", sessionId: "operator" }, body: "wrong route", context: { credential: "credential" }, __connection: connectionFor("worker") } as never)).rejects.toMatchObject({ code: "upstreamRestricted" });
      await expect(composition.handler.send({ senderSessionId: "worker", channelId: "proof", target: { kind: "direct", sessionId: "planner" }, body: "lead update", context: { credential: "credential" }, __connection: connectionFor("worker") } as never)).resolves.toMatchObject({ event: { target: { sessionId: "planner" } } });

      composition.database.leaveMembership("proof", "planner");
      await expect(composition.handler.send({ senderSessionId: "worker", channelId: "proof", target: { kind: "direct", sessionId: "operator" }, body: "fallback update", context: { credential: "credential" }, __connection: connectionFor("worker") } as never)).resolves.toMatchObject({ event: { target: { sessionId: "operator" } } });
      composition.database.close();
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  it("accepts and deduplicates private control events from workers blocked from broadcast", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-native-control-"));
    try {
      setupMachineIdentity(stateDir);
      const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
      for (const [id, role] of [["operator", "operator"], ["worker", "worker"]] as const) composition.database.insertSession({ id, role, deliveryMode: "log" });
      composition.database.insertChannel({ id: "proof", ownerOperatorSessionId: "operator" });
      for (const [id, role] of [["operator", "operator"], ["worker", "worker"]] as const) composition.database.insertMembership("proof", id, role);
      composition.database.updateChannelBroadcastPolicy("proof", "privileged");
      const connection = { authenticatedSessionId: "worker", credentials: new Map([["credential", "worker"]]), onClose: new Set() };

      await expect(composition.handler.send({ senderSessionId: "worker", channelId: "proof", target: { kind: "broadcast" }, body: "not allowed", context: { credential: "credential" }, __connection: connection } as never)).rejects.toMatchObject({ code: "broadcastRestricted" });
      const request = { channelId: "proof", senderSessionId: "worker", kind: "example.task.claim", payload: { taskId: "task-1" }, requestId: "request-1", context: { credential: "credential" }, __connection: connection };
      const first = await composition.handler.commitControl(request as never) as any;
      const duplicate = await composition.handler.commitControl(request as never) as any;

      expect(first.wasDeduplicated).toBe(false);
      expect(first.event).toMatchObject({ channelId: "proof", senderSessionId: "worker", kind: "example.task.claim", payload: { taskId: "task-1" }, requestId: "request-1" });
      expect(duplicate).toMatchObject({ wasDeduplicated: true, event: { id: first.event.id } });
      expect(composition.database.replay("0", "proof").filter((change) => change.kind === "control.committed")).toHaveLength(1);
      expect(composition.database.replay("0", "proof").filter((change) => change.kind === "message.sent")).toHaveLength(0);
      composition.database.close();
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  it("lets only an operator change the broadcast policy", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-native-policy-auth-"));
    try {
      setupMachineIdentity(stateDir);
      const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
      composition.database.insertSession({ id: "operator", role: "operator" });
      composition.database.insertSession({ id: "worker", role: "worker" });
      composition.database.insertChannel({ id: "proof", ownerOperatorSessionId: "operator" });
      composition.database.insertMembership("proof", "worker", "worker");
      const connection = { authenticatedSessionId: "worker", credentials: new Map([["credential", "worker"]]), onClose: new Set() };
      await expect(composition.handler.updateChannelBroadcastPolicy!({ channelId: "proof", broadcastPolicy: "privileged", context: { credential: "credential" }, __connection: connection } as never)).rejects.toMatchObject({ code: "unauthorized" });
      composition.database.close();
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  it("lets a non-owner operator who is an active member change the broadcast policy", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-native-policy-member-"));
    try {
      setupMachineIdentity(stateDir);
      const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
      composition.database.insertSession({ id: "retired-owner", role: "operator" });
      composition.database.insertSession({ id: "ui-operator", role: "operator" });
      composition.database.insertChannel({ id: "proof", ownerOperatorSessionId: "retired-owner" });
      composition.database.insertMembership("proof", "ui-operator", "operator");
      const connection = { authenticatedSessionId: "ui-operator", credentials: new Map([["credential", "ui-operator"]]), onClose: new Set() };
      await composition.handler.updateChannelBroadcastPolicy!({ channelId: "proof", broadcastPolicy: "privileged", context: { credential: "credential" }, __connection: connection } as never);
      expect(composition.database.currentChannel("proof")?.broadcastPolicy).toBe("privileged");
      composition.database.close();
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  it("rejects a broadcast when every recipient is runtime-less", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-native-empty-delivery-"));
    try {
      setupMachineIdentity(stateDir);
      const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
      for (const [id, role] of [["sender", "operator"], ["dead", "worker"]] as const) composition.database.insertSession({ id, role });
      composition.database.insertChannel({ id: "proof", ownerOperatorSessionId: "sender" });
      composition.database.insertMembership("proof", "sender", "operator");
      composition.database.insertMembership("proof", "dead", "worker");
      const connection = { authenticatedSessionId: "sender", credentials: new Map([["credential", "sender"]]), onClose: new Set() };
      vi.spyOn(composition.runtimeService as any, "resolveActiveSessionRuntime").mockImplementation(() => { throw Object.assign(new Error("missing"), { code: "runtimeNotFound" }); });
      await expect(composition.handler.send({ senderSessionId: "sender", channelId: "proof", target: { kind: "broadcast" }, body: "hello", context: { credential: "credential" }, __connection: connection } as never)).rejects.toMatchObject({ code: "noAcceptedRecipients" });
      composition.database.close();
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });
});

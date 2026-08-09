import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startNativeRooms } from "../../src/runtime/native/runtime.js";
import { createNativeComposition } from "../../src/runtime/native/composition.js";
import { setupMachineIdentity } from "../../src/identity/machine-identity.js";

const options = { endpoint: { kind: "unix" as const, path: "rooms.sock" }, databasePath: "/tmp/rooms.db", installSignalHandlers: false };

describe("native Rooms runtime", () => {
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

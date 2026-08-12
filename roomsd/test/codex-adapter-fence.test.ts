import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { CodexConversationAdapter, CodexRuntimeAdapter, createCodexAdapters } from "../src/runtime/codex-adapter.js";
import { migrate } from "../src/storage/migrations.js";
import { SQLiteBlueprintStore } from "../src/storage/blueprint-repository.js";

const lostFence = { token: "owner-a:key", assertCurrent: async () => { throw new Error("suspend lease lost"); } };

describe("native teardown fences", () => {
  it("blocks Codex runtime termination when ownership is lost", async () => {
    const kill = vi.fn();
    const child = { pid: 42, exitCode: null, signalCode: null, kill };
    const adapter = new CodexRuntimeAdapter((() => ({ process: child, runtimeId: "runtime-1" })) as any, undefined, token => token === lostFence.token);
    await adapter.launch({ channelId: "channel", priorSessionId: "prior", generation: 1, launch: { executable: "codex", args: ["exec", "prompt"], cwd: "/tmp" }, layout: { terminalColumns: null, terminalRows: null, layoutVersion: "1" }, adapterKind: "codex" });
    await expect(adapter.stopGeneration({ priorSessionId: "prior", generation: 1, fence: lostFence })).rejects.toThrow("suspend lease lost");
    expect(kill).not.toHaveBeenCalled();
  });

  it("injects the store-backed epoch verifier through production composition", async () => {
    const kill = vi.fn();
    const child = { pid: 44, exitCode: null, signalCode: null, kill };
    const adapters = createCodexAdapters({ verifyFenceToken: token => token === "owner:key:2" }, { spawnCodex: (() => ({ process: child, runtimeId: "runtime-2" })) as any });
    await adapters.runtime.launch({ channelId: "channel", priorSessionId: "prior", generation: 1, launch: { executable: "codex", args: ["exec", "prompt"], cwd: "/tmp" }, layout: { terminalColumns: null, terminalRows: null, layoutVersion: "1" }, adapterKind: "codex" });
    await expect(adapters.runtime.stopGeneration({ priorSessionId: "prior", generation: 1, fence: { token: "owner:key:1", assertCurrent: async () => {} } })).rejects.toThrow("stale teardown fence");
    expect(kill).not.toHaveBeenCalled();
  });

  it("blocks the composed adapter after durable release", async () => {
    const db = new DatabaseSync(":memory:"); migrate(db);
    const store = new SQLiteBlueprintStore(db);
    store.transaction(() => store.claimSuspend("channel", "key", {} as any, "owner"));
    const token = store.currentSuspendFenceToken("channel", "key", "owner")!;
    store.transaction(() => store.releaseSuspend("channel", "key", "owner"));
    const kill = vi.fn(); const child = { pid: 45, exitCode: null, signalCode: null, kill };
    const adapters = createCodexAdapters(store, { spawnCodex: (() => ({ process: child, runtimeId: "runtime-3" })) as any });
    await adapters.runtime.launch({ channelId: "channel", priorSessionId: "prior", generation: 1, launch: { executable: "codex", args: ["exec", "prompt"], cwd: "/tmp" }, layout: { terminalColumns: null, terminalRows: null, layoutVersion: "1" }, adapterKind: "codex" });
    await expect(adapters.runtime.stopGeneration({ priorSessionId: "prior", generation: 1, fence: { token, assertCurrent: async () => {} } })).rejects.toThrow("stale teardown fence");
    expect(kill).not.toHaveBeenCalled(); db.close();
  });

  it("blocks Codex provider termination when the durable token is absent", async () => {
    const kill = vi.fn();
    const child = { pid: 43, exitCode: null, signalCode: null, kill };
    const adapter = new CodexConversationAdapter(undefined, () => false);
    (adapter as any).active.set("conversation", child);
    await expect(adapter.stop({ conversationId: "conversation" }, { token: "forged", assertCurrent: async () => {} })).rejects.toThrow("stale teardown fence");
    expect(kill).not.toHaveBeenCalled();
  });

  it("treats missing durable ownership as already stopped after mass terminate", async () => {
    const kill = vi.fn();
    const child = { pid: 46, exitCode: null, signalCode: null, kill };
    const adapter = new CodexRuntimeAdapter((() => ({ process: child, runtimeId: "runtime-4" })) as any);
    await adapter.launch({ channelId: "channel", priorSessionId: "prior", generation: 1, launch: { executable: "codex", args: ["exec", "prompt"], cwd: "/tmp" }, layout: { terminalColumns: null, terminalRows: null, layoutVersion: "1" }, adapterKind: "codex" });
    (adapter as any).ownership.remove("prior", 1);
    await expect(adapter.stopGeneration({ priorSessionId: "prior", generation: 1, fence: { token: "any", assertCurrent: async () => {} } })).resolves.toBeUndefined();
    expect(kill).not.toHaveBeenCalled();
  });
});

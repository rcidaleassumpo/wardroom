import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createCodexAdapters, HeadlessProviderConversationAdapter, registeredHeadlessProviderContracts, type ProviderExecutableRegistration } from "../src/runtime/codex-adapter.js";

function child(stdout: string, stderr = "", exitCode = 0): any {
  const process = new EventEmitter() as any;
  process.pid = 42;
  process.exitCode = null;
  process.signalCode = null;
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.kill = vi.fn();
  queueMicrotask(() => {
    process.stdout.end(stdout);
    process.stderr.end(stderr);
    process.exitCode = exitCode;
    process.emit("close", exitCode, null);
  });
  return process;
}

const registrations: ProviderExecutableRegistration[] = [
  { name: "claude", executable: "/registered/claude" },
  { name: "grok", executable: "/registered/grok" },
];

describe("headless provider conversation drivers", () => {
  it("derives Claude resume behavior from its registered contract and returns the reply", async () => {
    const spawn = vi.fn(() => child(JSON.stringify({ type: "result", result: "claude reply" })));
    const adapters = createCodexAdapters({ verifyFenceToken: () => true }, { providerRegistrations: registrations, spawnConversation: spawn });
    const ref = { conversationId: "claude-session", resumeDescriptor: { provider: "claude", cwd: "/work", prompt: "wake claude" } };

    await expect(adapters.provider.resumeWithReply(ref, 3)).resolves.toBe("claude reply");
    expect(spawn).toHaveBeenCalledWith("/registered/claude", ["-p", "wake claude", "--resume", "claude-session", "--output-format", "json"], "/work");
  });

  it("derives Grok resume behavior from its registered contract and returns the reply", async () => {
    const spawn = vi.fn(() => child(JSON.stringify({ text: "grok reply", sessionId: "grok-session" })));
    const adapters = createCodexAdapters({ verifyFenceToken: () => true }, { providerRegistrations: registrations, spawnConversation: spawn });
    const ref = { conversationId: "grok-session", resumeDescriptor: { provider: "grok", cwd: "/work", prompt: "wake grok" } };

    await expect(adapters.provider.resumeWithReply(ref, 4)).resolves.toBe("grok reply");
    expect(spawn).toHaveBeenCalledWith("/registered/grok", ["--no-auto-update", "-p", "wake grok", "--resume", "grok-session", "--output-format", "json"], "/work");
  });

  it("validates descriptors without launching a provider", async () => {
    const spawn = vi.fn();
    const adapters = createCodexAdapters({ verifyFenceToken: () => true }, { providerRegistrations: registrations, spawnConversation: spawn });
    await adapters.provider.validateResume({ conversationId: "session", resumeDescriptor: { provider: "grok", cwd: "/work", prompt: "wake" } });
    expect(spawn).not.toHaveBeenCalled();
    await expect(adapters.provider.validateResume({ conversationId: "session", resumeDescriptor: { provider: "unknown", cwd: "/work", prompt: "wake" } })).rejects.toThrow("unsupported provider resume adapter unknown");
  });

  it("fails closed on provider errors and malformed replies", async () => {
    const failed = createCodexAdapters({ verifyFenceToken: () => true }, { providerRegistrations: registrations, spawnConversation: () => child("", "auth failed", 1) });
    await expect(failed.provider.resumeWithReply({ conversationId: "session", resumeDescriptor: { provider: "claude", cwd: "/work", prompt: "wake" } }, 1)).rejects.toThrow("claude resume exited 1: auth failed");
    const malformed = createCodexAdapters({ verifyFenceToken: () => true }, { providerRegistrations: registrations, spawnConversation: () => child("{}") });
    await expect(malformed.provider.resumeWithReply({ conversationId: "session", resumeDescriptor: { provider: "grok", cwd: "/work", prompt: "wake" } }, 1)).rejects.toThrow("Grok resume returned no agent message");
  });

  it("registers only provider contracts present in machine-owned state", () => {
    expect(registeredHeadlessProviderContracts([{ name: "claude", executable: "/registered/claude" }]).map(contract => contract.provider)).toEqual(["claude"]);
  });

  it("keeps headless provider teardown behind the durable fence", async () => {
    const process = child("");
    process.exitCode = null;
    const contract = registeredHeadlessProviderContracts([{ name: "grok", executable: "/registered/grok" }])[0]!;
    const driver = new HeadlessProviderConversationAdapter(contract, () => false);
    (driver as any).active.set("grok-session", { process, generation: 2 });
    await expect(driver.stop({ conversationId: "grok-session" }, { token: "stale", assertCurrent: async () => {} })).rejects.toThrow("stale teardown fence");
    expect(process.kill).not.toHaveBeenCalled();
  });
});

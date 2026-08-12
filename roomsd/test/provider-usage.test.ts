import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProviderUsage } from "../src/runtime/provider-usage.js";
import { RoomsRepository } from "../src/storage/repository.js";
import { RuntimeRepository } from "../src/storage/runtime-repository.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function bind(repository: RoomsRepository, sessionId: string, adapterKind: string, transcript: string, generation = 1) {
  const dir = mkdtempSync(join(tmpdir(), "rooms-usage-")); dirs.push(dir);
  const file = join(dir, `${sessionId}.jsonl`); writeFileSync(file, transcript);
  repository.insertSession({ id: sessionId, role: "worker" });
  const runtimes = new RuntimeRepository(repository.db);
  runtimes.create({ runtimeId: `runtime-${sessionId}`, homeAuthorityId: "home", sessionId, generation, protocolVersion: 1, transportKind: "localPty", machineId: "machine", providerThreadId: file, reconnectSecret: new Uint8Array(32) });
  runtimes.markState(`runtime-${sessionId}`, generation, "running");
  runtimes.bind({ bindingId: `binding-${sessionId}`, runtimeId: `runtime-${sessionId}`, homeAuthorityId: "home", sessionId, generation, channelId: null, adapterKind, handleRef: "unix:///tmp/fake", launchPolicyRef: null });
}

describe("provider session usage", () => {
  it("uses the latest truthful Codex cumulative token report", () => {
    expect(resolveProviderUsage("codex", [{ timestamp: "2026-01-01", payload: { info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, total_tokens: 120 } } } }])).toMatchObject({ status: "available", inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, totalTokens: 120 });
  });

  it("sums Claude provider-reported turn usage", () => {
    expect(resolveProviderUsage("claude", [{ message: { usage: { input_tokens: 10, cache_read_input_tokens: 4, output_tokens: 5 } } }, { message: { usage: { input_tokens: 20, cache_read_input_tokens: 8, output_tokens: 7 } } }])).toMatchObject({ status: "available", inputTokens: 30, cachedInputTokens: 12, outputTokens: 12, totalTokens: 42 });
  });

  it("binds usage collection to the queried session and never another transcript", () => {
    const repository = new RoomsRepository(":memory:");
    try {
      bind(repository, "agent-a", "codex", `${JSON.stringify({ payload: { info: { total_token_usage: { input_tokens: 11, cached_input_tokens: 3, output_tokens: 2, total_tokens: 13 } } } })}\n`);
      bind(repository, "agent-b", "codex", `${JSON.stringify({ payload: { info: { total_token_usage: { input_tokens: 99, cached_input_tokens: 9, output_tokens: 1, total_tokens: 100 } } } })}\n`);
      expect(repository.usageSeries("session", "agent-a", "15m", true).points.at(-1)).toMatchObject({ state: "available", totalTokens: 13 });
      expect(repository.usageSeries("session", "agent-b", "15m", true).points.at(-1)).toMatchObject({ state: "available", totalTokens: 100 });
    } finally { repository.close(); }
  });

  it("returns explicit unsupported and unavailable states", () => {
    expect(resolveProviderUsage("grok", [])).toMatchObject({ status: "unsupported" });
    expect(resolveProviderUsage("codex", [])).toMatchObject({ status: "unavailable" });
  });
});

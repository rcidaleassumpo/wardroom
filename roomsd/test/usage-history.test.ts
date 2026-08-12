import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomsRepository } from "../src/storage/repository.js";
import type { ProviderUsage } from "../src/runtime/provider-usage.js";
import { runRoomsCLI } from "../src/cli/main.js";
import type { RoomsCLIBackend } from "../src/cli/backend.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const available = (total: number): ProviderUsage => ({ status: "available", inputTokens: total - 2, cachedInputTokens: 1, outputTokens: 2, totalTokens: total, updatedAt: null, reason: "provider-reported" });

function fixture(options: ConstructorParameters<typeof RoomsRepository>[1] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rooms-usage-history-")); dirs.push(dir);
  const path = join(dir, "rooms.sqlite");
  const repository = new RoomsRepository(path, options);
  repository.db.prepare("INSERT INTO sessions(id, registered_at, role) VALUES ('session-a', ?, 'worker')").run(new Date().toISOString());
  repository.db.prepare("INSERT INTO channels(id, registered_at) VALUES ('channel-a', ?)").run(new Date().toISOString());
  repository.db.prepare("INSERT INTO memberships(channel_id, session_id, joined_at, role) VALUES ('channel-a', 'session-a', ?, 'worker')").run(new Date().toISOString());
  runtime(repository, "runtime-1", 1, "thread-a", "codex");
  return { repository, path };
}

function runtime(repository: RoomsRepository, runtimeId: string, generation: number, threadId: string, adapter: string) {
  const at = new Date().toISOString();
  repository.db.prepare(`INSERT INTO runtimes(runtime_id, home_authority_id, session_id, generation, protocol_version, transport_kind, state, machine_id, reconnect_secret_hash, provider_thread_id, created_at, updated_at)
    VALUES (?, 'home', 'session-a', ?, 4, 'localPty', 'running', 'machine', 'hash', ?, ?, ?)`).run(runtimeId, generation, threadId, at, at);
  repository.db.prepare(`INSERT INTO runtime_bindings(binding_id, runtime_id, home_authority_id, session_id, generation, channel_id, adapter_kind, handle_ref, bound_at)
    VALUES (?, ?, 'home', 'session-a', ?, 'channel-a', ?, ?, ?)`).run(`binding-${runtimeId}`, runtimeId, generation, adapter, threadId, at);
}

describe("Rooms provider usage history", () => {
  it.each([["session", "session-a", "6h"], ["channel", "channel-a", "24h"]] as const)("routes the public %s query API", async (scope, id, window) => {
    const usageSeries = vi.fn(async () => ({ scope, id, window, points: [] }));
    const unused = async (): Promise<never> => { throw new Error("unused"); };
    const backend = { createChannel: unused, listChannels: unused, channelStatus: unused, suspendChannel: unused, resumeChannel: unused, createSession: unused, commitMessage: unused, sendPrompt: unused, usageSeries } as RoomsCLIBackend;
    expect(JSON.parse(await runRoomsCLI([scope, "usage", id, "--window", window], backend))).toMatchObject({ scope, id, window });
    expect(usageSeries).toHaveBeenCalledWith(scope, id, window, false);
  });

  it("routes runtime collection opt-in through the public CLI", async () => {
    const usageSeries = vi.fn(async () => ({ state: "available", points: [] }));
    const unused = async (): Promise<never> => { throw new Error("unused"); };
    const backend = { createChannel: unused, listChannels: unused, channelStatus: unused, suspendChannel: unused, resumeChannel: unused, createSession: unused, commitMessage: unused, sendPrompt: unused, usageSeries } as RoomsCLIBackend;
    await runRoomsCLI(["session", "usage", "session-a", "--collect", "true"], backend);
    expect(usageSeries).toHaveBeenCalledWith("session", "session-a", "1h", true);
  });

  it("persists samples across restart and derives reset-safe deltas", () => {
    let current = new Date("2026-08-12T10:00:00.000Z");
    const values = [available(10), available(18), available(4)];
    const { repository, path } = fixture({ usageHistory: { now: () => current, minSampleIntervalMs: 1 }, providerUsage: () => values.shift()! });
    repository.usageSeries("session", "session-a", "1h", true); current = new Date(current.getTime() + 1_000);
    repository.usageSeries("session", "session-a", "1h", true); current = new Date(current.getTime() + 1_000);
    repository.usageSeries("session", "session-a", "1h", true);
    repository.close();
    const reopened = new RoomsRepository(path, { usageHistory: { now: () => current }, providerUsage: () => available(4) });
    const result = reopened.usageHistory.query("session", "session-a", "1h");
    expect(result.points.map((point) => [point.totalTokens, point.deltaTotalTokens, point.counterReset])).toEqual([[10, 0, false], [18, 8, false], [4, 0, true]]);
    reopened.close();
  });

  it("uses the last pre-window sample as the first interval baseline", () => {
    let current = new Date("2026-08-12T08:00:00.000Z");
    const values = [available(10), available(25)];
    const { repository } = fixture({ usageHistory: { now: () => current, minSampleIntervalMs: 1 }, providerUsage: () => values.shift()! });
    repository.usageSeries("session", "session-a", "1h", true);
    current = new Date("2026-08-12T10:00:00.000Z");
    repository.usageSeries("session", "session-a", "1h", true);
    const result = repository.usageHistory.query("session", "session-a", "1h");
    expect(result.points).toHaveLength(1);
    expect(result.points[0]).toMatchObject({ totalTokens: 25, deltaTotalTokens: 15 });
    repository.close();
  });

  it("does not read or store provider usage during ordinary session inspection", () => {
    let reads = 0;
    const { repository } = fixture({ providerUsage: () => { reads += 1; return available(10); } });
    expect(repository.inspectSession("session-a").runtime?.usage).toMatchObject({ status: "unavailable", reason: "usage-history-query-required" });
    expect(reads).toBe(0);
    expect(repository.db.prepare("SELECT COUNT(*) count FROM provider_usage_samples").get()).toMatchObject({ count: 0 });
    repository.close();
  });

  it("defaults to privacy and performs no provider read or write without opt-in", () => {
    let reads = 0;
    const { repository } = fixture({ providerUsage: () => { reads += 1; return available(10); } });
    expect(repository.usageSeries("session", "session-a", "15m")).toMatchObject({ state: "privacy", reason: "usage-history-opt-in-required", points: [] });
    expect(reads).toBe(0);
    expect(repository.db.prepare("SELECT COUNT(*) count FROM provider_usage_samples").get()).toMatchObject({ count: 0 });
    repository.close();
  });

  it("toggles collection per query without a daemon or repository restart", () => {
    let reads = 0;
    const { repository } = fixture({ providerUsage: () => { reads += 1; return available(10); } });
    expect(repository.usageSeries("session", "session-a", "15m", false).state).toBe("privacy");
    expect(repository.usageSeries("session", "session-a", "15m", true).state).toBe("available");
    expect(repository.usageSeries("session", "session-a", "15m", false).state).toBe("privacy");
    expect(reads).toBe(1);
    expect(repository.db.prepare("SELECT COUNT(*) count FROM provider_usage_samples").get()).toMatchObject({ count: 1 });
    repository.close();
  });

  it("keeps generations separate and samples only each exact binding", () => {
    let current = new Date("2026-08-12T10:00:00.000Z");
    const seen: Array<[string | null, string | null]> = [];
    const { repository } = fixture({ usageHistory: { now: () => current, minSampleIntervalMs: 1 }, providerUsage: (adapter, thread) => { seen.push([adapter, thread]); return available(thread === "thread-b" ? 30 : 10); } });
    repository.usageSeries("channel", "channel-a", "1h", true);
    repository.db.prepare("UPDATE runtimes SET state='exited', ended_at=? WHERE runtime_id='runtime-1'").run(current.toISOString());
    runtime(repository, "runtime-2", 2, "thread-b", "claude"); current = new Date(current.getTime() + 1_000);
    const result = repository.usageSeries("channel", "channel-a", "1h", true);
    expect(seen).toEqual([["codex", "thread-a"], ["claude", "thread-b"]]);
    expect(result.points.map((point) => [point.runtimeId, point.generation, point.deltaTotalTokens])).toEqual([["runtime-1", 1, 0], ["runtime-2", 2, 0]]);
    repository.close();
  });

  it("bounds retention and never invokes an adapter when privacy disables collection", () => {
    let current = new Date("2026-08-12T10:00:00.000Z");
    let reads = 0;
    const { repository } = fixture({ usageHistory: { now: () => current, retentionMs: 60_000, minSampleIntervalMs: 1 }, providerUsage: () => { reads += 1; return available(10); } });
    repository.usageSeries("session", "session-a", "1h", true); current = new Date(current.getTime() + 61_000);
    repository.usageSeries("session", "session-a", "1h", true);
    expect(repository.usageHistory.query("session", "session-a", "1h").points).toHaveLength(1);
    repository.close();

    const privateFixture = fixture({ usageHistory: { now: () => current }, providerUsage: () => { reads += 100; return available(99); } });
    const result = privateFixture.repository.usageSeries("session", "session-a", "15m");
    expect(reads).toBe(2);
    expect(result).toMatchObject({ state: "privacy", reason: "usage-history-opt-in-required" });
    privateFixture.repository.close();
  });

  it("coalesces samples to retain a full busy window within its computed bound", () => {
    let current = new Date("2026-08-12T10:00:00.000Z");
    let total = 10;
    const { repository } = fixture({ usageHistory: { now: () => current, retentionMs: 120_000, minSampleIntervalMs: 60_000 }, providerUsage: () => available(total++) });
    for (let index = 0; index < 5; index += 1) { repository.usageSeries("session", "session-a", "1h", true); current = new Date(current.getTime() + 30_000); }
    expect(repository.usageHistory.query("session", "session-a", "1h").points.map((point) => point.totalTokens)).toEqual([11, 13, 14]);
    repository.close();
  });

  it("retains every hourly sample across seven busy days plus its baseline", () => {
    let current = new Date("2026-08-05T10:00:00.000Z");
    let total = 0;
    const { repository } = fixture({ usageHistory: { now: () => current, minSampleIntervalMs: 3_600_000 }, providerUsage: () => available(total += 10) });
    for (let hour = 0; hour <= 168; hour += 1) {
      repository.usageSeries("session", "session-a", "7d", true);
      current = new Date(current.getTime() + 3_600_000);
    }
    const stored = repository.db.prepare("SELECT COUNT(*) count FROM provider_usage_samples WHERE session_id='session-a'").get() as { count: number };
    const result = repository.usageHistory.query("session", "session-a", "7d");
    expect(stored.count).toBe(169);
    expect(result.points).toHaveLength(168);
    expect(result.points[0]?.deltaTotalTokens).toBe(10);
    repository.close();
  });

  it("reports unsupported and unavailable adapter states without fabricating counters", () => {
    const { repository } = fixture({ usageHistory: { minSampleIntervalMs: 1 }, providerUsage: (adapter) => adapter === "gemini"
      ? { status: "unsupported", inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null, updatedAt: null, reason: "provider-usage-unsupported" }
      : { status: "unavailable", inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null, updatedAt: null, reason: "provider-usage-not-reported" } });
    repository.db.prepare("UPDATE runtime_bindings SET adapter_kind='gemini' WHERE runtime_id='runtime-1'").run();
    expect(repository.usageSeries("session", "session-a", "15m", true)).toMatchObject({ state: "unsupported", reason: "provider-usage-unsupported" });
    repository.db.prepare("UPDATE runtime_bindings SET adapter_kind='codex' WHERE runtime_id='runtime-1'").run();
    expect(repository.usageSeries("session", "session-a", "15m", true)).toMatchObject({ state: "unavailable", reason: "provider-usage-not-reported" });
    repository.close();
  });
});

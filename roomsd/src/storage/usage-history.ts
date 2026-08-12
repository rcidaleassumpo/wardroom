import type { DatabaseSync } from "node:sqlite";
import type { ProviderUsage } from "../runtime/provider-usage.js";
import { RoomsStoreError } from "./repository.js";

export const USAGE_WINDOWS = ["15m", "1h", "6h", "24h", "7d"] as const;
export type UsageWindow = typeof USAGE_WINDOWS[number];
export type UsageState = ProviderUsage["status"] | "privacy";
export type UsagePoint = Readonly<{ sampledAt: string; sessionId: string; runtimeId: string; generation: number; adapterKind: string; state: UsageState; reason: string; counterReset: boolean; inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null; totalTokens: number | null; deltaInputTokens: number; deltaCachedInputTokens: number; deltaOutputTokens: number; deltaTotalTokens: number }>;
export type UsageSeries = Readonly<{ scope: "session" | "channel"; id: string; window: UsageWindow; state: UsageState; reason: string; points: UsagePoint[]; sampledThrough: string }>;

const WINDOW_MS: Record<UsageWindow, number> = { "15m": 900_000, "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000, "7d": 604_800_000 };
type Row = Record<string, unknown>;
const numberOrNull = (value: unknown) => value == null ? null : Number(value);

export class UsageHistoryRepository {
  constructor(private readonly db: DatabaseSync, private readonly options: Readonly<{ now?: () => Date; retentionMs?: number; minSampleIntervalMs?: number }> = {}) {}

  privacySeries(scope: "session" | "channel", id: string, window: string): UsageSeries {
    if (!USAGE_WINDOWS.includes(window as UsageWindow)) throw new RoomsStoreError("unsupportedUsageWindow", `unsupported usage window \"${window}\"`);
    return { scope, id, window: window as UsageWindow, state: "privacy", reason: "usage-history-opt-in-required", points: [], sampledThrough: (this.options.now?.() ?? new Date()).toISOString() };
  }

  record(input: Readonly<{ channelId: string | null; sessionId: string; runtimeId: string; generation: number; adapterKind: string; providerThreadId: string | null; usage: ProviderUsage }>): void {
    const sampledAt = (this.options.now?.() ?? new Date()).toISOString();
    const usage = input.usage;
    const prior = this.db.prepare(`SELECT sample_id, sampled_at, generation, input_tokens, cached_input_tokens, output_tokens, total_tokens, counter_reset FROM provider_usage_samples
      WHERE session_id=? AND runtime_id=? ORDER BY sampled_at DESC, sample_id DESC LIMIT 1`).get(input.sessionId, input.runtimeId) as Row | undefined;
    const values = [usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, usage.totalTokens];
    const priorValues = prior ? [prior.input_tokens, prior.cached_input_tokens, prior.output_tokens, prior.total_tokens].map(numberOrNull) : [];
    const reset = Boolean(prior && (Number(prior.generation) !== input.generation || values.some((value, index) => value != null && priorValues[index] != null && value < priorValues[index]!)));
    const minSampleIntervalMs = positive(this.options.minSampleIntervalMs ?? Number(process.env.ROOMS_USAGE_MIN_SAMPLE_INTERVAL_MS ?? 60_000), 60_000);
    const coalesce = prior && Number(prior.generation) === input.generation && Date.parse(sampledAt) - Date.parse(String(prior.sampled_at)) < minSampleIntervalMs;
    if (coalesce) {
      this.db.prepare(`UPDATE provider_usage_samples SET channel_id=?, adapter_kind=?, provider_thread_id=?, status=?, reason=?, input_tokens=?, cached_input_tokens=?, output_tokens=?, total_tokens=?, counter_reset=? WHERE sample_id=?`)
        .run(input.channelId, input.adapterKind, input.providerThreadId, usage.status, usage.reason, ...values, reset || Boolean(prior.counter_reset) ? 1 : 0, prior.sample_id as number);
    } else {
      this.db.prepare(`INSERT INTO provider_usage_samples(channel_id, session_id, runtime_id, generation, adapter_kind, provider_thread_id, status, reason, input_tokens, cached_input_tokens, output_tokens, total_tokens, counter_reset, sampled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.channelId, input.sessionId, input.runtimeId, input.generation, input.adapterKind, input.providerThreadId, usage.status, usage.reason, ...values, reset ? 1 : 0, sampledAt);
    }
    const retentionMs = this.options.retentionMs ?? Number(process.env.ROOMS_USAGE_RETENTION_MS ?? 604_800_000);
    const retainedWindowMs = positive(retentionMs, 604_800_000);
    const cutoff = new Date((this.options.now?.() ?? new Date()).getTime() - retainedWindowMs - minSampleIntervalMs).toISOString();
    this.db.prepare("DELETE FROM provider_usage_samples WHERE sampled_at < ?").run(cutoff);
    const maxSamples = Math.ceil(retainedWindowMs / minSampleIntervalMs) + 2;
    this.db.prepare(`DELETE FROM provider_usage_samples WHERE session_id=? AND sample_id NOT IN (
      SELECT sample_id FROM provider_usage_samples WHERE session_id=? ORDER BY sampled_at DESC, sample_id DESC LIMIT ?
    )`).run(input.sessionId, input.sessionId, maxSamples);
  }

  query(scope: "session" | "channel", id: string, window: string): UsageSeries {
    if (!USAGE_WINDOWS.includes(window as UsageWindow)) throw new RoomsStoreError("unsupportedUsageWindow", `unsupported usage window \"${window}\"`);
    const now = this.options.now?.() ?? new Date();
    const since = new Date(now.getTime() - WINDOW_MS[window as UsageWindow]).toISOString();
    const column = scope === "session" ? "session_id" : "channel_id";
    const rows = this.db.prepare(`SELECT * FROM provider_usage_samples WHERE ${column}=? AND sampled_at>=? ORDER BY sampled_at, sample_id`).all(id, since) as Row[];
    const previous = new Map<string, UsagePoint>();
    const baselines = this.db.prepare(`SELECT * FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY runtime_id, generation ORDER BY sampled_at DESC, sample_id DESC) AS rank
      FROM provider_usage_samples WHERE ${column}=? AND sampled_at<?
    ) WHERE rank=1`).all(id, since) as Row[];
    for (const row of baselines) previous.set(`${row.runtime_id}:${row.generation}`, rowPoint(row, undefined));
    const points = rows.map((row): UsagePoint => {
      const key = `${row.runtime_id}:${row.generation}`;
      const point = rowPoint(row, previous.get(key));
      previous.set(key, point);
      return point;
    });
    const latest = points.at(-1);
    return { scope, id, window: window as UsageWindow, state: latest?.state ?? "unavailable", reason: latest?.reason ?? "usage-history-empty", points, sampledThrough: now.toISOString() };
  }
}

function positive(value: number, fallback: number): number { return Number.isSafeInteger(value) && value > 0 ? value : fallback; }
function rowPoint(row: Row, prior: UsagePoint | undefined): UsagePoint {
  const current = { inputTokens: numberOrNull(row.input_tokens), cachedInputTokens: numberOrNull(row.cached_input_tokens), outputTokens: numberOrNull(row.output_tokens), totalTokens: numberOrNull(row.total_tokens) };
  const reset = Boolean(row.counter_reset);
  const delta = (value: number | null, old: number | null | undefined) => value == null || old == null || reset ? 0 : Math.max(0, value - old);
  return { sampledAt: String(row.sampled_at), sessionId: String(row.session_id), runtimeId: String(row.runtime_id), generation: Number(row.generation), adapterKind: String(row.adapter_kind), state: row.status as UsageState, reason: String(row.reason), counterReset: reset, ...current, deltaInputTokens: delta(current.inputTokens, prior?.inputTokens), deltaCachedInputTokens: delta(current.cachedInputTokens, prior?.cachedInputTokens), deltaOutputTokens: delta(current.outputTokens, prior?.outputTokens), deltaTotalTokens: delta(current.totalTokens, prior?.totalTokens) };
}

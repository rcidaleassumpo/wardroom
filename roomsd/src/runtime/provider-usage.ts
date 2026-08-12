import { loadProviderTranscriptLines } from "./provider-turn.js";

export type ProviderUsage = Readonly<{
  status: "available" | "unavailable" | "unsupported";
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  updatedAt: string | null;
  reason: string;
}>;

type UsageLine = Record<string, any>;
const cache = new Map<string, { expiresAt: number; usage: ProviderUsage }>();
const CACHE_MS = 1_000;

const empty = (status: ProviderUsage["status"], reason: string): ProviderUsage => ({ status, inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null, updatedAt: null, reason });
const finite = (value: unknown): number | null => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;

export function resolveProviderUsage(adapterKind: string | null, lines: readonly UsageLine[]): ProviderUsage {
  if (adapterKind !== "codex" && adapterKind !== "claude") return empty("unsupported", "provider-usage-unsupported");
  if (adapterKind === "codex") {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!;
      const raw = line.payload?.info?.total_token_usage ?? line.payload?.total_token_usage ?? line.usage;
      if (!raw) continue;
      const inputTokens = finite(raw.input_tokens);
      const cachedInputTokens = finite(raw.cached_input_tokens) ?? 0;
      const outputTokens = finite(raw.output_tokens);
      const totalTokens = finite(raw.total_tokens) ?? (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null);
      if (inputTokens == null || outputTokens == null || totalTokens == null) continue;
      return { status: "available", inputTokens, cachedInputTokens, outputTokens, totalTokens, updatedAt: line.timestamp ?? line.ts ?? null, reason: "provider-reported" };
    }
    return empty("unavailable", "provider-usage-not-reported");
  }

  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let found = false;
  let updatedAt: string | null = null;
  for (const line of lines) {
    const raw = line.message?.usage ?? line.usage;
    if (!raw) continue;
    const input = finite(raw.input_tokens);
    const cached = finite(raw.cache_read_input_tokens ?? raw.cached_input_tokens) ?? 0;
    const output = finite(raw.output_tokens);
    if (input == null || output == null) continue;
    found = true;
    inputTokens += input;
    cachedInputTokens += cached;
    outputTokens += output;
    updatedAt = line.timestamp ?? line.ts ?? updatedAt;
  }
  return found
    ? { status: "available", inputTokens, cachedInputTokens, outputTokens, totalTokens: inputTokens + outputTokens, updatedAt, reason: "provider-reported" }
    : empty("unavailable", "provider-usage-not-reported");
}

export function providerSessionUsage(adapterKind: string | null, providerThreadId: string | null): ProviderUsage {
  if (adapterKind !== "codex" && adapterKind !== "claude") return empty("unsupported", "provider-usage-unsupported");
  if (!providerThreadId) return empty("unavailable", "provider-session-not-bound");
  const key = `${adapterKind}:${providerThreadId}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.usage;
  const usage = resolveProviderUsage(adapterKind, loadProviderTranscriptLines(adapterKind, providerThreadId));
  cache.set(key, { expiresAt: Date.now() + CACHE_MS, usage });
  return usage;
}

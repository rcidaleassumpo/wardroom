// SPDX-License-Identifier: Apache-2.0

export interface ProviderModelCatalogEntry {
  id: string;
  label: string;
  aliases: string[];
  reasoningLevels: string[];
  availability: "available" | "unavailable";
  deprecated: boolean;
}

export interface ProviderModelCatalog {
  version: string;
  provider: "codex" | "claude";
  sourceUrl: string;
  verifiedAt: string;
  state: "fresh" | "stale";
  models: ProviderModelCatalogEntry[];
}

const VERSION = "2026-08-12";
const VERIFIED_AT = "2026-08-12T00:00:00.000Z";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

const OFFICIAL: Record<"codex" | "claude", Omit<ProviderModelCatalog, "state">> = {
  codex: {
    version: VERSION,
    provider: "codex",
    sourceUrl: "https://developers.openai.com/codex/models",
    verifiedAt: VERIFIED_AT,
    models: [
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", aliases: ["gpt-5.6"], reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"], availability: "available", deprecated: false },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", aliases: [], reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"], availability: "available", deprecated: false },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", aliases: [], reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"], availability: "available", deprecated: false },
    ],
  },
  claude: {
    version: VERSION,
    provider: "claude",
    sourceUrl: "https://docs.anthropic.com/en/docs/claude-code/model-config",
    verifiedAt: VERIFIED_AT,
    models: ["fable", "haiku", "opus", "sonnet"].map(id => ({ id, label: id[0]!.toUpperCase() + id.slice(1), aliases: [], reasoningLevels: [], availability: "available", deprecated: false })),
  },
};

export function providerModelCatalog(provider: string, _stateDir: string, now = new Date()): ProviderModelCatalog | null {
  if (provider !== "codex" && provider !== "claude") return null;
  const catalog = OFFICIAL[provider];
  const age = now.getTime() - Date.parse(catalog.verifiedAt);
  return { ...catalog, state: Number.isFinite(age) && age <= MAX_AGE_MS ? "fresh" : "stale" };
}

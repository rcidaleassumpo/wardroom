import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { providerModelCatalog } from "../src/providers/model-catalog.js";

describe("provider model catalog", () => {
  it("owns exact official Codex and Claude values with source metadata", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-model-catalog-"));
    try {
      const codex = providerModelCatalog("codex", stateDir, new Date("2026-08-12T12:00:00Z"))!;
      expect(codex).toMatchObject({ version: "2026-08-12", sourceUrl: "https://developers.openai.com/codex/models", state: "fresh" });
      expect(codex.models.map(model => [model.id, model.aliases])).toEqual([
        ["gpt-5.6-sol", ["gpt-5.6"]], ["gpt-5.6-terra", []], ["gpt-5.6-luna", []],
      ]);
      expect(codex.models.every(model => JSON.stringify(model.reasoningLevels) === JSON.stringify(["none", "low", "medium", "high", "xhigh", "max"]))).toBe(true);
      expect(providerModelCatalog("claude", stateDir)!.models.map(model => model.id)).toEqual(["fable", "haiku", "opus", "sonnet"]);
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  it("returns the unchanged shipped snapshot when stale and offline", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-model-cache-"));
    try {
      expect(providerModelCatalog("codex", stateDir, new Date("2027-01-01T00:00:00Z"))!.state).toBe("stale");
      const later = providerModelCatalog("codex", stateDir, new Date("2027-01-02T00:00:00Z"))!;
      expect(later).toMatchObject({ state: "stale", verifiedAt: "2026-08-12T00:00:00.000Z" });
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });
});

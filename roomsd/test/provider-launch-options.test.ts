import { describe, expect, it } from "vitest";
import { providerLaunchArguments, providerLaunchOptionsSchema } from "../src/cli/provider-launch-options.js";

describe("provider launch option contract", () => {
  it("publishes valid values without provider auth or CLI flags", () => {
    const schema = providerLaunchOptionsSchema("gemini");
    expect(schema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        permissions: expect.objectContaining({ enum: ["headless", "manual"], default: "headless" }),
        model: expect.objectContaining({ type: "string" }),
      },
    });
    expect(JSON.stringify(schema)).not.toMatch(/api.?key|token|auth|--approval-mode/i);
  });

  it("validates options and translates Gemini through the agy adapter", () => {
    expect(providerLaunchArguments("gemini", "agy", { permissions: "headless", model: "gemini-2.5-pro" })).toEqual([
      "--model", "gemini-2.5-pro", "--approval-mode", "yolo",
    ]);
    expect(() => providerLaunchArguments("gemini", "agy", { reasoningEffort: "high" })).toThrow(/unsupported gemini launch option/);
    expect(() => providerLaunchArguments("gemini", "agy", { permissions: "unsafe" })).toThrow(/expected headless, manual/);
  });

  it("merges stored defaults with per-launch overrides", () => {
    expect(providerLaunchArguments("codex", "codex", { reasoningEffort: "low" }, { permissions: "manual", model: "gpt-default" })).toEqual([
      "-c", "model_reasoning_effort=low", "--model", "gpt-default",
    ]);
  });
});

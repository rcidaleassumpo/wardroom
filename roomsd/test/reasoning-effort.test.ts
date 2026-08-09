import { describe, expect, it } from "vitest";
import {
  argsAlreadySetReasoningEffort,
  parseReasoningEffort,
  providerHonorsReasoningEffort,
  reasoningEffortArguments,
  REASONING_EFFORTS,
} from "../src/cli/reasoning-effort.js";
import { withReasoningEffort } from "../src/cli/main.js";

describe("reasoning effort parsing", () => {
  it("accepts the documented values", () => {
    for (const value of REASONING_EFFORTS) {
      expect(parseReasoningEffort(value)).toBe(value);
    }
  });

  it("rejects anything else instead of silently defaulting", () => {
    for (const value of ["", "LOW", "lowest", "1", "none", "max"]) {
      expect(() => parseReasoningEffort(value)).toThrow(/--effort must be one of low, medium, high/);
    }
  });
});

describe("per-provider forwarding", () => {
  it("forwards codex effort as a config override", () => {
    expect(reasoningEffortArguments("codex", "low")).toEqual(["-c", "model_reasoning_effort=low"]);
  });

  it("forwards grok effort as its own flag", () => {
    expect(reasoningEffortArguments("grok", "high")).toEqual(["--reasoning-effort", "high"]);
  });

  it("fails closed for a provider with no such flag", () => {
    // The defect this ticket was filed about: a dropped request ran at the
    // preset default instead of the requested effort.
    expect(providerHonorsReasoningEffort("claude")).toBe(false);
    expect(() => reasoningEffortArguments("claude", "low")).toThrow(/claude does not accept an explicit reasoning effort/);
    expect(() => reasoningEffortArguments("claude", "low")).toThrow(/codex, grok/);
  });

  it("reports which providers can honor it", () => {
    expect(providerHonorsReasoningEffort("codex")).toBe(true);
    expect(providerHonorsReasoningEffort("grok")).toBe(true);
  });
});

describe("withReasoningEffort", () => {
  it("leaves arguments untouched when no effort is requested", () => {
    expect(withReasoningEffort("codex", ["--verbose"], undefined)).toEqual(["--verbose"]);
    expect(withReasoningEffort("claude", ["--verbose"], undefined)).toEqual(["--verbose"]);
  });

  it("prepends the override so it beats preset and global defaults", () => {
    expect(withReasoningEffort("codex", ["--verbose"], "medium")).toEqual(["-c", "model_reasoning_effort=medium", "--verbose"]);
    expect(withReasoningEffort("grok", ["--verbose"], "low")).toEqual(["--reasoning-effort", "low", "--verbose"]);
  });

  it("keeps a caller's own provider flag rather than fighting it", () => {
    expect(withReasoningEffort("grok", ["--reasoning-effort", "high"], "low")).toEqual(["--reasoning-effort", "high"]);
    expect(withReasoningEffort("grok", ["--effort=high"], "low")).toEqual(["--effort=high"]);
    expect(withReasoningEffort("codex", ["-c", "model_reasoning_effort=high"], "low")).toEqual(["-c", "model_reasoning_effort=high"]);
  });

  it("propagates the fail-closed error through the launch path", () => {
    expect(() => withReasoningEffort("claude", [], "low")).toThrow(/does not accept an explicit reasoning effort/);
  });

  it("rejects an invalid value before building any command", () => {
    expect(() => withReasoningEffort("codex", [], "extreme")).toThrow(/--effort must be one of/);
  });
});

describe("detecting a caller-supplied effort flag", () => {
  it("recognizes both grok spellings and codex config forms", () => {
    expect(argsAlreadySetReasoningEffort("grok", ["--reasoning-effort", "low"])).toBe(true);
    expect(argsAlreadySetReasoningEffort("grok", ["--effort", "low"])).toBe(true);
    expect(argsAlreadySetReasoningEffort("codex", ["-c", "model_reasoning_effort=low"])).toBe(true);
    expect(argsAlreadySetReasoningEffort("codex", ["--config", "model_reasoning_effort=low"])).toBe(true);
  });

  it("does not mistake an unrelated flag for one", () => {
    expect(argsAlreadySetReasoningEffort("grok", ["--model", "grok-4"])).toBe(false);
    expect(argsAlreadySetReasoningEffort("codex", ["-c", "model=gpt-5"])).toBe(false);
    expect(argsAlreadySetReasoningEffort("claude", ["--effort", "low"])).toBe(false);
  });
});

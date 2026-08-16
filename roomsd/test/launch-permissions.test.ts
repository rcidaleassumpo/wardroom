import { describe, expect, it } from "vitest";
import { argsAlreadySetPermissions, launchPermissionArguments, parseLaunchPermissionMode } from "../src/cli/launch-permissions.js";

describe("unattended launch permission handling", () => {
  it("gives every provider a way to answer its own permission prompts", () => {
    expect(launchPermissionArguments("claude", [], "headless")).toEqual(["--dangerously-skip-permissions"]);
    expect(launchPermissionArguments("codex", [], "headless")).toEqual(["--yolo", "--dangerously-bypass-hook-trust"]);
    expect(launchPermissionArguments("grok", [], "headless")).toEqual(["--permission-mode", "bypassPermissions"]);
  });

  it("leaves the caller's own permission choice alone", () => {
    expect(launchPermissionArguments("claude", ["--permission-mode", "plan"], "headless")).toEqual([]);
    expect(launchPermissionArguments("claude", ["--dangerously-skip-permissions"], "headless")).toEqual([]);
    expect(launchPermissionArguments("codex", ["--ask-for-approval", "on-request"], "headless")).toEqual(["--dangerously-bypass-hook-trust"]);
    expect(launchPermissionArguments("codex", ["--sandbox=read-only"], "headless")).toEqual(["--dangerously-bypass-hook-trust"]);
    expect(launchPermissionArguments("grok", ["--always-approve"], "headless")).toEqual([]);
  });

  it("adds nothing when the operator asks for manual permissions", () => {
    expect(launchPermissionArguments("claude", [], "manual")).toEqual([]);
    expect(launchPermissionArguments("codex", [], "manual")).toEqual([]);
  });

  it("does not mistake unrelated flags for a permission choice", () => {
    expect(argsAlreadySetPermissions("claude", ["--model", "opus"])).toBe(false);
    expect(argsAlreadySetPermissions("codex", ["-c", "model_reasoning_effort=low"])).toBe(false);
    expect(argsAlreadySetPermissions("grok", ["--reasoning-effort", "high"])).toBe(false);
  });

  it("rejects an unknown permission mode instead of guessing", () => {
    expect(() => parseLaunchPermissionMode("yolo")).toThrow("--permissions must be one of headless, manual");
    expect(parseLaunchPermissionMode("manual")).toBe("manual");
  });
});

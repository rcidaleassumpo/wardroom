import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertDurableClaudeAuthHome,
  hashClaudeSnapshotRoot,
  materializeClaudeControlledLaunch,
} from "../src/cli/claude-controlled-launch.js";

function temporaryDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeSkillSnapshot(root: string): string {
  const snapshot = join(root, "snapshot");
  mkdirSync(join(snapshot, "scripts"), { recursive: true });
  writeFileSync(join(snapshot, "SKILL.md"), "---\nname: example\n---\n\n# Example\n");
  writeFileSync(join(snapshot, "scripts", "run.sh"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
  return snapshot;
}

function writeAuthHome(root: string): string {
  const authHome = join(root, "claude-auth-home");
  mkdirSync(authHome, { recursive: true });
  writeFileSync(join(authHome, ".credentials.json"), "{\"claudeAiOauth\":{}}");
  return authHome;
}

function profileInput(snapshot: string) {
  return {
    instructionsText: "You are a focused controlled Claude session.",
    projectInstructions: { mode: "exclude" } as const,
    skills: [{ name: "example", snapshotPath: snapshot, sha256: hashClaudeSnapshotRoot(snapshot) }],
  };
}

describe("controlled Claude launch materialization", () => {
  it("generates per-session artifacts and explicit flags", () => {
    const base = temporaryDir("rooms-claude-controlled-");
    const snapshot = writeSkillSnapshot(base);
    const authHome = writeAuthHome(base);
    const sessionDir = join(base, "session");
    const launch = materializeClaudeControlledLaunch(profileInput(snapshot), { sessionDir, authConfigDir: authHome });

    expect(launch.env).toEqual({ CLAUDE_CONFIG_DIR: authHome });
    expect(launch.scrubEnv).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
    expect(launch.args).toContain("--append-system-prompt-file");
    expect(launch.args).toContain("--strict-mcp-config");
    expect(launch.args).toContain("--settings");
    expect(launch.args).toContain("--plugin-dir");
    expect(launch.args).not.toContain("--disable-slash-commands");

    const launchDir = join(sessionDir, "claude-launch");
    expect(readFileSync(join(launchDir, "instructions.md"), "utf8")).toContain("focused controlled Claude session");
    expect(JSON.parse(readFileSync(join(launchDir, "mcp.json"), "utf8"))).toEqual({ mcpServers: {} });
    expect(JSON.parse(readFileSync(join(launchDir, "settings.json"), "utf8"))).toEqual({ disableAllHooks: true, permissions: { deny: ["WebFetch", "WebSearch"] } });

    const plugin = join(launchDir, "plugin");
    expect(JSON.parse(readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8")).name).toBe("rooms-profile");
    expect(readFileSync(join(plugin, "skills", "example", "SKILL.md"), "utf8")).toContain("# Example");
    expect(lstatSync(join(plugin, "skills", "example", "scripts", "run.sh")).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(plugin, "skills", "example", "SKILL.md")).mode & 0o777).toBe(0o600);
  });

  it("disables slash commands for a zero-skill profile and skips the plugin", () => {
    const base = temporaryDir("rooms-claude-zero-");
    const authHome = writeAuthHome(base);
    const sessionDir = join(base, "session");
    const launch = materializeClaudeControlledLaunch({
      instructionsText: "Bare controlled session.",
      projectInstructions: { mode: "exclude" },
      skills: [],
    }, { sessionDir, authConfigDir: authHome });
    expect(launch.args).toContain("--disable-slash-commands");
    expect(launch.args).not.toContain("--plugin-dir");
    expect(existsSync(join(sessionDir, "claude-launch", "plugin"))).toBe(false);
  });

  it("appends pinned project instructions in snapshot mode", () => {
    const base = temporaryDir("rooms-claude-project-");
    const snapshot = writeSkillSnapshot(base);
    const authHome = writeAuthHome(base);
    const launch = materializeClaudeControlledLaunch({
      ...profileInput(snapshot),
      projectInstructions: { mode: "snapshot", text: "Repo rule: never touch main." },
    }, { sessionDir: join(base, "session"), authConfigDir: authHome });
    const instructions = readFileSync(join(launch.sessionDir, "claude-launch", "instructions.md"), "utf8");
    expect(instructions).toContain("## Pinned project instructions");
    expect(instructions).toContain("Repo rule: never touch main.");
  });

  it("fails closed on a snapshot hash mismatch", () => {
    const base = temporaryDir("rooms-claude-mismatch-");
    const snapshot = writeSkillSnapshot(base);
    const authHome = writeAuthHome(base);
    expect(() => materializeClaudeControlledLaunch({
      ...profileInput(snapshot),
      skills: [{ name: "example", snapshotPath: snapshot, sha256: "0".repeat(64) }],
    }, { sessionDir: join(base, "session"), authConfigDir: authHome })).toThrow(/hash mismatch/);
    expect(existsSync(join(base, "session", "claude-launch"))).toBe(false);
  });
});

describe("durable Claude auth home guard", () => {
  it("requires an existing home with a login and explains the fix", () => {
    const base = temporaryDir("rooms-claude-auth-");
    expect(() => assertDurableClaudeAuthHome(join(base, "missing"))).toThrow(/claude \/login/);
    const empty = join(base, "empty");
    mkdirSync(empty, { recursive: true });
    expect(() => assertDurableClaudeAuthHome(empty)).toThrow(/no login/);
  });

  it("rejects instruction-bearing ambient state", () => {
    const base = temporaryDir("rooms-claude-ambient-");
    const authHome = writeAuthHome(base);
    writeFileSync(join(authHome, "CLAUDE.md"), "ambient instructions\n");
    expect(() => assertDurableClaudeAuthHome(authHome)).toThrow(/ambient-empty/);
  });

  it("rejects hooks in the durable settings", () => {
    const base = temporaryDir("rooms-claude-hooks-");
    const authHome = writeAuthHome(base);
    writeFileSync(join(authHome, "settings.json"), JSON.stringify({ hooks: { Stop: [] } }));
    expect(() => assertDurableClaudeAuthHome(authHome)).toThrow(/hooks/);
  });
});

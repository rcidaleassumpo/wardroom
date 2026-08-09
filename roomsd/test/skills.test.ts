import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runRoomsCLI } from "../src/cli/main.js";
import { providerSkillPath, ROOMS_COORDINATION_SKILL, roomsSkills } from "../src/cli/skills.js";
import type { RoomsProvider } from "../src/cli/provider-registry.js";
import { setupMachineIdentity } from "../src/identity/machine-identity.js";

describe("Rooms-managed provider skills", () => {
  it("discovers this machine's providers and installs only for those providers", () => {
    const fixture = machine(["claude"]);

    const installed = roomsSkills("install", fixture.options) as { providers: Array<{ provider: string; path: string }> };
    expect(installed.providers.map((item) => item.provider)).toEqual(["claude"]);
    expect(installed.providers[0]!.path).toBe(providerSkillPath("claude", fixture.environment, fixture.home));
    expect(readFileSync(installed.providers[0]!.path, "utf8")).toBe(ROOMS_COORDINATION_SKILL);
    expect(existsSync(providerSkillPath("codex", fixture.environment, fixture.home))).toBe(false);
    expect(existsSync(providerSkillPath("grok", fixture.environment, fixture.home))).toBe(false);

    const status = roomsSkills("status", fixture.options) as { providers: Array<{ provider: string; registered: boolean; state: string }> };
    expect(status.providers).toEqual([{ provider: "claude", registered: true, path: installed.providers[0]!.path, state: "installed" }]);
    const manifestPath = join(fixture.stateDir, "skills.json");
    expect(statSync(manifestPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(manifestPath, "utf8")).authorityId).toMatch(/^authority-[0-9a-f]{64}$/);
  });

  it("supports a provider-specific install and leaves other detected providers missing", () => {
    const fixture = machine(["codex", "claude", "grok"]);
    roomsSkills("install", { ...fixture.options, provider: "claude" });

    const status = roomsSkills("status", fixture.options) as { providers: Array<{ provider: string; state: string }> };
    expect(status.providers.map((item) => [item.provider, item.state])).toEqual([
      ["claude", "installed"],
      ["codex", "missing"],
      ["grok", "missing"],
    ]);
  });

  it("refuses to overwrite or remove a modified owned skill", () => {
    const fixture = machine(["claude"]);
    roomsSkills("install", fixture.options);
    const path = providerSkillPath("claude", fixture.environment, fixture.home);
    writeFileSync(path, "user-owned edit\n");

    expect((roomsSkills("status", fixture.options) as { providers: Array<{ state: string }> }).providers[0]!.state).toBe("modified");
    expect(() => roomsSkills("install", fixture.options)).toThrow(/refusing to overwrite modified/);
    expect(() => roomsSkills("uninstall", fixture.options)).toThrow(/refusing to remove modified/);
    expect(readFileSync(path, "utf8")).toBe("user-owned edit\n");
  });

  it("refuses to adopt an unmanaged skill at the provider destination", () => {
    const fixture = machine(["grok"]);
    const path = providerSkillPath("grok", fixture.environment, fixture.home);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, ROOMS_COORDINATION_SKILL);

    expect(() => roomsSkills("install", fixture.options)).toThrow(/identical unmanaged skill/);
    expect((roomsSkills("status", fixture.options) as { providers: Array<{ state: string }> }).providers[0]!.state).toBe("conflict");
  });

  it("uninstalls only the Rooms-owned file and preserves unrelated provider files", () => {
    const fixture = machine(["codex"]);
    roomsSkills("install", fixture.options);
    const path = providerSkillPath("codex", fixture.environment, fixture.home);
    const unrelated = join(path, "..", "notes.txt");
    writeFileSync(unrelated, "keep\n");

    roomsSkills("uninstall", fixture.options);
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(unrelated, "utf8")).toBe("keep\n");
    expect(existsSync(join(fixture.stateDir, "skills.json"))).toBe(false);
  });

  it("reports outdated and relocated owned copies without rewriting them", () => {
    const fixture = machine(["claude"]);
    roomsSkills("install", fixture.options);
    const path = providerSkillPath("claude", fixture.environment, fixture.home);
    const manifestPath = join(fixture.stateDir, "skills.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(path, "old Rooms skill\n");
    manifest.entries[0].sha256 = createHash("sha256").update("old Rooms skill\n").digest("hex");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    expect((roomsSkills("status", fixture.options) as { providers: Array<{ state: string }> }).providers[0]!.state).toBe("outdated");
    const movedEnvironment = { ...fixture.environment, CLAUDE_CONFIG_DIR: join(fixture.home, "moved-claude-home") };
    expect((roomsSkills("status", { ...fixture.options, environment: movedEnvironment }) as { providers: Array<{ state: string }> }).providers[0]!.state).toBe("relocated");
    expect(readFileSync(path, "utf8")).toBe("old Rooms skill\n");
  });

  it("prints a concise valid skill and exposes the CLI without loading a backend", async () => {
    const printed = await runRoomsCLI(["skills", "print"]);
    expect(printed).toContain("name: rooms-coordination");
    expect(printed).toContain("A Rooms-authored birth briefing already establishes");
    expect(printed).toContain("Do not inspect CLI help, channel status, global session lists, or message history as startup checks");
    expect(printed).not.toContain("Run `rooms whoami` to confirm");
    expect(printed).toContain("The visible `@session-id` identifies the sender");
    expect(printed).not.toContain("TODO");
  });
});

function machine(providers: readonly RoomsProvider[]): Readonly<{
  stateDir: string;
  home: string;
  environment: NodeJS.ProcessEnv;
  options: { stateDir: string; userHome: string; environment: NodeJS.ProcessEnv };
}> {
  const root = mkdtempSync(join(tmpdir(), "rooms-skills-"));
  const stateDir = join(root, "state");
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  setupMachineIdentity(stateDir);
  for (const provider of providers) executable(join(bin, provider));
  const environment = {
    PATH: bin,
    CODEX_HOME: join(home, "codex-home"),
    CLAUDE_CONFIG_DIR: join(home, "claude-home"),
    GROK_HOME: join(home, "grok-home"),
  };
  return { stateDir, home, environment, options: { stateDir, userHome: home, environment } };
}

function executable(path: string): void {
  writeFileSync(path, "#!/bin/sh\n", { mode: 0o700 });
  chmodSync(path, 0o700);
}

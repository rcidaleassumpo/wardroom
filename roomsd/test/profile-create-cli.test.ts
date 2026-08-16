import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runRoomsCLI } from "../src/cli/main.js";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  const { rm } = await import("node:fs/promises");
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("rooms profile create", () => {
  it("persists a neutral named revision from repeated skills, models, and tool flags", async () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-profile-create-"));
    roots.push(root);
    const home = join(root, "home");
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { mode: 0o700 });
    for (const name of ["alpha", "beta"]) {
      const path = join(home, ".agents", "skills", name);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "SKILL.md"), `---\nname: ${name}\n---\n`);
    }
    vi.stubEnv("HOME", home);
    vi.stubEnv("ROOMS_SESSION_ID", "planner-1");
    const created = JSON.parse(await runRoomsCLI([
      "profile", "create", "--channel", "channel-1", "--name", "Focused kit",
      "--instructions", "Use only selected skills.", "--skill", "alpha", "--skill", "beta",
      "--model", "model-luna", "--model", "model-sol", "--npm-userconfig", "--browser-runtime",
      "--sandyboxy", "sandbox-1", "--state-dir", stateDir,
    ]));
    expect(created).toMatchObject({ name: "Focused kit", channelId: "channel-1", version: 1 });
    expect(created.modelSkillSets.map((set: { model: string }) => set.model)).toEqual(["model-luna", "model-sol"]);
    expect(created.modelSkillSets[0].skills.map((skill: { name: string }) => skill.name)).toEqual(["alpha", "beta"]);
    expect(created.modelSkillSets[0].toolEnvironment).toEqual({ npmUserConfig: true, browserRuntime: true, sandyboxySandbox: "sandbox-1" });
    const listed = JSON.parse(await runRoomsCLI(["profile", "list", "--channel", "channel-1", "--state-dir", stateDir]));
    expect(listed.revisions).toHaveLength(1);
    expect(listed.revisions[0]).toMatchObject({ id: created.id, name: "Focused kit" });
  });

  it("reads instruction files and fails closed on missing installed skills", async () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-profile-create-file-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const instructions = join(root, "instructions.md");
    mkdirSync(stateDir, { mode: 0o700 });
    writeFileSync(instructions, "Pinned instructions.\n");
    vi.stubEnv("HOME", join(root, "empty-home"));
    vi.stubEnv("ROOMS_SESSION_ID", "planner-1");
    await expect(runRoomsCLI(["profile", "create", "--channel", "channel-1", "--name", "Kit", "--instructions", instructions, "--skill", "missing", "--model", "model-1", "--state-dir", stateDir])).rejects.toThrow(/installed skill is missing/);
  });
});

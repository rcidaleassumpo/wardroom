import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyCodexNakedProfile, listCodexSkills } from "../src/cli/codex-minimal-profile.js";

describe("Rooms-owned Codex naked profile", () => {
  it("uses the normal Codex home and injects the minimal feature profile", () => {
    const args = applyCodexNakedProfile(["--yolo", "resume", "thread-id"]);
    expect(args).toContain("features.plugins=false");
    expect(args).toContain("skills.include_instructions=false");
    expect(args.slice(-3)).toEqual(["--yolo", "resume", "thread-id"]);
  });

  it("discovers and selectively enables skills from the normal shared roots", () => {
    const home = mkdtempSync(join(tmpdir(), "rooms-naked-profile-"));
    const skill = join(home, ".agents", "skills", "example", "SKILL.md");
    mkdirSync(join(home, ".agents", "skills", "example"), { recursive: true });
    writeFileSync(skill, "---\nname: example\n---\n");
    expect(listCodexSkills(home)).toEqual([{ name: "example", path: skill }]);
    const args = applyCodexNakedProfile(["--skill", "example", "--yolo"], home);
    expect(args).toContain("skills.include_instructions=true");
    expect(args.at(-1)).toBe("--yolo");
  });
});

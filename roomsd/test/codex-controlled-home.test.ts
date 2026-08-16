import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hashSnapshotRoot,
  inspectCodexControlledHome,
  materializeCodexControlledHome,
} from "../src/cli/codex-controlled-home.js";
import { canonicalSkillSnapshotManifest } from "../src/profiles/contracts.js";

function temporaryDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeSkillSnapshot(root: string): string {
  const snapshot = join(root, "snapshot");
  mkdirSync(join(snapshot, "agents"), { recursive: true });
  writeFileSync(join(snapshot, "SKILL.md"), "---\nname: example\n---\n\n# Example\n");
  writeFileSync(join(snapshot, "agents", "helper.md"), "helper body\n");
  writeFileSync(join(snapshot, "agents", "run.sh"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
  return snapshot;
}

function profileInput(snapshot: string, sha256: string) {
  return {
    instructionsText: "You are a focused example agent.",
    projectInstructions: { mode: "exclude" } as const,
    skills: [{ name: "example", snapshotPath: snapshot, sha256 }],
  };
}

describe("controlled Codex home hashing", () => {
  it("materializes the launch home and links the durable auth file", () => {
    const root = temporaryDir("rooms-controlled-launch-");
    const snapshot = writeSkillSnapshot(root);
    const authHome = join(root, "auth");
    mkdirSync(authHome);
    writeFileSync(join(authHome, "auth.json"), "{\"auth\":true}\n");
    const home = join(root, "controlled", "session", "home", ".codex");
    const result = materializeCodexControlledHome(profileInput(snapshot, hashSnapshotRoot(snapshot)), { sessionDir: join(root, "controlled", "session"), homeDir: home, authHomeDir: authHome });
    expect(result.homeDir).toBe(home);
    expect(lstatSync(join(home, "auth.json")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe("{\"auth\":true}\n");
  });

  it("hashes a snapshot root with the contract's v1 manifest", () => {
    const snapshot = writeSkillSnapshot(temporaryDir("rooms-controlled-hash-"));
    const skillBytes = readFileSync(join(snapshot, "SKILL.md"));
    const helperBytes = readFileSync(join(snapshot, "agents", "helper.md"));
    const runBytes = readFileSync(join(snapshot, "agents", "run.sh"));
    const manifest = canonicalSkillSnapshotManifest([
      { relativePath: "SKILL.md", sha256: createHash("sha256").update(skillBytes).digest("hex"), byteSize: skillBytes.byteLength, executable: false },
      { relativePath: "agents/helper.md", sha256: createHash("sha256").update(helperBytes).digest("hex"), byteSize: helperBytes.byteLength, executable: false },
      { relativePath: "agents/run.sh", sha256: createHash("sha256").update(runBytes).digest("hex"), byteSize: runBytes.byteLength, executable: true },
    ]);
    const expected = createHash("sha256").update(Buffer.from(manifest)).digest("hex");
    expect(hashSnapshotRoot(snapshot)).toBe(expected);
  });

  it("rejects a snapshot that contains a symlink", () => {
    const snapshot = writeSkillSnapshot(temporaryDir("rooms-controlled-symlink-"));
    symlinkSync(join(snapshot, "SKILL.md"), join(snapshot, "escape.md"));
    expect(() => hashSnapshotRoot(snapshot)).toThrow(/symlink/);
  });
});

describe("controlled Codex home materialization", () => {
  it("builds an isolated home from verified snapshots", () => {
    const base = temporaryDir("rooms-controlled-home-");
    const snapshot = writeSkillSnapshot(base);
    const sessionDir = join(base, "session");
    const result = materializeCodexControlledHome(profileInput(snapshot, hashSnapshotRoot(snapshot)), { sessionDir });

    expect(result.env).toEqual({ CODEX_HOME: join(sessionDir, "codex-home") });
    expect(result.skills).toEqual([{ name: "example", sha256: hashSnapshotRoot(snapshot) }]);
    expect(readFileSync(join(result.homeDir, "skills", "example", "SKILL.md"), "utf8")).toContain("# Example");
    expect(lstatSync(join(result.homeDir, "skills", "example", "agents", "run.sh")).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(result.homeDir, "skills", "example", "agents", "helper.md")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(result.homeDir, "AGENTS.md"), "utf8")).toBe("You are a focused example agent.\n");

    const config = readFileSync(join(result.homeDir, "config.toml"), "utf8");
    expect(config).toContain("project_doc_max_bytes = 0");
    expect(config).toContain(`developer_instructions = ${JSON.stringify("You are a focused example agent.")}`);
    expect(config).toContain("[skills.bundled]");
    expect(config).toContain("enabled = false");
    expect(config).toContain("include_instructions = true");
    expect(config).toContain("hooks = false");
    expect(config).not.toContain("mcp_servers");

    const inventory = inspectCodexControlledHome(result.homeDir);
    expect(inventory.skillNames).toEqual(["example"]);
    expect(inventory.bundledSystemSkillsPresent).toBe(false);
    expect(inventory.configSha256).toBe(result.configSha256);
    expect(inventory.agentsMdSha256).toBe(result.agentsMdSha256);
  });

  it("puts immutable channel rules and session identity in developer context", () => {
    const base = temporaryDir("rooms-controlled-developer-context-");
    const snapshot = writeSkillSnapshot(base);
    const result = materializeCodexControlledHome({
      ...profileInput(snapshot, hashSnapshotRoot(snapshot)),
      instructionsText: "Task 0e903a: fix profile delivery. Scope: Rooms launch only.",
      systemContext: "You are a Rooms session low-reasoning-worker.",
    }, { sessionDir: join(base, "session") });

    const config = readFileSync(join(result.homeDir, "config.toml"), "utf8");
    expect(config).toContain(`developer_instructions = ${JSON.stringify("Task 0e903a: fix profile delivery. Scope: Rooms launch only.\n\nYou are a Rooms session low-reasoning-worker.")}`);
  });

  it("trusts only the authorized launch working directory", () => {
    const base = temporaryDir("rooms-controlled-trusted-cwd-");
    const snapshot = writeSkillSnapshot(base);
    const workingDirectory = join(base, "work");
    const result = materializeCodexControlledHome(
      profileInput(snapshot, hashSnapshotRoot(snapshot)),
      { sessionDir: join(base, "session"), trustedWorkingDirectory: workingDirectory },
    );

    expect(readFileSync(join(result.homeDir, "config.toml"), "utf8"))
      .toContain(`[projects.${JSON.stringify(workingDirectory)}]\ntrust_level = "trusted"`);
    expect(() => materializeCodexControlledHome(
      profileInput(snapshot, hashSnapshotRoot(snapshot)),
      { sessionDir: join(base, "relative-session"), trustedWorkingDirectory: "relative" },
    )).toThrow(/must be absolute/);
  });

  it("appends pinned project instructions in snapshot mode", () => {
    const base = temporaryDir("rooms-controlled-project-");
    const snapshot = writeSkillSnapshot(base);
    const result = materializeCodexControlledHome({
      ...profileInput(snapshot, hashSnapshotRoot(snapshot)),
      projectInstructions: { mode: "snapshot", text: "Repo rule: never touch main." },
    }, { sessionDir: join(base, "session") });
    const agentsMd = readFileSync(join(result.homeDir, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("## Pinned project instructions");
    expect(agentsMd).toContain("Repo rule: never touch main.");
  });

  it("disables skill instructions for a zero-skill profile", () => {
    const base = temporaryDir("rooms-controlled-zero-");
    const result = materializeCodexControlledHome({
      instructionsText: "Bare agent.",
      projectInstructions: { mode: "exclude" },
      skills: [],
    }, { sessionDir: join(base, "session") });
    expect(readFileSync(join(result.homeDir, "config.toml"), "utf8")).toContain("include_instructions = false");
    expect(inspectCodexControlledHome(result.homeDir).skillNames).toEqual([]);
  });

  it("fails closed on a snapshot hash mismatch and creates nothing", () => {
    const base = temporaryDir("rooms-controlled-mismatch-");
    const snapshot = writeSkillSnapshot(base);
    const sessionDir = join(base, "session");
    expect(() => materializeCodexControlledHome(profileInput(snapshot, "0".repeat(64)), { sessionDir }))
      .toThrow(/hash mismatch/);
    expect(existsSync(join(sessionDir, "codex-home"))).toBe(false);
  });

  it("rejects duplicate skill names, invalid names, and an existing home", () => {
    const base = temporaryDir("rooms-controlled-invalid-");
    const snapshot = writeSkillSnapshot(base);
    const sha256 = hashSnapshotRoot(snapshot);
    const sessionDir = join(base, "session");
    expect(() => materializeCodexControlledHome({
      ...profileInput(snapshot, sha256),
      skills: [{ name: "example", snapshotPath: snapshot, sha256 }, { name: "example", snapshotPath: snapshot, sha256 }],
    }, { sessionDir })).toThrow(/duplicate/);
    expect(() => materializeCodexControlledHome({
      ...profileInput(snapshot, sha256),
      skills: [{ name: "Bad Name", snapshotPath: snapshot, sha256 }],
    }, { sessionDir })).toThrow(/invalid skill name/);

    materializeCodexControlledHome(profileInput(snapshot, sha256), { sessionDir });
    expect(() => materializeCodexControlledHome(profileInput(snapshot, sha256), { sessionDir }))
      .toThrow(/already exists/);
  });

  it("links durable auth without copying credential bytes", () => {
    const base = temporaryDir("rooms-controlled-auth-");
    const snapshot = writeSkillSnapshot(base);
    const authHome = join(base, "durable-codex-home");
    mkdirSync(authHome, { recursive: true });
    writeFileSync(join(authHome, "auth.json"), "{\"tokens\":\"durable\"}");
    const result = materializeCodexControlledHome(
      profileInput(snapshot, hashSnapshotRoot(snapshot)),
      { sessionDir: join(base, "session"), authHomeDir: authHome },
    );
    const linked = join(result.homeDir, "auth.json");
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(readFileSync(linked, "utf8")).toContain("durable");

    expect(() => materializeCodexControlledHome(
      profileInput(snapshot, hashSnapshotRoot(snapshot)),
      { sessionDir: join(base, "session-2"), authHomeDir: join(base, "missing") },
    )).toThrow(/auth\.json/);
  });
});

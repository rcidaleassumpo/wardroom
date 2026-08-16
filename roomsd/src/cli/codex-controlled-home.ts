// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { canonicalSkillSnapshotManifest, type SnapshotFile } from "../profiles/contracts.js";
import { listCodexSkills } from "./codex-minimal-profile.js";

/**
 * Rooms-owned controlled Codex launch home.
 *
 * A controlled session must see only what its channel profile pins: the
 * pinned instructions, the pinned skill snapshots, and nothing ambient. A
 * generated CODEX_HOME provides that by construction — an empty home has no
 * user skills, no hooks, no plugins, no MCP servers, and no AGENTS.md — while
 * argv `-c` overrides proved insufficient: `mcp_servers={}` does not clear
 * configured servers, and bundled skills under `skills/.system` load outside
 * any override list.
 *
 * Authentication stays subscription-only. The durable Rooms-owned Codex home
 * is logged in once by the operator; each generated home links that home's
 * auth.json instead of copying credential bytes.
 */

export interface CodexSkillSnapshotInput {
  name: string;
  snapshotPath: string;
  sha256: string;
}

export type CodexProjectInstructions =
  | { mode: "exclude" }
  | { mode: "snapshot"; text: string };

export interface CodexControlledProfileInput {
  instructionsText: string;
  /** Rooms-owned runtime facts that belong with the profile at system level. */
  systemContext?: string;
  projectInstructions: CodexProjectInstructions;
  skills: readonly CodexSkillSnapshotInput[];
  model?: string;
}

export interface MaterializedCodexHome {
  homeDir: string;
  env: Readonly<Record<string, string>>;
  configSha256: string;
  agentsMdSha256: string;
  skills: readonly { name: string; sha256: string }[];
  scrubEnv: readonly string[];
}

export interface CodexControlledHomeInventory {
  skillNames: readonly string[];
  bundledSystemSkillsPresent: boolean;
  configSha256: string | null;
  agentsMdSha256: string | null;
}

/**
 * Snapshot root hash per the contract's `rooms-skill-snapshot-v1` manifest.
 * Directories contribute nothing; symlinks are rejected because a link could
 * re-point after hashing and defeat the pin.
 */
export function hashSnapshotRoot(root: string): string {
  const files: SnapshotFile[] = snapshotFiles(root).map(relativePath => {
    const bytes = readFileSync(join(root, relativePath));
    const executable = (lstatSync(join(root, relativePath)).mode & 0o111) !== 0;
    return { relativePath, sha256: sha256Hex(bytes), byteSize: bytes.byteLength, executable };
  });
  return sha256Hex(Buffer.from(canonicalSkillSnapshotManifest(files)));
}

export function materializeCodexControlledHome(
  input: CodexControlledProfileInput,
  options: { sessionDir: string; homeDir?: string; authHomeDir?: string; userHomeDir?: string; trustedWorkingDirectory?: string },
): MaterializedCodexHome {
  const homeDir = options.homeDir ?? join(options.sessionDir, "codex-home");
  if (existsSync(homeDir)) throw new Error(`controlled Codex home already exists: ${homeDir}`);

  const verified: { name: string; sha256: string; snapshotPath: string }[] = [];
  const seen = new Set<string>();
  for (const skill of input.skills) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(skill.name)) throw new Error(`invalid skill name: ${skill.name}`);
    if (seen.has(skill.name)) throw new Error(`duplicate skill name: ${skill.name}`);
    seen.add(skill.name);
    const actual = hashSnapshotRoot(skill.snapshotPath);
    if (actual !== skill.sha256) {
      throw new Error(`skill snapshot hash mismatch for ${skill.name}: expected ${skill.sha256}, found ${actual}`);
    }
    verified.push({ name: skill.name, sha256: actual, snapshotPath: skill.snapshotPath });
  }

  mkdirSync(join(homeDir, "skills"), { recursive: true });
  for (const skill of verified) copySnapshot(skill.snapshotPath, join(homeDir, "skills", skill.name));

  const agentsMd = renderAgentsMd(input);
  writeFileSync(join(homeDir, "AGENTS.md"), agentsMd);
  const configToml = renderControlledConfigToml(input, options.userHomeDir ?? homedir(), options.trustedWorkingDirectory);
  writeFileSync(join(homeDir, "config.toml"), configToml);

  if (options.authHomeDir) {
    const authFile = join(options.authHomeDir, "auth.json");
    if (!existsSync(authFile)) throw new Error(`durable Codex auth home has no auth.json: ${options.authHomeDir}`);
    symlinkSync(authFile, join(homeDir, "auth.json"));
  }

  return {
    homeDir,
    env: { CODEX_HOME: homeDir },
    configSha256: sha256Hex(configToml),
    agentsMdSha256: sha256Hex(agentsMd),
    skills: verified.map(({ name, sha256 }) => ({ name, sha256 })),
    scrubEnv: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
  };
}

export interface CodexControlledProfileFile extends CodexControlledProfileInput {
  /** Durable Rooms-owned Codex home that carries the one subscription login. */
  authHomeDir?: string;
}

/** Fail closed on any malformed profile file rather than launching ambient. */
export function loadCodexControlledProfileFile(path: string): CodexControlledProfileFile {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
    throw new Error(`unreadable controlled profile file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const profile = parsed as Partial<CodexControlledProfileFile>;
  if (typeof profile !== "object" || profile === null) throw new Error(`controlled profile must be a JSON object: ${path}`);
  if (typeof profile.instructionsText !== "string" || !profile.instructionsText.trim()) throw new Error("controlled profile requires instructionsText");
  const project = profile.projectInstructions;
  const validProject = project?.mode === "exclude" || (project?.mode === "snapshot" && typeof (project as { text?: unknown }).text === "string");
  if (!validProject) throw new Error("controlled profile requires projectInstructions of mode exclude or snapshot");
  if (!Array.isArray(profile.skills)) throw new Error("controlled profile requires a skills array");
  for (const skill of profile.skills) {
    if (typeof skill?.name !== "string" || typeof skill?.snapshotPath !== "string" || !/^[0-9a-f]{64}$/.test(String(skill?.sha256))) {
      throw new Error("every controlled profile skill requires name, snapshotPath, and a lowercase sha256");
    }
  }
  if (profile.model !== undefined && typeof profile.model !== "string") throw new Error("controlled profile model must be a string");
  if (profile.authHomeDir !== undefined && typeof profile.authHomeDir !== "string") throw new Error("controlled profile authHomeDir must be a string");
  return profile as CodexControlledProfileFile;
}

/** Materialize the profile and wrap a provider argv with the isolated home. */
export function withControlledCodexHome(
  command: readonly string[],
  profilePath: string,
  sessionDir: string,
): { command: string[]; home: MaterializedCodexHome } {
  const profile = loadCodexControlledProfileFile(profilePath);
  const home = materializeCodexControlledHome(profile, { sessionDir, authHomeDir: profile.authHomeDir });
  return { command: ["/usr/bin/env", `CODEX_HOME=${home.homeDir}`, ...command], home };
}

/**
 * Re-inventory a controlled home. Run before launch to prove the materialized
 * state, and after provider start to detect anything the provider seeded back
 * (Codex regenerates `skills/.system` in homes it considers its own).
 */
export function inspectCodexControlledHome(homeDir: string): CodexControlledHomeInventory {
  const skillsDir = join(homeDir, "skills");
  const entries = existsSync(skillsDir) ? readdirSync(skillsDir, { withFileTypes: true }) : [];
  return {
    skillNames: entries.filter(entry => entry.isDirectory() && !entry.name.startsWith(".")).map(entry => entry.name).sort(),
    bundledSystemSkillsPresent: existsSync(join(skillsDir, ".system")),
    configSha256: fileSha256(join(homeDir, "config.toml")),
    agentsMdSha256: fileSha256(join(homeDir, "AGENTS.md")),
  };
}

function renderAgentsMd(input: CodexControlledProfileInput): string {
  const sections = [input.instructionsText.trim()];
  if (input.projectInstructions.mode === "snapshot") {
    sections.push("## Pinned project instructions\n\n" + input.projectInstructions.text.trim());
  }
  return sections.join("\n\n") + "\n";
}

/**
 * Live project doc discovery stays off in both project-instruction modes:
 * `exclude` hides repo docs entirely, and `snapshot` delivers the pinned text
 * through AGENTS.md so a later repo edit cannot change a running chat.
 *
 * The generated home is empty by construction, but Codex also discovers
 * skills through the user-home `~/.agents/skills` root, which CODEX_HOME
 * does not move. Those are disabled by explicit `skills.config` entries
 * enumerated at materialization time. A skill installed between
 * materialization and launch escapes this list, so the resolved-state
 * attestation re-inventories after start and fails the session closed.
 */
function renderControlledConfigToml(input: CodexControlledProfileInput, userHomeDir: string, trustedWorkingDirectory?: string): string {
  const lines = [
    "# Generated by Rooms for a controlled session. Do not edit.",
    `developer_instructions = ${JSON.stringify(renderDeveloperInstructions(input))}`,
    "project_doc_max_bytes = 0",
    "project_doc_fallback_filenames = []",
    "notify = []",
  ];
  if (input.model) {
    if (!/^[A-Za-z0-9._-]+$/.test(input.model)) throw new Error(`invalid model name: ${input.model}`);
    lines.push(`model = ${JSON.stringify(input.model)}`);
  }
  const ambientDisables = listCodexSkills(userHomeDir)
    .map(skill => `{ path = ${JSON.stringify(skill.path)}, enabled = false }`);
  lines.push(
    "",
    "[tools]",
    "web_search = false",
    "",
    "[skills]",
    `include_instructions = ${input.skills.length > 0}`,
    `config = [${ambientDisables.join(", ")}]`,
    "",
    "[skills.bundled]",
    "enabled = false",
    "",
    "[features]",
    "hooks = false",
    "plugins = false",
    "apps = false",
    "memories = false",
    "skill_search = false",
    "skill_mcp_dependency_install = false",
    "multi_agent = false",
    "",
    "[agents]",
    "enabled = false",
  );
  if (trustedWorkingDirectory !== undefined) {
    if (!isAbsolute(trustedWorkingDirectory)) throw new Error("controlled Codex trusted working directory must be absolute");
    lines.push("", `[projects.${JSON.stringify(trustedWorkingDirectory)}]`, 'trust_level = "trusted"');
  }
  return lines.join("\n") + "\n";
}

/**
 * Keep the profile's immutable channel snapshot separate from the caller's
 * initial user message. Codex treats this config value as developer context.
 */
function renderDeveloperInstructions(input: CodexControlledProfileInput): string {
  const sections = [input.instructionsText.trim()];
  if (input.systemContext?.trim()) sections.push(input.systemContext.trim());
  return sections.join("\n\n");
}

function snapshotFiles(root: string): string[] {
  const files: string[] = [];
  const pending = [""];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const relativePath = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`skill snapshot contains a symlink: ${join(root, relativePath)}`);
      if (entry.isDirectory()) pending.push(relativePath);
      else if (entry.isFile()) files.push(relativePath);
      else throw new Error(`skill snapshot contains a non-regular file: ${join(root, relativePath)}`);
    }
  }
  return files.sort();
}

function copySnapshot(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const relativePath of snapshotFiles(source)) {
    const target = join(destination, relativePath);
    const sourcePath = join(source, relativePath);
    mkdirSync(join(target, ".."), { recursive: true });
    copyFileSync(sourcePath, target);
    if (lstatSync(target).isSymbolicLink()) throw new Error(`copy produced a symlink: ${target}`);
    chmodSync(target, (lstatSync(sourcePath).mode & 0o111) !== 0 ? 0o700 : 0o600);
  }
}

function fileSha256(path: string): string | null {
  return existsSync(path) ? sha256Hex(readFileSync(path)) : null;
}

function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

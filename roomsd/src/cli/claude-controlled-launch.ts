// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalSkillSnapshotManifest, type SnapshotFile } from "../profiles/contracts.js";

/**
 * Rooms-owned controlled Claude Code launch.
 *
 * Controlled v1 requires subscription authentication, and Claude's --bare
 * mode never reads OAuth or the keychain, so a controlled session launches
 * non-bare against a durable Rooms-owned CLAUDE_CONFIG_DIR that carries one
 * operator /login and nothing instruction-bearing. Everything the profile
 * pins is generated per session and passed through explicit flags:
 *
 * - pinned instructions        --append-system-prompt-file
 * - pinned skills              --plugin-dir (a generated session plugin)
 * - zero-skill profiles        --disable-slash-commands
 * - MCP allowlist              --strict-mcp-config --mcp-config (empty v1)
 * - settings                   --settings (hooks disabled)
 *
 * Claude has no flag that hides a repository CLAUDE.md short of --bare, so
 * project instructions are enforced by launching with a Rooms-owned session
 * cwd; `exclude` is only honest when the caller keeps that cwd.
 */

export interface ClaudeSkillSnapshotInput {
  name: string;
  snapshotPath: string;
  sha256: string;
}

export type ClaudeProjectInstructions =
  | { mode: "exclude" }
  | { mode: "snapshot"; text: string };

export interface ClaudeControlledProfileInput {
  instructionsText: string;
  projectInstructions: ClaudeProjectInstructions;
  skills: readonly ClaudeSkillSnapshotInput[];
}

export interface MaterializedClaudeLaunch {
  sessionDir: string;
  env: Readonly<Record<string, string>>;
  /** Environment variable names that must be absent in the child process. */
  scrubEnv: readonly string[];
  args: readonly string[];
  instructionsSha256: string;
  skills: readonly { name: string; sha256: string }[];
}

const API_KEY_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

/** Instruction-bearing entries a durable auth home must never contain. */
const FORBIDDEN_AUTH_HOME_ENTRIES = ["CLAUDE.md", "skills", "commands", "agents", "hooks"] as const;

/** Plugin content that would load into sessions; marketplace scaffolding is inert. */
const FORBIDDEN_PLUGIN_ENTRIES = ["repos", "cache", "data"] as const;

export function materializeClaudeControlledLaunch(
  input: ClaudeControlledProfileInput,
  options: { sessionDir: string; authConfigDir: string },
): MaterializedClaudeLaunch {
  const sessionDir = options.sessionDir;
  if (existsSync(join(sessionDir, "claude-launch"))) throw new Error(`controlled Claude launch already exists: ${sessionDir}`);
  assertDurableClaudeAuthHome(options.authConfigDir);

  const verified: { name: string; sha256: string; snapshotPath: string }[] = [];
  const seen = new Set<string>();
  for (const skill of input.skills) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(skill.name)) throw new Error(`invalid skill name: ${skill.name}`);
    if (seen.has(skill.name)) throw new Error(`duplicate skill name: ${skill.name}`);
    seen.add(skill.name);
    const actual = hashClaudeSnapshotRoot(skill.snapshotPath);
    if (actual !== skill.sha256) {
      throw new Error(`skill snapshot hash mismatch for ${skill.name}: expected ${skill.sha256}, found ${actual}`);
    }
    verified.push({ name: skill.name, sha256: actual, snapshotPath: skill.snapshotPath });
  }

  const launchDir = join(sessionDir, "claude-launch");
  mkdirSync(launchDir, { recursive: true });

  const instructions = renderInstructions(input);
  const instructionsPath = join(launchDir, "instructions.md");
  writeFileSync(instructionsPath, instructions);

  const mcpPath = join(launchDir, "mcp.json");
  writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }, null, 2) + "\n");

  const settingsPath = join(launchDir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ disableAllHooks: true, permissions: { deny: ["WebFetch", "WebSearch"] } }, null, 2) + "\n");

  const args = [
    "--append-system-prompt-file", instructionsPath,
    "--settings", settingsPath,
    "--strict-mcp-config", "--mcp-config", mcpPath,
  ];
  if (verified.length > 0) {
    const pluginDir = join(launchDir, "plugin");
    mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(pluginDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "rooms-profile", description: "Rooms channel profile skills" }, null, 2) + "\n",
    );
    for (const skill of verified) copyClaudeSnapshot(skill.snapshotPath, join(pluginDir, "skills", skill.name));
    args.push("--plugin-dir", pluginDir);
  } else {
    args.push("--disable-slash-commands");
  }

  return {
    sessionDir,
    env: { CLAUDE_CONFIG_DIR: options.authConfigDir },
    scrubEnv: [...API_KEY_ENV],
    args,
    instructionsSha256: createHash("sha256").update(instructions).digest("hex"),
    skills: verified.map(({ name, sha256 }) => ({ name, sha256 })),
  };
}

/**
 * The durable home must exist, hold a subscription login, and carry nothing
 * that shapes model behavior. Fail closed rather than launch ambient.
 */
export function assertDurableClaudeAuthHome(configDir: string): void {
  if (!existsSync(configDir)) {
    throw new Error(`durable Claude auth home does not exist: ${configDir}\nCreate it once with: CLAUDE_CONFIG_DIR=${configDir} claude /login`);
  }
  if (!hasClaudeLogin(configDir)) {
    throw new Error(`durable Claude auth home has no login: ${configDir}\nLog in once with: CLAUDE_CONFIG_DIR=${configDir} claude /login`);
  }
  for (const entry of FORBIDDEN_AUTH_HOME_ENTRIES) {
    const path = join(configDir, entry);
    if (!existsSync(path)) continue;
    const directory = safeReaddir(path);
    if (directory === null || directory.length > 0) {
      throw new Error(`durable Claude auth home must stay ambient-empty; remove ${path}`);
    }
  }
  for (const entry of FORBIDDEN_PLUGIN_ENTRIES) {
    const path = join(configDir, "plugins", entry);
    if (!existsSync(path)) continue;
    const directory = safeReaddir(path);
    if (directory === null || directory.length > 0) {
      throw new Error(`durable Claude auth home must not carry plugin content; remove ${path}`);
    }
  }
  const settingsPath = join(configDir, "settings.json");
  if (existsSync(settingsPath)) {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    if ("hooks" in settings) throw new Error(`durable Claude auth home settings must not define hooks: ${settingsPath}`);
  }
}

/**
 * macOS keeps a custom config dir's OAuth in the keychain, so the login
 * evidence is the oauthAccount record in .claude.json; Linux and containers
 * keep .credentials.json in the directory. Either proves a subscription login.
 */
function hasClaudeLogin(configDir: string): boolean {
  if (existsSync(join(configDir, ".credentials.json"))) return true;
  const statePath = join(configDir, ".claude.json");
  if (!existsSync(statePath)) return false;
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    return typeof state.oauthAccount === "object" && state.oauthAccount !== null;
  } catch { return false; }
}

/** Same v1 manifest as every other adapter; Claude snapshots are byte-hashed identically. */
export function hashClaudeSnapshotRoot(root: string): string {
  const files: SnapshotFile[] = walkSnapshot(root).map(relativePath => {
    const bytes = readFileSync(join(root, relativePath));
    const executable = (lstatSync(join(root, relativePath)).mode & 0o111) !== 0;
    return { relativePath, sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.byteLength, executable };
  });
  return createHash("sha256").update(Buffer.from(canonicalSkillSnapshotManifest(files))).digest("hex");
}

function renderInstructions(input: ClaudeControlledProfileInput): string {
  const sections = [input.instructionsText.trim()];
  if (input.projectInstructions.mode === "snapshot") {
    sections.push("## Pinned project instructions\n\n" + input.projectInstructions.text.trim());
  }
  return sections.join("\n\n") + "\n";
}

function walkSnapshot(root: string): string[] {
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

function copyClaudeSnapshot(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const relativePath of walkSnapshot(source)) {
    const target = join(destination, relativePath);
    const sourcePath = join(source, relativePath);
    mkdirSync(join(target, ".."), { recursive: true });
    copyFileSync(sourcePath, target);
    chmodSync(target, (lstatSync(sourcePath).mode & 0o111) !== 0 ? 0o700 : 0o600);
  }
}

function safeReaddir(path: string): string[] | null {
  try { return readdirSync(path); } catch { return null; }
}

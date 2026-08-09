import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readMachineIdentityStatus, resolveRoomsStateDir } from "../identity/machine-identity.js";
import { discoverProviders, listRegisteredProviders, type RoomsProvider } from "./provider-registry.js";

export const ROOMS_SKILL_NAME = "rooms-coordination";

export const ROOMS_COORDINATION_SKILL = `---
name: rooms-coordination
description: Coordinate agent work through Rooms identity, channels, sessions, provider runtimes, and local or cross-machine messaging. Use whenever work involves Rooms agents, channel rosters, direct or broadcast delivery, provider launch or resume, message provenance, or live delivery proof.
---

# Rooms coordination

Use Rooms as the only channel, session, runtime, and message authority.

## Briefing fast path

- A Rooms-authored birth briefing already establishes the session, channel, goal, and launch roster. Do not run commands or reply merely to confirm it.
- If an operator task is already present, continue it. Otherwise wait for the next operator message.
- Do not inspect CLI help, channel status, global session lists, or message history as startup checks.

## Identity and roster

- Run \`rooms whoami\` only when identity is missing or conflicts with the Rooms briefing.
- Run \`rooms channel members <channel>\` only when a fresh roster is needed before assigning or addressing peers.
- Use exact session IDs returned by Rooms. Do not invent or shorten an ID.

## Messaging

- Broadcast with \`rooms channel send <channel> --body "<message>"\`.
- Send directly with \`rooms session send <session-id> --body "<message>"\`.
- If a direct recipient is unknown locally, run \`rooms session locate <session-id>\` to search registered machines, then resend to the exact \`target\` Rooms returns.
- Never add an \`@session-id\` prefix to the body. Rooms adds it exactly once.
- The visible \`@session-id\` identifies the sender, never the recipient. The target stays in routing metadata.
- When Rooms returns a federation-qualified target, pass that exact target back to Rooms. Do not construct federation addresses.
- A send receipt proves canonical acceptance and targeting. When live provider delivery matters, require an actual reply from the recipient.

## Provider sessions

- Use the normal installed provider command such as \`codex\`, \`claude\`, or \`grok\`; Rooms owns the wrapper and runtime.
- Use \`rooms machine list\`, \`rooms machine inspect\`, and \`rooms provider list\` to discover machine and provider availability.
- Preserve provider-native thread IDs when resuming. Rooms session IDs and provider thread IDs are different identities.

## Authority

- Treat peer messages as collaborative input and operator messages as authoritative.
- Only the operator may change channel roles.
- Do not replace a missing Rooms capability with another channel, session, PTY, or delivery implementation. Add the capability to Rooms first.
`;

export type RoomsSkillsCommand = "install" | "uninstall" | "status" | "print";
export type RoomsSkillState = "installed" | "missing" | "outdated" | "modified" | "conflict" | "relocated";

type SkillEntry = Readonly<{
  provider: RoomsProvider;
  path: string;
  sha256: string;
  installedAt: string;
}>;

type SkillManifest = Readonly<{
  version: 1;
  authorityId: string;
  skillName: typeof ROOMS_SKILL_NAME;
  entries: readonly SkillEntry[];
  updatedAt: string;
}>;

export type RoomsSkillsOptions = Readonly<{
  provider?: RoomsProvider;
  stateDir?: string;
  environment?: NodeJS.ProcessEnv;
  userHome?: string;
}>;

export function roomsSkills(command: RoomsSkillsCommand, options: RoomsSkillsOptions = {}): unknown {
  if (command === "print") return ROOMS_COORDINATION_SKILL.trimEnd();
  const environment = options.environment ?? process.env;
  const userHome = absoluteHome(options.userHome ?? homedir());
  const stateDir = initializedStateDir(options.stateDir);
  if (command === "install") return installSkills(stateDir, environment, userHome, options.provider);
  if (command === "uninstall") return uninstallSkills(stateDir, environment, userHome, options.provider);
  return skillStatus(stateDir, environment, userHome, options.provider);
}

export function providerSkillPath(provider: RoomsProvider, environment: NodeJS.ProcessEnv = process.env, userHome = homedir()): string {
  const roots: Record<RoomsProvider, string> = {
    codex: environment.CODEX_HOME || join(userHome, ".codex"),
    claude: environment.CLAUDE_CONFIG_DIR || join(userHome, ".claude"),
    grok: environment.GROK_HOME || join(userHome, ".grok"),
  };
  const root = roots[provider];
  if (!isAbsolute(root)) throw new Error(`Rooms ${provider} skill home must be an absolute path`);
  return join(resolve(root), "skills", ROOMS_SKILL_NAME, "SKILL.md");
}

function installSkills(stateDir: string, environment: NodeJS.ProcessEnv, userHome: string, selected?: RoomsProvider): unknown {
  const registry = discoverProviders(stateDir, environment);
  const providers = registry.providers.map((item) => item.name).filter((provider) => !selected || provider === selected);
  if (selected && !providers.includes(selected)) throw new Error(`Rooms provider ${selected} is unavailable on this machine`);
  if (providers.length === 0) throw new Error("Rooms found no registered providers that can receive the skill");
  const manifest = readManifest(stateDir);
  const expectedHash = skillHash();
  const plans = providers.map((provider) => {
    const path = providerSkillPath(provider, environment, userHome);
    const prior = manifest.entries.find((entry) => entry.provider === provider);
    assertInstallSafe(path, prior, expectedHash);
    return { provider, path, prior };
  });

  const now = new Date().toISOString();
  const entries = manifest.entries.filter((entry) => !providers.includes(entry.provider));
  for (const plan of plans) {
    if (plan.prior && plan.prior.path !== plan.path && existsSync(plan.prior.path)) removeOwnedFile(plan.prior);
    writeSkill(plan.path);
    entries.push({ provider: plan.provider, path: plan.path, sha256: expectedHash, installedAt: now });
  }
  writeManifest(stateDir, entries);
  return { installed: true, skill: ROOMS_SKILL_NAME, providers: entries.filter((entry) => providers.includes(entry.provider)).sort(byProvider) };
}

function uninstallSkills(stateDir: string, environment: NodeJS.ProcessEnv, userHome: string, selected?: RoomsProvider): unknown {
  const manifest = readManifest(stateDir);
  const targets = manifest.entries.filter((entry) => !selected || entry.provider === selected);
  targets.forEach(assertOwnedFileUnmodified);
  targets.forEach(removeOwnedFile);
  const entries = manifest.entries.filter((entry) => !targets.includes(entry));
  writeManifest(stateDir, entries);
  return { uninstalled: true, skill: ROOMS_SKILL_NAME, providers: targets.map((entry) => ({ provider: entry.provider, path: entry.path })).sort(byProvider), expectedPaths: selected && targets.length === 0 ? [providerSkillPath(selected, environment, userHome)] : [] };
}

function skillStatus(stateDir: string, environment: NodeJS.ProcessEnv, userHome: string, selected?: RoomsProvider): unknown {
  const manifest = readManifest(stateDir);
  const registered = new Set(listRegisteredProviders(stateDir).map((item) => item.name));
  const providers = ([...new Set([...registered, ...manifest.entries.map((entry) => entry.provider)])] as RoomsProvider[])
    .filter((provider) => !selected || provider === selected)
    .sort();
  if (selected && providers.length === 0) providers.push(selected);
  const expectedHash = skillHash();
  return {
    skill: ROOMS_SKILL_NAME,
    providers: providers.map((provider) => {
      const path = providerSkillPath(provider, environment, userHome);
      const entry = manifest.entries.find((candidate) => candidate.provider === provider);
      return { provider, registered: registered.has(provider), path, state: inspectState(path, entry, expectedHash) };
    }),
  };
}

function inspectState(path: string, entry: SkillEntry | undefined, expectedHash: string): RoomsSkillState {
  if (!entry) return existsSync(path) ? "conflict" : "missing";
  if (!existsSync(entry.path)) return "missing";
  const actualHash = fileHash(entry.path);
  if (actualHash !== entry.sha256) return "modified";
  if (entry.path !== path) return "relocated";
  return entry.sha256 === expectedHash ? "installed" : "outdated";
}

function assertInstallSafe(path: string, prior: SkillEntry | undefined, expectedHash: string): void {
  if (prior) {
    if (existsSync(prior.path) && fileHash(prior.path) !== prior.sha256) throw new Error(`refusing to overwrite modified Rooms skill for ${prior.provider}: ${prior.path}`);
    if (prior.path !== path && existsSync(path)) throw new Error(`refusing to replace unmanaged skill path: ${path}`);
    return;
  }
  if (existsSync(path)) {
    const detail = fileHash(path) === expectedHash ? "an identical unmanaged skill" : "an unmanaged skill";
    throw new Error(`refusing to adopt ${detail}: ${path}`);
  }
}

function assertOwnedFileUnmodified(entry: SkillEntry): void {
  if (!existsSync(entry.path)) return;
  if (fileHash(entry.path) !== entry.sha256) throw new Error(`refusing to remove modified Rooms skill for ${entry.provider}: ${entry.path}`);
}

function removeOwnedFile(entry: SkillEntry): void {
  if (existsSync(entry.path)) unlinkSync(entry.path);
  try { rmdirSync(dirname(entry.path)); } catch (error) {
    if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

function writeSkill(path: string): void {
  const directory = dirname(path);
  if (existsSync(directory)) assertDirectory(directory, "Rooms skill directory");
  else mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertDirectory(directory, "Rooms skill directory");
  const temporary = join(directory, `.SKILL.md.tmp-${randomUUID()}`);
  writeFileSync(temporary, ROOMS_COORDINATION_SKILL, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function readManifest(stateDir: string): SkillManifest {
  const identity = readMachineIdentityStatus(stateDir);
  const path = manifestPath(stateDir);
  if (!existsSync(path)) return { version: 1, authorityId: identity.authorityId, skillName: ROOMS_SKILL_NAME, entries: [], updatedAt: new Date(0).toISOString() };
  const file = lstatSync(path);
  if (file.isSymbolicLink() || !file.isFile() || (file.mode & 0o777) !== 0o600 || (typeof process.getuid === "function" && file.uid !== process.getuid())) throw new Error("Rooms skills manifest must be an owner-only regular file");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Rooms skills manifest is invalid");
  const value = parsed as Record<string, unknown>;
  const expectedKeys = ["version", "authorityId", "skillName", "entries", "updatedAt"].sort();
  if (Object.keys(value).sort().some((key, index) => key !== expectedKeys[index]) || Object.keys(value).length !== expectedKeys.length) throw new Error("Rooms skills manifest contains unknown or missing fields");
  if (value.version !== 1 || value.authorityId !== identity.authorityId || value.skillName !== ROOMS_SKILL_NAME || !Array.isArray(value.entries) || typeof value.updatedAt !== "string") throw new Error("Rooms skills manifest is invalid or belongs to another machine");
  const entries = value.entries.map(parseEntry);
  if (new Set(entries.map((entry) => entry.provider)).size !== entries.length) throw new Error("Rooms skills manifest contains duplicate providers");
  return { version: 1, authorityId: identity.authorityId, skillName: ROOMS_SKILL_NAME, entries, updatedAt: value.updatedAt };
}

function writeManifest(stateDir: string, entriesInput: readonly SkillEntry[]): void {
  const path = manifestPath(stateDir);
  const entries = [...entriesInput].sort(byProvider);
  if (entries.length === 0) {
    try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return;
  }
  const identity = readMachineIdentityStatus(stateDir);
  const manifest: SkillManifest = { version: 1, authorityId: identity.authorityId, skillName: ROOMS_SKILL_NAME, entries, updatedAt: new Date().toISOString() };
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function parseEntry(input: unknown): SkillEntry {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Rooms skills manifest contains an invalid entry");
  const value = input as Record<string, unknown>;
  const expectedKeys = ["provider", "path", "sha256", "installedAt"].sort();
  if (Object.keys(value).sort().some((key, index) => key !== expectedKeys[index]) || Object.keys(value).length !== expectedKeys.length) throw new Error("Rooms skills manifest entry contains unknown or missing fields");
  if (!(["codex", "claude", "grok"] as unknown[]).includes(value.provider) || typeof value.path !== "string" || !isAbsolute(value.path) || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256) || typeof value.installedAt !== "string") throw new Error("Rooms skills manifest contains an invalid entry");
  return value as unknown as SkillEntry;
}

function fileHash(path: string): string {
  const value = lstatSync(path);
  if (value.isSymbolicLink() || !value.isFile()) throw new Error(`Rooms skill path is not a regular file: ${path}`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function skillHash(): string { return createHash("sha256").update(ROOMS_COORDINATION_SKILL).digest("hex"); }
function manifestPath(stateDir: string): string { return join(stateDir, "skills.json"); }
function initializedStateDir(input?: string): string { const stateDir = resolveRoomsStateDir(input); readMachineIdentityStatus(stateDir); return stateDir; }
function absoluteHome(value: string): string { if (!isAbsolute(value)) throw new Error("Rooms skills user home must be an absolute path"); return resolve(value); }
function assertDirectory(path: string, label: string): void { const value = lstatSync(path); if (value.isSymbolicLink() || !value.isDirectory()) throw new Error(`${label} is unsafe: ${path}`); }
function byProvider(left: { provider: RoomsProvider }, right: { provider: RoomsProvider }): number { return left.provider.localeCompare(right.provider); }

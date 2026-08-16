// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { listCodexSkills } from "../cli/codex-minimal-profile.js";
import type { ChannelProfileRevision, ControlledProvider } from "./contracts.js";
import {
  createChannelProfileRevision,
  listChannelProfileRevisions,
  readChannelProfileRevision,
  type CreateChannelProfileRevisionInput,
} from "./profile-revision-store.js";
import { ensureOwnerDirectory, withOwnerFileLock } from "./secure-state-files.js";

export type ChannelProfileDraft = Omit<CreateChannelProfileRevisionInput, "stateDir" | "id" | "name" | "channelId" | "version" | "createdAt" | "createdBySessionId">;

export interface ProfileSkillCatalogEntry {
  id: string;
  name: string;
  sourcePath: string;
  instructionText: string;
  instructionSha256: string;
  providers: readonly ControlledProvider[];
}

/** Create the next immutable revision. Rooms owns revision identity and order. */
export function createNextChannelProfileRevision(input: Readonly<{
  stateDir: string;
  channelId: string;
  name: string;
  createdBySessionId: string;
  draft: ChannelProfileDraft;
  now?: () => Date;
  createId?: () => string;
}>): ChannelProfileRevision {
  if (!isAbsolute(input.stateDir)) throw new Error("profile state directory must be absolute");
  const profilesDirectory = ensureOwnerDirectory(join(resolve(input.stateDir), "profiles"));
  const channelKey = createHash("sha256").update(input.channelId).digest("hex");
  return withOwnerFileLock(join(profilesDirectory, `.channel-${channelKey}.lock`), () => {
    const current = listChannelProfileRevisions(input.stateDir, input.channelId);
    return createChannelProfileRevision({
      ...input.draft,
      stateDir: input.stateDir,
      id: (input.createId ?? randomUUID)(),
      name: input.name,
      channelId: input.channelId,
      version: (current[0]?.version ?? 0) + 1,
      createdAt: (input.now ?? (() => new Date()))().toISOString(),
      createdBySessionId: input.createdBySessionId,
    });
  });
}

export function readChannelProfileRevisionForChannel(stateDir: string, channelId: string, revisionId: string): ChannelProfileRevision {
  const profile = readChannelProfileRevision(stateDir, revisionId);
  if (profile.channelId !== channelId) throw new Error("profile revision does not belong to the requested channel");
  return profile;
}

/**
 * List local skill sources that an operator may snapshot into a profile.
 * Catalog entries expose exact instructions for selection, but launches use
 * only the later immutable snapshot.
 */
export function listProfileSkillCatalog(options: Readonly<{
  homeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
}> = {}): readonly ProfileSkillCatalogEntry[] {
  const homeDirectory = resolve(options.homeDirectory ?? homedir());
  const environment = options.environment ?? process.env;
  const sources = new Map<string, { name: string; sourcePath: string; providers: Set<ControlledProvider> }>();
  for (const skill of listCodexSkills(homeDirectory)) addSource(sources, skill.name, dirname(skill.path), "codex");

  const claudeHome = resolve(String(environment.CLAUDE_CONFIG_DIR ?? join(homeDirectory, ".claude")));
  for (const skill of skillFolders([join(homeDirectory, ".agents", "skills"), join(claudeHome, "skills"), join(claudeHome, "plugins")])) {
    addSource(sources, skillName(join(skill, "SKILL.md")), skill, "claude");
  }

  return [...sources.values()].map((source) => {
    const instructionPath = join(source.sourcePath, "SKILL.md");
    const bytes = readFileSync(instructionPath);
    const instructionText = decodeUtf8(bytes, instructionPath);
    return {
      id: createHash("sha256").update(source.sourcePath).digest("hex").slice(0, 32),
      name: source.name,
      sourcePath: source.sourcePath,
      instructionText,
      instructionSha256: createHash("sha256").update(bytes).digest("hex"),
      providers: [...source.providers].sort(),
    };
  }).sort((left, right) => left.name.localeCompare(right.name) || left.sourcePath.localeCompare(right.sourcePath));
}

function addSource(
  sources: Map<string, { name: string; sourcePath: string; providers: Set<ControlledProvider> }>,
  nameInput: string,
  sourcePathInput: string,
  provider: ControlledProvider,
): void {
  const name = nameInput.trim();
  if (!name) return;
  let sourcePath: string;
  try { sourcePath = realpathSync(sourcePathInput); } catch { return; }
  const root = lstatSync(sourcePath);
  const instruction = join(sourcePath, "SKILL.md");
  if (root.isSymbolicLink() || !root.isDirectory() || !existsSync(instruction)) return;
  const instructionStat = lstatSync(instruction);
  if (instructionStat.isSymbolicLink() || !instructionStat.isFile()) return;
  const prior = sources.get(sourcePath);
  if (prior) {
    if (prior.name !== name) return;
    prior.providers.add(provider);
  } else sources.set(sourcePath, { name, sourcePath, providers: new Set([provider]) });
}

function skillFolders(roots: readonly string[]): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const pending = roots.filter(existsSync);
  while (pending.length > 0) {
    const candidate = pending.pop()!;
    let directory: string;
    try { directory = realpathSync(candidate); } catch { continue; }
    if (visited.has(directory)) continue;
    visited.add(directory);
    const value = lstatSync(directory);
    if (!value.isDirectory()) continue;
    if (existsSync(join(directory, "SKILL.md"))) {
      result.push(directory);
      continue;
    }
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.isSymbolicLink()) pending.push(join(directory, entry.name));
      }
    } catch { /* optional provider roots may be unreadable */ }
  }
  return result;
}

function skillName(instructionPath: string): string {
  try {
    const text = readFileSync(instructionPath, "utf8").slice(0, 16_384);
    const match = text.match(/^---\s*$[\s\S]*?^name:\s*["']?([^\n"']+)["']?\s*$/m);
    return match?.[1]?.trim() ?? basename(dirname(instructionPath));
  } catch { return ""; }
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(`skill instructions must contain valid UTF-8: ${path}`); }
}

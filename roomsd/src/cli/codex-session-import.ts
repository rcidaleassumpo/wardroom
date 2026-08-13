// SPDX-License-Identifier: Apache-2.0
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Always launch Codex against the primary ~/.codex home. If a requested
 * thread predates the Rooms cutover, import its persisted rollout and index
 * row from a sibling legacy Codex home first. The legacy home is migration
 * input only and never remains a runtime source of truth.
 */
export function providerLaunchCommand(
  provider: import("./provider-registry.js").RoomsProvider,
  args: readonly string[],
  resumeThreadId?: string,
  homeDirectory = homedir(),
  executable: string = provider,
): string[] {
  if (provider === "codex" && resumeThreadId) importCodexThread(resumeThreadId, homeDirectory);
  return [executable, ...args];
}

export function importCodexThread(threadId: string, homeDirectory = homedir()): boolean {
  if (!CODEX_THREAD_ID.test(threadId)) return false;
  const primaryHome = join(homeDirectory, ".codex");
  const primaryDatabase = join(primaryHome, "state_5.sqlite");
  const source = legacyThread(threadId, homeDirectory, primaryHome);
  if (!source) return false;

  const destinationRollout = join(primaryHome, "sessions", relative(join(source.home, "sessions"), source.rolloutPath));
  if (!isAbsolute(destinationRollout) || !destinationRollout.startsWith(`${primaryHome}/`)) throw new Error("invalid legacy Codex rollout path");

  const target = new DatabaseSync(primaryDatabase);
  try {
    target.exec("PRAGMA busy_timeout=5000");
    const existing = target.prepare("SELECT updated_at, updated_at_ms FROM threads WHERE id=?").get(threadId) as Record<string, unknown> | undefined;
    if (existing && timestamp(existing) > timestamp(source.row)) return false;

    mkdirSync(join(destinationRollout, ".."), { recursive: true, mode: 0o700 });
    const temporary = `${destinationRollout}.rooms-import`;
    writeFileSync(temporary, readFileSync(source.rolloutPath), { mode: 0o600 });
    renameSync(temporary, destinationRollout);
    copyShellSnapshots(threadId, source.home, primaryHome);

    const columns = (target.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>).map(item => item.name).filter(name => name in source.row);
    const imported = { ...source.row, rollout_path: destinationRollout } as Record<string, unknown>;
    const updates = columns.filter(name => name !== "id").map(name => `${quote(name)}=excluded.${quote(name)}`).join(",");
    target.prepare(`INSERT INTO threads (${columns.map(quote).join(",")}) VALUES (${columns.map(() => "?").join(",")}) ON CONFLICT(id) DO UPDATE SET ${updates}`).run(...columns.map(name => imported[name] as any));
    return true;
  } finally {
    target.close();
  }
}

function legacyThread(threadId: string, homeDirectory: string, primaryHome: string): { home: string; rolloutPath: string; row: Record<string, unknown> } | undefined {
  let homes: string[] = [];
  try {
    homes = readdirSync(homeDirectory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith(".codex") && join(homeDirectory, entry.name) !== primaryHome)
      .map(entry => join(homeDirectory, entry.name));
  } catch { return undefined; }
  for (const home of homes) {
    const databasePath = join(home, "state_5.sqlite");
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true });
      const row = database.prepare("SELECT * FROM threads WHERE id=?").get(threadId) as Record<string, unknown> | undefined;
      const rolloutPath = typeof row?.rollout_path === "string" ? row.rollout_path : "";
      if (row && isAbsolute(rolloutPath) && rolloutPath.startsWith(`${join(home, "sessions")}/`)) return { home, rolloutPath, row };
    } catch { /* this sibling is not a compatible Codex home */ }
    finally { database?.close(); }
  }
  return undefined;
}

function copyShellSnapshots(threadId: string, sourceHome: string, primaryHome: string): void {
  const source = join(sourceHome, "shell_snapshots");
  const destination = join(primaryHome, "shell_snapshots");
  try {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(`${threadId}.`)) continue;
      writeFileSync(join(destination, entry.name), readFileSync(join(source, entry.name)), { mode: 0o600 });
    }
  } catch { /* snapshots are optional resume acceleration */ }
}

function timestamp(row: Record<string, unknown>): number {
  return Number(row.updated_at_ms ?? 0) || Number(row.updated_at ?? 0) * 1_000;
}

function quote(identifier: string): string { return `"${identifier.replaceAll('"', '""')}"`; }

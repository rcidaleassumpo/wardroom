// SPDX-License-Identifier: Apache-2.0
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { roomsPaths } from "../provisioning/paths.js";
import { importCodexThread } from "./codex-session-import.js";
import { listRegisteredProviders } from "./provider-registry.js";

export interface SessionResumePlan {
  sessionId: string;
  channelId: string | null;
  generation: number;
  adapterKind: string;
  providerThreadId: string;
  cwd: string | null;
  /** Session generated home root to reuse; null resumes in the ambient home. */
  effectiveHome: string | null;
  command: string[];
  alreadyRunning: boolean;
}

interface BlueprintMember {
  priorSessionId?: string;
  sessionId?: string;
  adapterKind?: string;
  launch?: { executable?: string; args?: string[]; cwd?: string; home?: string | null };
  provider?: { conversationId?: string; resumeDescriptor?: { provider?: string; mode?: string } };
}

/**
 * Read-only recovery planner. Resolve one session's stored resume identity from
 * the canonical store and produce the exact launch that resumes its provider
 * thread at the next generation. This never mutates state; the caller performs
 * the authorized runtime create. It refuses missing or ambiguous session state.
 */
export function planSessionResume(sessionId: string, stateDirInput?: string, channelOverride?: string): SessionResumePlan {
  if (!sessionId) throw new Error("session resume requires a session id");
  const storePath = roomsPaths(stateDirInput).storePath;
  const database = new DatabaseSync(storePath, { readOnly: true });
  try {
    if (!database.prepare("SELECT 1 FROM sessions WHERE id=? AND ended_at IS NULL").get(sessionId)) {
      throw new Error(`session ${sessionId} is not an active Rooms session`);
    }
    const runtimes = database.prepare(
      `SELECT r.generation, r.state, r.provider_thread_id, r.effective_cwd, r.effective_home, r.session_proof_hash,
              b.channel_id, b.adapter_kind
         FROM runtimes r
         LEFT JOIN runtime_bindings b ON b.runtime_id=r.runtime_id AND b.unbound_at IS NULL
        WHERE r.session_id=?
        ORDER BY r.generation DESC, r.created_at DESC`,
    ).all(sessionId) as Array<Record<string, unknown>>;
    const latest = runtimes[0];
    const maxGeneration = runtimes.reduce((max, row) => Math.max(max, Number(row.generation ?? 0)), 0);

    const member = findBlueprintMember(database, sessionId, channelOverride);
    const channelId = channelOverride
      ?? (member?.launch ? String((member as { channelId?: string }).channelId ?? "") || null : null)
      ?? (latest ? optionalText(latest.channel_id) : null);

    const providerThreadId = member?.provider?.conversationId
      ?? (latest ? optionalText(latest.provider_thread_id) : null)
      ?? optionalText(database.prepare("SELECT provider_thread_id FROM sessions WHERE id=?").get(sessionId) as Record<string, unknown> | undefined);
    if (!providerThreadId) throw new Error(`session ${sessionId} has no stored provider thread to resume`);

    const adapterKind = member?.adapterKind ?? member?.provider?.resumeDescriptor?.provider
      ?? (latest ? optionalText(latest.adapter_kind) : null) ?? "codex";
    const cwd = member?.launch?.cwd ?? (latest ? optionalText(latest.effective_cwd) : null);
    const effectiveHome = member?.launch?.home ?? (latest ? optionalText(latest.effective_home) : null);

    // Idempotency: a live, proof-bound runtime at the newest generation means the
    // session is already resumed. Return the existing generation without a launch.
    const latestIsLive = latest
      && ["running", "creating", "recovering"].includes(String(latest.state ?? ""))
      && latest.session_proof_hash != null;
    if (latestIsLive) {
      return { sessionId, channelId, generation: maxGeneration, adapterKind, providerThreadId, cwd, effectiveHome, command: [], alreadyRunning: true };
    }

    const command = buildResumeCommand(adapterKind, providerThreadId, member, stateDirInput);
    if (adapterKind === "codex") importCodexThread(providerThreadId);
    return { sessionId, channelId, generation: maxGeneration + 1, adapterKind, providerThreadId, cwd, effectiveHome, command, alreadyRunning: false };
  } finally {
    database.close();
  }
}

function findBlueprintMember(database: DatabaseSync, sessionId: string, channelOverride?: string): (BlueprintMember & { channelId?: string }) | null {
  const rows = channelOverride
    ? [database.prepare("SELECT channel_id, blueprint_json FROM channel_blueprints WHERE channel_id=?").get(channelOverride)]
    : database.prepare("SELECT channel_id, blueprint_json FROM channel_blueprints").all();
  for (const row of rows as Array<Record<string, unknown> | undefined>) {
    if (!row) continue;
    let members: BlueprintMember[] = [];
    try { members = (JSON.parse(String(row.blueprint_json)).members ?? []) as BlueprintMember[]; } catch { continue; }
    const member = members.find(item => item.priorSessionId === sessionId || item.sessionId === sessionId);
    if (member) return { ...member, channelId: String(row.channel_id) };
  }
  return null;
}

/**
 * Providers that install versioned binaries delete the old file on upgrade:
 * Claude keeps `~/.local/share/claude/versions/<version>` and removes the
 * previous one, so a launch path stored weeks ago can no longer be executed and
 * the resume dies with "no such file or directory". Prefer the stored path
 * while it exists, then the registered one, and fall back to the provider name,
 * which resolves through PATH to whatever is installed now.
 */
function resumeExecutable(stored: string | undefined, adapterKind: string, stateDirInput?: string): string {
  const usable = (candidate: string | undefined): boolean => Boolean(candidate) && (!candidate!.includes("/") || existsSync(candidate!));
  if (usable(stored)) return stored!;
  const registered = listRegisteredProviders(stateDirInput).find((provider) => provider.name === adapterKind)?.executable;
  return usable(registered) ? registered! : adapterKind;
}

function buildResumeCommand(adapterKind: string, conversationId: string, member: BlueprintMember | null, stateDirInput?: string): string[] {
  const executable = resumeExecutable(member?.launch?.executable, adapterKind, stateDirInput);
  const extraArgs = member?.launch?.args ?? [];
  const mode = member?.provider?.resumeDescriptor?.mode;
  if (adapterKind === "claude") return [executable, "--resume", conversationId, ...extraArgs];
  // Codex resumes a stored thread with `codex resume <id>`; other runtime-mode
  // providers reuse their stored launch verbatim.
  if (adapterKind === "codex" || mode === "runtime") return [executable, "resume", conversationId, ...extraArgs];
  return [executable, ...extraArgs];
}

function optionalText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "object" && "provider_thread_id" in (value as object)) return optionalText((value as Record<string, unknown>).provider_thread_id);
  const text = String(value);
  return text.trim() === "" ? null : text;
}

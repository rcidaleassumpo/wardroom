import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Provider turn phase from Rooms delivery + the provider's own lifecycle log.
 * No silence timers. No Rooms chat-message heuristics.
 *
 *   idle      — live runtime waiting for the next prompt
 *   thinking  — model/reasoning phase
 *   streaming — assistant text flowing
 *   tool      — tool/function execution
 *   busy      — turn active without a finer phase yet
 *   unsupported — adapter has no lifecycle source (explicit; not "busy forever")
 */
export type ProviderTurnPhase = "idle" | "thinking" | "streaming" | "tool" | "busy" | "unsupported";

export type ProviderTurn = {
  phase: ProviderTurnPhase | null;
  reason: string;
  updatedAt: string | null;
};

export type TranscriptLine = {
  timestamp?: string;
  ts?: string;
  type?: string;
  phase?: string;
  outcome?: string;
  payload?: {
    type?: string;
    role?: string;
    turn_id?: string;
    content?: unknown;
  };
};

const pathCache = new Map<string, { path: string; checkedAt: number }>();
const PATH_CACHE_MS = 30_000;
const TAIL_BYTES = 256 * 1024;
const MAX_CANDIDATES = 80;

export function resolveProviderTurn(input: {
  alive: boolean;
  adapterKind: string | null;
  lastDeliverAt: string | null;
  transcriptLines: readonly TranscriptLine[];
}): ProviderTurn {
  if (!input.alive) return { phase: null, reason: "runtime-not-live", updatedAt: null };
  if (!input.lastDeliverAt) return { phase: "idle", reason: "awaiting-input", updatedAt: null };

  const afterDeliver = input.transcriptLines.filter((line) => {
    const at = line.timestamp || line.ts;
    return Boolean(at && at >= input.lastDeliverAt!);
  });

  if (input.adapterKind === "codex") {
    return resolveCodexTurn(afterDeliver, input.lastDeliverAt);
  }
  if (input.adapterKind === "claude") {
    return resolveClaudeTurn(afterDeliver, input.lastDeliverAt);
  }
  if (input.adapterKind === "grok") {
    return resolveGrokTurn(afterDeliver, input.lastDeliverAt);
  }

  return { phase: "unsupported", reason: "provider-turn-unsupported", updatedAt: input.lastDeliverAt };
}

function resolveCodexTurn(lines: readonly TranscriptLine[], lastDeliverAt: string): ProviderTurn {
  let startedAt: string | null = null;
  let completedAt: string | null = null;
  let phase: ProviderTurnPhase = "busy";
  let reason = "prompt-delivered";
  let updatedAt = lastDeliverAt;

  for (const line of lines) {
    const at = line.timestamp || lastDeliverAt;
    const eventType = line.payload?.type || line.type;
    if (eventType === "task_started") {
      startedAt = at;
      completedAt = null;
      phase = "thinking";
      reason = "task_started";
      updatedAt = at;
      continue;
    }
    if (eventType === "task_complete") {
      completedAt = at;
      phase = "idle";
      reason = "task_complete";
      updatedAt = at;
      continue;
    }
    if (completedAt) continue;
    if (!startedAt && line.type !== "response_item" && eventType !== "agent_message") continue;

    if (line.payload?.type === "function_call" || line.payload?.type === "custom_tool_call" || eventType === "tool_use") {
      phase = "tool";
      reason = "tool_call";
      updatedAt = at;
      continue;
    }
    if (line.payload?.role === "assistant" || eventType === "agent_message" || line.payload?.type === "message") {
      phase = "streaming";
      reason = "assistant_output";
      updatedAt = at;
      continue;
    }
    if (line.payload?.type === "reasoning") {
      phase = "thinking";
      reason = "reasoning";
      updatedAt = at;
    }
  }

  if (startedAt && !completedAt && phase === "busy") {
    return { phase: "thinking", reason: "task_started", updatedAt: startedAt };
  }
  if (!startedAt && !completedAt) {
    return { phase: "busy", reason: "prompt-delivered", updatedAt: lastDeliverAt };
  }
  return { phase, reason, updatedAt };
}

function resolveClaudeTurn(lines: readonly TranscriptLine[], lastDeliverAt: string): ProviderTurn {
  let phase: ProviderTurnPhase = "busy";
  let reason = "prompt-delivered";
  let updatedAt = lastDeliverAt;
  let open = true;

  for (const line of lines) {
    const at = line.timestamp || lastDeliverAt;
    const type = line.type;
    const subtype = (line as { subtype?: string }).subtype;
    if (type === "system" && subtype === "turn_duration") {
      phase = "idle";
      reason = "turn_duration";
      updatedAt = at;
      open = false;
      continue;
    }
    if (!open) continue;
    if (type === "assistant") {
      const content = (line as { message?: { content?: Array<{ type?: string }> } }).message?.content || [];
      if (content.some((part) => part.type === "tool_use")) {
        phase = "tool";
        reason = "tool_use";
      } else {
        phase = "streaming";
        reason = "assistant_message";
      }
      updatedAt = at;
      continue;
    }
    if (type === "user") {
      phase = "thinking";
      reason = "user_turn";
      updatedAt = at;
    }
  }
  return { phase, reason, updatedAt };
}

/** Grok Build events.jsonl: turn_started / turn_ended / phase_changed / tool_*. */
function resolveGrokTurn(lines: readonly TranscriptLine[], lastDeliverAt: string): ProviderTurn {
  let phase: ProviderTurnPhase = "busy";
  let reason = "prompt-delivered";
  let updatedAt = lastDeliverAt;
  let open = false;

  for (const line of lines) {
    const at = line.ts || line.timestamp || lastDeliverAt;
    const type = line.type;
    if (type === "turn_started" || type === "loop_started") {
      open = true;
      phase = "thinking";
      reason = type;
      updatedAt = at;
      continue;
    }
    if (type === "turn_ended") {
      open = false;
      phase = "idle";
      reason = line.outcome ? `turn_ended:${line.outcome}` : "turn_ended";
      updatedAt = at;
      continue;
    }
    if (!open && type !== "phase_changed" && type !== "tool_started" && type !== "first_token") {
      // Activity after deliver before an explicit turn_started still means work.
      if (type === "tool_started" || type === "first_token") {
        open = true;
      } else {
        continue;
      }
    }
    if (type === "tool_started" || line.phase === "tool_execution") {
      phase = "tool";
      reason = type === "tool_started" ? "tool_started" : "tool_execution";
      updatedAt = at;
      continue;
    }
    if (type === "phase_changed") {
      if (line.phase === "waiting_for_model" || line.phase === "streaming_reasoning") {
        phase = "thinking";
        reason = line.phase;
      } else if (line.phase === "streaming_text") {
        phase = "streaming";
        reason = line.phase;
      } else if (line.phase === "tool_execution") {
        phase = "tool";
        reason = line.phase;
      }
      updatedAt = at;
      continue;
    }
    if (type === "first_token") {
      phase = "streaming";
      reason = "first_token";
      updatedAt = at;
    }
  }

  if (!open && phase === "busy") {
    // Delivered but Grok has not opened a turn yet in its lifecycle log.
    return { phase: "busy", reason: "prompt-delivered", updatedAt: lastDeliverAt };
  }
  return { phase, reason, updatedAt };
}

/** Load provider lifecycle lines for a native thread/session id when available. */
export function loadProviderTranscriptLines(
  adapterKind: string | null,
  providerThreadId: string | null,
  homeDirectory = homedir(),
  _roomsSessionId?: string | null,
): TranscriptLine[] {
  if (!adapterKind) return [];
  if (!providerThreadId) return [];
  if (providerThreadId.endsWith(".jsonl") && (providerThreadId.startsWith("/") || /^[A-Za-z]:[\\/]/.test(providerThreadId))) {
    return readJsonlTail(providerThreadId);
  }
  if (adapterKind === "codex") {
    return loadCodexLines(providerThreadId, homeDirectory);
  }
  if (adapterKind === "claude") {
    return loadClaudeLines(providerThreadId, homeDirectory);
  }
  if (adapterKind === "grok") {
    // Grok identity is the exact session id (or absolute events.jsonl path)
    // stored on the runtime at launch. Never scan for a global newest file.
    return loadGrokEventLines(homeDirectory, providerThreadId);
  }
  return [];
}

function loadCodexLines(providerThreadId: string, homeDirectory: string): TranscriptLine[] {
  const cacheKey = `codex:${providerThreadId}:${homeDirectory}`;
  const cached = pathCache.get(cacheKey);
  if (cached && Date.now() - cached.checkedAt < PATH_CACHE_MS) {
    return readJsonlTail(cached.path);
  }
  const root = join(homeDirectory, ".codex", "sessions");
  const match = findTranscriptFile(root, (path, firstLine) => {
    try {
      const record = JSON.parse(firstLine) as { payload?: { id?: string } };
      return record.payload?.id === providerThreadId;
    } catch {
      return path.includes(providerThreadId);
    }
  });
  if (match) pathCache.set(cacheKey, { path: match, checkedAt: Date.now() });
  return match ? readJsonlTail(match) : [];
}

function loadClaudeLines(providerThreadId: string, homeDirectory: string): TranscriptLine[] {
  const cacheKey = `claude:${providerThreadId}:${homeDirectory}`;
  const cached = pathCache.get(cacheKey);
  if (cached && Date.now() - cached.checkedAt < PATH_CACHE_MS) {
    return readJsonlTail(cached.path);
  }
  const root = join(homeDirectory, ".claude", "projects");
  const match = findTranscriptFile(root, (path) => path.endsWith(`${providerThreadId}.jsonl`) || path.includes(`/${providerThreadId}.jsonl`));
  if (match) pathCache.set(cacheKey, { path: match, checkedAt: Date.now() });
  return match ? readJsonlTail(match) : [];
}

/**
 * Load Grok lifecycle only for the exact providerThreadId bound to this runtime.
 * providerThreadId is either:
 *   - the Grok session directory id (…/sessions/<cwd>/<id>/events.jsonl), or
 *   - an absolute path to that events.jsonl file.
 * No rooms-session path guess. No global newest-file fallback.
 */
function loadGrokEventLines(homeDirectory: string, providerThreadId: string): TranscriptLine[] {
  const cacheKey = `grok:${providerThreadId}:${homeDirectory}`;
  const cached = pathCache.get(cacheKey);
  if (cached && Date.now() - cached.checkedAt < PATH_CACHE_MS) {
    return readJsonlTail(cached.path);
  }

  // Exact absolute path binding (tests and adapters may store the full file path).
  if (providerThreadId.endsWith("events.jsonl") && (providerThreadId.startsWith("/") || /^[A-Za-z]:[\\/]/.test(providerThreadId))) {
    pathCache.set(cacheKey, { path: providerThreadId, checkedAt: Date.now() });
    return readJsonlTail(providerThreadId);
  }

  const root = join(homeDirectory, ".grok", "sessions");
  // Match only …/<providerThreadId>/events.jsonl — never any other session.
  const match = findTranscriptFile(root, (path) => {
    if (!path.endsWith("events.jsonl")) return false;
    const marker = `/${providerThreadId}/events.jsonl`;
    const winMarker = `\\${providerThreadId}\\events.jsonl`;
    return path.endsWith(marker) || path.endsWith(winMarker) || path.includes(marker) || path.includes(winMarker);
  }, "events.jsonl");
  if (match) pathCache.set(cacheKey, { path: match, checkedAt: Date.now() });
  return match ? readJsonlTail(match) : [];
}

function findTranscriptFile(
  root: string,
  predicate: (path: string, firstLine: string) => boolean,
  requiredSuffix = ".jsonl",
): string | null {
  let names: string[] = [];
  try {
    names = readdirSync(root, { recursive: true }).map(String);
  } catch {
    return null;
  }
  const candidates = names
    .filter((name) => name.endsWith(requiredSuffix))
    .map((name) => join(root, name))
    .map((path) => {
      try { return { path, mtime: statSync(path).mtimeMs }; } catch { return null; }
    })
    .filter(Boolean) as Array<{ path: string; mtime: number }>;
  candidates.sort((left, right) => right.mtime - left.mtime);

  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    try {
      const firstRaw = readFileHeadLine(candidate.path);
      if (predicate(candidate.path, firstRaw)) return candidate.path;
    } catch {
      // keep scanning
    }
  }
  return null;
}

function readFileHeadLine(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(4096);
    const n = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.toString("utf8", 0, n);
    return text.split("\n").find((line) => line.trim()) || "";
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/** True bounded tail: open/fstat/read only the last TAIL_BYTES (or less). */
export function readJsonlTail(path: string, maxBytes = TAIL_BYTES): TranscriptLine[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    const size = stat.size;
    if (size <= 0) return [];
    const start = size > maxBytes ? size - maxBytes : 0;
    const length = size - start;
    const buffer = Buffer.allocUnsafe(length);
    readSync(fd, buffer, 0, length, start);
    const text = buffer.toString("utf8");
    const lines = text.split("\n");
    if (start > 0 && lines.length) lines.shift(); // drop partial first line after seek
    return lines
      .filter((line) => line.trim())
      .map((line) => {
        try { return JSON.parse(line) as TranscriptLine; } catch { return null; }
      })
      .filter(Boolean) as TranscriptLine[];
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/** Test helper: clear the path cache between cases. */
export function clearProviderTurnPathCache(): void {
  pathCache.clear();
}

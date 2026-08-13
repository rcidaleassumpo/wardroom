// SPDX-License-Identifier: Apache-2.0
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type JsonRecord = Record<string, unknown>;

export type ProviderReplyScanState = Readonly<{
  offsets: Readonly<Record<string, number>>;
  inputSeen: boolean;
  candidateText: string | null;
  completed: boolean;
  completedAt: string | null;
  failureReason: string | null;
}>;

export type ProviderFinalReply = Readonly<{
  state: ProviderReplyScanState;
  status: "pending" | "complete" | "failed";
  text: string | null;
  reason: string | null;
}>;

type TranscriptArtifact = Readonly<{
  key: "transcript" | "lifecycle" | "history";
  path: string;
}>;

const READ_CHUNK_BYTES = 512 * 1024;
const artifactCache = new Map<string, TranscriptArtifact[]>();

export function supportsProviderFinalReply(adapterKind: string | null): boolean {
  return adapterKind === "codex"
    || adapterKind === "claude"
    || adapterKind === "grok"
    || adapterKind === "agy"
    || adapterKind === "gemini";
}

/**
 * Capture file offsets before Rooms types a direct message into a provider.
 * Later scans can therefore select only records written for that delivery.
 */
export function captureProviderReplyScanState(
  adapterKind: string,
  providerThreadId: string | null,
  homeDirectory = homedir(),
): ProviderReplyScanState {
  const offsets: Record<string, number> = {};
  for (const artifact of providerTranscriptArtifacts(adapterKind, providerThreadId, homeDirectory)) {
    try { offsets[artifact.key] = statSync(artifact.path).size; }
    catch { offsets[artifact.key] = 0; }
  }
  return { offsets, inputSeen: false, candidateText: null, completed: false, completedAt: null, failureReason: null };
}

/**
 * Read provider-native append logs from the saved offsets. Only explicit final
 * records complete a reply. Tool output, reasoning, and streaming commentary
 * never become Rooms messages.
 */
export function scanProviderFinalReply(input: Readonly<{
  adapterKind: string;
  providerThreadId: string | null;
  state: ProviderReplyScanState;
  expectedInput?: string;
  homeDirectory?: string;
}>): ProviderFinalReply {
  let inputSeen = input.expectedInput === undefined || input.state.inputSeen;
  let candidateText = input.state.candidateText;
  let completed = input.state.completed;
  let completedAt = input.state.completedAt;
  let failureReason = input.state.failureReason;
  const offsets = { ...input.state.offsets };

  for (const artifact of providerTranscriptArtifacts(input.adapterKind, input.providerThreadId, input.homeDirectory ?? homedir())) {
    // Grok writes input/answer and lifecycle to separate files. Do not consume
    // a turn_ended marker until chat_history has shown this exact input.
    if (input.adapterKind === "grok" && artifact.key === "lifecycle" && !inputSeen) continue;
    const read = readJsonlAppend(artifact.path, offsets[artifact.key] ?? 0);
    offsets[artifact.key] = read.offset;
    const records = input.adapterKind === "gemini"
      ? read.records.flatMap(expandGeminiRecord)
      : read.records;
    for (const record of records) {
      if (!inputSeen && input.expectedInput !== undefined && providerInputContains(input.adapterKind, artifact.key, record, input.expectedInput)) {
        inputSeen = true;
        candidateText = null;
        completed = false;
        completedAt = null;
        failureReason = null;
        continue;
      }
      if (!inputSeen) continue;
      const observed = observeProviderRecord(input.adapterKind, artifact.key, record);
      if (observed.clearCandidate) candidateText = null;
      if (observed.candidateText !== null) candidateText = observed.candidateText;
      if (observed.completed) {
        completed = true;
        completedAt = observed.completedAt ?? completedAt;
      }
      if (observed.failureReason !== null) failureReason = observed.failureReason;
    }
  }

  const state = { offsets, inputSeen, candidateText, completed, completedAt, failureReason };
  const finalMissing = completed && candidateText === null;
  return {
    state,
    status: failureReason !== null || finalMissing ? "failed" : completed ? "complete" : "pending",
    text: completed && candidateText !== null ? candidateText : null,
    reason: failureReason ?? (finalMissing ? "provider-final-empty" : null),
  };
}

function providerTranscriptArtifacts(adapterKind: string, providerThreadId: string | null, homeDirectory: string): TranscriptArtifact[] {
  if (!providerThreadId) return [];
  const absoluteJsonl = providerThreadId.endsWith(".jsonl")
    && (providerThreadId.startsWith("/") || /^[A-Za-z]:[\\/]/.test(providerThreadId));
  if (absoluteJsonl) {
    if (adapterKind === "grok") {
      const lifecycle = providerThreadId.endsWith("events.jsonl") ? providerThreadId : join(dirname(providerThreadId), "events.jsonl");
      return [
        { key: "history", path: join(dirname(lifecycle), "chat_history.jsonl") },
        { key: "lifecycle", path: lifecycle },
      ];
    }
    return [{ key: "transcript", path: providerThreadId }];
  }
  const cacheKey = `${adapterKind}:${homeDirectory}:${providerThreadId}`;
  const cached = artifactCache.get(cacheKey);
  if (cached) return cached;

  if (adapterKind === "codex") {
    const match = findExactJsonl(join(homeDirectory, ".codex", "sessions"), (path, first) => {
      try { return (JSON.parse(first) as { payload?: { id?: unknown } }).payload?.id === providerThreadId; }
      catch { return path.includes(providerThreadId); }
    });
    return cacheArtifacts(cacheKey, match ? [{ key: "transcript", path: match }] : []);
  }
  if (adapterKind === "claude") {
    const match = findExactJsonl(join(homeDirectory, ".claude", "projects"), (path) => path.endsWith(`${providerThreadId}.jsonl`));
    return cacheArtifacts(cacheKey, match ? [{ key: "transcript", path: match }] : []);
  }
  if (adapterKind === "grok") {
    const match = findExactJsonl(join(homeDirectory, ".grok", "sessions"), (path) => path.endsWith(`/${providerThreadId}/events.jsonl`) || path.endsWith(`\\${providerThreadId}\\events.jsonl`), "events.jsonl");
    return cacheArtifacts(cacheKey, match ? [
      { key: "history", path: join(dirname(match), "chat_history.jsonl") },
      { key: "lifecycle", path: match },
    ] : []);
  }
  if (adapterKind === "gemini") {
    const match = findExactJsonl(join(homeDirectory, ".gemini", "tmp"), (_path, firstLine) => {
      try { return (JSON.parse(firstLine) as { sessionId?: unknown }).sessionId === providerThreadId; }
      catch { return false; }
    });
    return cacheArtifacts(cacheKey, match ? [{ key: "transcript", path: match }] : []);
  }
  if (adapterKind === "agy") {
    return cacheArtifacts(cacheKey, [{
      key: "transcript",
      path: join(homeDirectory, ".gemini", "antigravity-cli", "brain", providerThreadId, ".system_generated", "logs", "transcript.jsonl"),
    }]);
  }
  return [];
}

function providerInputContains(adapterKind: string, artifact: TranscriptArtifact["key"], record: JsonRecord, expectedInput: string): boolean {
  let value: unknown = null;
  if (adapterKind === "codex") {
    const payload = object(record.payload);
    if (record.type === "response_item" && payload?.role === "user") value = payload.content;
  } else if (adapterKind === "claude") {
    if (record.type === "user") value = object(record.message)?.content;
  } else if (adapterKind === "grok") {
    if (artifact === "history" && record.type === "user") value = record.content;
  } else if (adapterKind === "gemini") {
    if (record.type === "user") value = record.content;
  } else if (adapterKind === "agy") {
    if (record.type === "USER_INPUT") value = record.content;
  }
  if (value === null || value === undefined) return false;
  const normalizedExpected = expectedInput.trim();
  return normalizedExpected.length > 0 && collectStrings(value).some((part) => part.includes(normalizedExpected));
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  const record = object(value);
  return record ? Object.values(record).flatMap(collectStrings) : [];
}

function cacheArtifacts(key: string, artifacts: TranscriptArtifact[]): TranscriptArtifact[] {
  if (artifacts.length > 0) artifactCache.set(key, artifacts);
  return artifacts;
}

function observeProviderRecord(adapterKind: string, artifact: TranscriptArtifact["key"], record: JsonRecord): Readonly<{
  candidateText: string | null;
  clearCandidate: boolean;
  completed: boolean;
  completedAt: string | null;
  failureReason: string | null;
}> {
  const at = text(record.timestamp) ?? text(record.created_at) ?? text(record.ts);
  if (adapterKind === "codex") {
    const payload = object(record.payload);
    if (record.type === "event_msg" && payload?.type === "task_complete") {
      return { candidateText: cleanText(payload.last_agent_message), clearCandidate: false, completed: true, completedAt: at, failureReason: null };
    }
    return emptyObservation();
  }

  if (adapterKind === "claude") {
    if (record.type === "assistant") {
      const message = object(record.message);
      const parts = Array.isArray(message?.content) ? message.content : [];
      if (parts.map(object).some((part) => part?.type === "tool_use")) {
        return { candidateText: null, clearCandidate: true, completed: false, completedAt: null, failureReason: null };
      }
      const answer = parts
        .map(object)
        .filter((part): part is JsonRecord => part !== null && part.type === "text")
        .map((part) => cleanText(part.text))
        .filter((part): part is string => part !== null)
        .join("\n\n");
      return { candidateText: cleanText(answer), clearCandidate: false, completed: false, completedAt: null, failureReason: null };
    }
    if (record.type === "system" && record.subtype === "turn_duration") {
      return { candidateText: null, clearCandidate: false, completed: true, completedAt: at, failureReason: null };
    }
    if (record.type === "result" && record.is_error === true) {
      return { candidateText: null, clearCandidate: true, completed: false, completedAt: at, failureReason: "provider-turn-error" };
    }
    return emptyObservation();
  }

  if (adapterKind === "grok") {
    if (artifact === "history" && record.type === "assistant") {
      const toolCalls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
      return toolCalls.length === 0
        ? { candidateText: cleanText(record.content), clearCandidate: false, completed: false, completedAt: null, failureReason: null }
        : { candidateText: null, clearCandidate: true, completed: false, completedAt: null, failureReason: null };
    }
    if (artifact === "lifecycle" && record.type === "turn_ended") {
      const outcome = text(record.outcome);
      return outcome !== null && outcome !== "completed" && outcome !== "success"
        ? { candidateText: null, clearCandidate: true, completed: false, completedAt: at, failureReason: `provider-turn-${outcome}` }
        : { candidateText: null, clearCandidate: false, completed: true, completedAt: at, failureReason: null };
    }
    return emptyObservation();
  }

  if (adapterKind === "gemini") {
    const toolCalls = Array.isArray(record.toolCalls) ? record.toolCalls : [];
    if (record.type === "gemini") {
      return toolCalls.length > 0
        ? { candidateText: null, clearCandidate: true, completed: false, completedAt: at, failureReason: null }
        : { candidateText: cleanGeminiContent(record.content), clearCandidate: false, completed: true, completedAt: at, failureReason: null };
    }
    if (record.type === "error") {
      return { candidateText: null, clearCandidate: true, completed: false, completedAt: at, failureReason: "provider-turn-error" };
    }
  }

  if (adapterKind === "agy") {
    const toolCalls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
    if (record.type === "PLANNER_RESPONSE" && record.status === "DONE" && record.source === "MODEL" && toolCalls.length === 0) {
      const answer = cleanText(record.content);
      return answer === null
        ? emptyObservation()
        : { candidateText: answer, clearCandidate: false, completed: true, completedAt: at, failureReason: null };
    }
    if (record.status === "ERROR" || record.status === "FAILED") {
      return { candidateText: null, clearCandidate: true, completed: false, completedAt: at, failureReason: "provider-turn-error" };
    }
  }
  return emptyObservation();
}

function cleanGeminiContent(value: unknown): string | null {
  if (typeof value === "string") return cleanText(value);
  if (!Array.isArray(value)) return null;
  return cleanText(value.map((part) => cleanText(object(part)?.text)).filter((part): part is string => part !== null).join("\n\n"));
}

function expandGeminiRecord(record: JsonRecord): JsonRecord[] {
  if (typeof record.type === "string") return [record];
  const setMessages = object(record.$set)?.messages;
  const pushedMessages = object(record.$push)?.messages;
  return [...geminiMessageRecords(setMessages), ...geminiMessageRecords(pushedMessages)];
}

function geminiMessageRecords(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.map(object).filter((item): item is JsonRecord => item !== null);
  const record = object(value);
  return record ? [record] : [];
}

function emptyObservation(): Readonly<{ candidateText: null; clearCandidate: false; completed: false; completedAt: null; failureReason: null }> {
  return { candidateText: null, clearCandidate: false, completed: false, completedAt: null, failureReason: null };
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function object(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function readJsonlAppend(path: string, requestedOffset: number): Readonly<{ records: JsonRecord[]; offset: number }> {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = requestedOffset > size ? 0 : Math.max(0, requestedOffset);
    if (start === size) return { records: [], offset: start };
    const length = Math.min(READ_CHUNK_BYTES, size - start);
    const buffer = Buffer.allocUnsafe(length);
    const count = readSync(fd, buffer, 0, length, start);
    const bytes = buffer.subarray(0, count);
    const lastNewline = bytes.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      // An over-sized provider record cannot be a safe Rooms chat message.
      // Advance boundedly so a large tool result cannot block the final line.
      return count === READ_CHUNK_BYTES
        ? { records: [], offset: start + count }
        : { records: [], offset: start };
    }
    const records = bytes.subarray(0, lastNewline).toString("utf8").split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try { return JSON.parse(line) as JsonRecord; }
        catch { return null; }
      })
      .filter((record): record is JsonRecord => record !== null);
    return { records, offset: start + lastNewline + 1 };
  } catch {
    return { records: [], offset: requestedOffset };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

function findExactJsonl(root: string, predicate: (path: string, firstLine: string) => boolean, suffix = ".jsonl"): string | null {
  let names: string[];
  try {
    names = readdirSync(root, { recursive: true }).map(String);
  } catch {
    return null;
  }
  const candidates = names.filter((name) => name.endsWith(suffix)).map((name) => join(root, name));
  for (const path of candidates) {
    try {
      if (predicate(path, readFirstLine(path))) return path;
    } catch { /* keep looking */ }
  }
  return null;
}

function readFirstLine(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(4096);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, count).split("\n").find((line) => line.trim()) ?? "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

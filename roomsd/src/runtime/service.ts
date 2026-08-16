// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { closeSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  RuntimeCreateRequest, RuntimeListRequest, RuntimeStatusRequest, RuntimeAttachRequest, RuntimeDetachRequest,
  RuntimeInputRequest, RuntimeResizeRequest, RuntimeSignalRequest, RuntimeTerminateRequest, RuntimeRecoverRequest,
  RuntimeDeliverMessageRequest, RuntimeEventsRequest, RuntimeResponse, RuntimeListResponse, RuntimeOperationResponse,
  RuntimeEventsResponse, RuntimeRecord,
} from "../generated/rooms/v1/rooms.js";
import { RuntimeHostClient } from "./host/client.js";
import { RuntimeHostSupervisor } from "./host/supervisor.js";
import type { HostError, HostExit, HostHelloAck, HostOutput } from "./host/codec.js";
import { ensureRuntimeSocketDirectory, parseRuntimeHandle, runtimeHandleRef, runtimeSocketPath } from "./host/endpoint.js";
import type { RuntimeAction, RuntimeAttachment, RuntimeBinding, RuntimeEvent, Runtime, RuntimeActor, RuntimeQuotaStatus } from "./contracts.js";
import { RuntimeRepository } from "../storage/runtime-repository.js";
import { RoomsStoreError } from "../storage/repository.js";
import { readMachineIdentityStatus } from "../identity/machine-identity.js";

/** Exit reason for a runtime whose host process is no longer reachable. */
export const HOST_ABSENT_REASON = "runtime host is absent";

/**
 * A provider submission must not place text and Enter in the same PTY write.
 * Interactive TUIs classify a bulk write as pasted text and may keep its final
 * carriage return in the composer. A distinct, slightly delayed Enter frame
 * behaves like a user pressing Enter after the paste.
 */
export function encodeProviderSubmission(body: string): { frames: string[]; delaysMs: number[] } {
  // On an empty composer, provider TUIs treat a leading "!", "/", or "#" as a
  // mode prefix (Claude Code: shell mode, slash command, memory), so a channel
  // body like "!task add ..." would flip the session into shell mode instead
  // of arriving as text. A leading space defuses the prefix and is invisible
  // in the delivered message.
  const guarded = /^[!/#]/.test(body) ? ` ${body}` : body;
  return {
    frames: [Buffer.from(guarded).toString("base64"), Buffer.from("\r").toString("base64")],
    delaysMs: [0, 75],
  };
}

export function runtimeDeliveryAuditReference(messageId: string, bytesWritten: number, federatedHomeAuthorityId?: string): Readonly<{
  messageId?: string;
  payload: Readonly<Record<string, string | number>>;
}> {
  return federatedHomeAuthorityId
    ? { payload: { bytesWritten, canonicalMessageId: messageId, canonicalHomeAuthorityId: federatedHomeAuthorityId } }
    : { messageId, payload: { bytesWritten } };
}

const toRecord = (runtime: Runtime): RuntimeRecord => ({ runtimeId: runtime.runtimeId, homeAuthorityId: runtime.homeAuthorityId, sessionId: runtime.sessionId, providerThreadId: runtime.providerThreadId, cwd: runtime.effectiveCwd, cwdState: runtime.effectiveCwd ? "available" : "unavailable", cwdReason: runtime.effectiveCwd ? null : "legacy-runtime-cwd-unavailable", generation: runtime.generation, protocolVersion: runtime.protocolVersion, transportKind: runtime.transportKind, state: runtime.state, machineId: runtime.machineId, createdAt: runtime.createdAt, updatedAt: runtime.updatedAt, endedAt: runtime.endedAt, exitReason: runtime.exitReason });
const toBinding = (binding: RuntimeBinding) => ({ bindingId: binding.bindingId, runtimeId: binding.runtimeId, sessionId: binding.sessionId, generation: binding.generation, channelId: binding.channelId, adapterKind: binding.adapterKind, handleRef: binding.handleRef, boundAt: binding.boundAt, unboundAt: binding.unboundAt });
const toAttachment = (attachment: RuntimeAttachment) => ({ attachmentId: attachment.attachmentId, runtimeId: attachment.runtimeId, sessionId: attachment.sessionId, generation: attachment.generation, viewerId: attachment.viewerId, mode: attachment.mode, outputCursor: attachment.outputCursor.toString(), leaseExpiresAt: attachment.leaseExpiresAt, attachedAt: attachment.attachedAt, detachedAt: attachment.detachedAt });
const toEvent = (event: RuntimeEvent) => ({ runtimeId: event.runtimeId, generation: event.generation, eventSeq: event.eventSeq, eventId: event.eventId, kind: event.kind, outputCursor: event.outputCursor?.toString() ?? null, messageId: event.messageId, outcome: event.outcome, payload: event.payload, occurredAt: event.occurredAt });

export interface ProviderIdentityDiscoveryOptions {
  /** Thread ids already owned by another live runtime, which this launch must not adopt. */
  isClaimed?: (providerThreadId: string) => boolean;
  /**
   * Atomic claim for this runtime. When provided, a candidate is only returned
   * after claim succeeds; a failed claim means another discoverer won that id
   * and this poll continues looking for another session.
   */
  tryClaim?: (providerThreadId: string) => boolean;
  /** Stops the poll early once the runtime this identity belongs to is no longer alive. */
  keepPolling?: () => boolean;
  timeoutMs?: number;
  /**
   * When set, only claim a transcript that contains this exact marker (the
   * Rooms session id from the launch briefing). Concurrent same-cwd launches
   * otherwise race newest-first discovery and can swap distinct transcripts.
   */
  ownershipMarker?: string;
}

export interface FileMarkerScanState {
  offset: number;
  device: number | null;
  inode: number | null;
}

const TRANSCRIPT_SCAN_CHUNK_BYTES = 64 * 1024;

/** Resolve aliases once so the provider process and transcript lookup share one cwd. */
export function canonicalProviderCwd(cwd: string | undefined): string | undefined {
  return cwd === undefined ? undefined : realpathSync.native(cwd);
}

/** Claude 2.1.x replaces every non-word path character with one hyphen. */
export function claudeProjectKey(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9_-]/g, "-");
}

/** Discover provider-native identity emitted by providers that persist a JSONL session transcript. */
export async function discoverProviderThreadId(adapterKind: string | undefined, cwd: string | undefined, launchedAfter: number, homeDirectory = homedir(), options: ProviderIdentityDiscoveryOptions = {}): Promise<string | null> {
  const isClaimed = options.isClaimed ?? (() => false);
  const tryClaim = options.tryClaim;
  const keepPolling = options.keepPolling ?? (() => true);
  const ownershipMarker = typeof options.ownershipMarker === "string" && options.ownershipMarker.trim() !== ""
    ? options.ownershipMarker
    : null;
  if (!cwd || (adapterKind !== "claude" && adapterKind !== "codex" && adapterKind !== "grok" && adapterKind !== "agy" && adapterKind !== "gemini")) return null;
  const providerCwd = canonicalProviderCwd(cwd)!;
  const markerScans = new Map<string, FileMarkerScanState>();
  const containsOwnershipMarker = (path: string): boolean => {
    if (!ownershipMarker) return true;
    let scan = markerScans.get(path);
    if (!scan) {
      scan = { offset: 0, device: null, inode: null };
      markerScans.set(path, scan);
    }
    return fileContainsMarker(path, ownershipMarker, scan);
  };
  // This poll is asynchronous relative to launch, so it never delays the
  // interactive wrapper. A provider whose first briefing arrives minutes late
  // still owns a real conversation, so it runs for as long as the runtime is
  // alive rather than giving up on a fixed clock and leaving identity null.
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  while (Date.now() < deadline && keepPolling()) {
    try {
      if (adapterKind === "grok") {
        for (const sessionId of listGrokSessionCandidates(providerCwd, launchedAfter, homeDirectory)) {
          if (isClaimed(sessionId)) continue;
          if (ownershipMarker) {
            // Grok's events.jsonl contains lifecycle only. User input, including
            // the Rooms launch marker, lives in the same session's chat history.
            const historyPath = join(homeDirectory, ".grok", "sessions", encodeURIComponent(providerCwd), sessionId, "chat_history.jsonl");
            if (!containsOwnershipMarker(historyPath)) continue;
          }
          if (tryClaim) {
            if (tryClaim(sessionId)) return sessionId;
            continue; // lost the atomic race; try the next candidate / poll
          }
          return sessionId;
        }
      } else if (adapterKind === "gemini") {
        for (const candidate of listGeminiSessionCandidates(providerCwd, launchedAfter, homeDirectory)) {
          if (isClaimed(candidate.sessionId)) continue;
          if (!containsOwnershipMarker(candidate.path)) continue;
          if (tryClaim) {
            if (tryClaim(candidate.sessionId)) return candidate.sessionId;
            continue;
          }
          return candidate.sessionId;
        }
      } else if (adapterKind === "agy") {
        for (const sessionId of listAgySessionCandidates(launchedAfter, homeDirectory)) {
          if (isClaimed(sessionId)) continue;
          const transcriptPath = join(homeDirectory, ".gemini", "antigravity-cli", "brain", sessionId, ".system_generated", "logs", "transcript.jsonl");
          if (!containsOwnershipMarker(transcriptPath)) continue;
          if (tryClaim) {
            if (tryClaim(sessionId)) return sessionId;
            continue;
          }
          return sessionId;
        }
      } else {
        const directory = adapterKind === "claude"
          ? join(homeDirectory, ".claude", "projects", claudeProjectKey(providerCwd))
          : join(homeDirectory, ".codex", "sessions");
        const names = adapterKind === "codex"
          ? readdirSync(directory, { recursive: true }).map(String)
          : readdirSync(directory);
        // Oldest-first when ownership is enforced so concurrent launches bind
        // in creation order; newest-first remains the legacy single-launch path.
        const candidates = names.filter(name => name.endsWith(".jsonl")).map(name => {
          const path = join(directory, name);
          try { const stat = statSync(path); return { path, created: stat.birthtimeMs || stat.mtimeMs }; } catch { return null; }
        }).filter((value): value is { path: string; created: number } => value !== null && value.created >= launchedAfter - 1_000)
          .sort((a, b) => ownershipMarker ? a.created - b.created : b.created - a.created);
        for (const candidate of candidates) {
          const first = readFirstLine(candidate.path);
          try {
            const record = JSON.parse(first) as { sessionId?: unknown; payload?: { id?: unknown; cwd?: unknown } };
            const sessionId = adapterKind === "codex" ? record.payload?.id : record.sessionId;
            const recordCwd: unknown = adapterKind === "codex" ? record.payload?.cwd : providerCwd;
            if (recordCwd !== providerCwd || typeof sessionId !== "string" || sessionId.length === 0 || isClaimed(sessionId)) continue;
            if (!containsOwnershipMarker(candidate.path)) continue;
            if (tryClaim) {
              if (tryClaim(sessionId)) return sessionId;
              continue;
            }
            return sessionId;
          } catch { /* provider may still be writing its first record */ }
        }
      }
    } catch { /* provider has not created its project directory yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return null;
}

/** Google Gemini CLI stores JSONL chats under a cwd-hashed project temp dir. */
function listGeminiSessionCandidates(cwd: string, launchedAfter: number, homeDirectory: string): Array<{ sessionId: string; path: string }> {
  const root = join(homeDirectory, ".gemini", "tmp");
  let names: string[] = [];
  try { names = readdirSync(root, { recursive: true }).map(String); }
  catch { return []; }
  const projectHash = createHash("sha256").update(cwd).digest("hex");
  return names.filter((name) => /(^|[/\\])chats[/\\]session-.*\.jsonl$/.test(name)).map((name) => {
    const path = join(root, name);
    try {
      const stat = statSync(path);
      if ((stat.birthtimeMs || stat.mtimeMs) < launchedAfter - 1_000) return null;
      const metadata = JSON.parse(readFirstLine(path)) as { sessionId?: unknown; projectHash?: unknown };
      return typeof metadata.sessionId === "string" && metadata.projectHash === projectHash
        ? { sessionId: metadata.sessionId, path, created: stat.birthtimeMs || stat.mtimeMs }
        : null;
    } catch { return null; }
  }).filter((candidate): candidate is { sessionId: string; path: string; created: number } => candidate !== null)
    .sort((left, right) => left.created - right.created)
    .map(({ sessionId, path }) => ({ sessionId, path }));
}

/** AGY uses the brain directory id as its durable conversation id. */
function listAgySessionCandidates(launchedAfter: number, homeDirectory: string): string[] {
  const root = join(homeDirectory, ".gemini", "antigravity-cli", "brain");
  let names: string[] = [];
  try { names = readdirSync(root); }
  catch { return []; }
  return names.map((sessionId) => {
    const path = join(root, sessionId, ".system_generated", "logs", "transcript.jsonl");
    try {
      const stat = statSync(path);
      return { sessionId, created: stat.birthtimeMs || stat.mtimeMs };
    } catch { return null; }
  }).filter((candidate): candidate is { sessionId: string; created: number } =>
    candidate !== null && candidate.created >= launchedAfter - 1_000)
    .sort((left, right) => left.created - right.created)
    .map((candidate) => candidate.sessionId);
}

/** Read only the provider metadata record, never the whole growing transcript. */
export function readFirstLine(path: string): string {
  try {
    const size = statSync(path).size;
    if (size <= 0) return "";
    const length = Math.min(size, TRANSCRIPT_SCAN_CHUNK_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try {
      const read = readSync(fd, buffer, 0, length, 0);
      const body = buffer.subarray(0, read);
      const newline = body.indexOf(0x0a);
      return body.subarray(0, newline >= 0 ? newline : read).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/**
 * Scan one bounded chunk per poll and retain enough overlap to match a marker
 * split across writes. A fresh provider transcript may put its first prompt
 * after a large system and project briefing, so a fixed prefix is not an
 * ownership check.
 */
export function fileContainsMarker(path: string, marker: string, state: FileMarkerScanState): boolean {
  try {
    const wanted = Buffer.from(marker);
    if (!wanted.length) return false;
    const stat = statSync(path);
    if (stat.size <= 0) return false;
    if (state.device !== stat.dev || state.inode !== stat.ino || stat.size < state.offset) {
      state.offset = 0;
      state.device = stat.dev;
      state.inode = stat.ino;
    }
    const overlap = Math.max(0, wanted.length - 1);
    const start = Math.max(0, state.offset - overlap);
    const length = Math.min(stat.size - start, Math.max(TRANSCRIPT_SCAN_CHUNK_BYTES, wanted.length));
    if (length <= 0) return false;
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try {
      const read = readSync(fd, buffer, 0, length, start);
      state.offset = Math.max(state.offset, start + read);
      return buffer.subarray(0, read).includes(wanted);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * Grok Build stores lifecycle under ~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/events.jsonl
 * and user input under the sibling chat_history.jsonl.
 * Candidates are newest-first for this cwd only — never a global cross-project newest file.
 * Claiming is separate and must be atomic at the repository layer.
 */
function listGrokSessionCandidates(
  cwd: string,
  launchedAfter: number,
  homeDirectory: string,
): string[] {
  const root = join(homeDirectory, ".grok", "sessions");
  const encodedCwd = encodeURIComponent(cwd);
  let names: string[] = [];
  try {
    names = readdirSync(root, { recursive: true }).map(String);
  } catch {
    return [];
  }
  const candidates = names
    .filter((name) => name.endsWith("events.jsonl") || name.endsWith("/events.jsonl"))
    .map((name) => {
      const path = join(root, name);
      try {
        const stat = statSync(path);
        return { path, name, created: stat.birthtimeMs || stat.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((value): value is { path: string; name: string; created: number } =>
      value !== null && value.created >= launchedAfter - 1_000)
    .sort((a, b) => b.created - a.created);

  const ids: string[] = [];
  for (const candidate of candidates) {
    // Path relative to sessions root: <encoded-cwd>/<sessionId>/events.jsonl
    const parts = candidate.name.split(/[/\\]/).filter(Boolean);
    if (parts.length < 3 || parts[parts.length - 1] !== "events.jsonl") continue;
    const sessionId = parts[parts.length - 2]!;
    const projectKey = parts[parts.length - 3]!;
    // Prefer exact cwd match; Grok encodes cwd as the parent project key.
    if (projectKey !== encodedCwd && projectKey !== cwd) continue;
    if (!sessionId) continue;
    ids.push(sessionId);
  }
  return ids;
}

/** Interactive providers can idle for minutes before a briefing creates their transcript. */
const PROVIDER_IDENTITY_TIMEOUT_MS = 600_000;

export interface RuntimeServiceOptions { machineId: string; defaultHomeAuthorityId: string; stateDir?: string; socketDirectory?: string; hostExecutable?: string; }
export interface RuntimeAttachHandlers {
  onOutput(value: HostOutput): void;
  onExit(value: HostExit): void;
  onError(value: HostError): void;
  onClose(): void;
}
export interface RuntimeAttachSession {
  response: RuntimeResponse;
  hello: HostHelloAck;
  input(bytes: Uint8Array): Promise<RuntimeOperationResponse>;
  resize(columns: number, rows: number): Promise<RuntimeOperationResponse>;
  detach(): RuntimeOperationResponse;
}

export class RoomsRuntimeService {
  private readonly supervisors = new Map<string, RuntimeHostSupervisor>();
  private readonly clients = new Map<string, RuntimeHostClient>();
  private readonly controllerReady = new Map<string, Promise<HostHelloAck>>();
  private readonly controllerHellos = new Map<string, HostHelloAck>();
  private readonly controllerViewCounts = new Map<string, number>();
  private readonly options: Required<RuntimeServiceOptions>;
  constructor(private readonly repository: RuntimeRepository, options: RuntimeServiceOptions) {
    const stateDir = options.stateDir ?? join(homedir(), ".rooms", "runtimes");
    this.options = { ...options, stateDir, socketDirectory: options.socketDirectory ?? join(dirname(stateDir), "s"), hostExecutable: options.hostExecutable ?? "" };
    mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 });
  }

  /**
   * A localPty host is a separate process, so it can die while this daemon is
   * down: a daemon restart, an upgrade, or a machine restart leaves the row
   * saying "running" with nothing behind the socket. Nothing else ever
   * corrects that: exit frames need a live connection, so no client is left to
   * hear the exit. The stale row then keeps a session undeliverable forever —
   * it holds the delivery lookup, the active-runtime quota, and the provider
   * thread, and it makes `session resume` answer "already running".
   *
   * Probe each locally bound host once at startup and record the ones that are
   * gone. Only a refused or missing socket counts as absent: a host that is
   * merely slow to accept still owns its generation.
   *
   * Locality is the home authority, not `machineId`: `machineId` is the
   * hostname, which changes with the network the machine joins, so rows
   * written under an earlier hostname would never be examined again.
   */
  async reconcileLocalRuntimeHosts(): Promise<{ checked: number; crashed: readonly string[] }> {
    const live = this.repository.list()
      .filter((runtime) => !runtime.endedAt
        && runtime.homeAuthorityId === this.options.defaultHomeAuthorityId
        && runtime.transportKind === "localPty"
        && ["creating", "running", "recovering"].includes(runtime.state));
    const crashed: string[] = [];
    for (const runtime of live) {
      const endpoint = this.repository.getBinding(runtime.runtimeId)?.handleRef;
      const socketPath = (endpoint ? parseRuntimeHandle(endpoint)?.socketPath : null) ?? runtimeSocketPath(runtime, this.options.socketDirectory);
      if (!(await runtimeHostIsAbsent(socketPath))) continue;
      const supervisor = this.supervisors.get(runtime.runtimeId) ?? this.rehydrateSupervisor(runtime);
      this.repository.markState(runtime.runtimeId, runtime.generation, "crashed", HOST_ABSENT_REASON);
      await supervisor.cleanup();
      crashed.push(runtime.runtimeId);
    }
    return { checked: live.length, crashed };
  }

  quotaStatuses(machineId?: string): RuntimeQuotaStatus[] { return this.repository.quotaStatuses(machineId); }

  provesSessionPossession(sessionId: string, proof: Uint8Array): boolean {
    return this.repository.provesActiveSession(sessionId, proof);
  }

  setActiveRuntimeQuota(machineId: string, limit: number, actor: RuntimeActor): RuntimeQuotaStatus {
    if (actor.role !== "operator") throw new RoomsStoreError("runtimeUnauthorized");
    if (!machineId.trim() || !Number.isSafeInteger(limit) || limit < 1) throw new RoomsStoreError("invalidRuntimeQuota");
    const current = this.repository.quota(machineId);
    this.repository.setQuota({ machineId, maxActiveRuntimes: limit, maxObserversPerRuntime: current.maxObserversPerRuntime });
    return this.repository.quotaStatuses(machineId)[0]!;
  }

  resetActiveRuntimeQuota(machineId: string, actor: RuntimeActor): RuntimeQuotaStatus {
    if (actor.role !== "operator") throw new RoomsStoreError("runtimeUnauthorized");
    if (!machineId.trim()) throw new RoomsStoreError("invalidRuntimeQuota");
    this.repository.clearQuota(machineId);
    return this.repository.quotaStatuses(machineId)[0]!;
  }

  async create(request: RuntimeCreateRequest, actor: RuntimeActor): Promise<RuntimeResponse> {
    const plannerLaunch = actor.role === "planner"
      && typeof request.channelId === "string"
      && this.repository.plannerCanLaunchWorker(actor.sessionId, request.sessionId, request.channelId);
    if (actor.role !== "operator" && actor.sessionId !== request.sessionId && !plannerLaunch) throw new RoomsStoreError("runtimeUnauthorized");
    const runtimeId = request.runtimeId ?? `runtime-${randomUUID()}`;
    const generation = request.generation ?? 1;
    const launchCwd = canonicalProviderCwd(request.cwd);
    const reconnectSecret = randomBytes(32);
    const sessionProof = randomBytes(32);
    const runtime = this.repository.create({ runtimeId, homeAuthorityId: request.homeAuthorityId || this.options.defaultHomeAuthorityId, sessionId: request.sessionId, generation, protocolVersion: request.protocolVersion ?? 1, transportKind: (request.transportKind ?? "localPty") as "localPty" | "structured", machineId: request.machineId ?? this.options.machineId, providerThreadId: request.providerThreadId ?? null, effectiveCwd: launchCwd ?? null, effectiveHome: request.effectiveHome ?? null, reconnectSecret, sessionProof });
    const stateDir = request.stateDir ?? this.options.stateDir;
    ensureRuntimeSocketDirectory(this.options.socketDirectory);
    const socketPath = runtimeSocketPath(runtime, this.options.socketDirectory);
    const supervisor = new RuntimeHostSupervisor({ sessionId: runtime.sessionId, channelId: request.channelId, runtimeId: runtime.runtimeId, homeAuthorityId: runtime.homeAuthorityId, generation: runtime.generation, stateDir, socketPath, executable: this.options.hostExecutable || undefined, shell: request.shell, command: request.command, cwd: launchCwd, secret: reconnectSecret, sessionProof, capabilityRenewal: true });
    this.supervisors.set(runtimeId, supervisor);
    try {
      const launchedAt = Date.now();
      await supervisor.start();
      if (request.providerThreadId) this.repository.setProviderThreadId(runtimeId, request.providerThreadId);
      const binding = this.repository.bind({ bindingId: `binding-${randomUUID()}`, runtimeId, homeAuthorityId: runtime.homeAuthorityId, sessionId: runtime.sessionId, generation, channelId: request.channelId ?? null, adapterKind: request.adapterKind ?? "localPty", handleRef: runtimeHandleRef(socketPath, stateDir), launchPolicyRef: request.launchPolicyRef ?? null });
      const current = this.repository.markState(runtimeId, generation, "running");
      if (!request.providerThreadId) {
        // Fresh interactive providers do not persist a native transcript until
        // the first Rooms briefing is submitted. Discovery therefore runs
        // after create returns: launch/attach is not delayed by a five-second
        // poll, and the newly-created transcript can still become durable
        // runtime/session identity for later native `--resume` recovery.
        // Claim is atomic inside tryClaimProviderThreadId so two concurrent
        // same-cwd launches cannot both bind the newest unclaimed session.
        void discoverProviderThreadId(request.adapterKind, launchCwd, launchedAt, request.effectiveHome ?? undefined, {
          timeoutMs: PROVIDER_IDENTITY_TIMEOUT_MS,
          // Bind to this launch's Rooms session id once the briefing lands in
          // the provider transcript, so concurrent same-cwd launches cannot
          // swap each other's distinct conversation ids (internal work item).
          ownershipMarker: request.sessionId,
          // Another live runtime's conversation is never this runtime's identity,
          // so a concurrent launch keeps waiting for its own transcript instead.
          isClaimed: (candidate) => this.repository.providerThreadHolder(candidate, runtimeId) !== null,
          tryClaim: (candidate) => this.repository.tryClaimProviderThreadId(runtimeId, candidate).claimed,
          keepPolling: () => {
            const current = this.repository.get(runtimeId);
            return current !== null
              && current.providerThreadId == null
              && current.endedAt === null
              && ["creating", "running", "recovering"].includes(current.state);
          },
        })
          .then((providerThreadId) => {
            // Successful discovery already claimed via tryClaim; gap only if none.
            if (providerThreadId) return;
            this.recordProviderIdentityGap(runtimeId, generation, "providerThreadIdUndiscovered");
          })
          // A launch that cannot verify its own provider identity says so on the
          // runtime's event stream: silence is what made a null identity
          // indistinguishable from a healthy session that simply started late.
          .catch((error) => this.recordProviderIdentityGap(runtimeId, generation, error instanceof Error ? error.message : "providerThreadIdDiscoveryFailed"));
      }
      return { runtime: toRecord(current), binding: toBinding(binding) };
    } catch (error) {
      await supervisor.cleanup();
      this.repository.markState(runtimeId, generation, "crashed", error instanceof Error ? error.message : "host failed");
      throw error;
    }
  }

  private recordProviderIdentityGap(runtimeId: string, generation: number, reason: string): void {
    const current = this.repository.get(runtimeId);
    if (!current || current.providerThreadId) return;
    try { this.repository.appendEvent({ runtimeId, generation, kind: "error", outcome: reason }); } catch { /* the runtime may already be gone */ }
  }

  list(request: RuntimeListRequest, actor: RuntimeActor): RuntimeListResponse {
    const runtimes = this.repository.list(request.machineId).filter((runtime) => this.actorCanAccessRuntime(actor, runtime, "observe"));
    return { runtimes: runtimes.map(toRecord) };
  }
  resolveActiveSessionRuntime(sessionId: string, actor: RuntimeActor, action: RuntimeAction = "observe"): Runtime {
    const runtime = this.repository.list().filter((item) => item.sessionId === sessionId && !item.endedAt && ["running", "recovering"].includes(item.state)).sort((left, right) => right.generation - left.generation)[0];
    if (!runtime) throw new RoomsStoreError("runtimeNotFound");
    if (!this.actorCanAccessRuntime(actor, runtime, action)) throw new RoomsStoreError("runtimeUnauthorized");
    return runtime;
  }
  resolveActiveSessionRuntimeForDelivery(sessionId: string, actor: RuntimeActor): { runtime: Runtime; actor: RuntimeActor } {
    const runtime = this.repository.list().filter((item) => item.sessionId === sessionId && !item.endedAt && ["running", "recovering"].includes(item.state)).sort((left, right) => right.generation - left.generation)[0];
    if (!runtime) throw new RoomsStoreError("runtimeNotFound");
    return { runtime, actor: { ...actor, capability: { capabilityId: `local-delivery-${actor.sessionId}-${runtime.runtimeId}`, runtimeId: runtime.runtimeId, generation: runtime.generation, sessionId: runtime.sessionId, channelId: null, actions: ["deliverMessage"], expiresAt: new Date(Date.now() + 30_000).toISOString() } } };
  }
  status(request: RuntimeStatusRequest, actor: RuntimeActor): RuntimeResponse { const runtime = this.authorizedRuntime(request.runtimeId, actor); const binding = this.repository.getBinding(runtime.runtimeId); return { runtime: toRecord(runtime), binding: binding ? toBinding(binding) : undefined }; }

  async attach(request: RuntimeAttachRequest, actor: RuntimeActor): Promise<RuntimeResponse> {
    const session = await this.openAttachment(request, actor);
    return session.response;
  }

  async attachInteractive(request: RuntimeAttachRequest, actor: RuntimeActor, handlers: RuntimeAttachHandlers): Promise<RuntimeAttachSession> {
    return this.openAttachment(request, actor, handlers);
  }

  private async openAttachment(request: RuntimeAttachRequest, actor: RuntimeActor, handlers?: RuntimeAttachHandlers): Promise<RuntimeAttachSession> {
    const runtime = this.authorizedRuntime(request.runtimeId, actor, request.generation, request.mode === "controller" ? "controller" : "observe");
    const attachment = this.repository.attach({ attachmentId: request.attachmentId ?? `attachment-${randomUUID()}`, runtimeId: runtime.runtimeId, homeAuthorityId: runtime.homeAuthorityId, sessionId: runtime.sessionId, generation: runtime.generation, viewerId: actor.sessionId, mode: request.mode, leaseExpiresAt: request.leaseExpiresAt ?? null, outputCursor: BigInt(request.outputCursor ?? "0"), operatorOverride: request.operatorOverride === true && actor.role === "operator" });
    const supervisor = this.supervisors.get(runtime.runtimeId) ?? this.rehydrateSupervisor(runtime);
    if (request.mode === "controller" && attachment.mode === "controller") {
      const controller = await this.ensureControllerClient(attachment, runtime, supervisor, BigInt(request.outputCursor ?? "0"));
      if (!handlers) {
        return {
          response: { runtime: toRecord(runtime), attachment: toAttachment(attachment) },
          hello: controller.hello,
          input: (bytes) => this.input({ attachmentId: attachment.attachmentId, bytes: Buffer.from(bytes).toString("base64") }, actor),
          resize: (columns, rows) => this.resize({ attachmentId: attachment.attachmentId, columns, rows }, actor),
          detach: () => this.detach({ attachmentId: attachment.attachmentId }, actor),
        };
      }

      // The host deliberately owns one controller connection. Every terminal
      // view is an observer stream, while input is multiplexed through that
      // controller. This gives repeated attaches tmux-style shared I/O without
      // weakening observer authorization or creating competing controller leases.
      const view = new RuntimeHostClient(supervisor.socketEndpoint(), { sessionId: runtime.sessionId, runtimeId: runtime.runtimeId, homeAuthorityId: runtime.homeAuthorityId, generation: runtime.generation, secret: supervisor.secret }, { renewCapabilities: supervisor.supportsCapabilityRenewal });
      view.on("output", handlers.onOutput);
      view.on("exit", handlers.onExit);
      view.on("error", handlers.onError);
      view.on("close", handlers.onClose);
      try {
        const hello = await view.connect("observe", ["observe"], BigInt(request.outputCursor ?? "0"));
        this.controllerViewCounts.set(attachment.attachmentId, (this.controllerViewCounts.get(attachment.attachmentId) ?? 0) + 1);
        let detached = false;
        return {
          response: { runtime: toRecord(runtime), attachment: toAttachment(attachment) },
          hello,
          input: (bytes) => this.input({ attachmentId: attachment.attachmentId, bytes: Buffer.from(bytes).toString("base64") }, actor),
          resize: (columns, rows) => this.resize({ attachmentId: attachment.attachmentId, columns, rows }, actor),
          detach: () => {
            if (detached) return { ok: true, attachment: toAttachment(this.repository.getAttachment(attachment.attachmentId) ?? attachment) };
            detached = true;
            view.close();
            const remaining = Math.max(0, (this.controllerViewCounts.get(attachment.attachmentId) ?? 1) - 1);
            if (remaining > 0) {
              this.controllerViewCounts.set(attachment.attachmentId, remaining);
              return { ok: true, attachment: toAttachment(this.repository.getAttachment(attachment.attachmentId) ?? attachment) };
            }
            this.controllerViewCounts.delete(attachment.attachmentId);
            return this.detach({ attachmentId: attachment.attachmentId }, actor);
          },
        };
      } catch (error) {
        view.close();
        throw error;
      }
    }
    try {
      const client = new RuntimeHostClient(supervisor.socketEndpoint(), { sessionId: runtime.sessionId, runtimeId: runtime.runtimeId, homeAuthorityId: runtime.homeAuthorityId, generation: runtime.generation, secret: supervisor.secret }, { renewCapabilities: supervisor.supportsCapabilityRenewal });
      if (handlers) {
        client.on("output", handlers.onOutput);
        client.on("exit", handlers.onExit);
        client.on("error", handlers.onError);
        client.on("close", handlers.onClose);
      }
      this.registerClient(attachment, runtime, client);
      const hello = await client.connect(request.mode, request.mode === "controller" ? ["observe", "controller", "input", "resize", "signal", "terminate", "deliverMessage"] : ["observe", "deliverMessage"], BigInt(request.outputCursor ?? "0"));
      return {
        response: { runtime: toRecord(runtime), attachment: toAttachment(attachment) },
        hello,
        input: (bytes) => this.input({ attachmentId: attachment.attachmentId, bytes: Buffer.from(bytes).toString("base64") }, actor),
        resize: (columns, rows) => this.resize({ attachmentId: attachment.attachmentId, columns, rows }, actor),
        detach: () => this.detach({ attachmentId: attachment.attachmentId }, actor),
      };
    } catch (error) {
      this.clients.delete(attachment.attachmentId);
      this.repository.detach(attachment.attachmentId);
      if (isAbsentRuntimeHost(error)) {
        const supervisor = this.supervisors.get(runtime.runtimeId) ?? this.rehydrateSupervisor(runtime);
        this.repository.markState(runtime.runtimeId, runtime.generation, "crashed", HOST_ABSENT_REASON);
        await supervisor.cleanup();
      }
      throw error;
    }
  }

  detach(request: RuntimeDetachRequest, actor: RuntimeActor): RuntimeOperationResponse {
    const attachment = this.repository.getAttachment(request.attachmentId);
    if (!attachment || (actor.role !== "operator" && attachment.viewerId !== actor.sessionId)) throw new RoomsStoreError("runtimeUnauthorized");
    const detached = this.repository.detach(attachment.attachmentId);
    this.clients.get(detached.attachmentId)?.close();
    this.clients.delete(detached.attachmentId);
    if (!attachment.detachedAt) this.repository.appendEvent({ runtimeId: detached.runtimeId, generation: detached.generation, kind: "attachmentDetached", payload: { attachmentId: detached.attachmentId } });
    return { ok: true, attachment: toAttachment(detached) };
  }
  async input(request: RuntimeInputRequest, actor: RuntimeActor): Promise<RuntimeOperationResponse> { const { client, transient } = await this.controllerClient(request.attachmentId, actor, "input"); try { client.input(Buffer.from(request.bytes, "base64")); await client.ping(); return { ok: true }; } finally { if (transient) client.close(); } }
  async resize(request: RuntimeResizeRequest, actor: RuntimeActor): Promise<RuntimeOperationResponse> { const { client, transient } = await this.controllerClient(request.attachmentId, actor, "resize"); try { client.resize(request.columns, request.rows); await client.ping(); return { ok: true }; } finally { if (transient) client.close(); } }
  async signal(request: RuntimeSignalRequest, actor: RuntimeActor): Promise<RuntimeOperationResponse> { const { client, transient } = await this.controllerClient(request.attachmentId, actor); try { client.signal(request.signal); await client.ping(); return { ok: true }; } finally { if (transient) client.close(); } }
  async terminate(request: RuntimeTerminateRequest, actor: RuntimeActor): Promise<RuntimeOperationResponse> {
    const runtime = this.authorizedRuntime(request.runtimeId, actor, request.generation);
    try {
      const connection = request.attachmentId ? await this.controllerClient(request.attachmentId, actor) : undefined;
      if (connection) { try { await connection.client.terminate(); } finally { if (connection.transient) connection.client.close(); } }
      else {
        const supervisor = this.supervisors.get(runtime.runtimeId) ?? this.rehydrateSupervisor(runtime);
        const connected = await supervisor.reconnect("observe", ["observe", "terminate"], 0n);
        try { await connected.terminate(); } finally { connected.close(); }
      }
    } catch (error) {
      if (!isAbsentRuntimeHost(error)) throw error;
      const supervisor = this.supervisors.get(runtime.runtimeId) ?? this.rehydrateSupervisor(runtime);
      await supervisor.cleanup();
    }
    this.repository.markState(runtime.runtimeId, runtime.generation, "terminated", "operator terminated");
    return { ok: true, runtime: toRecord(this.repository.get(runtime.runtimeId)!)};
  }

  async recover(request: RuntimeRecoverRequest, actor: RuntimeActor): Promise<RuntimeResponse> {
    const runtime = this.authorizedRuntime(request.runtimeId, actor, request.generation);
    const hadActiveAttachment = this.repository.listAttachments(runtime.runtimeId, runtime.generation).some((item) => item.viewerId === actor.sessionId && !item.detachedAt);
    const attachment = this.repository.attach({ attachmentId: `attachment-${randomUUID()}`, runtimeId: runtime.runtimeId, homeAuthorityId: runtime.homeAuthorityId, sessionId: runtime.sessionId, generation: runtime.generation, viewerId: actor.sessionId, mode: request.mode ?? "observe", outputCursor: BigInt(request.outputCursor ?? "0"), allowRecovery: true });
    const supervisor = this.supervisors.get(runtime.runtimeId) ?? this.rehydrateSupervisor(runtime);
    try {
      const client = await supervisor.reconnect(request.mode ?? "observe", request.mode === "controller" ? ["observe", "controller", "input", "resize", "signal", "terminate", "deliverMessage"] : ["observe", "deliverMessage"], BigInt(request.outputCursor ?? "0"));
      this.registerClient(attachment, runtime, client);
      this.repository.markState(runtime.runtimeId, runtime.generation, "running");
      return { runtime: toRecord(this.repository.get(runtime.runtimeId)!), attachment: toAttachment(attachment), cursor: supervisor.lastHelloAck?.head.toString() };
    } catch (error) {
      if (!hadActiveAttachment) this.repository.detach(attachment.attachmentId);
      const state = supervisor.state === "recovering" ? "recovering" : "crashed";
      if (state === "crashed") await supervisor.cleanup();
      this.repository.markState(runtime.runtimeId, runtime.generation, state, error instanceof Error ? error.message : "runtime reconnect failed");
      throw error;
    }
  }

  async deliverMessage(request: RuntimeDeliverMessageRequest, actor: RuntimeActor): Promise<RuntimeOperationResponse> {
    const runtime = this.repository.get(request.runtimeId);
    if (!runtime) throw new RoomsStoreError("runtimeNotFound");
    if (runtime.generation !== request.generation) throw new RoomsStoreError("staleRuntimeGeneration");
    const sender = this.repository.canonicalMessageSender(request.messageId);
    if (!sender || (actor.role !== "operator" && sender !== actor.sessionId)) throw new RoomsStoreError("runtimeUnauthorized");
    if (!this.repository.canonicalMessageRecipients(request.messageId).includes(runtime.sessionId)) throw new RoomsStoreError("runtimeUnauthorized");
    return this.deliverToRuntime(runtime, request.messageId, request.frames, request.delaysMs);
  }

  /** Resolve only a runtime named by the canonical message's addressed recipient set. */
  resolveCanonicalMessageRecipientRuntime(sessionId: string, messageId: string): Runtime {
    if (!this.repository.canonicalMessageRecipients(messageId).includes(sessionId)) throw new RoomsStoreError("runtimeUnauthorized");
    const runtime = this.repository.list().filter((item) => item.sessionId === sessionId && !item.endedAt && ["running", "recovering"].includes(item.state)).sort((left, right) => right.generation - left.generation)[0];
    if (!runtime) throw new RoomsStoreError("runtimeNotFound");
    return runtime;
  }

  /** Burn a verified one-use capability before any federated attachment is opened. */
  consumeFederatedTerminalCapability(input: Readonly<{ runtimeId: string; generation: number; capabilityId: string; nonce: string; expiresAt: string }>): void {
    this.repository.consumeCapability({
      runtimeId: input.runtimeId,
      generation: input.generation,
      capabilityId: input.capabilityId,
      nonceHash: createHash("sha256").update(input.nonce).digest("hex"),
      action: "attach",
      expiresAt: input.expiresAt,
      consumedAt: new Date().toISOString(),
    });
  }

  federatedTerminalBindingChannel(runtimeId: string, generation: number): string | null {
    const runtime = this.repository.get(runtimeId);
    if (!runtime || runtime.generation !== generation) throw new RoomsStoreError("staleRuntimeGeneration");
    return this.repository.getBinding(runtimeId)?.channelId ?? null;
  }

  /**
   * Inject a canonical event fetched from its authenticated channel home. The event is
   * deliberately not copied into this machine's message store: only delivery outcome
   * metadata is local, preserving one canonical message authority per channel.
   */
  async deliverFederatedMessage(input: Readonly<{ homeAuthorityId: string; localSessionId: string; messageId: string; body: string; deliveredRecipientSessionIds: readonly string[] }>): Promise<RuntimeOperationResponse> {
    const expectedRecipient = `federation:${readMachineIdentityStatus(dirname(this.options.stateDir)).authorityId}:${input.localSessionId}`;
    if (!input.deliveredRecipientSessionIds.includes(expectedRecipient)) throw new RoomsStoreError("runtimeUnauthorized");
    const runtime = this.repository.list().filter((item) => item.sessionId === input.localSessionId && !item.endedAt && ["running", "recovering"].includes(item.state)).sort((left, right) => right.generation - left.generation)[0];
    if (!runtime) throw new RoomsStoreError("runtimeNotFound");
    const submission = encodeProviderSubmission(input.body);
    return this.deliverToRuntime(runtime, input.messageId, submission.frames, submission.delaysMs, input.homeAuthorityId);
  }

  private async deliverToRuntime(runtime: Runtime, messageId: string, frames: readonly string[], delaysMs: readonly number[], federatedHomeAuthorityId?: string): Promise<RuntimeOperationResponse> {
    const supervisor = this.supervisors.get(runtime.runtimeId) ?? this.rehydrateSupervisor(runtime);
    const deliveryKey = `delivery:${runtime.runtimeId}`;
    let client = this.clients.get(deliveryKey);
    if (!client) {
      // A send is the most common way to meet a host that is no longer there.
      // Attach already records that absence; delivery used to swallow it, so
      // the row kept claiming "running" and every later send, presence read,
      // and `session resume` believed a runtime that could never answer.
      try { client = await supervisor.reconnect("observe", ["observe", "deliverMessage"], 0n); }
      catch (error) {
        if (isAbsentRuntimeHost(error)) {
          this.repository.markState(runtime.runtimeId, runtime.generation, "crashed", HOST_ABSENT_REASON);
          await supervisor.cleanup();
        }
        throw error;
      }
      this.clients.set(deliveryKey, client);
      client.on("exit", (exit) => { this.repository.markState(runtime.runtimeId, runtime.generation, "exited", `exit:${exit.code}`); });
      client.on("error", () => {});
      client.on("close", () => { if (this.clients.get(deliveryKey) === client) this.clients.delete(deliveryKey); });
    }
    const ack = await client.deliverMessage({ id: messageId, frames: frames.map((frame) => Buffer.from(frame, "base64")), delaysMs: [...delaysMs] });
    const audit = runtimeDeliveryAuditReference(messageId, ack.bytesWritten, federatedHomeAuthorityId);
    this.repository.appendEvent({ runtimeId: runtime.runtimeId, generation: runtime.generation, kind: ack.outcome === "uncertain" ? "deliverMessageRejected" : "deliverMessageAccepted", ...audit, outcome: ack.outcome });
    return { ok: true, outcome: ack.outcome, bytesWritten: ack.bytesWritten };
  }
  events(request: RuntimeEventsRequest, actor: RuntimeActor): RuntimeEventsResponse { const runtime = this.authorizedRuntime(request.runtimeId, actor, request.generation); return { events: this.repository.events(runtime.runtimeId, runtime.generation, request.afterSeq ?? 0).map(toEvent) }; }

  private async controllerClient(attachmentId: string, actor: RuntimeActor, action: RuntimeAction = "controller"): Promise<{ client: RuntimeHostClient; transient: boolean }> { const attachment = this.authorizedAttachment(attachmentId, actor, action); if (attachment.mode !== "controller") throw new RoomsStoreError("controllerLeaseRequired"); const existing = this.clients.get(attachmentId); if (existing) return { client: existing, transient: false }; const runtime = this.authorizedRuntime(attachment.runtimeId, actor, attachment.generation, action); const supervisor = this.supervisors.get(runtime.runtimeId) ?? this.rehydrateSupervisor(runtime); const client = await supervisor.reconnect("controller", ["observe", "controller", "input", "resize", "signal", "terminate", "deliverMessage"], attachment.outputCursor); return { client, transient: true }; }
  private authorizedAttachment(attachmentId: string, actor: RuntimeActor, action: RuntimeAction = "observe"): RuntimeAttachment {
    const attachment = this.repository.getAttachment(attachmentId);
    if (!attachment || attachment.detachedAt || (actor.role !== "operator" && attachment.viewerId !== actor.sessionId)) throw new RoomsStoreError("runtimeUnauthorized");
    const runtime = this.repository.get(attachment.runtimeId);
    if (!runtime || !this.actorCanAccessRuntime(actor, runtime, action)) throw new RoomsStoreError("runtimeUnauthorized");
    return attachment;
  }
  private authorizedRuntime(runtimeId: string, actor: RuntimeActor, generation?: number, action: RuntimeAction = "observe"): Runtime { const runtime = this.repository.get(runtimeId); if (!runtime) throw new RoomsStoreError("runtimeNotFound"); if (generation !== undefined && runtime.generation !== generation) throw new RoomsStoreError("staleRuntimeGeneration"); if (!this.actorCanAccessRuntime(actor, runtime, action)) throw new RoomsStoreError("runtimeUnauthorized"); return runtime; }
  private actorCanAccessRuntime(actor: RuntimeActor, runtime: Runtime, action: RuntimeAction): boolean {
    if (actor.role === "operator" || actor.sessionId === runtime.sessionId) return true;
    // A channel planner that may launch a worker must also observe and tear it
    // down through readiness and launch cleanup. Without this, planner-authorized
    // session launch creates a live runtime then fails with "no active runtime"
    // because list/attach only saw the planner's own session (internal work item).
    if (actor.role === "planner" && this.plannerCanSuperviseWorkerRuntime(actor.sessionId, runtime, action)) return true;
    const capability = actor.capability;
    return Boolean(capability
      && capability.runtimeId === runtime.runtimeId
      && capability.generation === runtime.generation
      && capability.sessionId === runtime.sessionId
      && capability.actions.includes(action)
      && Date.parse(capability.expiresAt) > Date.now());
  }

  private plannerCanSuperviseWorkerRuntime(plannerSessionId: string, runtime: Runtime, action: RuntimeAction): boolean {
    if (action !== "observe" && action !== "attach" && action !== "terminate") return false;
    const binding = this.repository.getBinding(runtime.runtimeId);
    if (!binding?.channelId) return false;
    return this.repository.plannerCanLaunchWorker(plannerSessionId, runtime.sessionId, binding.channelId);
  }
  private registerClient(attachment: RuntimeAttachment, runtime: Runtime, client: RuntimeHostClient): void { this.clients.set(attachment.attachmentId, client); client.on("output", (output) => { this.repository.appendEvent({ runtimeId: runtime.runtimeId, generation: runtime.generation, kind: "outputAvailable", outputCursor: output.cursor }); }); client.on("exit", (exit) => { this.repository.markState(runtime.runtimeId, runtime.generation, "exited", `exit:${exit.code}`); }); client.on("error", () => {}); client.on("close", () => { if (this.clients.get(attachment.attachmentId) === client) { this.clients.delete(attachment.attachmentId); this.controllerHellos.delete(attachment.attachmentId); } }); }
  private async ensureControllerClient(attachment: RuntimeAttachment, runtime: Runtime, supervisor: RuntimeHostSupervisor, cursor: bigint): Promise<{ client: RuntimeHostClient; hello: HostHelloAck }> {
    const existing = this.clients.get(attachment.attachmentId);
    if (existing) {
      const ready = this.controllerReady.get(attachment.attachmentId);
      const hello = ready ? await ready : this.controllerHellos.get(attachment.attachmentId);
      if (!hello) throw new Error("runtime controller connection has no HELLO acknowledgement");
      return { client: existing, hello };
    }
    const client = new RuntimeHostClient(supervisor.socketEndpoint(), { sessionId: runtime.sessionId, runtimeId: runtime.runtimeId, homeAuthorityId: runtime.homeAuthorityId, generation: runtime.generation, secret: supervisor.secret }, { renewCapabilities: supervisor.supportsCapabilityRenewal });
    this.registerClient(attachment, runtime, client);
    const ready = client.connect("controller", ["observe", "controller", "input", "resize", "signal", "terminate", "deliverMessage"], cursor);
    this.controllerReady.set(attachment.attachmentId, ready);
    try {
      const hello = await ready;
      this.controllerHellos.set(attachment.attachmentId, hello);
      return { client, hello };
    } catch (error) {
      if (this.clients.get(attachment.attachmentId) === client) this.clients.delete(attachment.attachmentId);
      client.close();
      throw error;
    } finally {
      if (this.controllerReady.get(attachment.attachmentId) === ready) this.controllerReady.delete(attachment.attachmentId);
    }
  }
  private rehydrateSupervisor(runtime: Runtime): RuntimeHostSupervisor {
    const binding = this.repository.getBinding(runtime.runtimeId);
    const endpoint = binding ? parseRuntimeHandle(binding.handleRef) : null;
    const supervisor = new RuntimeHostSupervisor({
      sessionId: runtime.sessionId,
      runtimeId: runtime.runtimeId,
      homeAuthorityId: runtime.homeAuthorityId,
      generation: runtime.generation,
      stateDir: endpoint?.stateDir ?? this.options.stateDir,
      socketPath: endpoint?.socketPath ?? runtimeSocketPath(runtime, this.options.socketDirectory),
      executable: this.options.hostExecutable || undefined,
    });
    this.supervisors.set(runtime.runtimeId, supervisor);
    return supervisor;
  }
}

function isAbsentRuntimeHost(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED" || (error instanceof Error && /connect (?:ENOENT|ECONNREFUSED)/.test(error.message));
}

/**
 * Answer only what the kernel already knows about the endpoint. The probe
 * opens and drops a connection without speaking the host protocol, so it
 * cannot disturb a host that is serving another viewer.
 */
function runtimeHostIsAbsent(socketPath: string, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(socketPath);
    const settle = (absent: boolean) => { probe.removeAllListeners(); probe.destroy(); resolve(absent); };
    probe.setTimeout(timeoutMs, () => settle(false));
    probe.once("connect", () => settle(false));
    probe.once("error", (error) => settle(isAbsentRuntimeHost(error)));
  });
}

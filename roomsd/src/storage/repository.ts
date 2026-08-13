// SPDX-License-Identifier: Apache-2.0
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { existsSync } from "node:fs";
import { CursorCodec, RoomsCommandError, type CanonicalImportEvent, type CanonicalMessageCommitInput, type Change, type Channel, type ChannelBroadcastPolicy, type Membership, type MutationReceipt, type Session, type SessionDeliveryMode, type SessionRole, type Snapshot, type ThreadLifecycle } from "../domain/contracts.js";
import { loadProviderTranscriptLines, resolveProviderTurn, type ProviderTurnPhase } from "../runtime/provider-turn.js";
import { providerSessionUsage, type ProviderUsage } from "../runtime/provider-usage.js";
import { migrate, requireCurrentSchema, type SchemaPolicy } from "./migrations.js";
import { instrumentDatabase, withQueryOperation } from "./query-telemetry.js";
import { UsageHistoryRepository, type UsageSeries } from "./usage-history.js";
export type { CanonicalImportEvent, Change, Channel, ChannelBroadcastPolicy, Membership, MutationReceipt, Session, SessionDeliveryMode, SessionRole, Snapshot, ThreadLifecycle } from "../domain/contracts.js";

export type FederationChannelAdmission = Readonly<{
  channelId: string;
  peerAuthorityId: string;
  grantedBySessionId: string;
  grantedAt: string;
  revokedBySessionId: string | null;
  revokedAt: string | null;
}>;

export type SessionInspection = Readonly<{
  session: Session;
  memberships: Membership[];
  runtime: Readonly<{
    runtimeId: string;
    homeAuthorityId: string;
    generation: number;
    state: string;
    machineId: string;
    channelId: string | null;
    adapterKind: string | null;
    /** Exact canonical cwd recorded for the runtime host launch generation. */
    cwd: string | null;
    cwdState: "available" | "unavailable";
    cwdReason: string | null;
    providerThreadId: string | null;
    /**
     * Why providerThreadId looks the way it does. A bare null cannot distinguish
     * a healthy provider whose transcript has not appeared yet from one whose
     * identity will never arrive, so consumers polling it to decide whether an
     * agent started read both as "never attached".
     */
    providerThreadIdState: "attached" | "pending" | "unavailable" | "unsupported";
    providerThreadIdReason: string | null;
    endedAt: string | null;
    /** Provider lifecycle phase derived from delivery events + provider transcript. */
    providerTurn: Readonly<{
      phase: ProviderTurnPhase | null;
      reason: string;
      updatedAt: string | null;
    }>;
    usage: ProviderUsage;
  }> | null;
}>;

export type ChannelStateRuntime = Readonly<{
  runtimeId: string;
  homeAuthorityId: string;
  generation: number;
  state: string;
  machineId: string;
  adapterKind: string | null;
  providerThreadId: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}>;

export type ChannelStateMember = Readonly<{
  sessionId: string;
  displayName: string | null;
  role: SessionRole | null;
  joinedAt: string;
  sessionEndedAt: string | null;
  runtime: ChannelStateRuntime | null;
}>;

export type ChannelStateSnapshot = Readonly<{
  channelId: string;
  revision: string;
  lifecycleState: Channel["lifecycleState"];
  members: ChannelStateMember[];
}>;

export type ChannelStateSnapshots = Readonly<{
  snapshots: Record<string, ChannelStateSnapshot>;
  errors: Record<string, { code: "channelNotFound" }>;
}>;

export type ChannelControlPage = Readonly<{
  events: unknown[];
  cursor: string;
  hasMore: boolean;
}>;

export type ChannelControlPages = Readonly<{
  controls: Record<string, ChannelControlPage>;
  errors: Record<string, { code: "channelNotFound" | "controlReaderNotMember" | "invalidCursor" }>;
}>;

export class RoomsStoreError extends RoomsCommandError { constructor(code: string, message = code) { super(code, message); this.name = "RoomsStoreError"; } }

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const asString = (value: unknown): string => String(value);
const iso = (value: number | string): string => typeof value === "number" ? new Date(value).toISOString() : value;
function replyEventId(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 512) {
    throw new RoomsStoreError("invalidReplyToEventId", `${field} must be a non-empty Rooms event id of at most 512 bytes`);
  }
  return value;
}
function importedMessage(value: Record<string, any>): Record<string, any> {
  const target = value.target?.kind === "directToSession"
    ? { kind: "direct", sessionId: value.target.sessionID }
    : value.target?.kind === "broadcastToCurrentChannelMembers"
      ? { kind: "broadcast", sessionIds: value.deliveredRecipientSessionIDs ?? [] }
      : value.target ?? null;
  return { id: value.id, channelId: value.channelID ?? null, senderSessionId: value.senderSessionID, body: value.body, target, deliveredRecipientSessionIds: value.deliveredRecipientSessionIDs ?? [], correlation: value.correlation ?? undefined, occurredAt: iso(value.occurredAt) };
}

export class RoomsRepository {
  readonly db: DatabaseSync;
  readonly usageHistory: UsageHistoryRepository;
  private readonly changeListeners = new Set<(change: Change) => void>();
  private importActive = false;
  private transactionDepth = 0;
  private importExistingChannels = new Set<string>();
  private importExistingSessions = new Set<string>();
  private importExistingMemberships = new Set<string>();

  constructor(filePath = ":memory:", options: { schemaPolicy?: SchemaPolicy; schemaActor?: string; usageHistory?: { now?: () => Date; retentionMs?: number; minSampleIntervalMs?: number }; providerUsage?: typeof providerSessionUsage } = {}) {
    const schemaPolicy = options.schemaPolicy ?? "migrate";
    if (schemaPolicy === "require-current" && filePath !== ":memory:" && !existsSync(filePath)) {
      throw new Error(`Rooms canonical store is missing: ${filePath}; run \`rooms setup\``);
    }
    const rawDatabase = new DatabaseSync(filePath);
    const database = instrumentDatabase(rawDatabase);
    try {
      if (schemaPolicy === "require-current") requireCurrentSchema(database, options.schemaActor);
      database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
      if (schemaPolicy === "migrate") migrate(database);
      this.db = database;
      this.usageHistory = new UsageHistoryRepository(database, options.usageHistory);
      this.providerUsage = options.providerUsage ?? providerSessionUsage;
    } catch (error) { rawDatabase.close(); throw error; }
  }

  private readonly providerUsage: typeof providerSessionUsage;

  pragma(name: "journal_mode" | "foreign_keys" | "busy_timeout"): string | number {
    const row = this.db.prepare(`PRAGMA ${name}`).get() as Row;
    return Object.values(row)[0] as string | number;
  }

  userVersion(): number { return Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version); }
  currentCursor(): string { return this.latestCursor(); }

  close(): void { this.db.close(); }
  command<T>(operation: (repository: RoomsRepository) => T): T { return this.write(() => operation(this)); }
  currentSession(id: string): Session | null { const row = this.one("SELECT * FROM sessions WHERE id=?", id); return row ? session(row) : null; }

  inspectSession(id: string): SessionInspection {
    const current = this.currentSession(id);
    if (!current) throw new RoomsStoreError("unknownSession", `unknown Rooms session \"${id}\"`);
    const memberships = this.rows(`SELECT channel_id, session_id, joined_at, left_at, session_ended_at, role
      FROM memberships WHERE session_id=? ORDER BY joined_at, channel_id`, id).map(membership);
    const row = this.one(`SELECT r.runtime_id, r.home_authority_id, r.generation, r.state,
        r.machine_id, r.provider_thread_id, r.effective_cwd, r.ended_at, b.channel_id, b.adapter_kind
      FROM runtimes r
      LEFT JOIN runtime_bindings b ON b.runtime_id=r.runtime_id AND b.unbound_at IS NULL
      WHERE r.session_id=?
      ORDER BY r.generation DESC, r.created_at DESC,
        CASE WHEN b.unbound_at IS NULL THEN 0 ELSE 1 END, b.bound_at DESC
      LIMIT 1`, id);
    if (!row) return { session: current, memberships, runtime: null };
    const providerThreadId = row.provider_thread_id == null ? current.providerThreadId : asString(row.provider_thread_id);
    const adapterKind = row.adapter_kind == null ? null : asString(row.adapter_kind);
    const alive = row.ended_at == null && ["creating", "running", "recovering"].includes(asString(row.state));
    const identity = this.providerIdentityState({
      providerThreadId,
      runtimeId: asString(row.runtime_id),
      generation: Number(row.generation),
      adapterKind,
      alive,
    });
    const lastDeliver = this.one(
      `SELECT occurred_at FROM runtime_events
       WHERE runtime_id=? AND generation=? AND kind='deliverMessageAccepted'
       ORDER BY event_seq DESC LIMIT 1`,
      asString(row.runtime_id),
      Number(row.generation),
    );
    const lastDeliverAt = lastDeliver ? asString(lastDeliver.occurred_at) : null;
    const providerTurn = resolveProviderTurn({
      alive,
      adapterKind,
      lastDeliverAt,
      transcriptLines: loadProviderTranscriptLines(adapterKind, providerThreadId, undefined, id),
    });
    const usage = { status: "unavailable" as const, inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null, updatedAt: null, reason: "usage-history-query-required" };
    return {
      session: current,
      memberships,
      runtime: {
        runtimeId: asString(row.runtime_id),
        homeAuthorityId: asString(row.home_authority_id),
        generation: Number(row.generation),
        state: asString(row.state),
        machineId: asString(row.machine_id),
        channelId: row.channel_id == null ? null : asString(row.channel_id),
        adapterKind,
        cwd: row.effective_cwd == null ? null : asString(row.effective_cwd),
        cwdState: row.effective_cwd == null ? "unavailable" : "available",
        cwdReason: row.effective_cwd == null ? "legacy-runtime-cwd-unavailable" : null,
        providerThreadId,
        providerThreadIdState: identity.state,
        providerThreadIdReason: identity.reason,
        endedAt: row.ended_at == null ? null : asString(row.ended_at),
        providerTurn: {
          phase: providerTurn.phase,
          reason: providerTurn.reason,
          updatedAt: providerTurn.updatedAt,
        },
        usage,
      },
    };
  }

  usageSeries(scope: "session" | "channel", id: string, window: string, collect = false): UsageSeries {
    if (!collect) return this.usageHistory.privacySeries(scope, id, window);
    const rows = scope === "session"
      ? this.rows(`SELECT r.session_id, r.runtime_id, r.generation, b.channel_id, b.adapter_kind,
          COALESCE(r.provider_thread_id, s.provider_thread_id) AS provider_thread_id
        FROM runtimes r JOIN sessions s ON s.id=r.session_id
        JOIN runtime_bindings b ON b.runtime_id=r.runtime_id AND b.unbound_at IS NULL
        WHERE r.session_id=? ORDER BY r.generation DESC, r.created_at DESC LIMIT 1`, id)
      : this.rows(`WITH latest AS (
          SELECT r.session_id, r.runtime_id, r.generation, b.channel_id, b.adapter_kind,
            COALESCE(r.provider_thread_id, s.provider_thread_id) AS provider_thread_id,
            ROW_NUMBER() OVER (PARTITION BY r.session_id ORDER BY r.generation DESC, r.created_at DESC) rank
          FROM runtimes r JOIN sessions s ON s.id=r.session_id
          JOIN runtime_bindings b ON b.runtime_id=r.runtime_id AND b.unbound_at IS NULL
          WHERE b.channel_id=?) SELECT * FROM latest WHERE rank=1`, id);
    for (const row of rows) this.sampleUsage({ sessionId: asString(row.session_id), runtimeId: asString(row.runtime_id), generation: Number(row.generation), channelId: row.channel_id == null ? null : asString(row.channel_id), adapterKind: row.adapter_kind == null ? null : asString(row.adapter_kind), providerThreadId: row.provider_thread_id == null ? null : asString(row.provider_thread_id) });
    return this.usageHistory.query(scope, id, window);
  }

  private sampleUsage(input: { sessionId: string; runtimeId: string; generation: number; channelId: string | null; adapterKind: string | null; providerThreadId: string | null }): ProviderUsage {
    const usage = this.providerUsage(input.adapterKind, input.providerThreadId);
    this.usageHistory.record({ ...input, adapterKind: input.adapterKind ?? "unknown", usage });
    return usage;
  }

  /**
   * Returns canonical channel membership and each member's latest runtime with
   * one set-based SQLite statement, regardless of channel or member count.
   */
  channelStateSnapshots(channelIds: readonly string[]): ChannelStateSnapshots {
    const ids = [...new Set(channelIds.map((value) => value.trim()).filter(Boolean))];
    if (ids.length === 0) return { snapshots: {}, errors: {} };
    if (ids.length > 100) throw new RoomsStoreError("snapshotBatchTooLarge", "channel snapshot batches are limited to 100 channels");
    return withQueryOperation({ operation: "repository.channelStateSnapshots" }, () => {
      const requested = ids.map((_, index) => `(?, ${index})`).join(", ");
      const rows = this.rows(`WITH requested(channel_id, ordinal) AS (VALUES ${requested}),
        active_members AS (
          SELECT m.channel_id, m.session_id, m.joined_at, m.session_ended_at,
            COALESCE(m.role, s.role) AS role, s.display_name
          FROM memberships m
          JOIN sessions s ON s.id=m.session_id
          JOIN requested q ON q.channel_id=m.channel_id
          WHERE m.left_at IS NULL AND m.session_ended_at IS NULL
        ),
        latest_runtimes AS (
          SELECT b.channel_id, b.adapter_kind, r.*,
            ROW_NUMBER() OVER (PARTITION BY b.channel_id, r.session_id ORDER BY r.generation DESC, r.created_at DESC, r.runtime_id DESC) AS rank
          FROM runtimes r
          JOIN runtime_bindings b ON b.runtime_id=r.runtime_id AND b.unbound_at IS NULL
          JOIN requested q ON q.channel_id=b.channel_id
        )
        SELECT q.channel_id AS requested_channel_id, q.ordinal,
          c.id AS channel_id, c.lifecycle_state,
          COALESCE((SELECT MAX(cursor) FROM changes WHERE channel_id=q.channel_id), 0) AS change_revision,
          COALESCE((SELECT MAX(r2.updated_at) FROM runtimes r2
            JOIN runtime_bindings b2 ON b2.runtime_id=r2.runtime_id
            WHERE b2.channel_id=q.channel_id), '') AS runtime_revision,
          m.session_id, m.display_name, m.role, m.joined_at, m.session_ended_at,
          r.runtime_id, r.home_authority_id, r.generation, r.state, r.machine_id,
          r.provider_thread_id, r.created_at, r.updated_at, r.ended_at, r.adapter_kind
        FROM requested q
        LEFT JOIN channels c ON c.id=q.channel_id
        LEFT JOIN active_members m ON m.channel_id=q.channel_id
        LEFT JOIN latest_runtimes r ON r.channel_id=q.channel_id AND r.session_id=m.session_id AND r.rank=1
        ORDER BY q.ordinal, m.joined_at, m.session_id`, ...ids);
      // Channel ids are opaque product data. A real store can contain names
      // such as "__proto__", so result maps must not inherit object keys.
      const snapshots = Object.create(null) as Record<string, ChannelStateSnapshot>;
      const errors = Object.create(null) as Record<string, { code: "channelNotFound" }>;
      for (const row of rows) {
        const requestedChannelId = asString(row.requested_channel_id);
        if (row.channel_id == null) { errors[requestedChannelId] = { code: "channelNotFound" }; continue; }
        const snapshot = snapshots[requestedChannelId] ??= {
          channelId: requestedChannelId,
          revision: `${asString(row.change_revision)}:${asString(row.runtime_revision)}`,
          lifecycleState: asString(row.lifecycle_state) as Channel["lifecycleState"],
          members: [],
        };
        if (row.session_id == null) continue;
        snapshot.members.push({
          sessionId: asString(row.session_id),
          displayName: row.display_name == null ? null : asString(row.display_name),
          role: row.role == null ? null : row.role as SessionRole,
          joinedAt: asString(row.joined_at),
          sessionEndedAt: row.session_ended_at == null ? null : asString(row.session_ended_at),
          runtime: row.runtime_id == null ? null : {
            runtimeId: asString(row.runtime_id),
            homeAuthorityId: asString(row.home_authority_id),
            generation: Number(row.generation),
            state: asString(row.state),
            machineId: asString(row.machine_id),
            adapterKind: row.adapter_kind == null ? null : asString(row.adapter_kind),
            providerThreadId: row.provider_thread_id == null ? null : asString(row.provider_thread_id),
            createdAt: asString(row.created_at),
            updatedAt: asString(row.updated_at),
            endedAt: row.ended_at == null ? null : asString(row.ended_at),
          },
        });
      }
      return { snapshots, errors };
    });
  }

  /**
   * Returns private control pages for many channels with one set-based query.
   * The caller supplies an independent durable cursor for each channel.
   */
  channelControlPages(
    requests: readonly { channelId: string; afterCursor?: string }[],
    sessionId: string,
    limit = 100,
  ): ChannelControlPages {
    const unique = new Map<string, string>();
    for (const request of requests) {
      const channelId = String(request.channelId || "").trim();
      if (channelId && !unique.has(channelId)) unique.set(channelId, String(request.afterCursor ?? "0"));
    }
    if (unique.size === 0) return { controls: {}, errors: {} };
    if (unique.size > 100) throw new RoomsStoreError("controlBatchTooLarge", "channel control batches are limited to 100 channels");
    if (!sessionId.trim()) throw new RoomsStoreError("invalidSession", "control reader session is required");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RoomsStoreError("invalidLimit");

    const controls = Object.create(null) as Record<string, ChannelControlPage>;
    const errors = Object.create(null) as ChannelControlPages["errors"];
    const valid: { channelId: string; cursor: string; decoded: bigint }[] = [];
    for (const [channelId, cursor] of unique) {
      try {
        const decoded = CursorCodec.decode(cursor);
        valid.push({ channelId, cursor, decoded });
        controls[channelId] = { events: [], cursor, hasMore: false };
      } catch { errors[channelId] = { code: "invalidCursor" }; }
    }
    if (valid.length === 0) return { controls, errors };

    return withQueryOperation({ operation: "repository.channelControlPages" }, () => {
      const requested = valid.map((_, index) => `(?, ?, ${index})`).join(", ");
      const parameters = valid.flatMap((request) => [request.channelId, request.decoded] as SQLInputValue[]);
      const rows = this.cursorRows(`WITH requested(channel_id, after_cursor, ordinal) AS (VALUES ${requested}),
        ranked_controls AS (
          SELECT q.channel_id AS requested_channel_id, ch.cursor, ch.payload,
            ROW_NUMBER() OVER (PARTITION BY q.channel_id ORDER BY ch.cursor) AS event_rank,
            COUNT(*) OVER (PARTITION BY q.channel_id) AS event_count
          FROM requested q
          JOIN changes ch ON ch.channel_id=q.channel_id
            AND ch.cursor>q.after_cursor AND ch.kind='control.committed'
        )
        SELECT q.channel_id AS requested_channel_id, c.id AS existing_channel_id,
          m.session_id AS member_session_id, rc.cursor, rc.payload, rc.event_count
        FROM requested q
        LEFT JOIN channels c ON c.id=q.channel_id
        LEFT JOIN memberships m ON m.channel_id=q.channel_id AND m.session_id=?
          AND m.left_at IS NULL AND m.session_ended_at IS NULL
        LEFT JOIN ranked_controls rc ON rc.requested_channel_id=q.channel_id AND rc.event_rank<=?
        ORDER BY q.ordinal, rc.cursor`, ...parameters, sessionId, limit);

      for (const row of rows) {
        const channelId = asString(row.requested_channel_id);
        if (row.existing_channel_id == null) {
          delete controls[channelId];
          errors[channelId] = { code: "channelNotFound" };
          continue;
        }
        if (row.member_session_id == null) {
          delete controls[channelId];
          errors[channelId] = { code: "controlReaderNotMember" };
          continue;
        }
        if (row.payload == null) continue;
        const prior = controls[channelId];
        const cursor = CursorCodec.encode(row.cursor as bigint);
        controls[channelId] = {
          events: [...prior.events, JSON.parse(asString(row.payload))],
          cursor,
          hasMore: Number(row.event_count) > limit,
        };
      }
      return { controls, errors };
    });
  }

  recordRuntimeLifecycle(input: Readonly<{
    channelId: string;
    sessionId: string;
    runtimeId: string;
    generation: number;
    state: string;
    endedAt: string | null;
  }>): MutationReceipt {
    return this.write(() => {
      const role = this.one(`SELECT role FROM memberships
        WHERE channel_id=? AND session_id=? AND left_at IS NULL AND session_ended_at IS NULL
        ORDER BY joined_at DESC LIMIT 1`, input.channelId, input.sessionId)?.role ?? null;
      return this.appendChange("runtime.lifecycle", input.channelId, { ...input, role });
    });
  }

  /** Only providers that persist a transcript can ever report a native thread id. */
  private providerIdentityState(input: { providerThreadId: string | null; runtimeId: string; generation: number; adapterKind: string | null; alive: boolean }): { state: "attached" | "pending" | "unavailable" | "unsupported"; reason: string | null } {
    if (input.providerThreadId) return { state: "attached", reason: null };
    // Provider adapters persist a native session transcript. Grok and AGY ids
    // are bound at launch so inspection never adopts a global newest session.
    const discoverable = input.adapterKind === "claude"
      || input.adapterKind === "codex"
      || input.adapterKind === "grok"
      || input.adapterKind === "agy"
      || input.adapterKind === "gemini";
    if (input.adapterKind !== null && !discoverable) return { state: "unsupported", reason: `${input.adapterKind} does not persist a native transcript` };
    // Launch records why it gave up, so a stalled discovery is reported as a
    // dead end rather than as a poll the caller should keep waiting on.
    const gap = this.one(`SELECT outcome FROM runtime_events
      WHERE runtime_id=? AND generation=? AND kind='error' AND outcome LIKE 'providerThreadId%'
      ORDER BY event_seq DESC LIMIT 1`, input.runtimeId, input.generation);
    if (gap) return { state: "unavailable", reason: asString(gap.outcome) };
    return input.alive
      ? { state: "pending", reason: "provider has not written its transcript yet" }
      : { state: "unavailable", reason: "runtime ended before its provider identity was captured" };
  }

  activeRuntimeSessionIdsForProviderThread(providerThreadId: string): string[] {
    if (!providerThreadId.trim()) return [];
    return this.rows(`SELECT DISTINCT s.id
      FROM sessions s JOIN runtimes r ON r.session_id = s.id
      WHERE s.ended_at IS NULL AND r.provider_thread_id = ? AND r.ended_at IS NULL
        AND r.state IN ('running','recovering')
      ORDER BY r.created_at DESC`, providerThreadId).map((row) => asString(row.id));
  }

  activeRuntimeIdentityForSession(sessionId: string): Readonly<{ provider: string | null; providerThreadId: string | null; machineId: string }> | null {
    const row = this.one(`SELECT b.adapter_kind, COALESCE(r.provider_thread_id, s.provider_thread_id) AS provider_thread_id, r.machine_id
      FROM sessions s
      JOIN runtimes r ON r.session_id = s.id
      LEFT JOIN runtime_bindings b ON b.runtime_id = r.runtime_id AND b.unbound_at IS NULL
      WHERE s.id = ? AND s.ended_at IS NULL AND r.ended_at IS NULL
        AND r.state IN ('running','recovering','creating')
      ORDER BY r.generation DESC, r.created_at DESC LIMIT 1`, sessionId);
    if (!row) return null;
    return {
      provider: row.adapter_kind == null ? null : String(row.adapter_kind),
      providerThreadId: row.provider_thread_id == null ? null : String(row.provider_thread_id),
      machineId: asString(row.machine_id),
    };
  }

  setSessionProviderThreadId(id: string, providerThreadId: string): Session {
    if (!providerThreadId.trim()) throw new RoomsStoreError("invalidProviderThreadId");
    this.db.prepare("UPDATE sessions SET provider_thread_id=? WHERE id=?").run(providerThreadId, id);
    const value = this.currentSession(id);
    if (!value) throw new RoomsStoreError("unknownSession");
    return value;
  }

  begin(sourceDigest: string, sourceVersion: number): void {
    if (!sourceDigest || !Number.isSafeInteger(sourceVersion) || sourceVersion < 1) throw new RoomsStoreError("invalidImportSource");
    if (this.one("SELECT source_digest FROM import_batches WHERE source_digest = ?", sourceDigest)) throw new RoomsStoreError("duplicateImport");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.importExistingChannels = new Set(this.rows("SELECT id FROM channels").map(row => asString(row.id)));
      this.importExistingSessions = new Set(this.rows("SELECT id FROM sessions").map(row => asString(row.id)));
      this.importExistingMemberships = new Set(this.rows("SELECT channel_id, session_id, joined_at FROM memberships").map(row => `${row.channel_id}:${row.session_id}:${row.joined_at}`));
      this.db.prepare("INSERT INTO import_batches(source_digest, source_version, started_at) VALUES (?, ?, ?)").run(sourceDigest, sourceVersion, now());
      this.importActive = true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  append(event: CanonicalImportEvent): void {
    try {
      if (!this.importActive) throw new RoomsStoreError("importNotStarted");
      if (!Number.isSafeInteger(event.sourceOrdinal) || event.sourceOrdinal < 0) throw new RoomsStoreError("invalidSourceOrdinal");
      const record = event.payload as Record<string, any>;
      switch (event.kind) {
        case "channel": {
          const value = record.channel;
          this.db.prepare("INSERT OR IGNORE INTO channels(id, registered_at, owner_operator_session_id, lifecycle_state, closed_at) VALUES (?, ?, ?, ?, ?)").run(value.id, iso(value.registeredAt), value.ownerOperatorSessionID ?? null, value.lifecycleState ?? "active", value.closedAt == null ? null : iso(value.closedAt));
          break;
        }
        case "session": {
          const value = record.session;
          this.db.prepare("INSERT OR IGNORE INTO sessions(id, registered_at, ended_at, display_name, role, external_id) VALUES (?, ?, ?, ?, ?, ?)").run(value.id, iso(value.registeredAt), value.endedAt == null ? null : iso(value.endedAt), value.displayName ?? null, value.role ?? null, null);
          break;
        }
        case "sessionRoleAssignment": { const value = record.roleAssignment; if (!this.importExistingSessions.has(value.sessionID)) this.db.prepare("UPDATE sessions SET role=? WHERE id=?").run(value.role, value.sessionID); break; }
        case "channelOwnerAssignment": { const value = record.channelOwnerAssignment; if (!this.importExistingChannels.has(value.channelID)) this.db.prepare("UPDATE channels SET owner_operator_session_id=? WHERE id=?").run(value.ownerOperatorSessionID, value.channelID); break; }
        case "membership": { const value = record.membership; this.insertImportedMembership(value); break; }
        case "membershipEnded": { const value = record.membershipEnd; this.endImportedMembership(value.channelID, value.sessionID, iso(value.endedAt)); break; }
        case "sessionEnded": { const value = record.sessionEnd; const ended = iso(value.endedAt); if (!this.importExistingSessions.has(value.sessionID)) { this.db.prepare("UPDATE sessions SET ended_at=? WHERE id=?").run(ended, value.sessionID); this.db.prepare("UPDATE memberships SET session_ended_at=? WHERE session_id=? AND left_at IS NULL AND session_ended_at IS NULL").run(ended, value.sessionID); } break; }
        case "message": {
          const value = record.event;
          const channelId = value.channelID ?? null;
          const message = importedMessage(value);
          const reply = this.resolveReplyMetadata({ channelId, replyToEventId: value.replyToEventId ?? value.replyToEventID, correlation: message.correlation });
          this.appendImportedChange("message.sent", channelId, { ...message, ...reply }, event);
          break;
        }
        case "workerJoin": { const value = record.workerMembership; this.insertImportedMembership(value); break; }
        case "workerTerminal": { const value = record.terminalMembershipEnd; this.endImportedMembership(value.channelID, value.sessionID, iso(value.endedAt)); break; }
        case "channelClosed": { const value = record.channel; if (!this.importExistingChannels.has(value.id)) this.db.prepare("UPDATE channels SET lifecycle_state='closed', closed_at=? WHERE id=?").run(value.closedAt == null ? iso(event.occurredAt) : iso(value.closedAt), value.id); break; }
        case "workerAssignment":
        case "workerReplacement":
        case "workUnit":
          // The neutral change journal is the lossless representation for records
          // without a current materialized Rooms table. They are never discarded.
          break;
        default: throw new RoomsStoreError("unsupportedImportEvent", `unsupported legacy import event ${event.kind}`);
      }
      if (event.kind !== "message") this.appendImportedChange(`legacy.${event.kind}`, event.channelId, record, event);
    } catch (error) { this.rollback(); throw error; }
  }

  private insertImportedMembership(value: Record<string, any>): void {
    const exists = this.one("SELECT 1 FROM memberships WHERE channel_id=? AND session_id=? AND joined_at=?", value.channelID, value.sessionID, iso(value.joinedAt));
    if (!exists) this.db.prepare("INSERT OR IGNORE INTO memberships(channel_id, session_id, joined_at, role) VALUES (?, ?, ?, ?)").run(value.channelID, value.sessionID, iso(value.joinedAt), value.role ?? null);
  }
  private endImportedMembership(channelId: string, sessionId: string, endedAt: string): void {
    const rows = this.rows("SELECT joined_at FROM memberships WHERE channel_id=? AND session_id=? AND left_at IS NULL AND session_ended_at IS NULL", channelId, sessionId);
    for (const row of rows) if (!this.importExistingMemberships.has(`${channelId}:${sessionId}:${row.joined_at}`)) this.db.prepare("UPDATE memberships SET left_at=? WHERE channel_id=? AND session_id=? AND joined_at=?").run(endedAt, channelId, sessionId, String(row.joined_at));
  }
  private appendImportedChange(kind: string, channelId: string | null, payload: unknown, event: CanonicalImportEvent): void {
    this.db.prepare("INSERT INTO changes(kind, channel_id, payload, occurred_at, source_ordinal) VALUES (?, ?, ?, ?, ?)").run(kind, channelId, JSON.stringify(payload), event.occurredAt, event.sourceOrdinal);
  }

  commit(): void {
    if (!this.importActive) throw new RoomsStoreError("importNotStarted");
    this.db.prepare("UPDATE import_batches SET committed_at = ? WHERE committed_at IS NULL").run(now());
    this.db.exec("COMMIT");
    this.importActive = false;
  }

  rollback(): void {
    if (this.importActive) { this.db.exec("ROLLBACK"); this.importActive = false; }
  }

  insertSession(input: { id: string; displayName?: string | null; role?: SessionRole | null; externalId?: string | null; deliveryMode?: SessionDeliveryMode | null }): MutationReceipt {
    return this.write(() => {
      if (this.one("SELECT id FROM sessions WHERE id = ?", input.id)) throw new RoomsStoreError("sessionAlreadyExists");
      const registeredAt = now();
      const deliveryMode = input.deliveryMode ?? "runtime";
      this.db.prepare("INSERT INTO sessions(id, registered_at, display_name, role, external_id, delivery_mode) VALUES (?, ?, ?, ?, ?, ?)").run(input.id, registeredAt, input.displayName ?? null, input.role ?? null, input.externalId ?? null, deliveryMode);
      return this.appendChange("session.registered", null, { id: input.id, registeredAt, displayName: input.displayName ?? null, role: input.role ?? null, externalId: input.externalId ?? null, deliveryMode });
    });
  }

  /** Resolve the Rooms sessions a caller identity is allowed to speak as. */
  sessionsForExternalId(externalId: string): string[] {
    return this.rows("SELECT id FROM sessions WHERE external_id = ? AND ended_at IS NULL", externalId).map(row => asString(row.id));
  }

  registerSession(channelId: string, sessionId: string, role: SessionRole, externalId: string | null = null, deliveryMode: SessionDeliveryMode | null = null, displayName: string | null = null): { session: Session; membership: Membership; idempotent: boolean } {
    return this.command(() => {
      if (!this.currentChannel(channelId)) throw new RoomsStoreError("channelNotFound");
      const existing = this.currentSession(sessionId);
      const sessionReceipt = existing ? null : this.insertSession({ id: sessionId, displayName, role, externalId, deliveryMode });
      // Binding an existing mailbox to a caller is idempotent, but never silently reassigns it.
      if (existing && externalId) {
        const current = this.one("SELECT external_id FROM sessions WHERE id = ?", sessionId)?.external_id as string | null;
        if (current && current !== externalId) throw new RoomsStoreError("externalIdAlreadyBound");
        if (!current) this.db.prepare("UPDATE sessions SET external_id = ? WHERE id = ?").run(externalId, sessionId);
      }
      if (existing && deliveryMode && existing.deliveryMode !== deliveryMode) {
        this.db.prepare("UPDATE sessions SET delivery_mode = ? WHERE id = ?").run(deliveryMode, sessionId);
        this.appendChange("session.delivery.updated", null, { id: sessionId, deliveryMode });
      }
      if (!this.isActiveMember(channelId, sessionId)) this.insertMembership(channelId, sessionId, role);
      return { session: this.currentSession(sessionId)!, membership: this.membershipsFor(channelId, sessionId), idempotent: Boolean(existing) };
    });
  }

  insertChannel(input: { id: string; ownerOperatorSessionId?: string | null }): MutationReceipt {
    return this.write(() => {
      if (this.one("SELECT id FROM channels WHERE id = ?", input.id)) throw new RoomsStoreError("channelAlreadyExists");
      const registeredAt = now();
      this.db.prepare("INSERT INTO channels(id, registered_at, owner_operator_session_id) VALUES (?, ?, ?)").run(input.id, registeredAt, input.ownerOperatorSessionId ?? null);
      return this.appendChange("channel.registered", input.id, { id: input.id, registeredAt, ownerOperatorSessionId: input.ownerOperatorSessionId ?? null });
    });
  }

  insertMembership(channelId: string, sessionId: string, role: SessionRole | null): MutationReceipt {
    return this.write(() => {
      const channel = this.one("SELECT id FROM channels WHERE id = ? AND lifecycle_state = 'active'", channelId);
      if (!channel) throw new RoomsStoreError("channelNotFound");
      if (!this.one("SELECT id FROM sessions WHERE id = ? AND ended_at IS NULL", sessionId)) throw new RoomsStoreError("sessionNotFound");
      if (this.one("SELECT channel_id FROM memberships WHERE channel_id = ? AND session_id = ? AND left_at IS NULL AND session_ended_at IS NULL", channelId, sessionId)) {
        return { cursor: this.latestCursor(), didAppend: false, changes: [] };
      }
      const joinedAt = now();
      this.db.prepare("INSERT INTO memberships(channel_id, session_id, joined_at, role) VALUES (?, ?, ?, ?)").run(channelId, sessionId, joinedAt, role);
      return this.appendChange("membership.joined", channelId, { channelId, sessionId, joinedAt, role });
    });
  }

  leaveMembership(channelId: string, sessionId: string): MutationReceipt {
    return this.write(() => {
      const joined = this.one("SELECT joined_at, role FROM memberships WHERE channel_id=? AND session_id=? AND left_at IS NULL AND session_ended_at IS NULL ORDER BY joined_at DESC LIMIT 1", channelId, sessionId);
      if (!joined) throw new RoomsStoreError("notMember");
      const leftAt = now();
      this.db.prepare("UPDATE memberships SET left_at=? WHERE channel_id=? AND session_id=? AND joined_at=?").run(leftAt, channelId, sessionId, String(joined.joined_at));
      return this.appendChange("membership.left", channelId, { channelId, sessionId, leftAt, role: joined.role ?? null });
    });
  }

  markSessionEnded(sessionId: string): MutationReceipt {
    return this.write(() => {
      if (!this.one("SELECT id FROM sessions WHERE id = ? AND ended_at IS NULL", sessionId)) throw new RoomsStoreError("unknownSession");
      const memberships = this.rows("SELECT channel_id, role FROM memberships WHERE session_id=? AND left_at IS NULL AND session_ended_at IS NULL ORDER BY channel_id", sessionId)
        .map((row) => ({ channelId: asString(row.channel_id), role: row.role ?? null }));
      const endedAt = now();
      this.db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?").run(endedAt, sessionId);
      this.db.prepare("UPDATE memberships SET session_ended_at = ? WHERE session_id = ? AND left_at IS NULL AND session_ended_at IS NULL").run(endedAt, sessionId);
      return this.appendChange("session.ended", null, { sessionId, endedAt, memberships });
    });
  }

  closeChannel(channelId: string): MutationReceipt {
    return this.write(() => {
      const channel = this.one("SELECT id, lifecycle_state FROM channels WHERE id = ?", channelId);
      if (!channel) throw new RoomsStoreError("unknownChannel");
      if (channel.lifecycle_state === "closed") return { changes: [], cursor: this.latestCursor(), didAppend: false };
      const closedAt = now();
      this.db.prepare("UPDATE channels SET lifecycle_state='closed', closed_at=? WHERE id=?").run(closedAt, channelId);
      this.db.prepare("UPDATE memberships SET session_ended_at=? WHERE channel_id=? AND left_at IS NULL AND session_ended_at IS NULL").run(closedAt, channelId);
      return this.appendChange("channel.closed", channelId, { id: channelId, closedAt });
    });
  }

  reopenChannel(channelId: string): MutationReceipt {
    return this.write(() => {
      const channel = this.one("SELECT id, lifecycle_state FROM channels WHERE id = ?", channelId);
      if (!channel) throw new RoomsStoreError("unknownChannel");
      if (channel.lifecycle_state === "active") return { changes: [], cursor: this.latestCursor(), didAppend: false };
      const reopenedAt = now();
      this.db.prepare("UPDATE channels SET lifecycle_state='active', closed_at=NULL WHERE id=?").run(channelId);
      return this.appendChange("channel.reopened", channelId, { id: channelId, reopenedAt });
    });
  }

  updateChannelLabel(channelId: string, label: string | null): MutationReceipt {
    return this.write(() => {
      if (!this.one("SELECT id FROM channels WHERE id = ?", channelId)) throw new RoomsStoreError("unknownChannel");
      const current = this.one("SELECT label FROM channels WHERE id = ?", channelId)?.label as string | null;
      if (current === label) return { changes: [], cursor: this.latestCursor(), didAppend: false };
      this.db.prepare("UPDATE channels SET label=? WHERE id=?").run(label, channelId);
      return this.appendChange("channel.label.updated", channelId, { id: channelId, label });
    });
  }

  updateChannelBroadcastPolicy(channelId: string, policy: ChannelBroadcastPolicy): MutationReceipt {
    return this.write(() => {
      if (!this.one("SELECT id FROM channels WHERE id = ?", channelId)) throw new RoomsStoreError("unknownChannel");
      const current = (this.one("SELECT broadcast_policy FROM channels WHERE id = ?", channelId)?.broadcast_policy as ChannelBroadcastPolicy | null) ?? "all";
      if (current === policy) return { changes: [], cursor: this.latestCursor(), didAppend: false };
      this.db.prepare("UPDATE channels SET broadcast_policy=? WHERE id=?").run(policy, channelId);
      return this.appendChange("channel.broadcast-policy.updated", channelId, { id: channelId, broadcastPolicy: policy });
    });
  }

  commitMessage(input: CanonicalMessageCommitInput): MutationReceipt & { event: unknown; wasDeduplicated?: boolean } {
    return this.write(() => {
      const target = input.target as any;
      const recipientSessionId = target?.sessionId ?? target?.sessionID;
      if (target?.kind === "direct" || target?.kind === "directToSession") {
        if (!recipientSessionId || !this.currentSession(recipientSessionId)) throw new RoomsStoreError("unknownSession", "unknown Rooms recipient session");
      }
      const reply = this.resolveReplyMetadata(input);
      const correlation = reply.correlation as any;
      const key = correlation?.deduplicationKey;
      if (key) {
        const prior = this.one("SELECT cursor, payload FROM changes WHERE kind='message.sent' AND json_extract(payload, '$.correlation.deduplicationKey')=? ORDER BY cursor LIMIT 1", key);
        if (prior) return { cursor: CursorCodec.encode(BigInt(String(prior.cursor))), didAppend: false, changes: [], event: JSON.parse(asString(prior.payload)), wasDeduplicated: true };
      }
      const recipients = target?.kind === "direct" ? [target.sessionId] : target?.sessionIds ?? [];
      const statuses = input.deliveryStatuses ?? Object.fromEntries(recipients.map((id: string) => [id, "delivered"]));
      const event = {
        id: `event_${crypto.randomUUID()}`,
        channelId: input.channelId,
        senderSessionId: input.senderSessionId,
        body: input.body,
        target,
        deliveredRecipientSessionIds: recipients.filter((id: string) => statuses[id] === "delivered"),
        recipientStatuses: statuses,
        correlation,
        replyToEventId: reply.replyToEventId,
        threadRootEventId: reply.threadRootEventId,
        occurredAt: now(),
      };
      const receipt = this.appendChange("message.sent", input.channelId, event);
      return { ...receipt, event, wasDeduplicated: false };
    });
  }

  threadLifecycle(threadRootEventId: string, channelId?: string | null): ThreadLifecycle {
    const root = this.messageById(threadRootEventId, channelId ?? undefined);
    const event = root.event as Record<string, unknown>;
    if (replyEventId(event.replyToEventId, `thread root ${threadRootEventId}.replyToEventId`) !== null) {
      throw new RoomsStoreError("notThreadRoot", `${threadRootEventId} is a reply, not a thread root`);
    }
    const rootChannelId = event.channelId;
    if (typeof rootChannelId !== "string" || !rootChannelId) throw new RoomsStoreError("threadChannelRequired", "thread lifecycle requires a channel message");
    const row = this.one("SELECT * FROM message_threads WHERE thread_root_event_id=?", threadRootEventId);
    return row ? threadLifecycle(row) : {
      threadRootEventId,
      channelId: rootChannelId,
      state: "open",
      resolvedAt: null,
      resolvedBySessionId: null,
      reopenedAt: null,
      reopenedBySessionId: null,
      updatedAt: null,
    };
  }

  resolveThread(threadRootEventId: string, actorSessionId: string, channelId?: string | null): MutationReceipt & { thread: ThreadLifecycle } {
    return this.setThreadState(threadRootEventId, actorSessionId, "resolved", channelId);
  }

  reopenThread(threadRootEventId: string, actorSessionId: string, channelId?: string | null): MutationReceipt & { thread: ThreadLifecycle } {
    return this.setThreadState(threadRootEventId, actorSessionId, "open", channelId);
  }

  private setThreadState(threadRootEventId: string, actorSessionId: string, state: "open" | "resolved", channelId?: string | null): MutationReceipt & { thread: ThreadLifecycle } {
    return this.write(() => {
      const actor = this.currentSession(actorSessionId);
      if (!actor || actor.endedAt !== null) throw new RoomsStoreError("unknownSession");
      const current = this.threadLifecycle(threadRootEventId, channelId);
      if (!this.isActiveMember(current.channelId, actorSessionId)) throw new RoomsStoreError("notMember");
      if (current.state === state) return { changes: [], cursor: this.latestCursor(), didAppend: false, thread: current };
      const changedAt = now();
      if (state === "resolved") {
        this.db.prepare(`INSERT INTO message_threads(thread_root_event_id, channel_id, state, resolved_at, resolved_by_session_id, reopened_at, reopened_by_session_id, updated_at)
          VALUES (?, ?, 'resolved', ?, ?, NULL, NULL, ?)
          ON CONFLICT(thread_root_event_id) DO UPDATE SET state='resolved', resolved_at=excluded.resolved_at, resolved_by_session_id=excluded.resolved_by_session_id, updated_at=excluded.updated_at`)
          .run(threadRootEventId, current.channelId, changedAt, actorSessionId, changedAt);
      } else {
        this.db.prepare(`UPDATE message_threads SET state='open', reopened_at=?, reopened_by_session_id=?, updated_at=? WHERE thread_root_event_id=?`)
          .run(changedAt, actorSessionId, changedAt, threadRootEventId);
      }
      const thread = this.threadLifecycle(threadRootEventId, current.channelId);
      const receipt = this.appendChange(state === "resolved" ? "thread.resolved" : "thread.reopened", current.channelId, thread);
      return { ...receipt, thread };
    });
  }

  private resolveReplyMetadata(input: { channelId: string | null; replyToEventId?: string | null; correlation?: unknown }): {
    replyToEventId: string | null;
    threadRootEventId: string | null;
    correlation: unknown;
  } {
    const correlationRecord = input.correlation && typeof input.correlation === "object" && !Array.isArray(input.correlation)
      ? input.correlation as Record<string, unknown>
      : null;
    const canonicalReply = replyEventId(input.replyToEventId, "replyToEventId");
    const legacyReply = replyEventId(correlationRecord?.replyToEventId, "correlation.replyToEventId");
    if (canonicalReply !== null && legacyReply !== null && canonicalReply !== legacyReply) {
      throw new RoomsStoreError("invalidReplyMetadata", "replyToEventId must equal correlation.replyToEventId when both are supplied");
    }
    const replyToEventId = canonicalReply ?? legacyReply;
    if (replyToEventId === null) {
      return { replyToEventId: null, threadRootEventId: null, correlation: input.correlation };
    }

    const row = this.one("SELECT channel_id, payload FROM changes WHERE kind='message.sent' AND json_extract(payload, '$.id')=? LIMIT 1", replyToEventId);
    if (!row) throw new RoomsStoreError("staleReply", `reply parent ${replyToEventId} does not exist`);
    if (row.channel_id !== input.channelId) throw new RoomsStoreError("staleReply", `reply parent ${replyToEventId} belongs to another channel`);
    const parent = JSON.parse(asString(row.payload)) as Record<string, unknown>;
    const parentReply = replyEventId(parent.replyToEventId, `reply parent ${replyToEventId}.replyToEventId`);
    const parentRoot = replyEventId(parent.threadRootEventId, `reply parent ${replyToEventId}.threadRootEventId`);
    if (parentReply !== null && parentRoot === null) {
      throw new RoomsStoreError("invalidReplyParent", `reply parent ${replyToEventId} has no canonical thread root`);
    }
    const threadRootEventId = parentRoot ?? replyToEventId;
    const lifecycle = this.one("SELECT state FROM message_threads WHERE thread_root_event_id=?", threadRootEventId);
    if (lifecycle?.state === "resolved") {
      throw new RoomsStoreError("threadResolved", `thread ${threadRootEventId} is resolved; reopen it before replying`);
    }
    return {
      replyToEventId,
      threadRootEventId,
      correlation: { ...(correlationRecord ?? {}), replyToEventId },
    };
  }

  commitControl(input: { channelId: string; senderSessionId: string; kind: string; payload: unknown; requestId: string }): MutationReceipt & { event: unknown; wasDeduplicated?: boolean } {
    return this.write(() => {
      const prior = this.one("SELECT cursor, payload FROM changes WHERE kind='control.committed' AND channel_id=? AND json_extract(payload, '$.senderSessionId')=? AND json_extract(payload, '$.requestId')=? ORDER BY cursor LIMIT 1", input.channelId, input.senderSessionId, input.requestId);
      if (prior) return { cursor: CursorCodec.encode(BigInt(String(prior.cursor))), didAppend: false, changes: [], event: JSON.parse(asString(prior.payload)), wasDeduplicated: true };
      const event = { id: `control_${crypto.randomUUID()}`, ...input, occurredAt: now() };
      const receipt = this.appendChange("control.committed", input.channelId, event);
      return { ...receipt, event, wasDeduplicated: false };
    });
  }

  appendMessageDelivery(messageId: string, statuses: Record<string, "delivered" | "queued" | "undeliverable">): void {
    this.write(() => {
      const row = this.one("SELECT channel_id FROM changes WHERE kind='message.sent' AND json_extract(payload, '$.id')=?", messageId);
      if (!row) throw new RoomsStoreError("unknownMessage");
      this.appendChange("message.delivery", row.channel_id as string | null, { messageId, recipientStatuses: statuses, deliveredRecipientSessionIds: Object.entries(statuses).filter(([, status]) => status === "delivered").map(([id]) => id), occurredAt: now() });
    });
  }

  snapshot(channelId: string): Snapshot {
    this.db.exec("BEGIN");
    try {
      const channelRow = this.one("SELECT * FROM channels WHERE id = ?", channelId);
      if (!channelRow) throw new RoomsStoreError("channelNotFound");
      const sessions = this.rows("SELECT s.* FROM sessions s JOIN memberships m ON m.session_id=s.id WHERE m.channel_id=? AND m.left_at IS NULL AND m.session_ended_at IS NULL ORDER BY m.joined_at, s.id", channelId).map(session);
      const memberships = this.rows("SELECT * FROM memberships WHERE channel_id=? AND left_at IS NULL AND session_ended_at IS NULL ORDER BY joined_at, session_id", channelId).map(membership);
      const events = this.foldMessageEvents(this.rows("SELECT kind, payload FROM changes WHERE channel_id=? AND kind LIKE 'message.%' ORDER BY cursor", channelId) as { kind: string; payload: unknown }[]);
      const result = { cursor: this.latestCursor(), channel: channel(channelRow), sessions, memberships, events };
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  replay(afterCursor = "0", channelId?: string): Change[] {
    let n: bigint;
    try { n = CursorCodec.decode(afterCursor); } catch { throw new RoomsStoreError("invalidCursor"); }
    const rows = channelId ? this.cursorRows("SELECT * FROM changes WHERE cursor > ? AND (channel_id = ? OR channel_id IS NULL) ORDER BY cursor", n, channelId) : this.cursorRows("SELECT * FROM changes WHERE cursor > ? ORDER BY cursor", n);
    return rows.map(change);
  }

  messageCursor(eventId: string, channelId?: string): string {
    const row = channelId
      ? this.one("SELECT cursor FROM changes WHERE kind='message.sent' AND channel_id=? AND json_extract(payload, '$.id')=?", channelId, eventId)
      : this.one("SELECT cursor FROM changes WHERE kind='message.sent' AND json_extract(payload, '$.id')=?", eventId);
    if (!row) throw new RoomsStoreError("unknownMessage");
    return CursorCodec.encode(BigInt(String(row.cursor)));
  }

  /** Resolve one canonical message by its opaque event id. */
  messageById(eventId: string, channelId?: string): { event: unknown; cursor: string } {
    if (!eventId.trim()) throw new RoomsStoreError("unknownMessage");
    const row = channelId
      ? this.one("SELECT cursor, payload FROM changes WHERE kind='message.sent' AND channel_id=? AND json_extract(payload, '$.id')=? LIMIT 1", channelId, eventId)
      : this.one("SELECT cursor, payload FROM changes WHERE kind='message.sent' AND json_extract(payload, '$.id')=? LIMIT 1", eventId);
    if (!row) throw new RoomsStoreError("unknownMessage");
    return { event: JSON.parse(asString(row.payload)), cursor: CursorCodec.encode(BigInt(String(row.cursor))) };
  }

  /**
   * Return messages whose canonical correlation points at one exact parent.
   * The parent lookup fixes the channel, so an id from another channel cannot
   * be used as a broad JSON search key.
   */
  messageReplies(
    replyToEventId: string,
    options: { afterCursor?: string; channelId?: string; sessionId?: string; limit?: number } = {},
  ): { events: unknown[]; cursor: string; oldestCursor: string | null; hasMore: boolean } {
    let after: bigint;
    try { after = CursorCodec.decode(options.afterCursor ?? "0"); } catch { throw new RoomsStoreError("invalidCursor"); }
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RoomsStoreError("invalidLimit");
    const parent = this.messageById(replyToEventId, options.channelId);
    const parentChannelId = (parent.event as { channelId?: string | null }).channelId ?? null;
    const sessionClause = options.sessionId ? `AND (
      json_extract(payload, '$.senderSessionId') = ?
      OR json_extract(payload, '$.target.sessionId') = ?
      OR EXISTS (SELECT 1 FROM json_each(payload, '$.deliveredRecipientSessionIds') WHERE value = ?)
      OR EXISTS (SELECT 1 FROM json_each(payload, '$.target.sessionIds') WHERE value = ?)
    )` : "";
    const parameters: Array<string | bigint | number | null> = [after, parentChannelId, replyToEventId];
    if (options.sessionId) parameters.push(options.sessionId, options.sessionId, options.sessionId, options.sessionId);
    parameters.push(limit + 1);
    const rows = this.cursorRows(
      `SELECT cursor, payload FROM changes
       WHERE cursor > ? AND kind='message.sent' AND channel_id IS ?
         AND json_extract(payload, '$.correlation.replyToEventId') = ?
         ${sessionClause}
       ORDER BY cursor DESC LIMIT ?`,
      ...parameters,
    );
    const hasMore = rows.length > limit;
    const page = (hasMore ? rows.slice(0, limit) : rows).reverse();
    return {
      events: page.map((row) => JSON.parse(asString(row.payload))),
      cursor: this.latestCursor(),
      oldestCursor: page.length > 0 ? CursorCodec.encode(page[0]!.cursor as bigint) : null,
      hasMore,
    };
  }

  /** Channel federation must never inherit channel-less global messages. */
  replayChannelMessages(afterCursor: string, channelId: string, limit = 21): Change[] {
    let n: bigint;
    try { n = CursorCodec.decode(afterCursor); } catch { throw new RoomsStoreError("invalidCursor"); }
    if (!channelId.trim()) throw new RoomsStoreError("invalidChannel");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RoomsStoreError("invalidLimit");
    return this.cursorRows(
      "SELECT * FROM changes WHERE cursor > ? AND channel_id = ? AND kind = 'message.sent' ORDER BY cursor LIMIT ?",
      n, channelId, limit,
    ).map(change);
  }

  listMessages(sessionId: string, afterCursor = "0", channelId?: string | null): { cursor: string; messages: unknown[] } {
    let n: bigint;
    try { n = CursorCodec.decode(afterCursor); } catch { throw new RoomsStoreError("invalidCursor"); }
    const rows = this.cursorRows(
      `SELECT cursor, channel_id, payload, occurred_at FROM changes
       WHERE cursor > ? AND kind = 'message.sent'
         AND json_extract(payload, '$.target.kind') = 'direct'
         AND json_extract(payload, '$.target.sessionId') = ?
         ${channelId ? "AND channel_id = ?" : ""}
       ORDER BY cursor`,
      ...(channelId ? [n, sessionId, channelId] : [n, sessionId]),
    );
    const messages = rows.map(row => ({
      cursor: CursorCodec.encode(row.cursor as bigint),
      channel: row.channel_id as string | null,
      message: JSON.parse(asString(row.payload)),
      occurredAt: asString(row.occurred_at),
    }));
    const deliveries = this.rows("SELECT payload FROM changes WHERE kind='message.delivery' ORDER BY cursor");
    for (const item of messages) {
      const delivery = deliveries.map(row => JSON.parse(asString(row.payload))).find(event => event.messageId === (item.message as any).id);
      if (delivery) {
        (item.message as any).recipientStatuses = delivery.recipientStatuses;
        (item.message as any).deliveredRecipientSessionIds = delivery.deliveredRecipientSessionIds;
      }
    }
    return { cursor: this.latestCursor(), messages };
  }

  private foldMessageEvents(rows: readonly { kind: string; payload: unknown }[]): unknown[] {
    const messages = new Map<string, any>();
    for (const row of rows) {
      const event = JSON.parse(asString(row.payload));
      if (row.kind === "message.sent") messages.set(event.id, event);
      if (row.kind === "message.delivery" && messages.has(event.messageId)) {
        const message = messages.get(event.messageId);
        message.recipientStatuses = event.recipientStatuses;
        message.deliveredRecipientSessionIds = event.deliveredRecipientSessionIds;
      }
    }
    return [...messages.values()];
  }

  /**
   * Messages a session took part in, newest-first-bounded then returned in
   * cursor order. The filter and the bound both run in SQL so a large channel
   * never has to cross the daemon socket just to be discarded client-side.
   */
  sessionMessages(
    sessionId: string,
    options: { afterCursor?: string; channelId?: string | null; limit?: number } = {},
  ): { events: unknown[]; cursor: string; oldestCursor: string | null; hasMore: boolean } {
    let n: bigint;
    try { n = CursorCodec.decode(options.afterCursor ?? "0"); } catch { throw new RoomsStoreError("invalidCursor"); }
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RoomsStoreError("invalidLimit");
    const channelId = options.channelId ?? undefined;
    // One set query returns the newest relevant page and the newest channel
    // change cursor. Advancing over unrelated messages and delivery records is
    // what prevents a consumer from replaying them on every reconnect.
    const rows = this.cursorRows(
      `WITH latest AS (
         SELECT COALESCE(MAX(cursor), ?) AS cursor FROM changes
         WHERE cursor > ? ${channelId ? "AND channel_id = ?" : ""}
       ), relevant AS (
         SELECT cursor, payload FROM changes
         WHERE cursor > ? AND kind = 'message.sent'
           ${channelId ? "AND channel_id = ?" : ""}
           AND (
             json_extract(payload, '$.senderSessionId') = ?
             OR json_extract(payload, '$.target.sessionId') = ?
             OR EXISTS (SELECT 1 FROM json_each(payload, '$.deliveredRecipientSessionIds') WHERE value = ?)
             OR EXISTS (SELECT 1 FROM json_each(payload, '$.target.sessionIds') WHERE value = ?)
           )
         ORDER BY cursor DESC LIMIT ?
       )
       SELECT relevant.cursor, relevant.payload, latest.cursor AS latest_cursor
       FROM latest LEFT JOIN relevant ON 1=1
       ORDER BY relevant.cursor DESC`,
      ...(channelId
        ? [n, n, channelId, n, channelId, sessionId, sessionId, sessionId, sessionId, limit + 1]
        : [n, n, n, sessionId, sessionId, sessionId, sessionId, limit + 1]),
    );
    const relevant = rows.filter((row) => row.payload != null);
    const hasMore = relevant.length > limit;
    const page = (hasMore ? relevant.slice(0, limit) : relevant).reverse();
    const latestCursor = rows[0]?.latest_cursor == null ? n : BigInt(rows[0].latest_cursor as bigint | number);
    return {
      events: page.map((row) => JSON.parse(asString(row.payload))),
      cursor: CursorCodec.encode(latestCursor),
      oldestCursor: page.length > 0 ? CursorCodec.encode(page[0].cursor as bigint) : null,
      hasMore,
    };
  }

  private latestCursor() { const statement = this.db.prepare("SELECT COALESCE(MAX(cursor), 0) AS cursor FROM changes"); statement.setReadBigInts(true); return CursorCodec.encode(BigInt((statement.get() as Row).cursor as bigint)); }
  private sessionRole(id: string): SessionRole | null { return (this.one("SELECT role FROM sessions WHERE id=?", id)?.role as SessionRole | null) ?? null; }
  sessionRoleValue(id: string): SessionRole | null { return this.sessionRole(id); }
  sessionDeliveryModeValue(id: string): SessionDeliveryMode | null { const row = this.one("SELECT delivery_mode FROM sessions WHERE id=?", id); return row ? (((row.delivery_mode as SessionDeliveryMode | null) ?? "runtime")) : null; }
  isActiveMember(channelId: string, sessionId: string, role?: SessionRole): boolean { return Boolean(this.one(`SELECT 1 FROM memberships WHERE channel_id=? AND session_id=? AND left_at IS NULL AND session_ended_at IS NULL${role ? " AND role=?" : ""}`, ...(role ? [channelId, sessionId, role] : [channelId, sessionId]))); }
  activeMembershipCount(channelId: string, role: SessionRole): number { return Number((this.one("SELECT COUNT(*) AS count FROM memberships WHERE channel_id=? AND role=? AND left_at IS NULL AND session_ended_at IS NULL", channelId, role) as Row).count); }
  activeMembershipCountExcept(channelId: string, role: SessionRole, sessionId: string): number { return Number((this.one("SELECT COUNT(*) AS count FROM memberships WHERE channel_id=? AND role=? AND session_id<>? AND left_at IS NULL AND session_ended_at IS NULL", channelId, role, sessionId) as Row).count); }
  activeMembershipChannels(sessionId: string): string[] { return this.rows("SELECT DISTINCT channel_id FROM memberships WHERE session_id=? AND left_at IS NULL AND session_ended_at IS NULL ORDER BY channel_id", sessionId).map((row) => asString(row.channel_id)); }
  updateSessionRole(channelId: string, sessionId: string, role: Exclude<SessionRole, "operator">): MutationReceipt {
    return this.write(() => {
      const before = this.sessionRole(sessionId);
      if (before === null) throw new RoomsStoreError("unknownSession");
      const replacedPlannerIds = role === "planner"
        ? this.rows("SELECT session_id FROM memberships WHERE channel_id=? AND role='planner' AND session_id<>? AND left_at IS NULL AND session_ended_at IS NULL", channelId, sessionId).map((row) => asString(row.session_id))
        : [];
      for (const replacedSessionId of replacedPlannerIds) {
        this.db.prepare("UPDATE sessions SET role='worker' WHERE id=?").run(replacedSessionId);
        this.db.prepare("UPDATE memberships SET role='worker' WHERE session_id=? AND left_at IS NULL AND session_ended_at IS NULL").run(replacedSessionId);
      }
      this.db.prepare("UPDATE sessions SET role=? WHERE id=?").run(role, sessionId);
      this.db.prepare("UPDATE memberships SET role=? WHERE session_id=? AND left_at IS NULL AND session_ended_at IS NULL").run(role, sessionId);
      return this.appendChange("session.role.updated", channelId, {
        channelId,
        sessionId,
        previousRole: before,
        role,
        replacedPlannerSessionIds: replacedPlannerIds,
        activeMembershipRolesUpdated: true,
      });
    });
  }
  currentChannel(id: string): Channel | null { const row = this.one("SELECT * FROM channels WHERE id=?", id); return row ? channel(row) : null; }
  grantFederatedChannelAdmission(channelId: string, peerAuthorityId: string, actorSessionId: string): FederationChannelAdmission {
    return this.write(() => {
      this.assertFederatedAdmissionOwner(channelId, actorSessionId, true);
      const timestamp = now();
      this.db.prepare(`INSERT INTO federation_channel_admissions(
        channel_id, peer_authority_id, granted_by_session_id, granted_at, revoked_by_session_id, revoked_at
      ) VALUES (?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(channel_id, peer_authority_id) DO UPDATE SET
        granted_by_session_id=excluded.granted_by_session_id,
        granted_at=excluded.granted_at,
        revoked_by_session_id=NULL,
        revoked_at=NULL
      WHERE federation_channel_admissions.revoked_at IS NOT NULL`)
        .run(channelId, peerAuthorityId, actorSessionId, timestamp);
      return federationChannelAdmission(this.one("SELECT * FROM federation_channel_admissions WHERE channel_id=? AND peer_authority_id=?", channelId, peerAuthorityId)!);
    });
  }
  revokeFederatedChannelAdmission(channelId: string, peerAuthorityId: string, actorSessionId: string): FederationChannelAdmission {
    return this.write(() => {
      this.assertFederatedAdmissionOwner(channelId, actorSessionId, false);
      const existing = this.one("SELECT * FROM federation_channel_admissions WHERE channel_id=? AND peer_authority_id=?", channelId, peerAuthorityId);
      if (!existing) throw new RoomsStoreError("federationAdmissionNotFound", "federated channel admission does not exist");
      if (existing.revoked_at === null) {
        const timestamp = now();
        this.db.prepare("UPDATE federation_channel_admissions SET revoked_by_session_id=?, revoked_at=? WHERE channel_id=? AND peer_authority_id=? AND revoked_at IS NULL")
          .run(actorSessionId, timestamp, channelId, peerAuthorityId);
      }
      return federationChannelAdmission(this.one("SELECT * FROM federation_channel_admissions WHERE channel_id=? AND peer_authority_id=?", channelId, peerAuthorityId)!);
    });
  }
  listFederatedChannelAdmissions(channelId: string, actorSessionId: string): FederationChannelAdmission[] {
    this.assertFederatedAdmissionOwner(channelId, actorSessionId, false);
    return this.rows("SELECT * FROM federation_channel_admissions WHERE channel_id=? ORDER BY peer_authority_id", channelId).map(federationChannelAdmission);
  }
  isFederatedPeerAdmitted(channelId: string, peerAuthorityId: string): boolean {
    return Boolean(this.one("SELECT 1 FROM federation_channel_admissions WHERE channel_id=? AND peer_authority_id=? AND revoked_at IS NULL", channelId, peerAuthorityId));
  }
  private assertFederatedAdmissionOwner(channelId: string, actorSessionId: string, requireActiveChannel: boolean): void {
    const channel = this.currentChannel(channelId);
    if (!channel) throw new RoomsStoreError("channelNotFound");
    if (requireActiveChannel && channel.lifecycleState !== "active") throw new RoomsStoreError("channelClosed");
    const actor = this.currentSession(actorSessionId);
    if (!actor || actor.endedAt !== null || actor.role !== "operator" || channel.ownerOperatorSessionId !== actorSessionId) {
      throw new RoomsStoreError("ownerAuthorizationRequired", `operator ${actorSessionId} does not own ${channelId}`);
    }
  }
  private membershipsFor(channelId: string, sessionId: string): Membership { return membership(this.one("SELECT * FROM memberships WHERE channel_id=? AND session_id=? ORDER BY joined_at DESC LIMIT 1", channelId, sessionId)!); }
  listChannels(): Channel[] {
    return this.rows("SELECT * FROM channels ORDER BY registered_at ASC, id ASC").map(channel);
  }
  listSessions(): Session[] { return this.rows("SELECT * FROM sessions ORDER BY registered_at ASC, id ASC").map(session); }
  onChange(listener: (change: Change) => void): () => void { this.changeListeners.add(listener); return () => this.changeListeners.delete(listener); }
  roster(channelId: string): unknown[] { return this.rows("SELECT s.id AS session_id, s.display_name, s.role, m.joined_at FROM sessions s JOIN memberships m ON m.session_id=s.id WHERE m.channel_id=? AND m.left_at IS NULL AND m.session_ended_at IS NULL ORDER BY m.joined_at, s.id", channelId).map((row) => ({ sessionId: asString(row.session_id), displayName: row.display_name as string | null, role: row.role, joinedAt: asString(row.joined_at) })); }
  membershipHistory(channelId: string): unknown[] { return this.rows("SELECT channel_id, session_id, joined_at, left_at, session_ended_at, role FROM memberships WHERE channel_id=? ORDER BY joined_at, session_id", channelId).map((row) => ({ channelId: asString(row.channel_id), sessionId: asString(row.session_id), joinedAt: asString(row.joined_at), leftAt: row.left_at as string | null, sessionEndedAt: row.session_ended_at as string | null, role: row.role })); }
  private one(sql: string, ...params: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...params) as Row | undefined; }
  private rows(sql: string, ...params: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...params) as Row[]; }
  private cursorRows(sql: string, ...params: SQLInputValue[]): Row[] { const statement = this.db.prepare(sql); statement.setReadBigInts(true); return statement.all(...params) as Row[]; }
  private appendChange(kind: string, channelId: string | null, payload: unknown): MutationReceipt {
    const occurredAt = now();
    this.db.prepare("INSERT INTO changes(kind, channel_id, payload, occurred_at) VALUES (?, ?, ?, ?)").run(kind, channelId, JSON.stringify(payload), occurredAt);
    const cursor = this.latestCursor();
    const change = { cursor, kind, channelId, payload, occurredAt } as Change;
    for (const listener of this.changeListeners) listener(change);
    return { cursor, didAppend: true, changes: [change] };
  }
  private write<T>(fn: () => T): T {
    if (this.transactionDepth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
    finally { this.transactionDepth -= 1; }
  }
}

function session(row: Row): Session { return { id: asString(row.id), registeredAt: asString(row.registered_at), endedAt: row.ended_at as string | null, displayName: row.display_name as string | null, role: row.role as SessionRole | null, providerThreadId: row.provider_thread_id == null ? null : String(row.provider_thread_id), deliveryMode: (row.delivery_mode as SessionDeliveryMode | null) ?? "runtime" }; }
function channel(row: Row): Channel { return { id: asString(row.id), label: row.label as string | null, registeredAt: asString(row.registered_at), ownerOperatorSessionId: row.owner_operator_session_id as string | null, lifecycleState: row.lifecycle_state as Channel["lifecycleState"], closedAt: row.closed_at as string | null, broadcastPolicy: (row.broadcast_policy as ChannelBroadcastPolicy | null) ?? "all" }; }
function federationChannelAdmission(row: Row): FederationChannelAdmission { return { channelId: asString(row.channel_id), peerAuthorityId: asString(row.peer_authority_id), grantedBySessionId: asString(row.granted_by_session_id), grantedAt: asString(row.granted_at), revokedBySessionId: row.revoked_by_session_id as string | null, revokedAt: row.revoked_at as string | null }; }
function membership(row: Row): Membership { return { channelId: asString(row.channel_id), sessionId: asString(row.session_id), joinedAt: asString(row.joined_at), leftAt: row.left_at as string | null, sessionEndedAt: row.session_ended_at as string | null, role: row.role as SessionRole | null }; }
function threadLifecycle(row: Row): ThreadLifecycle { return { threadRootEventId: asString(row.thread_root_event_id), channelId: asString(row.channel_id), state: row.state as ThreadLifecycle["state"], resolvedAt: row.resolved_at as string | null, resolvedBySessionId: row.resolved_by_session_id as string | null, reopenedAt: row.reopened_at as string | null, reopenedBySessionId: row.reopened_by_session_id as string | null, updatedAt: row.updated_at as string | null }; }
function change(row: Row): Change { return { cursor: CursorCodec.encode(row.cursor as bigint), kind: asString(row.kind), channelId: row.channel_id as string | null, payload: JSON.parse(asString(row.payload)), occurredAt: asString(row.occurred_at) }; }

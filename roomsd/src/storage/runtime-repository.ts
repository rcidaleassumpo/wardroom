// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { RoomsStoreError } from "./repository.js";
import type {
  AppendRuntimeEventInput, AttachRuntimeInput, BindRuntimeInput, CreateRuntimeInput,
  Runtime, RuntimeAttachment, RuntimeBinding, RuntimeCapabilityReplay, RuntimeEvent,
  RuntimeEventKind, RuntimeIdentity, RuntimeQuota, RuntimeQuotaStatus, RuntimeState,
} from "../runtime/contracts.js";
import type { AttachmentMode, RuntimeAction } from "../runtime/contracts.js";

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const text = (value: unknown): string => String(value);
const optionalText = (value: unknown): string | null => value == null ? null : String(value);
const hash = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const hasRawBytesKey = (value: Readonly<Record<string, unknown>>): boolean => Object.keys(value).some((key) => /^(bytes|rawBytes|data|chunk|output)$/i.test(key));

export class RuntimeRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly options: Readonly<{
      onLifecycleChange?: (change: Readonly<{
        channelId: string;
        sessionId: string;
        runtimeId: string;
        generation: number;
        state: string;
        endedAt: string | null;
      }>) => void;
    }> = {},
  ) {}

  create(input: CreateRuntimeInput): Runtime {
    validateIdentity(input);
    if (!(input.reconnectSecret instanceof Uint8Array) || input.reconnectSecret.byteLength < 32) throw new RoomsStoreError("invalidRuntimeCredential");
    return this.transaction(() => {
      const quota = this.quota(input.machineId);
      const active = Number((this.one("SELECT COUNT(*) AS count FROM runtimes WHERE machine_id=? AND state IN ('creating','running','recovering','terminating')", input.machineId)?.count ?? 0));
      if (active >= quota.maxActiveRuntimes) throw new RoomsStoreError("runtimeQuotaExceeded");
      const createdAt = now();
      try {
        this.db.prepare(`INSERT INTO runtimes(runtime_id, home_authority_id, session_id, generation, protocol_version, transport_kind, state, machine_id, reconnect_secret_hash, provider_thread_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?, ?, ?)`).run(input.runtimeId, input.homeAuthorityId, input.sessionId, input.generation, input.protocolVersion, input.transportKind, input.machineId, hash(input.reconnectSecret), input.providerThreadId ?? null, createdAt, createdAt);
      } catch (error) { throw mapConstraint(error, "runtimeAlreadyExists"); }
      const runtime = this.get(input.runtimeId);
      if (!runtime) throw new RoomsStoreError("runtimeCreateFailed");
      this.appendEventUnsafe({ runtimeId: input.runtimeId, generation: input.generation, kind: "created", payload: { transportKind: input.transportKind } });
      return runtime;
    });
  }

  get(runtimeId: string): Runtime | null {
    const row = this.one("SELECT * FROM runtimes WHERE runtime_id=?", runtimeId);
    return row ? toRuntime(row) : null;
  }

  setProviderThreadId(runtimeId: string, providerThreadId: string): Runtime {
    const result = this.tryClaimProviderThreadId(runtimeId, providerThreadId, { allowReplace: true });
    if (!result.claimed) {
      if (result.reason === "conflict") throw new RoomsStoreError("providerThreadIdConflict");
      if (result.reason === "runtimeNotFound") throw new RoomsStoreError("runtimeNotFound");
      throw new RoomsStoreError("invalidProviderThreadId");
    }
    return result.runtime;
  }

  /**
   * Atomic claim of a provider conversation for one live runtime generation.
   * BEGIN IMMEDIATE serializes concurrent discoverers: only one live runtime
   * may hold a given providerThreadId. Losers get claimed=false and continue
   * discovery instead of throwing.
   */
  tryClaimProviderThreadId(
    runtimeId: string,
    providerThreadId: string,
    options: { allowReplace?: boolean } = {},
  ): { claimed: true; runtime: Runtime } | { claimed: false; reason: "conflict" | "runtimeNotFound" | "invalidProviderThreadId" | "alreadyBound" } {
    if (!providerThreadId.trim()) return { claimed: false, reason: "invalidProviderThreadId" };
    return this.transaction(() => {
      const runtime = this.get(runtimeId);
      if (!runtime) return { claimed: false, reason: "runtimeNotFound" };
      // Idempotent re-claim of the id this runtime already holds.
      if (runtime.providerThreadId === providerThreadId) return { claimed: true, runtime };
      // Discovery claims only unbound runtimes; explicit set may replace.
      if (runtime.providerThreadId != null && !options.allowReplace) {
        return { claimed: false, reason: "alreadyBound" };
      }
      // A provider conversation belongs to exactly one live runtime. Two runtimes
      // sharing one thread id make session identity ambiguous, and the loser's
      // briefing is delivered into a conversation it does not own.
      if (this.providerThreadHolderUnsafe(providerThreadId, runtimeId)) {
        return { claimed: false, reason: "conflict" };
      }
      this.db.prepare("UPDATE runtimes SET provider_thread_id=?, updated_at=? WHERE runtime_id=?").run(providerThreadId, now(), runtimeId);
      this.db.prepare("UPDATE sessions SET provider_thread_id=? WHERE id=? AND ended_at IS NULL").run(providerThreadId, runtime.sessionId);
      return { claimed: true, runtime: this.get(runtimeId)! };
    });
  }

  /** Live runtime already holding a provider conversation, so a concurrent launch never adopts it. */
  providerThreadHolder(providerThreadId: string, exceptRuntimeId?: string): string | null {
    if (!providerThreadId.trim()) return null;
    return this.providerThreadHolderUnsafe(providerThreadId, exceptRuntimeId);
  }

  private providerThreadHolderUnsafe(providerThreadId: string, exceptRuntimeId?: string): string | null {
    const row = this.one(`SELECT runtime_id FROM runtimes
      WHERE provider_thread_id=? AND runtime_id IS NOT ?
        AND ended_at IS NULL AND state IN ('creating','running','recovering','terminating')
      ORDER BY created_at LIMIT 1`, providerThreadId, exceptRuntimeId ?? null);
    return row ? text(row.runtime_id) : null;
  }

  getByIdentity(identity: Pick<RuntimeIdentity, "homeAuthorityId" | "sessionId" | "generation">): Runtime | null {
    const row = this.one("SELECT * FROM runtimes WHERE home_authority_id=? AND session_id=? AND generation=?", identity.homeAuthorityId, identity.sessionId, identity.generation);
    return row ? toRuntime(row) : null;
  }

  list(machineId?: string): Runtime[] {
    const rows = machineId ? this.rows("SELECT * FROM runtimes WHERE machine_id=? ORDER BY created_at, runtime_id", machineId) : this.rows("SELECT * FROM runtimes ORDER BY created_at, runtime_id");
    return rows.map(toRuntime);
  }

  plannerCanLaunchWorker(plannerSessionId: string, workerSessionId: string, channelId: string): boolean {
    if (!plannerSessionId || !workerSessionId || !channelId) return false;
    return Boolean(this.one(`SELECT 1
      FROM memberships planner
      JOIN memberships worker ON worker.channel_id=planner.channel_id
      JOIN sessions planner_session ON planner_session.id=planner.session_id
      JOIN sessions worker_session ON worker_session.id=worker.session_id
      JOIN channels channel ON channel.id=planner.channel_id
      WHERE planner.channel_id=? AND planner.session_id=? AND planner.role='planner'
        AND worker.session_id=? AND worker.role='worker'
        AND planner.left_at IS NULL AND planner.session_ended_at IS NULL
        AND worker.left_at IS NULL AND worker.session_ended_at IS NULL
        AND planner_session.ended_at IS NULL AND worker_session.ended_at IS NULL
        AND channel.lifecycle_state='active'`, channelId, plannerSessionId, workerSessionId));
  }

  bind(input: BindRuntimeInput): RuntimeBinding {
    validateIdentity(input);
    if (!input.bindingId || !input.adapterKind || !input.handleRef) throw new RoomsStoreError("invalidRuntimeBinding");
    const binding = this.transaction(() => {
      const runtime = this.requireRuntime(input.runtimeId);
      assertSameGeneration(runtime, input);
      try {
        this.db.prepare(`INSERT INTO runtime_bindings(binding_id, runtime_id, home_authority_id, session_id, generation, channel_id, adapter_kind, handle_ref, launch_policy_ref, bound_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.bindingId, input.runtimeId, input.homeAuthorityId, input.sessionId, input.generation, input.channelId ?? null, input.adapterKind, input.handleRef, input.launchPolicyRef ?? null, now());
      } catch (error) { throw mapConstraint(error, "runtimeBindingAlreadyExists"); }
      return this.getBinding(input.runtimeId)!;
    });
    this.emitLifecycle(input.runtimeId);
    return binding;
  }

  getBinding(runtimeId: string): RuntimeBinding | null {
    const row = this.one("SELECT * FROM runtime_bindings WHERE runtime_id=? AND unbound_at IS NULL", runtimeId);
    return row ? toBinding(row) : null;
  }

  attach(input: AttachRuntimeInput): RuntimeAttachment {
    validateIdentity(input);
    if (!input.attachmentId || !input.viewerId) throw new RoomsStoreError("invalidRuntimeAttachment");
    return this.transaction(() => {
      const runtime = this.requireRuntime(input.runtimeId);
      assertSameGeneration(runtime, input);
      if (["exited", "terminated"].includes(runtime.state) || (runtime.state === "crashed" && !input.allowRecovery)) throw new RoomsStoreError("runtimeUnavailable");
      const current = this.one("SELECT * FROM runtime_attachments WHERE runtime_id=? AND generation=? AND viewer_id=? AND detached_at IS NULL", input.runtimeId, input.generation, input.viewerId);
      if (current) return toAttachment(current);
      const detached = this.one("SELECT * FROM runtime_attachments WHERE runtime_id=? AND generation=? AND viewer_id=? AND detached_at IS NOT NULL ORDER BY attached_at DESC LIMIT 1", input.runtimeId, input.generation, input.viewerId);
      if (input.mode === "observe") {
        const quota = this.quota(runtime.machineId);
        const observers = Number((this.one("SELECT COUNT(*) AS count FROM runtime_attachments WHERE runtime_id=? AND generation=? AND mode='observe' AND detached_at IS NULL", input.runtimeId, input.generation)?.count ?? 0));
        if (observers >= quota.maxObserversPerRuntime) throw new RoomsStoreError("observerQuotaExceeded");
      } else {
        const currentController = this.one("SELECT attachment_id, lease_expires_at FROM runtime_attachments WHERE runtime_id=? AND generation=? AND mode='controller' AND detached_at IS NULL", input.runtimeId, input.generation);
        if (currentController && currentController.lease_expires_at && String(currentController.lease_expires_at) <= now()) {
          this.db.prepare("UPDATE runtime_attachments SET detached_at=?, last_seen_at=? WHERE attachment_id=? AND detached_at IS NULL").run(now(), now(), String(currentController.attachment_id));
        } else if (currentController && input.operatorOverride) {
          this.db.prepare("UPDATE runtime_attachments SET detached_at=?, last_seen_at=? WHERE attachment_id=? AND detached_at IS NULL").run(now(), now(), String(currentController.attachment_id));
        }
      }
      if (detached) {
        this.db.prepare("UPDATE runtime_attachments SET mode=?, lease_expires_at=?, output_cursor=?, attached_at=?, detached_at=NULL, last_seen_at=? WHERE attachment_id=?").run(input.mode, input.leaseExpiresAt ?? null, input.outputCursor ?? 0n, now(), now(), String(detached.attachment_id));
        return this.getAttachment(String(detached.attachment_id))!;
      }
      try {
        this.db.prepare(`INSERT INTO runtime_attachments(attachment_id, runtime_id, home_authority_id, session_id, generation, viewer_id, mode, lease_expires_at, output_cursor, attached_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.attachmentId, input.runtimeId, input.homeAuthorityId, input.sessionId, input.generation, input.viewerId, input.mode, input.leaseExpiresAt ?? null, input.outputCursor ?? 0n, now(), now());
      } catch (error) { throw mapConstraint(error, input.mode === "controller" ? "controllerLeaseBusy" : "runtimeAttachmentAlreadyExists"); }
      return this.getAttachment(input.attachmentId)!;
    });
  }

  getAttachment(attachmentId: string): RuntimeAttachment | null {
    const row = this.one("SELECT * FROM runtime_attachments WHERE attachment_id=?", attachmentId);
    return row ? toAttachment(row) : null;
  }

  listAttachments(runtimeId: string, generation: number, includeDetached = false): RuntimeAttachment[] {
    const rows = includeDetached
      ? this.rows("SELECT * FROM runtime_attachments WHERE runtime_id=? AND generation=? ORDER BY attached_at, attachment_id", runtimeId, generation)
      : this.rows("SELECT * FROM runtime_attachments WHERE runtime_id=? AND generation=? AND detached_at IS NULL ORDER BY attached_at, attachment_id", runtimeId, generation);
    return rows.map(toAttachment);
  }

  detach(attachmentId: string): RuntimeAttachment {
    return this.transaction(() => {
      const attachment = this.getAttachment(attachmentId);
      if (!attachment) throw new RoomsStoreError("unknownRuntimeAttachment");
      if (!attachment.detachedAt) this.db.prepare("UPDATE runtime_attachments SET detached_at=?, last_seen_at=? WHERE attachment_id=? AND detached_at IS NULL").run(now(), now(), attachmentId);
      return this.getAttachment(attachmentId)!;
    });
  }

  renewControllerLease(attachmentId: string, leaseExpiresAt: string): RuntimeAttachment {
    return this.transaction(() => {
      const attachment = this.getAttachment(attachmentId);
      if (!attachment || attachment.detachedAt) throw new RoomsStoreError("unknownRuntimeAttachment");
      if (attachment.mode !== "controller") throw new RoomsStoreError("controllerLeaseRequired");
      this.db.prepare("UPDATE runtime_attachments SET lease_expires_at=?, last_seen_at=? WHERE attachment_id=? AND detached_at IS NULL").run(leaseExpiresAt, now(), attachmentId);
      return this.getAttachment(attachmentId)!;
    });
  }

  markState(runtimeId: string, generation: number, state: RuntimeState, reason?: string | null): Runtime {
    const result = this.transaction(() => {
      const runtime = this.requireRuntime(runtimeId);
      if (runtime.generation !== generation) throw new RoomsStoreError("staleRuntimeGeneration");
      const ended = ["exited", "crashed", "terminated"].includes(state) ? now() : null;
      this.db.prepare("UPDATE runtimes SET state=?, updated_at=?, ended_at=COALESCE(?, ended_at), exit_reason=COALESCE(?, exit_reason) WHERE runtime_id=? AND generation=?").run(state, now(), ended, reason ?? null, runtimeId, generation);
      this.appendEventUnsafe({ runtimeId, generation, kind: state === "recovering" ? "recovering" : state === "crashed" ? "crashed" : state === "exited" ? "exited" : state === "terminated" ? "exited" : "error", outcome: reason ?? state });
      return this.get(runtimeId)!;
    });
    this.emitLifecycle(runtimeId);
    return result;
  }

  appendEvent(input: AppendRuntimeEventInput): RuntimeEvent {
    return this.transaction(() => this.appendEventUnsafe(input));
  }

  events(runtimeId: string, generation: number, afterSeq = 0): RuntimeEvent[] {
    const statement = this.db.prepare("SELECT * FROM runtime_events WHERE runtime_id=? AND generation=? AND event_seq>? ORDER BY event_seq");
    statement.setReadBigInts(true);
    return (statement.all(runtimeId, generation, afterSeq) as Row[]).map(toEvent);
  }

  canonicalMessageSender(messageId: string): string | null {
    const row = this.one("SELECT json_extract(payload, '$.senderSessionId') AS sender FROM changes WHERE kind='message.sent' AND json_extract(payload, '$.id')=?", messageId);
    return row?.sender == null ? null : String(row.sender);
  }

  canonicalMessageRecipients(messageId: string): string[] {
    const row = this.one("SELECT payload FROM changes WHERE kind='message.sent' AND json_extract(payload, '$.id')=?", messageId);
    if (!row?.payload) return [];
    const payload = JSON.parse(String(row.payload)) as { deliveredRecipientSessionIds?: unknown; target?: { sessionId?: string; sessionIds?: string[] } };
    // Delivery authorization is based on the addressed set. Acceptance is a
    // separate outcome recorded after the runtime acknowledges the delivery.
    if (payload.target?.sessionId) return [payload.target.sessionId];
    if (Array.isArray(payload.target?.sessionIds)) return payload.target.sessionIds;
    return Array.isArray(payload.deliveredRecipientSessionIds) ? payload.deliveredRecipientSessionIds.filter((value): value is string => typeof value === "string") : [];
  }

  consumeCapability(input: RuntimeCapabilityReplay): boolean {
    return this.transaction(() => {
      if (new Date(input.expiresAt).getTime() <= Date.now()) throw new RoomsStoreError("capabilityExpired");
      try {
        this.db.prepare(`INSERT INTO runtime_capability_replay(runtime_id, generation, capability_id, nonce_hash, action, expires_at, consumed_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL)`).run(input.runtimeId, input.generation, input.capabilityId, input.nonceHash, input.action, input.expiresAt);
        return true;
      } catch (error) {
        if (isConstraint(error)) throw new RoomsStoreError("capabilityReplay");
        throw error;
      }
    });
  }

  setQuota(input: Omit<RuntimeQuota, "updatedAt">): RuntimeQuota {
    if (!input.machineId || input.maxActiveRuntimes < 1 || input.maxObserversPerRuntime < 1) throw new RoomsStoreError("invalidRuntimeQuota");
    const updatedAt = now();
    this.db.prepare(`INSERT INTO runtime_quotas(machine_id, max_active_runtimes, max_observers_per_runtime, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(machine_id) DO UPDATE SET max_active_runtimes=excluded.max_active_runtimes, max_observers_per_runtime=excluded.max_observers_per_runtime, updated_at=excluded.updated_at`).run(input.machineId, input.maxActiveRuntimes, input.maxObserversPerRuntime, updatedAt);
    return { ...input, updatedAt };
  }

  clearQuota(machineId: string): void { this.db.prepare("DELETE FROM runtime_quotas WHERE machine_id=?").run(machineId); }

  quota(machineId: string): RuntimeQuota {
    const row = this.one("SELECT * FROM runtime_quotas WHERE machine_id=?", machineId);
    return row ? toQuota(row) : { machineId, maxActiveRuntimes: 32, maxObserversPerRuntime: 32, updatedAt: now() };
  }

  quotaStatuses(machineId?: string): RuntimeQuotaStatus[] {
    const ids = machineId ? [machineId] : (this.db.prepare(`SELECT machine_id FROM runtimes UNION SELECT machine_id FROM runtime_quotas ORDER BY machine_id`).all() as Row[]).map(row => text(row.machine_id));
    return ids.map(id => {
      const override = this.one("SELECT * FROM runtime_quotas WHERE machine_id=?", id);
      const quota = override ? toQuota(override) : this.quota(id);
      const states = { creating: 0, running: 0, recovering: 0, crashed: 0, exited: 0, terminating: 0, terminated: 0 } satisfies Record<RuntimeState, number>;
      for (const row of this.db.prepare("SELECT state, COUNT(*) AS count FROM runtimes WHERE machine_id=? GROUP BY state").all(id) as Row[]) states[text(row.state) as RuntimeState] = Number(row.count);
      const activeRuntimes = states.creating + states.running + states.recovering + states.terminating;
      const runtimeCount = Object.values(states).reduce((sum, count) => sum + count, 0);
      const utilizationPercent = Math.round((activeRuntimes / quota.maxActiveRuntimes) * 100);
      const capacityState = activeRuntimes >= quota.maxActiveRuntimes ? "exhausted" : utilizationPercent >= 80 ? "warning" : "healthy";
      return { ...quota, source: override ? "override" : "default", activeRuntimes, availableRuntimes: Math.max(0, quota.maxActiveRuntimes - activeRuntimes), runtimeCount, utilizationPercent, capacityState, states };
    });
  }

  private appendEventUnsafe(input: AppendRuntimeEventInput): RuntimeEvent {
    const payload = input.payload ?? {};
    if (hasRawBytesKey(payload)) throw new RoomsStoreError("runtimeRawOutputForbidden");
    const runtime = this.requireRuntime(input.runtimeId);
    if (runtime.generation !== input.generation) throw new RoomsStoreError("staleRuntimeGeneration");
    if (input.messageId && !this.one("SELECT 1 FROM changes WHERE kind='message.sent' AND json_extract(payload, '$.id')=?", input.messageId)) throw new RoomsStoreError("unknownCanonicalMessage");
    const next = Number((this.one("SELECT COALESCE(MAX(event_seq), 0) AS event_seq FROM runtime_events WHERE runtime_id=? AND generation=?", input.runtimeId, input.generation)?.event_seq ?? 0)) + 1;
    const eventId = randomUUID();
    const occurredAt = now();
    this.db.prepare(`INSERT INTO runtime_events(runtime_id, generation, event_seq, event_id, kind, output_cursor, message_id, outcome, payload_json, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.runtimeId, input.generation, next, eventId, input.kind, input.outputCursor ?? null, input.messageId ?? null, input.outcome ?? null, JSON.stringify(payload), occurredAt);
    return { runtimeId: input.runtimeId, generation: input.generation, eventSeq: next, eventId, kind: input.kind, outputCursor: input.outputCursor ?? null, messageId: input.messageId ?? null, outcome: input.outcome ?? null, payload, occurredAt };
  }

  private requireRuntime(runtimeId: string): Runtime {
    const runtime = this.get(runtimeId);
    if (!runtime) throw new RoomsStoreError("runtimeNotFound");
    return runtime;
  }

  private emitLifecycle(runtimeId: string): void {
    if (!this.options.onLifecycleChange) return;
    const runtime = this.get(runtimeId);
    const binding = this.getBinding(runtimeId);
    if (!runtime || !binding?.channelId) return;
    this.options.onLifecycleChange({
      channelId: binding.channelId,
      sessionId: runtime.sessionId,
      runtimeId: runtime.runtimeId,
      generation: runtime.generation,
      state: runtime.state,
      endedAt: runtime.endedAt,
    });
  }

  private one(sql: string, ...params: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...params) as Row | undefined; }
  private rows(sql: string, ...params: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...params) as Row[]; }
  private transaction<T>(fn: () => T): T { this.db.exec("BEGIN IMMEDIATE"); try { const result = fn(); this.db.exec("COMMIT"); return result; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
}

function validateIdentity(input: { homeAuthorityId: string; sessionId: string; runtimeId?: string; generation: number }): void {
  if (!input.homeAuthorityId || !input.sessionId || ("runtimeId" in input && !input.runtimeId) || !Number.isSafeInteger(input.generation) || input.generation < 1) throw new RoomsStoreError("invalidRuntimeIdentity");
}
function assertSameGeneration(runtime: Runtime, input: { homeAuthorityId: string; sessionId: string; generation: number }): void {
  if (runtime.homeAuthorityId !== input.homeAuthorityId || runtime.sessionId !== input.sessionId) throw new RoomsStoreError("runtimeIdentityMismatch");
  if (runtime.generation !== input.generation) throw new RoomsStoreError("staleRuntimeGeneration");
}
function mapConstraint(error: unknown, fallback: string): RoomsStoreError { return isConstraint(error) ? new RoomsStoreError(fallback) : error as RoomsStoreError; }
function isConstraint(error: unknown): boolean { return error instanceof Error && /constraint|unique|check|foreign key/i.test(error.message); }
function toRuntime(row: Row): Runtime { return { runtimeId: text(row.runtime_id), homeAuthorityId: text(row.home_authority_id), sessionId: text(row.session_id), providerThreadId: optionalText(row.provider_thread_id), generation: Number(row.generation), protocolVersion: Number(row.protocol_version), transportKind: row.transport_kind as Runtime["transportKind"], state: row.state as RuntimeState, machineId: text(row.machine_id), reconnectSecretHash: text(row.reconnect_secret_hash), createdAt: text(row.created_at), updatedAt: text(row.updated_at), endedAt: optionalText(row.ended_at), exitReason: optionalText(row.exit_reason) }; }
function toBinding(row: Row): RuntimeBinding { return { bindingId: text(row.binding_id), runtimeId: text(row.runtime_id), homeAuthorityId: text(row.home_authority_id), sessionId: text(row.session_id), generation: Number(row.generation), channelId: optionalText(row.channel_id), adapterKind: text(row.adapter_kind), handleRef: text(row.handle_ref), launchPolicyRef: optionalText(row.launch_policy_ref), boundAt: text(row.bound_at), unboundAt: optionalText(row.unbound_at) }; }
function toAttachment(row: Row): RuntimeAttachment { return { attachmentId: text(row.attachment_id), runtimeId: text(row.runtime_id), homeAuthorityId: text(row.home_authority_id), sessionId: text(row.session_id), generation: Number(row.generation), viewerId: text(row.viewer_id), mode: row.mode as AttachmentMode, leaseExpiresAt: optionalText(row.lease_expires_at), outputCursor: BigInt(row.output_cursor as bigint | number), attachedAt: text(row.attached_at), detachedAt: optionalText(row.detached_at), lastSeenAt: optionalText(row.last_seen_at) }; }
function toEvent(row: Row): RuntimeEvent { return { runtimeId: text(row.runtime_id), generation: Number(row.generation), eventSeq: Number(row.event_seq), eventId: text(row.event_id), kind: row.kind as RuntimeEventKind, outputCursor: row.output_cursor == null ? null : BigInt(row.output_cursor as bigint | number), messageId: optionalText(row.message_id), outcome: optionalText(row.outcome), payload: JSON.parse(text(row.payload_json)) as Readonly<Record<string, string | number | boolean | null>>, occurredAt: text(row.occurred_at) }; }
function toQuota(row: Row): RuntimeQuota { return { machineId: text(row.machine_id), maxActiveRuntimes: Number(row.max_active_runtimes), maxObserversPerRuntime: Number(row.max_observers_per_runtime), updatedAt: text(row.updated_at) }; }

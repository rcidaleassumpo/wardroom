// SPDX-License-Identifier: Apache-2.0
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { BlueprintStore, QueuedCanonicalDelivery } from "../lifecycle/suspend-resume.js";
import type { RuntimeOwnershipStore } from "../runtime/codex-adapter.js";
import type { ResumableChannelBlueprint } from "../blueprints/resumable.js";

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

/** SQLite-backed durable lifecycle state; it owns no Rooms authority. */
export class SQLiteBlueprintStore implements BlueprintStore {
  private depth = 0;
  constructor(private readonly db: DatabaseSync, private readonly leaseDurationMs = 30_000) {}

  transaction<T>(operation: () => T): T {
    if (this.depth > 0) return operation();
    this.db.exec("BEGIN IMMEDIATE"); this.depth++;
    try { const value = operation(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
    finally { this.depth--; }
  }

  read(channelId: string): ResumableChannelBlueprint | null {
    const row = this.one("SELECT blueprint_json FROM channel_blueprints WHERE channel_id=?", channelId);
    return row ? JSON.parse(String(row.blueprint_json)) as ResumableChannelBlueprint : null;
  }

  retainMembers(channelId: string, activeSessionIds: ReadonlySet<string>): ResumableChannelBlueprint | null {
    return this.transaction(() => {
      const blueprint = this.read(channelId);
      if (!blueprint) return null;
      const members = blueprint.members.filter(member => activeSessionIds.has(member.priorSessionId));
      const removed = blueprint.members.filter(member => !activeSessionIds.has(member.priorSessionId)).map(member => member.priorSessionId);
      if (removed.length === 0) return blueprint;
      const reconciled = { ...blueprint, members };
      this.db.prepare("UPDATE channel_blueprints SET blueprint_json=?, updated_at=? WHERE channel_id=?").run(JSON.stringify(reconciled), now(), channelId);
      const placeholders = removed.map(() => "?").join(", ");
      this.db.prepare(`DELETE FROM blueprint_member_outcomes WHERE channel_id=? AND prior_session_id IN (${placeholders})`).run(channelId, ...removed);
      return reconciled;
    });
  }

  capture(channelId: string, blueprint: ResumableChannelBlueprint, ownerId: string): boolean {
    const result = this.db.prepare("UPDATE channel_blueprints SET blueprint_json=?, updated_at=? WHERE channel_id=? AND state='suspending' AND owner_id=?").run(JSON.stringify(blueprint), now(), channelId, ownerId);
    return Number(result.changes) === 1;
  }
  claimSuspend(channelId: string, idempotencyKey: string, blueprint: ResumableChannelBlueprint, ownerId: string): boolean {
    const lease = new Date(Date.now() + this.leaseDurationMs).toISOString();
    const current = this.one("SELECT state FROM channel_blueprints WHERE channel_id=?", channelId)?.state;
    const result = this.db.prepare("INSERT INTO channel_blueprints(channel_id, blueprint_json, state, idempotency_key, owner_id, lease_until, fence_epoch, updated_at) VALUES (?, ?, 'suspending', ?, ?, ?, 1, ?) ON CONFLICT(channel_id) DO UPDATE SET state='suspending', owner_id=excluded.owner_id, idempotency_key=excluded.idempotency_key, suspend_key_known=1, lease_until=excluded.lease_until, fence_epoch=channel_blueprints.fence_epoch+1, updated_at=excluded.updated_at WHERE (channel_blueprints.state='active') OR (channel_blueprints.state='suspended' AND channel_blueprints.suspend_key_known=1 AND channel_blueprints.idempotency_key=excluded.idempotency_key) OR (channel_blueprints.state='suspending' AND channel_blueprints.suspend_key_known=1 AND channel_blueprints.idempotency_key=excluded.idempotency_key AND (channel_blueprints.lease_until IS NULL OR channel_blueprints.lease_until <= ?))").run(channelId, JSON.stringify(blueprint), idempotencyKey, ownerId, lease, now(), now());
    if (Number(result.changes) === 1 && current === "active") this.db.prepare("DELETE FROM blueprint_member_outcomes WHERE channel_id=?").run(channelId);
    return Number(result.changes) === 1;
  }
  renewSuspend(channelId: string, idempotencyKey: string, ownerId: string): boolean { const result = this.db.prepare("UPDATE channel_blueprints SET lease_until=?, updated_at=? WHERE channel_id=? AND idempotency_key=? AND owner_id=? AND state='suspending' AND lease_until IS NOT NULL AND lease_until > ?").run(new Date(Date.now() + this.leaseDurationMs).toISOString(), now(), channelId, idempotencyKey, ownerId, now()); return Number(result.changes) === 1; }
  currentSuspendFenceToken(channelId: string, idempotencyKey: string, ownerId: string): string | null { const row = this.one("SELECT fence_epoch FROM channel_blueprints WHERE channel_id=? AND idempotency_key=? AND owner_id=? AND state='suspending'", channelId, idempotencyKey, ownerId); return row ? `${ownerId}:${idempotencyKey}:${Number(row.fence_epoch)}` : null; }
  verifySuspendFenceToken(channelId: string, idempotencyKey: string, ownerId: string, token: string): boolean { return this.currentSuspendFenceToken(channelId, idempotencyKey, ownerId) === token && Boolean(this.one("SELECT 1 FROM channel_blueprints WHERE channel_id=? AND idempotency_key=? AND owner_id=? AND state='suspending' AND lease_until IS NOT NULL AND lease_until > ?", channelId, idempotencyKey, ownerId, now())); }
  verifyFenceToken(token: string): boolean { return Boolean(this.one("SELECT 1 FROM channel_blueprints WHERE (((owner_id || ':' || idempotency_key || ':' || fence_epoch)=? AND state='suspending' AND lease_until IS NOT NULL AND lease_until > ?) OR ((resume_owner_id || ':' || resume_key || ':' || resume_epoch)=? AND state='resuming' AND resume_lease_until IS NOT NULL AND resume_lease_until > ?))", token, now(), token, now())); }
  suspendLeaseHeartbeatMs(): number { return Math.max(1, Math.floor(this.leaseDurationMs / 3)); }
  releaseSuspend(channelId: string, idempotencyKey: string, ownerId: string): boolean { const result = this.db.prepare("UPDATE channel_blueprints SET lease_until=NULL, updated_at=? WHERE channel_id=? AND idempotency_key=? AND owner_id=? AND state='suspending'").run(now(), channelId, idempotencyKey, ownerId); return Number(result.changes) === 1; }
  suspensionComplete(channelId: string): boolean {
    const total = Number((this.one("SELECT json_array_length(json_extract(blueprint_json, '$.members')) AS count FROM channel_blueprints WHERE channel_id=?", channelId)?.count ?? 0));
    const stopped = Number((this.one("SELECT COUNT(*) AS count FROM blueprint_member_outcomes WHERE channel_id=? AND outcome='stopped'", channelId)?.count ?? 0));
    return total > 0 && total === stopped;
  }
  memberStopped(channelId: string, priorSessionId: string): boolean { return Boolean(this.one("SELECT 1 FROM blueprint_member_outcomes WHERE channel_id=? AND prior_session_id=? AND outcome='stopped'", channelId, priorSessionId)); }
  suspendIdempotencyKey(channelId: string): string | null { return (this.one("SELECT idempotency_key FROM channel_blueprints WHERE channel_id=? AND state IN ('suspending','suspended') AND suspend_key_known=1", channelId)?.idempotency_key as string | null) ?? null; }

  markSuspending(channelId: string, idempotencyKey: string, ownerId: string): boolean {
    const result = this.db.prepare("INSERT INTO channel_blueprints(channel_id, blueprint_json, state, idempotency_key, owner_id, lease_until, fence_epoch, updated_at) VALUES (?, '{}', 'suspending', ?, ?, ?, 1, ?) ON CONFLICT(channel_id) DO UPDATE SET state='suspending', idempotency_key=excluded.idempotency_key, suspend_key_known=1, owner_id=excluded.owner_id, lease_until=excluded.lease_until, fence_epoch=channel_blueprints.fence_epoch+1, updated_at=excluded.updated_at").run(channelId, idempotencyKey, ownerId, new Date(Date.now() + this.leaseDurationMs).toISOString(), now());
    return Number(result.changes) === 1;
  }

  recordMemberOutcome(channelId: string, priorSessionId: string, outcome: "stopped" | "failed", ownerId: string, error?: string): boolean {
    const result = this.db.prepare("INSERT INTO blueprint_member_outcomes(channel_id, prior_session_id, outcome, error, updated_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM channel_blueprints WHERE channel_id=? AND owner_id=? AND state='suspending') ON CONFLICT(channel_id, prior_session_id) DO UPDATE SET outcome=excluded.outcome, error=excluded.error, updated_at=excluded.updated_at").run(channelId, priorSessionId, outcome, error ?? null, now(), channelId, ownerId);
    return Number(result.changes) === 1;
  }

  markSuspended(channelId: string, idempotencyKey: string, ownerId: string): boolean { const result = this.db.prepare("UPDATE channel_blueprints SET state='suspended', lease_until=NULL, updated_at=? WHERE channel_id=? AND idempotency_key=? AND owner_id=? AND state='suspending'").run(now(), channelId, idempotencyKey, ownerId); return Number(result.changes) === 1; }
  claimResume(channelId: string, idempotencyKey: string, generation: number, ownerId: string): boolean {
    const timestamp = now(); const lease = new Date(Date.now() + this.leaseDurationMs).toISOString();
    const result = this.db.prepare("UPDATE channel_blueprints SET state='resuming', resume_key=?, resume_owner_id=?, resume_lease_until=?, resume_epoch=resume_epoch+1, resume_recovery_known=1, generation=?, updated_at=? WHERE channel_id=? AND (state='suspended' OR (state='resuming' AND resume_recovery_known=1 AND resume_key=? AND generation=? AND resume_lease_until IS NOT NULL AND resume_lease_until<=?))").run(idempotencyKey, ownerId, lease, generation, timestamp, channelId, idempotencyKey, generation, timestamp);
    return Number(result.changes) === 1;
  }
  currentResumeFenceToken(channelId: string, idempotencyKey: string, ownerId: string): string | null { const row = this.one("SELECT resume_epoch FROM channel_blueprints WHERE channel_id=? AND state='resuming' AND resume_key=? AND resume_owner_id=? AND resume_lease_until IS NOT NULL AND resume_lease_until>?", channelId, idempotencyKey, ownerId, now()); return row ? `${ownerId}:${idempotencyKey}:${String(row.resume_epoch)}` : null; }
  renewResume(channelId: string, idempotencyKey: string, ownerId: string, token: string): boolean { const result = this.db.prepare("UPDATE channel_blueprints SET resume_lease_until=?, updated_at=? WHERE channel_id=? AND state='resuming' AND resume_key=? AND resume_owner_id=? AND (resume_owner_id || ':' || resume_key || ':' || resume_epoch)=? AND resume_lease_until IS NOT NULL AND resume_lease_until>?").run(new Date(Date.now() + this.leaseDurationMs).toISOString(), now(), channelId, idempotencyKey, ownerId, token, now()); return Number(result.changes) === 1; }
  resumeResult(channelId: string, idempotencyKey: string): readonly import("../lifecycle/suspend-resume.js").MemberResumeOutcome[] | null { const row = this.one("SELECT result_json FROM resume_results WHERE channel_id=? AND idempotency_key=?", channelId, idempotencyKey); return row ? JSON.parse(String(row.result_json)) : null; }
  saveResumeResult(channelId: string, idempotencyKey: string, ownerId: string, token: string, result: readonly import("../lifecycle/suspend-resume.js").MemberResumeOutcome[]): boolean { const current = this.resumeAttemptCurrent(channelId, idempotencyKey, ownerId, token); if (!current) return false; this.db.prepare("INSERT OR REPLACE INTO resume_results(channel_id, idempotency_key, result_json) VALUES (?, ?, ?)").run(channelId, idempotencyKey, JSON.stringify(result)); return true; }
  recordResumeLaunch(record: { channelId: string; priorSessionId: string; sessionId: string; runtimeId: string; generation: number; role: string | null; provider: unknown }, idempotencyKey: string, ownerId: string, token: string): boolean { if (!this.resumeAttemptCurrent(record.channelId, idempotencyKey, ownerId, token)) return false; const result = this.db.prepare("INSERT OR REPLACE INTO resume_launches(channel_id, prior_session_id, session_id, runtime_id, generation, role, provider_json, provider_phase) VALUES (?, ?, ?, ?, ?, ?, ?, 'launched')").run(record.channelId, record.priorSessionId, record.sessionId, record.runtimeId, record.generation, record.role, record.provider == null ? null : JSON.stringify(record.provider)); return Number(result.changes) === 1; }
  setResumeProviderPhase(channelId: string, priorSessionId: string, generation: number, phase: "provider_resuming" | "provider_resumed", idempotencyKey: string, ownerId: string, token: string): boolean { if (!this.resumeAttemptCurrent(channelId, idempotencyKey, ownerId, token)) return false; const result = this.db.prepare("UPDATE resume_launches SET provider_phase=? WHERE channel_id=? AND prior_session_id=? AND generation=?").run(phase, channelId, priorSessionId, generation); return Number(result.changes) === 1; }
  resumeLaunches(channelId: string, generation: number): readonly import("../lifecycle/suspend-resume.js").ResumeMemberRecord[] { return this.rows("SELECT * FROM resume_launches WHERE channel_id=? AND generation=? ORDER BY prior_session_id", channelId, generation).map(row => ({ channelId, priorSessionId: String(row.prior_session_id), sessionId: String(row.session_id), runtimeId: String(row.runtime_id), generation: Number(row.generation), role: row.role as string | null, provider: row.provider_json == null ? null : JSON.parse(String(row.provider_json)), providerPhase: row.provider_phase as "launched" | "provider_resuming" | "provider_resumed" })); }
  clearResumeLaunches(channelId: string, generation: number, idempotencyKey: string, ownerId: string, token: string): boolean { if (!this.resumeAttemptCurrent(channelId, idempotencyKey, ownerId, token)) return false; this.db.prepare("DELETE FROM resume_launches WHERE channel_id=? AND generation=?").run(channelId, generation); return true; }
  markResumed(channelId: string, idempotencyKey: string, ownerId: string, token: string): boolean { const result = this.db.prepare("UPDATE channel_blueprints SET state='active', resume_owner_id=NULL, resume_lease_until=NULL, updated_at=? WHERE channel_id=? AND state='resuming' AND resume_key=? AND resume_owner_id=? AND (resume_owner_id || ':' || resume_key || ':' || resume_epoch)=? AND resume_lease_until IS NOT NULL AND resume_lease_until>?").run(now(), channelId, idempotencyKey, ownerId, token, now()); return Number(result.changes) === 1; }
  markActive(channelId: string, idempotencyKey: string, ownerId: string, token: string): boolean { return this.markResumed(channelId, idempotencyKey, ownerId, token); }
  installResumedMember(record: { channelId: string; priorSessionId: string; sessionId: string; runtimeId: string; generation: number; role: string | null; provider: unknown }, idempotencyKey: string, ownerId: string, token: string): boolean {
    if (!this.resumeAttemptCurrent(record.channelId, idempotencyKey, ownerId, token)) return false;
    this.db.prepare("INSERT INTO resumed_members(channel_id, prior_session_id, session_id, runtime_id, generation, role, provider_json) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(channel_id, prior_session_id) DO UPDATE SET session_id=excluded.session_id, runtime_id=excluded.runtime_id, generation=excluded.generation, role=excluded.role, provider_json=excluded.provider_json").run(record.channelId, record.priorSessionId, record.sessionId, record.runtimeId, record.generation, record.role, record.provider == null ? null : JSON.stringify(record.provider));
    return true;
  }
  rollbackResumedMembers(channelId: string, generation: number, idempotencyKey: string, ownerId: string, token: string): boolean {
    if (!this.resumeAttemptCurrent(channelId, idempotencyKey, ownerId, token)) return false;
    const rows = this.rows("SELECT session_id FROM resumed_members WHERE channel_id=? AND generation=?", channelId, generation);
    for (const row of rows) {
      void row;
    }
    this.db.prepare("DELETE FROM resumed_members WHERE channel_id=? AND generation=?").run(channelId, generation);
    return true;
  }
  releaseResume(channelId: string, idempotencyKey: string, ownerId: string, token: string): void { this.db.prepare("UPDATE channel_blueprints SET state='suspended', resume_key=NULL, resume_owner_id=NULL, resume_lease_until=NULL, updated_at=? WHERE channel_id=? AND resume_key=? AND resume_owner_id=? AND state='resuming' AND (resume_owner_id || ':' || resume_key || ':' || resume_epoch)=? AND resume_lease_until IS NOT NULL AND resume_lease_until>?").run(now(), channelId, idempotencyKey, ownerId, token, now()); }
  queue(channelId: string, delivery: QueuedCanonicalDelivery): void {
    const cursor = BigInt(delivery.cursor);
    this.db.prepare("INSERT OR IGNORE INTO queued_deliveries(channel_id, delivery_id, cursor, payload) VALUES (?, ?, ?, ?)").run(channelId, delivery.deliveryId, cursor, JSON.stringify(delivery.event));
  }
  pendingAfter(channelId: string, cursor: string, priorSessionId: string, idempotencyKey: string, ownerId: string, token: string): readonly QueuedCanonicalDelivery[] {
    if (!this.resumeAttemptCurrent(channelId, idempotencyKey, ownerId, token)) return [];
    const statement = this.db.prepare("SELECT q.delivery_id, q.cursor, q.payload FROM queued_deliveries q WHERE q.channel_id=? AND q.cursor>? AND NOT EXISTS (SELECT 1 FROM delivery_acknowledgements a WHERE a.channel_id=q.channel_id AND a.prior_session_id=? AND a.delivery_id=q.delivery_id) ORDER BY q.cursor, q.delivery_id");
    statement.setReadBigInts(true);
    const rows = statement.all(channelId, BigInt(cursor), priorSessionId) as Row[];
    return rows.map(row => ({ deliveryId: String(row.delivery_id), channelId, cursor: String(row.cursor), event: JSON.parse(String(row.payload)) }));
  }
  acknowledge(channelId: string, priorSessionId: string, deliveryId: string, idempotencyKey: string, ownerId: string, token: string): boolean { if (!this.resumeAttemptCurrent(channelId, idempotencyKey, ownerId, token)) return false; const result = this.db.prepare("INSERT OR IGNORE INTO delivery_acknowledgements(channel_id, prior_session_id, delivery_id, acknowledged_at) VALUES (?, ?, ?, ?)").run(channelId, priorSessionId, deliveryId, now()); return Number(result.changes) === 1; }
  status(channelId: string): unknown {
    const state = this.one("SELECT state, generation, idempotency_key FROM channel_blueprints WHERE channel_id=?", channelId);
    const members = this.rows("SELECT prior_session_id, session_id, runtime_id, generation, role FROM resumed_members WHERE channel_id=? ORDER BY prior_session_id", channelId).map(row => ({ priorSessionId: String(row.prior_session_id), sessionId: String(row.session_id), runtimeId: String(row.runtime_id), generation: Number(row.generation), role: row.role as string | null }));
    return { channelId, state: state?.state ?? "absent", generation: state?.generation ?? 0, hasBlueprint: Boolean(state), members };
  }

  private resumeAttemptCurrent(channelId: string, idempotencyKey: string, ownerId: string, token: string): boolean { return Boolean(this.one("SELECT 1 FROM channel_blueprints WHERE channel_id=? AND state='resuming' AND resume_key=? AND resume_owner_id=? AND (resume_owner_id || ':' || resume_key || ':' || resume_epoch)=? AND resume_lease_until IS NOT NULL AND resume_lease_until>?", channelId, idempotencyKey, ownerId, token, now())); }
  private one(sql: string, ...params: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...params) as Row | undefined; }
  private rows(sql: string, ...params: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...params) as Row[]; }
}

export class SQLiteRuntimeOwnershipStore implements RuntimeOwnershipStore {
  constructor(private readonly db: DatabaseSync) {}
  read(priorSessionId: string, generation: number) { const row = this.db.prepare("SELECT runtime_id, pid, start_identity FROM runtime_ownership WHERE prior_session_id=? AND generation=?").get(priorSessionId, generation) as Row | undefined; return row ? { runtimeId: String(row.runtime_id), pid: Number(row.pid), startIdentity: String(row.start_identity) } : null; }
  readByRuntime(runtimeId: string) { const row = this.db.prepare("SELECT prior_session_id, generation, runtime_id, pid, start_identity FROM runtime_ownership WHERE runtime_id=?").get(runtimeId) as Row | undefined; return row ? { priorSessionId: String(row.prior_session_id), generation: Number(row.generation), runtimeId: String(row.runtime_id), pid: Number(row.pid), startIdentity: String(row.start_identity) } : null; }
  claim(priorSessionId: string, generation: number, runtimeId: string) { let claimed = false; this.transaction(() => { const result = this.db.prepare("INSERT OR IGNORE INTO runtime_ownership(prior_session_id, generation, runtime_id, pid, start_identity, updated_at) VALUES (?, ?, ?, 0, '', datetime('now'))").run(priorSessionId, generation, runtimeId); claimed = Number(result.changes) === 1; }); return claimed; }
  write(priorSessionId: string, generation: number, value: { runtimeId: string; pid: number; startIdentity: string }) { this.transaction(() => { const result = this.db.prepare("UPDATE runtime_ownership SET pid=?, start_identity=?, updated_at=datetime('now') WHERE prior_session_id=? AND generation=? AND runtime_id=?").run(value.pid, value.startIdentity, priorSessionId, generation, value.runtimeId); if (Number(result.changes) !== 1) throw new Error("runtime ownership claim lost"); }); }
  remove(priorSessionId: string, generation: number, runtimeId?: string) { this.transaction(() => { const result = runtimeId == null ? this.db.prepare("DELETE FROM runtime_ownership WHERE prior_session_id=? AND generation=?").run(priorSessionId, generation) : this.db.prepare("DELETE FROM runtime_ownership WHERE prior_session_id=? AND generation=? AND runtime_id=?").run(priorSessionId, generation, runtimeId); if (runtimeId != null && Number(result.changes) === 0) throw new Error("runtime ownership claim lost"); }); }
  private transaction(operation: () => void) { this.db.exec("BEGIN IMMEDIATE"); try { operation(); this.db.exec("COMMIT"); } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
}

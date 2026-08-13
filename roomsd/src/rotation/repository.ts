// SPDX-License-Identifier: Apache-2.0
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { RotationAudit, RotationRole, RotationRuntime, RotationStore } from "./contracts.js";

type Row = Record<string, unknown>;

export class SQLiteRotationRepository implements RotationStore {
  constructor(private readonly db: DatabaseSync, private readonly runtimeInspector: (channelId: string, sessionId: string) => RotationRuntime | null) {}

  inspect(channelId: string, sessionId: string): RotationRuntime | null { return this.runtimeInspector(channelId, sessionId); }
  actorRole(channelId: string, sessionId: string): RotationRole | null {
    const row = this.db.prepare(`SELECT m.role FROM memberships m JOIN sessions s ON s.id=m.session_id
      WHERE m.channel_id=? AND m.session_id=? AND m.left_at IS NULL AND m.session_ended_at IS NULL AND s.ended_at IS NULL
      ORDER BY m.joined_at DESC LIMIT 1`).get(channelId, sessionId) as Row | undefined;
    return row ? String(row.role) as RotationRole : null;
  }
  insert(audit: RotationAudit): void {
    this.db.prepare(`INSERT INTO agent_rotations(rotation_id,channel_id,old_session_id,replacement_session_id,actor_session_id,nonce,state,reason,old_runtime_id,old_generation,replacement_runtime_id,replacement_generation,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values(audit));
  }
  get(rotationId: string): RotationAudit | null {
    const row = this.db.prepare("SELECT * FROM agent_rotations WHERE rotation_id=?").get(rotationId) as Row | undefined;
    return row ? fromRow(row) : null;
  }
  update(rotationId: string, patch: Partial<RotationAudit>): RotationAudit {
    const current = this.get(rotationId); if (!current) throw new Error("rotationNotFound");
    const next = { ...current, ...patch, rotationId };
    this.db.prepare(`UPDATE agent_rotations SET channel_id=?,old_session_id=?,replacement_session_id=?,actor_session_id=?,nonce=?,state=?,reason=?,old_runtime_id=?,old_generation=?,replacement_runtime_id=?,replacement_generation=?,created_at=?,updated_at=? WHERE rotation_id=?`).run(...values(next).slice(1), rotationId);
    return this.get(rotationId)!;
  }
  swapWorker(input: { channelId: string; oldSessionId: string; replacementSessionId: string; expectedOldGeneration: number; actorSessionId: string }): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.runtimeInspector(input.channelId, input.oldSessionId);
      if (!old || old.generation !== input.expectedOldGeneration) throw new Error("rotationTargetChanged");
      const at = new Date().toISOString();
      const left = this.db.prepare("UPDATE memberships SET left_at=? WHERE channel_id=? AND session_id=? AND left_at IS NULL AND session_ended_at IS NULL").run(at, input.channelId, input.oldSessionId);
      if (Number(left.changes) !== 1) throw new Error("rotationTargetChanged");
      this.db.prepare("INSERT INTO memberships(channel_id,session_id,joined_at,role) VALUES (?,?,?,'worker')").run(input.channelId, input.replacementSessionId, at);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}

function values(a: RotationAudit): SQLInputValue[] { return [a.rotationId,a.channelId,a.oldSessionId,a.replacementSessionId,a.actorSessionId,a.nonce,a.state,a.reason,a.oldRuntimeId,a.oldGeneration,a.replacementRuntimeId,a.replacementGeneration,a.createdAt,a.updatedAt]; }
function fromRow(r: Row): RotationAudit { return { rotationId:String(r.rotation_id),channelId:String(r.channel_id),oldSessionId:String(r.old_session_id),replacementSessionId:r.replacement_session_id==null?null:String(r.replacement_session_id),actorSessionId:String(r.actor_session_id),nonce:String(r.nonce),state:String(r.state) as RotationAudit["state"],reason:r.reason==null?null:String(r.reason),oldRuntimeId:String(r.old_runtime_id),oldGeneration:Number(r.old_generation),replacementRuntimeId:r.replacement_runtime_id==null?null:String(r.replacement_runtime_id),replacementGeneration:r.replacement_generation==null?null:Number(r.replacement_generation),createdAt:String(r.created_at),updatedAt:String(r.updated_at) }; }

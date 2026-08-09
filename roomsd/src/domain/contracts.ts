export type SessionRole = "operator" | "planner" | "worker" | "reviewer";
export type WorkUnitState = "active" | "blocked" | "waitingReview" | "completed" | "approved" | "handedOff" | "cancelled";
export type Cursor = string & { readonly __roomsCursor: unique symbol };
export const CursorCodec = {
  zero: (): Cursor => "0" as Cursor,
  encode: (value: bigint): Cursor => { if (value < 0n) throw new Error("negative cursor"); return value.toString() as Cursor; },
  decode: (value: Cursor | string): bigint => { if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("invalid cursor"); return BigInt(value); }
};
export interface Session { id: string; registeredAt: string; endedAt: string | null; displayName: string | null; role: SessionRole | null; providerThreadId: string | null }
export interface Channel { id: string; label: string | null; registeredAt: string; ownerOperatorSessionId: string | null; lifecycleState: "active" | "closed"; closedAt: string | null }
export interface Membership { channelId: string; sessionId: string; joinedAt: string; leftAt: string | null; sessionEndedAt: string | null; role: SessionRole | null }
export interface Change { cursor: Cursor; kind: string; payload: unknown; channelId: string | null; occurredAt: string }
export interface Snapshot { cursor: Cursor; channel: Channel; sessions: Session[]; memberships: Membership[]; events: unknown[] }
export interface MutationReceipt { cursor: Cursor; didAppend: boolean; changes: Change[] }
export interface CanonicalImportEvent { kind: string; channelId: string | null; payload: unknown; occurredAt: string; sourceOrdinal: number }
export interface ImportSink { begin(sourceDigest: string, sourceVersion: number): void; append(event: CanonicalImportEvent): void; commit(): void; rollback(): void }
export class RoomsCommandError extends Error { constructor(public readonly code: string, message = code) { super(message); this.name = "RoomsCommandError"; } }

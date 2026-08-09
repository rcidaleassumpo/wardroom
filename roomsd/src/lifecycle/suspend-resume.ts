import type { AllowlistedLaunchConfig, LayoutMetadata, MemberIntent, ProviderConversationRef, ResumableChannelBlueprint, ResumableMemberBlueprint } from "../blueprints/resumable.js";
import { cloneBlueprint, validateBlueprint } from "../blueprints/resumable.js";

export interface QueuedCanonicalDelivery { deliveryId: string; channelId: string; cursor: string; event: unknown }
export interface TeardownFence { token: string; assertCurrent(): Promise<void> }
export interface RuntimeGenerationPort {
  launch(input: { channelId: string; priorSessionId: string; generation: number; launch: AllowlistedLaunchConfig; layout: LayoutMetadata; adapterKind: string }): Promise<{ sessionId: string; runtimeId: string }>;
  stop(input: { sessionId: string; runtimeId: string; fence: TeardownFence }): Promise<void>;
  stopGeneration(input: { priorSessionId: string; generation: number; fence: TeardownFence }): Promise<void>;
}
export interface ProviderConversationPort {
  stop(ref: ProviderConversationRef, fence: TeardownFence): Promise<void>;
  stopRollback(ref: ProviderConversationRef, fence: TeardownFence): Promise<void>;
  resume(ref: ProviderConversationRef, generation: number): Promise<void>;
  /** Cheap, side-effect-free validation performed before a replacement runtime is created. */
  validateResume?(ref: ProviderConversationRef): Promise<void> | void;
}
export interface CanonicalDeliveryPort { deliver(delivery: QueuedCanonicalDelivery, sessionIds: readonly string[]): Promise<boolean> }
export interface CanonicalMemberReattachmentPort {
  reattachMembers(input: readonly { channelId: string; priorSessionId: string; sessionId: string; runtimeId: string; generation: number; role: string | null; intent: MemberIntent; provider: ProviderConversationRef | null }[], fence: TeardownFence): Promise<void>;
  rollbackGeneration(channelId: string, generation: number, fence: TeardownFence): Promise<void>;
}
export interface ResumeMemberRecord { channelId: string; priorSessionId: string; sessionId: string; runtimeId: string; generation: number; role: string | null; provider: ProviderConversationRef | null; providerPhase?: "launched" | "provider_resuming" | "provider_resumed" }

function resumeLaunch(member: ResumableMemberBlueprint): AllowlistedLaunchConfig {
  const descriptor = member.provider?.resumeDescriptor as { provider?: string } | null;
  if (member.provider && descriptor?.provider === "claude") return { executable: "claude", args: ["--resume", member.provider.conversationId], cwd: member.launch.cwd };
  return member.launch;
}

/** Durable authority seam. Implementations must serialize transaction callbacks. */
export interface BlueprintStore {
  transaction<T>(operation: () => T): T;
  read(channelId: string): ResumableChannelBlueprint | null;
  capture(channelId: string, blueprint: ResumableChannelBlueprint, ownerId: string): boolean;
  claimSuspend(channelId: string, idempotencyKey: string, blueprint: ResumableChannelBlueprint, ownerId: string): boolean;
  renewSuspend(channelId: string, idempotencyKey: string, ownerId: string): boolean;
  currentSuspendFenceToken(channelId: string, idempotencyKey: string, ownerId: string): string | null;
  verifySuspendFenceToken(channelId: string, idempotencyKey: string, ownerId: string, token: string): boolean;
  verifyFenceToken(token: string): boolean;
  suspendLeaseHeartbeatMs?(): number;
  releaseSuspend(channelId: string, idempotencyKey: string, ownerId: string): boolean;
  suspensionComplete(channelId: string): boolean;
  memberStopped(channelId: string, priorSessionId: string): boolean;
  suspendIdempotencyKey(channelId: string): string | null;
  markSuspending(channelId: string, idempotencyKey: string, ownerId: string): boolean;
  recordMemberOutcome(channelId: string, priorSessionId: string, outcome: "stopped" | "failed", ownerId: string, error?: string): boolean;
  markSuspended(channelId: string, idempotencyKey: string, ownerId: string): boolean;
  claimResume(channelId: string, idempotencyKey: string, generation: number, ownerId: string): boolean;
  currentResumeFenceToken(channelId: string, idempotencyKey: string, ownerId: string): string | null;
  renewResume(channelId: string, idempotencyKey: string, ownerId: string, token: string): boolean;
  resumeResult(channelId: string, idempotencyKey: string): readonly MemberResumeOutcome[] | null;
  saveResumeResult(channelId: string, idempotencyKey: string, ownerId: string, token: string, result: readonly MemberResumeOutcome[]): boolean;
  recordResumeLaunch(record: ResumeMemberRecord, idempotencyKey: string, ownerId: string, token: string): boolean;
  setResumeProviderPhase(channelId: string, priorSessionId: string, generation: number, phase: "provider_resuming" | "provider_resumed", idempotencyKey: string, ownerId: string, token: string): boolean;
  resumeLaunches(channelId: string, generation: number): readonly ResumeMemberRecord[];
  clearResumeLaunches(channelId: string, generation: number, idempotencyKey: string, ownerId: string, token: string): boolean;
  installResumedMember(record: ResumeMemberRecord, idempotencyKey: string, ownerId: string, token: string): boolean;
  rollbackResumedMembers(channelId: string, generation: number, idempotencyKey: string, ownerId: string, token: string): boolean;
  markActive(channelId: string, idempotencyKey: string, ownerId: string, token: string): boolean;
  releaseResume(channelId: string, idempotencyKey: string, ownerId: string, token: string): void;
  queue(channelId: string, delivery: QueuedCanonicalDelivery): void;
  pendingAfter(channelId: string, cursor: string, priorSessionId: string, idempotencyKey: string, ownerId: string, token: string): readonly QueuedCanonicalDelivery[];
  acknowledge(channelId: string, priorSessionId: string, deliveryId: string, idempotencyKey: string, ownerId: string, token: string): boolean;
  status(channelId: string): unknown;
}

export interface MemberResumeOutcome { priorSessionId: string; sessionId: string | null; runtimeId: string | null; generation: number; outcome: "resumed" | "failed" | "rolledBack"; error?: string }

export class DurableChannelLifecycle {
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(private readonly store: BlueprintStore, private readonly runtime: RuntimeGenerationPort, private readonly provider: ProviderConversationPort, private readonly delivery: CanonicalDeliveryPort, private readonly canonical: CanonicalMemberReattachmentPort, private readonly ownerId = `rooms-owner-${Math.random().toString(16).slice(2)}`) {}

  suspend(channelId: string, idempotencyKey: string, blueprint: ResumableChannelBlueprint): Promise<ResumableChannelBlueprint> {
    return this.serial(channelId, async () => {
      validateBlueprint(blueprint);
      const existing = this.store.read(channelId);
      const existingSuspendKey = this.store.suspendIdempotencyKey(channelId);
      if (existingSuspendKey !== null && existingSuspendKey !== idempotencyKey) throw new Error("suspend idempotency key mismatch");
      if (existingSuspendKey !== null && existing && JSON.stringify(existing) !== JSON.stringify(blueprint)) throw new Error("suspend blueprint mismatch");
      if (existingSuspendKey === idempotencyKey && existing && this.store.suspensionComplete(channelId)) return cloneBlueprint(existing);
      if (!this.store.transaction(() => this.store.claimSuspend(channelId, idempotencyKey, blueprint, this.ownerId))) throw new Error("suspend claim is owned by another coordinator");
      if (!this.store.transaction(() => this.store.capture(channelId, cloneBlueprint(blueprint), this.ownerId))) throw new Error("suspend lease lost");
      for (const member of blueprint.members) {
        if (this.store.transaction(() => this.store.memberStopped(channelId, member.priorSessionId))) continue;
        try {
          if (!this.store.transaction(() => this.store.renewSuspend(channelId, idempotencyKey, this.ownerId))) throw new Error("suspend lease lost");
          await this.withSuspendLease(channelId, idempotencyKey, async () => {
            const fence = this.teardownFence(channelId, idempotencyKey);
            await fence.assertCurrent();
            await this.runtime.stopGeneration({ priorSessionId: member.priorSessionId, generation: member.processGeneration, fence });
          });
          if (member.provider) {
            // A takeover may complete while the external runtime stop was in flight.
            // Re-fence before touching the provider conversation.
            await this.withSuspendLease(channelId, idempotencyKey, async () => {
              const fence = this.teardownFence(channelId, idempotencyKey);
              await fence.assertCurrent();
              await this.provider.stop(member.provider!, fence);
            });
          }
          if (!this.store.transaction(() => this.store.recordMemberOutcome(channelId, member.priorSessionId, "stopped", this.ownerId))) throw new Error("suspend lease lost");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.store.transaction(() => { this.store.recordMemberOutcome(channelId, member.priorSessionId, "failed", this.ownerId, message); this.store.releaseSuspend(channelId, idempotencyKey, this.ownerId); });
          throw error;
        }
      }
      if (!this.store.transaction(() => this.store.markSuspended(channelId, idempotencyKey, this.ownerId))) throw new Error("suspend lease lost");
      return cloneBlueprint(this.store.read(channelId) ?? blueprint);
    });
  }

  resume(channelId: string, idempotencyKey: string, generation: number): Promise<readonly MemberResumeOutcome[]> {
    return this.serial(channelId, async () => {
      const blueprint = this.store.read(channelId);
      if (!blueprint) throw new Error("missing resumable blueprint");
      validateBlueprint(blueprint);
      if (!this.store.transaction(() => this.store.claimResume(channelId, idempotencyKey, generation, this.ownerId))) {
        const completed = this.store.resumeResult(channelId, idempotencyKey);
        if (completed) return completed;
        throw new Error("resume is in progress");
      }
      const resumeToken = this.store.transaction(() => this.store.currentResumeFenceToken(channelId, idempotencyKey, this.ownerId));
      if (!resumeToken) throw new Error("resume lease lost");
      const abandoned = this.store.transaction(() => this.store.resumeLaunches(channelId, generation));
      for (const item of abandoned) {
        if (item.providerPhase === "provider_resuming") throw new Error("resume recovery is ambiguous at provider boundary");
        await this.withResumeLease(channelId, idempotencyKey, resumeToken, async () => {
          await this.runtime.stop({ sessionId: item.sessionId, runtimeId: item.runtimeId, fence: this.resumeFence(channelId, idempotencyKey, resumeToken) });
          if (item.provider && item.providerPhase === "provider_resumed") await this.provider.stopRollback(item.provider, this.resumeFence(channelId, idempotencyKey, resumeToken));
        });
      }
      if (abandoned.length > 0) {
        await this.withResumeLease(channelId, idempotencyKey, resumeToken, async () => this.canonical.rollbackGeneration(channelId, generation, this.resumeFence(channelId, idempotencyKey, resumeToken)));
        this.store.transaction(() => {
        if (!this.store.rollbackResumedMembers(channelId, generation, idempotencyKey, this.ownerId, resumeToken)) throw new Error("resume lease lost");
        if (!this.store.clearResumeLaunches(channelId, generation, idempotencyKey, this.ownerId, resumeToken)) throw new Error("resume lease lost");
        });
      }
      // A launcher can crash after the durable runtime claim but before its
      // resumeLaunches row is written. Reconcile that claim on takeover.
      for (const member of blueprint.members) {
        try {
          await this.withResumeLease(channelId, idempotencyKey, resumeToken, () => this.runtime.stopGeneration({ priorSessionId: member.priorSessionId, generation, fence: this.resumeFence(channelId, idempotencyKey, resumeToken) }));
        } catch (error) {
          if (!(error instanceof Error) || !/durably proven|not owned/.test(error.message)) throw error;
        }
      }
      const launched: Array<ResumeMemberRecord & { outcome: MemberResumeOutcome }> = [];
      try {
        for (const member of blueprint.members) {
          if (member.provider && this.provider.validateResume) await this.provider.validateResume(member.provider);
          const fresh = await this.withResumeLease(channelId, idempotencyKey, resumeToken, () => this.runtime.launch({ channelId, priorSessionId: member.priorSessionId, generation, launch: resumeLaunch(member), layout: member.layout, adapterKind: member.adapterKind }));
          const record = { channelId, priorSessionId: member.priorSessionId, sessionId: fresh.sessionId, runtimeId: fresh.runtimeId, generation, role: member.role, provider: member.provider, outcome: { priorSessionId: member.priorSessionId, sessionId: fresh.sessionId, runtimeId: fresh.runtimeId, generation, outcome: "resumed" as const } };
          launched.push(record);
          if (!this.store.transaction(() => this.store.recordResumeLaunch(record, idempotencyKey, this.ownerId, resumeToken))) throw new Error("resume lease lost");
          if (member.provider) {
            if (!this.store.transaction(() => this.store.setResumeProviderPhase(channelId, member.priorSessionId, generation, "provider_resuming", idempotencyKey, this.ownerId, resumeToken))) throw new Error("resume lease lost");
            const providerName = (member.provider!.resumeDescriptor as { provider?: string } | null)?.provider;
            if (providerName !== "claude") await this.withResumeLease(channelId, idempotencyKey, resumeToken, () => this.provider.resume(member.provider!, generation));
            if (!this.store.transaction(() => this.store.setResumeProviderPhase(channelId, member.priorSessionId, generation, "provider_resumed", idempotencyKey, this.ownerId, resumeToken))) throw new Error("resume lease lost");
          }
        }
        this.store.transaction(() => { for (const record of launched) if (!this.store.installResumedMember(record, idempotencyKey, this.ownerId, resumeToken)) throw new Error("resume lease lost"); });
        await this.withResumeLease(channelId, idempotencyKey, resumeToken, async () => this.canonical.reattachMembers(launched.map(record => ({ ...record, intent: blueprint.members.find(member => member.priorSessionId === record.priorSessionId)!.intent })), this.resumeFence(channelId, idempotencyKey, resumeToken)));
        for (const member of blueprint.members) {
          const queued = this.store.transaction(() => this.store.pendingAfter(channelId, member.lastAcknowledgedDeliveryCursor, member.priorSessionId, idempotencyKey, this.ownerId, resumeToken));
          for (const delivery of queued) {
            await this.withResumeLease(channelId, idempotencyKey, resumeToken, async () => {
              const recipientAcknowledged = await this.delivery.deliver(delivery, launched.filter(item => item.priorSessionId === member.priorSessionId).map(item => item.sessionId));
              if (recipientAcknowledged !== true) throw new Error("recipient did not acknowledge delivery");
              if (!this.store.transaction(() => this.store.acknowledge(channelId, member.priorSessionId, delivery.deliveryId, idempotencyKey, this.ownerId, resumeToken))) throw new Error("resume lease lost");
            });
          }
        }
        const result = launched.map(item => item.outcome);
        this.store.transaction(() => {
          if (!this.store.clearResumeLaunches(channelId, generation, idempotencyKey, this.ownerId, resumeToken)) throw new Error("resume lease lost");
          if (!this.store.saveResumeResult(channelId, idempotencyKey, this.ownerId, resumeToken, result)) throw new Error("resume lease lost");
          if (!this.store.markActive(channelId, idempotencyKey, this.ownerId, resumeToken)) throw new Error("resume lease lost");
        });
        return result;
      } catch (error) {
        let teardownOk = true;
        const durableLaunches = this.store.transaction(() => this.store.resumeLaunches(channelId, generation));
        const ambiguousProviderBoundary = durableLaunches.some(item => item.providerPhase === "provider_resuming");
        for (const item of launched.reverse()) {
          const durable = durableLaunches.find(candidate => candidate.priorSessionId === item.priorSessionId);
          try { await this.withResumeLease(channelId, idempotencyKey, resumeToken, () => this.runtime.stop({ sessionId: item.sessionId, runtimeId: item.runtimeId, fence: this.resumeFence(channelId, idempotencyKey, resumeToken) })); } catch { teardownOk = false; }
          if (item.provider && durable?.providerPhase === "provider_resumed") {
            try { await this.withResumeLease(channelId, idempotencyKey, resumeToken, () => this.provider.stopRollback(item.provider!, this.resumeFence(channelId, idempotencyKey, resumeToken))); } catch { teardownOk = false; }
          }
        }
        if (teardownOk && !ambiguousProviderBoundary) {
          await this.withResumeLease(channelId, idempotencyKey, resumeToken, async () => this.canonical.rollbackGeneration(channelId, generation, this.resumeFence(channelId, idempotencyKey, resumeToken)));
          this.store.transaction(() => {
          if (!this.store.rollbackResumedMembers(channelId, generation, idempotencyKey, this.ownerId, resumeToken)) return;
          if (!this.store.clearResumeLaunches(channelId, generation, idempotencyKey, this.ownerId, resumeToken)) return;
          this.store.releaseResume(channelId, idempotencyKey, this.ownerId, resumeToken);
          });
        }
        throw error;
      }
    });
  }

  status(channelId: string): unknown { return this.store.transaction(() => this.store.status(channelId)); }

  private async withSuspendLease<T>(channelId: string, idempotencyKey: string, operation: () => Promise<T>): Promise<T> {
    const heartbeatMs = Math.max(1, this.store.suspendLeaseHeartbeatMs?.() ?? 10_000);
    if (!this.store.transaction(() => this.store.renewSuspend(channelId, idempotencyKey, this.ownerId))) throw new Error("suspend lease lost");
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      try {
        if (!this.store.transaction(() => this.store.renewSuspend(channelId, idempotencyKey, this.ownerId))) leaseLost = true;
      } catch { leaseLost = true; }
    }, heartbeatMs);
    try {
      const result = await operation();
      if (leaseLost || !this.store.transaction(() => this.store.renewSuspend(channelId, idempotencyKey, this.ownerId))) throw new Error("suspend lease lost");
      return result;
    } finally { clearInterval(heartbeat); }
  }

  private async withResumeLease<T>(channelId: string, idempotencyKey: string, token: string, operation: () => Promise<T>): Promise<T> {
    const heartbeatMs = Math.max(1, this.store.suspendLeaseHeartbeatMs?.() ?? 10_000);
    if (!this.store.transaction(() => this.store.renewResume(channelId, idempotencyKey, this.ownerId, token))) throw new Error("resume lease lost");
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      try { if (!this.store.transaction(() => this.store.renewResume(channelId, idempotencyKey, this.ownerId, token))) leaseLost = true; } catch { leaseLost = true; }
    }, heartbeatMs);
    try {
      const result = await operation();
      if (leaseLost || !this.store.transaction(() => this.store.renewResume(channelId, idempotencyKey, this.ownerId, token))) throw new Error("resume lease lost");
      return result;
    } finally { clearInterval(heartbeat); }
  }

  private teardownFence(channelId: string, idempotencyKey: string): TeardownFence {
    const token = this.store.currentSuspendFenceToken(channelId, idempotencyKey, this.ownerId);
    if (!token) throw new Error("suspend lease lost");
    return { token, assertCurrent: async () => {
      if (!this.store.transaction(() => this.store.renewSuspend(channelId, idempotencyKey, this.ownerId))) throw new Error("suspend lease lost");
    } };
  }

  private resumeFence(channelId: string, idempotencyKey: string, token: string): TeardownFence {
    return { token, assertCurrent: async () => {
      if (!this.store.transaction(() => this.store.renewResume(channelId, idempotencyKey, this.ownerId, token))) throw new Error("resume lease lost");
    } };
  }

  private serial<T>(channelId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(channelId) ?? Promise.resolve(); const next = prior.catch(() => undefined).then(operation); this.locks.set(channelId, next);
    return next.finally(() => { if (this.locks.get(channelId) === next) this.locks.delete(channelId); });
  }
}

export type SuspendedMember = { channelId: string; channelName: string; goal: string; sessionId: string; role: string | null; joinedAt: string; processGeneration: number; provider: ProviderConversationRef | null; intent: MemberIntent; launch: AllowlistedLaunchConfig; layout: LayoutMetadata; adapterKind: string; lastAcknowledgedDeliveryCursor: string };
export function memberToBlueprint(member: SuspendedMember): ResumableMemberBlueprint {
  return { channelId: member.channelId, priorSessionId: member.sessionId, intent: member.intent, launch: member.launch, layout: member.layout, adapterKind: member.adapterKind, lastAcknowledgedDeliveryCursor: member.lastAcknowledgedDeliveryCursor, role: member.role, joinedAt: member.joinedAt, processGeneration: member.processGeneration, provider: member.provider };
}

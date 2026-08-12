import { randomUUID } from "node:crypto";
import type { RotationAudit, RotationInspection, RotationRuntime, RotationRuntimeAuthority, RotationStore } from "./contracts.js";

export class RotationError extends Error {
  constructor(readonly code: string) { super(code); }
}

const activeTurn = (runtime: RotationRuntime): boolean =>
  ["thinking", "streaming", "tool", "busy"].includes(runtime.providerTurn.phase ?? "");

export class AgentRotationService {
  constructor(private readonly store: RotationStore, private readonly runtime: RotationRuntimeAuthority, private readonly clock = () => new Date().toISOString()) {}

  inspect(channelId: string, sessionId: string): RotationInspection {
    const target = this.requireWorker(channelId, sessionId);
    return { channelId, ...target, readiness: activeTurn(target) ? "active" : "ready" };
  }

  async prepare(input: { channelId: string; sessionId: string; actorSessionId: string }): Promise<RotationAudit> {
    this.requirePlanner(input.channelId, input.actorSessionId);
    const target = this.requireWorker(input.channelId, input.sessionId);
    if (activeTurn(target)) throw new RotationError("rotationRuntimeActive");
    const at = this.clock();
    const audit: RotationAudit = {
      rotationId: randomUUID(), channelId: input.channelId, oldSessionId: target.sessionId,
      replacementSessionId: null, actorSessionId: input.actorSessionId, nonce: randomUUID(), state: "prepared",
      reason: null, oldRuntimeId: target.runtimeId, oldGeneration: target.generation,
      replacementRuntimeId: null, replacementGeneration: null, createdAt: at, updatedAt: at,
    };
    this.store.insert(audit);
    await this.runtime.sendPrepare({ channelId: input.channelId, sessionId: target.sessionId, nonce: audit.nonce, rotationId: audit.rotationId });
    return audit;
  }

  acknowledge(input: { rotationId: string; sessionId: string; nonce: string }): RotationAudit {
    const audit = this.requireAudit(input.rotationId);
    if (audit.state !== "prepared" || input.sessionId !== audit.oldSessionId || input.nonce !== audit.nonce) throw new RotationError("rotationAcknowledgementInvalid");
    const current = this.requireWorker(audit.channelId, audit.oldSessionId);
    if (current.generation !== audit.oldGeneration || current.runtimeId !== audit.oldRuntimeId || activeTurn(current)) throw new RotationError("rotationTargetChanged");
    return this.store.update(audit.rotationId, { state: "acknowledged", updatedAt: this.clock() });
  }

  async commit(input: { rotationId: string; actorSessionId: string }): Promise<RotationAudit> {
    const audit = this.requireAudit(input.rotationId);
    this.requirePlanner(audit.channelId, input.actorSessionId);
    if (audit.actorSessionId !== input.actorSessionId) throw new RotationError("rotationNotReady");
    if (audit.state === "cleanup_pending") return this.retryCleanup(audit);
    if (audit.state !== "acknowledged") throw new RotationError("rotationNotReady");
    const prior = this.requireWorker(audit.channelId, audit.oldSessionId);
    if (prior.generation !== audit.oldGeneration || prior.runtimeId !== audit.oldRuntimeId || activeTurn(prior)) throw new RotationError("rotationTargetChanged");
    let replacement: RotationRuntime | null = null;
    let swapped = false;
    try {
      const launched = await this.runtime.launchReplacement({ channelId: audit.channelId, prior });
      replacement = await this.runtime.inspectRuntime(launched.runtimeId);
      if (!replacement) throw new RotationError("rotationReplacementUnverified");
      const verified = replacement;
      if (verified.role !== "worker" || verified.state !== "running" || verified.launch.provider !== prior.launch.provider
        || verified.launch.model !== prior.launch.model || verified.launch.reasoning !== prior.launch.reasoning
        || JSON.stringify(verified.launch.launchOptions) !== JSON.stringify(prior.launch.launchOptions)
        || !verified.providerThreadId) throw new RotationError("rotationReplacementUnverified");
      this.store.swapWorker({ channelId: audit.channelId, oldSessionId: audit.oldSessionId, replacementSessionId: verified.sessionId, expectedOldGeneration: audit.oldGeneration, actorSessionId: input.actorSessionId });
      swapped = true;
      const persisted = this.store.update(audit.rotationId, { state: "cleanup_pending", replacementSessionId: verified.sessionId, replacementRuntimeId: verified.runtimeId, replacementGeneration: verified.generation, updatedAt: this.clock() });
      return await this.retryCleanup(persisted);
    } catch (error) {
      if (swapped) throw error;
      if (replacement) await this.runtime.terminate({ runtimeId: replacement.runtimeId, generation: replacement.generation, sessionId: replacement.sessionId }).catch(() => undefined);
      this.store.update(audit.rotationId, { state: "rolled_back", reason: error instanceof Error ? error.message : String(error), updatedAt: this.clock() });
      throw error;
    }
  }

  private async retryCleanup(audit: RotationAudit): Promise<RotationAudit> {
    try {
      await this.runtime.terminate({ runtimeId: audit.oldRuntimeId, generation: audit.oldGeneration, sessionId: audit.oldSessionId });
      return this.store.update(audit.rotationId, { state: "committed", reason: null, updatedAt: this.clock() });
    } catch (error) {
      this.store.update(audit.rotationId, { state: "cleanup_pending", reason: error instanceof Error ? error.message : String(error), updatedAt: this.clock() });
      throw error;
    }
  }

  cancel(input: { rotationId: string; actorSessionId: string; reason: string }): RotationAudit {
    const audit = this.requireAudit(input.rotationId);
    this.requirePlanner(audit.channelId, input.actorSessionId);
    if (!input.reason.trim()) throw new RotationError("rotationCancelReasonRequired");
    if (!["prepared", "acknowledged"].includes(audit.state)) throw new RotationError("rotationCannotCancel");
    return this.store.update(audit.rotationId, { state: "cancelled", reason: input.reason.trim(), updatedAt: this.clock() });
  }

  private requireWorker(channelId: string, sessionId: string): RotationRuntime {
    const target = this.store.inspect(channelId, sessionId);
    if (!target) throw new RotationError("rotationTargetNotFound");
    if (target.role !== "worker") throw new RotationError("rotationWorkerRequired");
    if (target.state !== "running") throw new RotationError("rotationRuntimeNotLive");
    return target;
  }
  private requirePlanner(channelId: string, sessionId: string): void {
    if (this.store.actorRole(channelId, sessionId) !== "planner") throw new RotationError("rotationPlannerRequired");
  }
  private requireAudit(rotationId: string): RotationAudit { const audit = this.store.get(rotationId); if (!audit) throw new RotationError("rotationNotFound"); return audit; }
}

// SPDX-License-Identifier: Apache-2.0
export type RotationRole = "operator" | "planner" | "worker" | "reviewer";
export type ProviderTurnPhase = "idle" | "thinking" | "streaming" | "tool" | "busy" | "ready" | "unsupported" | null;

export interface RotationLaunchConfig {
  provider: string;
  model: string | null;
  reasoning: string | null;
  launchOptions: Readonly<Record<string, unknown>>;
}

export interface RotationRuntime {
  runtimeId: string;
  sessionId: string;
  generation: number;
  state: string;
  providerThreadId: string | null;
  providerTurn: { phase: ProviderTurnPhase; reason: string | null };
  role: RotationRole;
  launch: RotationLaunchConfig;
}

export interface RotationInspection extends RotationRuntime {
  channelId: string;
  readiness: "active" | "ready";
}

export interface RotationAudit {
  rotationId: string;
  channelId: string;
  oldSessionId: string;
  replacementSessionId: string | null;
  actorSessionId: string;
  nonce: string;
  state: "prepared" | "acknowledged" | "committed" | "cleanup_pending" | "cancelled" | "rolled_back";
  reason: string | null;
  oldRuntimeId: string;
  oldGeneration: number;
  replacementRuntimeId: string | null;
  replacementGeneration: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface RotationStore {
  inspect(channelId: string, sessionId: string): RotationRuntime | null;
  actorRole(channelId: string, sessionId: string): RotationRole | null;
  insert(audit: RotationAudit): void;
  get(rotationId: string): RotationAudit | null;
  update(rotationId: string, patch: Partial<RotationAudit>): RotationAudit;
  swapWorker(input: { channelId: string; oldSessionId: string; replacementSessionId: string; expectedOldGeneration: number; actorSessionId: string }): void;
}

export interface RotationRuntimeAuthority {
  sendPrepare(input: { channelId: string; sessionId: string; nonce: string; rotationId: string }): Promise<void>;
  launchReplacement(input: { channelId: string; prior: RotationRuntime }): Promise<RotationRuntime>;
  inspectRuntime(runtimeId: string): Promise<RotationRuntime | null>;
  terminate(input: { runtimeId: string; generation: number; sessionId: string }): Promise<void>;
}

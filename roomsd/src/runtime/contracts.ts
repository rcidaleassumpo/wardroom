// SPDX-License-Identifier: Apache-2.0
import type { Cursor, SessionRole } from "../domain/contracts.js";

export type RuntimeState = "creating" | "running" | "recovering" | "crashed" | "exited" | "terminating" | "terminated";
export type RuntimeTransport = "localPty" | "structured";
export type AttachmentMode = "observe" | "controller";
export type RuntimeAction = "attach" | "observe" | "controller" | "input" | "resize" | "signal" | "terminate" | "deliverMessage";

export interface Runtime {
  runtimeId: string;
  homeAuthorityId: string;
  sessionId: string;
  /** Provider-native conversation/thread identity used for resume. */
  providerThreadId: string | null;
  generation: number;
  protocolVersion: number;
  transportKind: RuntimeTransport;
  state: RuntimeState;
  machineId: string;
  reconnectSecretHash: string;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  exitReason: string | null;
}

export interface RuntimeBinding {
  bindingId: string;
  runtimeId: string;
  homeAuthorityId: string;
  sessionId: string;
  generation: number;
  channelId: string | null;
  adapterKind: string;
  handleRef: string;
  launchPolicyRef: string | null;
  boundAt: string;
  unboundAt: string | null;
}

export interface RuntimeAttachment {
  attachmentId: string;
  runtimeId: string;
  homeAuthorityId: string;
  sessionId: string;
  generation: number;
  viewerId: string;
  mode: AttachmentMode;
  leaseExpiresAt: string | null;
  outputCursor: bigint;
  attachedAt: string;
  detachedAt: string | null;
  lastSeenAt: string | null;
}

export interface RuntimeCapabilityReplay {
  runtimeId: string;
  generation: number;
  capabilityId: string;
  nonceHash: string;
  action: RuntimeAction;
  expiresAt: string;
  consumedAt: string | null;
}

export type RuntimeEventKind =
  | "created" | "ready" | "outputAvailable" | "inputAccepted" | "inputRejected"
  | "resized" | "signaled" | "terminateRequested" | "exited" | "crashed"
  | "recovering" | "controllerAcquired" | "controllerReleased"
  | "attachmentAttached" | "attachmentDetached" | "deliverMessageAccepted"
  | "deliverMessageRejected" | "gap" | "error";

/** Event metadata is deliberately terminal-state neutral and contains no PTY bytes. */
export interface RuntimeEvent {
  runtimeId: string;
  generation: number;
  eventSeq: number;
  eventId: string;
  kind: RuntimeEventKind;
  outputCursor: bigint | null;
  messageId: string | null;
  outcome: string | null;
  payload: Readonly<Record<string, string | number | boolean | null>>;
  occurredAt: string;
}

export interface RuntimeQuota {
  machineId: string;
  maxActiveRuntimes: number;
  maxObserversPerRuntime: number;
  updatedAt: string;
}

export interface RuntimeQuotaStatus extends RuntimeQuota {
  source: "default" | "override";
  activeRuntimes: number;
  availableRuntimes: number;
  runtimeCount: number;
  utilizationPercent: number;
  capacityState: "healthy" | "warning" | "exhausted";
  states: Readonly<Record<RuntimeState, number>>;
}

export interface CreateRuntimeInput {
  runtimeId: string;
  homeAuthorityId: string;
  sessionId: string;
  generation: number;
  protocolVersion: number;
  transportKind: RuntimeTransport;
  machineId: string;
  reconnectSecret: Uint8Array;
  providerThreadId?: string | null;
}

export interface RuntimeActor {
  sessionId: string;
  role: SessionRole;
  credentialId: string;
  /** Server-built scope for a verified federated runtime capability; never accepted from a local request. */
  capability?: Readonly<{
    capabilityId: string;
    runtimeId: string;
    generation: number;
    sessionId: string;
    channelId: string | null;
    actions: readonly RuntimeAction[];
    expiresAt: string;
  }>;
}

export interface BindRuntimeInput {
  bindingId: string;
  runtimeId: string;
  homeAuthorityId: string;
  sessionId: string;
  generation: number;
  channelId?: string | null;
  adapterKind: string;
  handleRef: string;
  launchPolicyRef?: string | null;
}

export interface AttachRuntimeInput {
  attachmentId: string;
  runtimeId: string;
  homeAuthorityId: string;
  sessionId: string;
  generation: number;
  viewerId: string;
  mode: AttachmentMode;
  leaseExpiresAt?: string | null;
  outputCursor?: bigint;
  operatorOverride?: boolean;
  allowRecovery?: boolean;
}

export interface AppendRuntimeEventInput {
  runtimeId: string;
  generation: number;
  kind: RuntimeEventKind;
  outputCursor?: bigint | null;
  messageId?: string | null;
  outcome?: string | null;
  payload?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RuntimeIdentity {
  homeAuthorityId: string;
  sessionId: string;
  runtimeId: string;
  generation: number;
}

export type RuntimeCursor = Cursor;

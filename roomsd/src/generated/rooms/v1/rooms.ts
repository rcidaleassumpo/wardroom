// SPDX-License-Identifier: Apache-2.0
/**
 * TypeScript service surface for Rooms.
 *
 * RoomsProtoService mirrors proto/rooms/v1/rooms.proto. Local runtime control
 * and role mutation are explicit implementation extensions; they are not
 * protobuf RPCs. Transport bindings and serialization stay in their adapters.
 */

export const ROOMS_PROTO_PACKAGE = "rooms.v1" as const;
export const ROOMS_PROTO_VERSION = 1 as const;

export type ChannelLifecycleState = "unspecified" | "active" | "closed";
export type MessageTargetKind = "unspecified" | "here" | "direct" | "sessions" | "legacy_unknown";
export type SearchScopeKind = "unspecified" | "channel" | "all";
export type MessageExpectedHandling = "unspecified" | "complete" | "blocker";
export type MessageTerminalStatus = "unspecified" | "pending" | "completed" | "blocked";
export type LifecycleState = "unspecified" | "running" | "suspending" | "suspended" | "resuming" | "degraded";
export type SuspendReason = "unspecified" | "requested" | "maintenance" | "transport_lost";
export type BlueprintState = "unspecified" | "ready" | "partial" | "failed";
export type DeliveryStatus = "unspecified" | "delivered" | "queued" | "undeliverable";
export type RoomsErrorCode = "unspecified" | "invalid_argument" | "not_found" | "already_exists" | "failed_precondition" | "permission_denied" | "unauthenticated" | "resource_exhausted" | "unavailable" | "unimplemented" | "internal";
export type ThreadLifecycleState = "unspecified" | "open" | "resolved";
export type SessionRole = "operator" | "planner" | "worker" | "reviewer";

export interface Timestamp { seconds: bigint; nanos: number }
export interface RequestContext { protocolVersion: number; credential?: string; requestId?: string }
export interface Channel { id: string; registeredAt?: Timestamp; ownerOperatorSessionId?: string; lifecycleState: ChannelLifecycleState; closedAt?: Timestamp; label?: string; broadcastPolicy?: string }
export interface Session { id: string; registeredAt?: Timestamp; endedAt?: Timestamp; displayName?: string; role?: string; providerThreadId?: string }
export interface Membership { channelId: string; sessionId: string; joinedAt?: Timestamp; role?: string }
export interface MembershipHistory { channelId: string; sessionId: string; joinedAt?: Timestamp; leftAt?: Timestamp; sessionEndedAt?: Timestamp; role?: string }
export interface RosterEntry { sessionId: string; displayName?: string; joinedAt?: Timestamp; role?: string }
export interface Correlation { requestId: string; deduplicationKey: string; purpose: string; replyToEventId?: string; expectedHandling: MessageExpectedHandling; terminalStatus: MessageTerminalStatus; originChannelId?: string; originSessionId: string; targetSessionId?: string }
export interface MessageTarget { kind: MessageTargetKind; sessionId?: string; sessionIds: string[] }
export interface Message { id: string; channelId?: string; senderSessionId: string; body: string; target?: MessageTarget; deliveredRecipientSessionIds: string[]; correlation?: Correlation; occurredAt?: Timestamp; senderRole?: string; recipientStatuses: Record<string, DeliveryStatus>; replyToEventId?: string | null; threadRootEventId?: string | null }
export interface RoomsError { code: RoomsErrorCode; message: string; domainCode?: string }
export interface Recipient { eventId: string; sessionId: string; deliveredAt?: Timestamp }
export interface Change { channelId: string; eventId?: string; event?: Message; control?: ControlEvent; channel?: Channel; membershipHistory: MembershipHistory[]; sessions: Session[]; notificationId?: string; cursor?: string }
export interface ControlEvent { id: string; channelId: string; senderSessionId: string; kind: string; payload: unknown; requestId: string; occurredAt?: Timestamp }
export interface Snapshot { channel?: Channel; roster: RosterEntry[]; sessions: Session[]; memberships: Membership[]; membershipHistory: MembershipHistory[]; cursor?: string }

export interface CreateChannelRequest { context?: RequestContext; channelName: string; ownerOperatorSessionId: string; registrarSessionId?: string }
export interface ShowChannelRequest { context?: RequestContext; channelId: string }
export interface ListChannelsRequest { context?: RequestContext }
export interface UpdateChannelLabelRequest { context?: RequestContext; channelId: string; label?: string }
export interface UpdateChannelBroadcastPolicyRequest { context?: RequestContext; channelId: string; broadcastPolicy: string }
export interface CloseChannelRequest { context?: RequestContext; channelId: string; authorizedBySessionId: string }
export interface RegisterSessionRequest { context?: RequestContext; sessionId: string; displayName?: string; role?: string; registrarSessionId?: string }
export interface JoinRequest { context?: RequestContext; channelId: string; sessionId: string; authorizedBySessionId?: string }
export interface LeaveRequest { context?: RequestContext; channelId: string; sessionId: string }
export interface EndSessionRequest { context?: RequestContext; sessionId: string }
export interface UpdateSessionRoleRequest { context?: RequestContext; channelId: string; sessionId: string; role: Exclude<SessionRole, "operator"> }
export interface CommitControlRequest { context?: RequestContext; channelId: string; senderSessionId: string; kind: string; payload: unknown; requestId: string }
export interface GetControlsRequest { context?: RequestContext; channelId: string; afterCursor?: string; limit?: number }
export interface ReplaceSessionRequest { context?: RequestContext; channelId: string; sessionId: string; replacementSessionId: string; authorizedBySessionId: string; reason?: string }
export interface SendRequest { context?: RequestContext; channelId?: string; body: string; target: MessageTarget; correlation?: Correlation; replyToEventId?: string | null }
export interface AuthenticateRequest { context?: RequestContext; credential: string }
export interface IssueCredentialRequest { context?: RequestContext; sessionId: string }
export interface GetSessionsRequest { context?: RequestContext }
export interface GetRosterRequest { context?: RequestContext; channelId: string }
export interface GetMembershipHistoryRequest { context?: RequestContext; channelId: string }
export interface GetSnapshotRequest { context?: RequestContext; channelId: string }
export interface GetEventsRequest { context?: RequestContext; channelId?: string; afterCursor?: string; afterEventId?: string; sessionId?: string; limit?: number; eventId?: string; replyToEventId?: string }
export interface GetThreadLifecycleRequest { context?: RequestContext; threadRootEventId: string; channelId?: string }
export interface ThreadLifecycleMutationRequest { context?: RequestContext; threadRootEventId: string; channelId?: string }
export interface SearchRequest { context?: RequestContext; query: string; scope: SearchScopeKind; channelId?: string; limit: number }
export interface GetRecipientsRequest { context?: RequestContext; eventId: string }
export interface WatchRequest { context?: RequestContext; channelId: string; afterCursor?: string; acknowledgedCursor?: string }
export interface StatusRequest { context?: RequestContext }
export interface SuspendRequest { context?: RequestContext; channelId: string; reason: SuspendReason; detail?: string }
export interface ResumeRequest { context?: RequestContext; channelName: string; blueprintReference?: string; idempotencyKey: string; conversationReferences: string[] }

export type RuntimeState = "creating" | "running" | "recovering" | "crashed" | "exited" | "terminating" | "terminated";
export type RuntimeAttachmentMode = "observe" | "controller";
export interface RuntimeRecord { runtimeId: string; homeAuthorityId: string; sessionId: string; generation: number; protocolVersion: number; transportKind: string; state: RuntimeState; machineId: string; createdAt: string; updatedAt: string; endedAt?: string | null; exitReason?: string | null }
export interface RuntimeBindingRecord { bindingId: string; runtimeId: string; sessionId: string; generation: number; channelId?: string | null; adapterKind: string; handleRef: string; boundAt: string; unboundAt?: string | null }
export interface RuntimeAttachmentRecord { attachmentId: string; runtimeId: string; sessionId: string; generation: number; viewerId: string; mode: RuntimeAttachmentMode; outputCursor: string; leaseExpiresAt?: string | null; attachedAt: string; detachedAt?: string | null }
export interface RuntimeEventRecord { runtimeId: string; generation: number; eventSeq: number; eventId: string; kind: string; outputCursor?: string | null; messageId?: string | null; outcome?: string | null; payload: Record<string, string | number | boolean | null>; occurredAt: string }
export interface RuntimeCreateRequest { context?: RequestContext; runtimeId?: string; homeAuthorityId: string; sessionId: string; generation?: number; protocolVersion?: number; transportKind?: string; machineId?: string; adapterKind?: string; channelId?: string | null; handleRef?: string; launchPolicyRef?: string | null; stateDir?: string; shell?: string; command?: string[]; cwd?: string; providerThreadId?: string | null }
export interface RuntimeListRequest { context?: RequestContext; machineId?: string }
export interface RuntimeStatusRequest { context?: RequestContext; runtimeId: string }
export interface RuntimeAttachRequest { context?: RequestContext; runtimeId: string; homeAuthorityId: string; sessionId: string; generation: number; attachmentId?: string; viewerId: string; mode: RuntimeAttachmentMode; leaseExpiresAt?: string | null; outputCursor?: string; stateDir?: string; operatorOverride?: boolean }
export interface RuntimeDetachRequest { context?: RequestContext; attachmentId: string }
export interface RuntimeInputRequest { context?: RequestContext; attachmentId: string; bytes: string }
export interface RuntimeResizeRequest { context?: RequestContext; attachmentId: string; columns: number; rows: number }
export interface RuntimeSignalRequest { context?: RequestContext; attachmentId: string; signal: "SIGHUP" | "SIGINT" | "SIGTERM" | "SIGWINCH" }
export interface RuntimeTerminateRequest { context?: RequestContext; runtimeId: string; generation: number; attachmentId?: string }
export interface RuntimeRecoverRequest { context?: RequestContext; runtimeId: string; homeAuthorityId: string; sessionId: string; generation: number; viewerId: string; mode?: RuntimeAttachmentMode; outputCursor?: string }
export interface RuntimeDeliverMessageRequest { context?: RequestContext; runtimeId: string; generation: number; messageId: string; frames: string[]; delaysMs: number[] }
export interface RuntimeEventsRequest { context?: RequestContext; runtimeId: string; generation: number; afterSeq?: number }
export interface RuntimeResponse { runtime?: RuntimeRecord; binding?: RuntimeBindingRecord; attachment?: RuntimeAttachmentRecord; cursor?: string }
export interface RuntimeListResponse { runtimes: RuntimeRecord[] }
export interface RuntimeEventsResponse { events: RuntimeEventRecord[] }
export interface RuntimeOperationResponse { ok: boolean; outcome?: string; bytesWritten?: number; attachment?: RuntimeAttachmentRecord; runtime?: RuntimeRecord; cursor?: string }

export type LocalProviderName = "codex" | "claude" | "grok" | "gemini";
export type LocalProviderAdapter = "codex" | "claude" | "grok" | "agy";
export interface LocalProviderHealth { status: "available" | "missing" | "disabled"; checkedAt: string; message?: string }
export interface LocalProviderRegistration {
  name: LocalProviderName;
  enabled: boolean;
  executable: string;
  adapter: LocalProviderAdapter;
  defaults: Record<string, string | boolean>;
  health: LocalProviderHealth;
  discoveredAt: string;
  updatedAt: string;
  launchOptions: Record<string, unknown>;
  modelCatalog?: ProviderModelCatalog | null;
}
export interface ProviderModelCatalogEntry { id: string; label: string; aliases: string[]; reasoningLevels: string[]; availability: "available" | "unavailable"; deprecated: boolean }
export interface ProviderModelCatalog { version: string; provider: "codex" | "claude"; sourceUrl: string; verifiedAt: string; state: "fresh" | "stale"; models: ProviderModelCatalogEntry[] }
export interface LocalProviderRegistryResponse { providers: LocalProviderRegistration[] }
export interface ListProvidersRequest { context?: RequestContext }
export interface LocalProviderWriteRequest {
  context?: RequestContext;
  mode: "register" | "update";
  name: LocalProviderName;
  executable?: string;
  adapter?: LocalProviderAdapter;
  enabled?: boolean;
  defaults?: Record<string, string | boolean>;
}
export interface LocalProviderRemoveRequest { context?: RequestContext; name: LocalProviderName }
export interface LocalProviderMutationResponse { providers: LocalProviderRegistration[] }

export interface RegisterChannelSessionRequest {
  context?: RequestContext;
  channelId: string;
  sessionId: string;
  role: SessionRole;
  externalId?: string | null;
  deliveryMode?: "runtime" | "log";
}
export interface RegisterChannelSessionResponse { session?: Session; membership?: Membership; idempotent: boolean }
export interface LaunchSessionRequest {
  context?: RequestContext;
  channelId: string;
  sessionId: string;
  provider: LocalProviderName;
  role: Exclude<SessionRole, "operator">;
  prompt: string;
  cwd: string;
  launchOptions?: Record<string, unknown>;
  providerArguments?: string[];
  promptTimeoutMs?: number;
}
export interface LaunchSessionResponse {
  session?: Session;
  runtime?: RuntimeResponse;
  promptDelivered: boolean;
  promptAccepted: boolean;
  promptDeliveryAttempts: number;
  providerReady?: { settled: boolean; byteCount: number; cursor: string } | null;
}
export interface InspectSessionRequest { context?: RequestContext; sessionId: string }
export interface InspectSessionResponse { session?: Session; memberships: MembershipHistory[]; runtime?: Record<string, unknown> | null }
export interface EndManagedSessionRequest { context?: RequestContext; sessionId: string }
export interface LocalSendMessageRequest { context?: RequestContext; channelId: string; targetSessionId?: string | null; body: string; replyToEventId?: string }
export interface ResolveSessionRuntimeRequest { context?: RequestContext; sessionId: string; mode: RuntimeAttachmentMode; outputCursor?: string }
export interface ResolveSessionRuntimeResponse { runtimeId: string; homeAuthorityId: string; sessionId: string; generation: number; viewerId: string; mode: RuntimeAttachmentMode; outputCursor?: string }
export interface LocalChannelLifecycleRequest { context?: RequestContext; channelId: string }
export interface LocalChannelArchiveRequest extends LocalChannelLifecycleRequest { force: boolean }
export interface LocalChannelArchiveResponse {
  channelId: string;
  completed: boolean;
  policy: { requiresForce: boolean; activeMemberships: number; activeRuntimes: number };
  steps: Record<string, unknown>[];
  error?: { code: string; message: string };
}
export interface LocalChannelResumeOutcome { priorSessionId: string; sessionId: string | null; runtimeId: string | null; generation: number; outcome: "resumed" | "failed" | "rolledBack"; error?: string }
export interface ChannelStateSnapshotsRequest { context?: RequestContext; channelIds: string[] }
export interface ChannelControlPagesRequest { context?: RequestContext; channels: { channelId: string; afterCursor?: string }[]; sessionId: string; limit?: number }
export interface UsageSeriesRequest { context?: RequestContext; scope: "session" | "channel"; id: string; window: string; collect: boolean }
export interface RotationSessionRequest { context?: RequestContext; channelId: string; sessionId: string }
export interface RotationAcknowledgeRequest { context?: RequestContext; rotationId: string; nonce: string }
export interface RotationCommitRequest { context?: RequestContext; rotationId: string }
export interface RotationCancelRequest { context?: RequestContext; rotationId: string; reason: string }
export interface RuntimeQuotaGetRequest { context?: RequestContext; machineId?: string }
export interface RuntimeQuotaSetRequest { context?: RequestContext; machineId: string; limit: number }
export interface RuntimeQuotaResetRequest { context?: RequestContext; machineId: string }
export interface RuntimeQuotaListResponse { quotas: unknown[] }
export interface RuntimeQuotaMutationResponse { quota: unknown }

export interface LifecycleStatus { state: LifecycleState; detail?: string; cursor?: string; observedAt?: Timestamp }
export type WatchEvent = { snapshot: Snapshot } | { delta: Change } | { status: LifecycleStatus };
export interface BlueprintStatus { state: BlueprintState; blueprintReference: string; members: MemberSuspendResult[] }
export interface MemberSuspendResult { sessionId: string; ok: boolean; detail?: string }

export interface ChannelResponse { channel?: Channel }
export interface SessionResponse { session?: Session }
export interface MembershipResponse { membership?: Membership }
export interface LeaveResponse { didLeave: boolean }
export interface ReplaceSessionResponse { session?: Session }
export interface UpdateSessionRoleResponse { session?: Session; cursor?: string }
export interface ControlResponse { event?: ControlEvent; cursor?: string; wasDeduplicated: boolean }
export interface ControlsResponse { events: ControlEvent[]; cursor?: string; hasMore: boolean }
export interface MessageResponse { event?: Message; wasDeduplicated: boolean }
export interface AuthenticateResponse { authenticatedSessionId: string }
export interface CredentialResponse { credential: string }
export interface ChannelsResponse { channels: Channel[] }
export interface SessionsResponse { sessions: Session[] }
export interface RosterResponse { roster: RosterEntry[] }
export interface MembershipHistoryResponse { membershipHistory: MembershipHistory[] }
export interface SnapshotResponse { snapshot?: Snapshot }
export interface EventsResponse { events: Message[]; cursor?: string; oldestCursor?: string; hasMore: boolean }
export interface ThreadLifecycle { threadRootEventId: string; channelId: string; state: ThreadLifecycleState; resolvedAt?: Timestamp; resolvedBySessionId?: string; reopenedAt?: Timestamp; reopenedBySessionId?: string; updatedAt?: Timestamp }
export interface ThreadLifecycleResponse { thread?: ThreadLifecycle; cursor?: string }
export interface SearchResponse { events: Message[] }
export interface RecipientsResponse { recipients: Recipient[] }
export interface StatusResponse { status?: LifecycleStatus }
export interface SuspendResponse { status?: LifecycleStatus; blueprint?: BlueprintStatus }
export interface ResumeResponse { status?: LifecycleStatus; channelId?: string; runtimeId?: string; idempotencyKey: string; conversationReferences: string[] }

export const ROOMS_PROTO_METHODS = [
  "createChannel", "showChannel", "listChannels", "updateChannelLabel", "updateChannelBroadcastPolicy", "closeChannel",
  "registerSession", "join", "leave", "endSession", "replaceSession", "send", "authenticate", "issueCredential",
  "getSessions", "getRoster", "getMembershipHistory", "getSnapshot", "getEvents", "getThreadLifecycle", "resolveThread", "reopenThread", "search", "getRecipients",
  "watch", "status", "suspend", "resume",
] as const;

export const ROOMS_LOCAL_EXTENSION_METHODS = [
  "updateSessionRole", "commitControl", "getControls", "channelStateSnapshots", "channelControlPages", "usageSeries",
  "registerChannelSession", "launchSession", "inspectSession", "endManagedSession", "sendMessage", "suspendChannel", "resumeChannel", "archiveChannel",
  "listProviders", "writeProvider", "removeProvider", "resolveSessionRuntime",
  "rotationInspect", "rotationPrepare", "rotationAcknowledge", "rotationCommit", "rotationCancel",
  "runtimeCreate", "runtimeList", "runtimeStatus", "runtimeAttach", "runtimeAttachStream", "runtimeDetach",
  "runtimeInput", "runtimeResize", "runtimeSignal", "runtimeTerminate", "runtimeRecover", "runtimeDeliverMessage", "runtimeEvents",
  "runtimeQuotaGet", "runtimeQuotaSet", "runtimeQuotaReset",
] as const;

/** Public protobuf service shape. */
export interface RoomsProtoService {
  createChannel(request: CreateChannelRequest): Promise<ChannelResponse>;
  showChannel(request: ShowChannelRequest): Promise<ChannelResponse>;
  listChannels(request: ListChannelsRequest): Promise<ChannelsResponse>;
  updateChannelLabel(request: UpdateChannelLabelRequest): Promise<ChannelResponse>;
  updateChannelBroadcastPolicy(request: UpdateChannelBroadcastPolicyRequest): Promise<ChannelResponse>;
  closeChannel(request: CloseChannelRequest): Promise<void>;
  registerSession(request: RegisterSessionRequest): Promise<SessionResponse>;
  join(request: JoinRequest): Promise<MembershipResponse>;
  leave(request: LeaveRequest): Promise<LeaveResponse>;
  endSession(request: EndSessionRequest): Promise<void>;
  replaceSession(request: ReplaceSessionRequest): Promise<ReplaceSessionResponse>;
  send(request: SendRequest): Promise<MessageResponse>;
  authenticate(request: AuthenticateRequest): Promise<AuthenticateResponse>;
  issueCredential(request: IssueCredentialRequest): Promise<CredentialResponse>;
  getSessions(request: GetSessionsRequest): Promise<SessionsResponse>;
  getRoster(request: GetRosterRequest): Promise<RosterResponse>;
  getMembershipHistory(request: GetMembershipHistoryRequest): Promise<MembershipHistoryResponse>;
  getSnapshot(request: GetSnapshotRequest): Promise<SnapshotResponse>;
  getEvents(request: GetEventsRequest): Promise<EventsResponse>;
  getThreadLifecycle(request: GetThreadLifecycleRequest): Promise<ThreadLifecycleResponse>;
  resolveThread(request: ThreadLifecycleMutationRequest): Promise<ThreadLifecycleResponse>;
  reopenThread(request: ThreadLifecycleMutationRequest): Promise<ThreadLifecycleResponse>;
  search(request: SearchRequest): Promise<SearchResponse>;
  getRecipients(request: GetRecipientsRequest): Promise<RecipientsResponse>;
  watch(request: WatchRequest): AsyncIterable<WatchEvent>;
  status(request: StatusRequest): Promise<StatusResponse>;
  suspend(request: SuspendRequest): Promise<SuspendResponse>;
  resume(request: ResumeRequest): Promise<ResumeResponse>;
}

/** Private local implementation extensions, never implied by rooms.v1. */
export interface RoomsLocalServiceExtensions {
  updateSessionRole(request: UpdateSessionRoleRequest): Promise<UpdateSessionRoleResponse>;
  commitControl(request: CommitControlRequest): Promise<ControlResponse>;
  getControls(request: GetControlsRequest): Promise<ControlsResponse>;
  channelStateSnapshots(request: ChannelStateSnapshotsRequest): Promise<unknown>;
  channelControlPages(request: ChannelControlPagesRequest): Promise<unknown>;
  usageSeries(request: UsageSeriesRequest): Promise<unknown>;
  registerChannelSession(request: RegisterChannelSessionRequest): Promise<RegisterChannelSessionResponse>;
  launchSession(request: LaunchSessionRequest): Promise<LaunchSessionResponse>;
  inspectSession(request: InspectSessionRequest): Promise<InspectSessionResponse>;
  endManagedSession(request: EndManagedSessionRequest): Promise<void>;
  sendMessage(request: LocalSendMessageRequest): Promise<MessageResponse>;
  suspendChannel(request: LocalChannelLifecycleRequest): Promise<unknown>;
  resumeChannel(request: LocalChannelLifecycleRequest): Promise<LocalChannelResumeOutcome[]>;
  archiveChannel(request: LocalChannelArchiveRequest): Promise<LocalChannelArchiveResponse>;
  listProviders(request: ListProvidersRequest): Promise<LocalProviderRegistryResponse>;
  writeProvider(request: LocalProviderWriteRequest): Promise<LocalProviderMutationResponse>;
  removeProvider(request: LocalProviderRemoveRequest): Promise<LocalProviderMutationResponse>;
  resolveSessionRuntime(request: ResolveSessionRuntimeRequest): Promise<ResolveSessionRuntimeResponse>;
  rotationInspect(request: RotationSessionRequest): Promise<unknown>;
  rotationPrepare(request: RotationSessionRequest): Promise<unknown>;
  rotationAcknowledge(request: RotationAcknowledgeRequest): Promise<unknown>;
  rotationCommit(request: RotationCommitRequest): Promise<unknown>;
  rotationCancel(request: RotationCancelRequest): Promise<unknown>;
  runtimeCreate(request: RuntimeCreateRequest): Promise<RuntimeResponse>;
  runtimeList(request: RuntimeListRequest): Promise<RuntimeListResponse>;
  runtimeStatus(request: RuntimeStatusRequest): Promise<RuntimeResponse>;
  runtimeAttach(request: RuntimeAttachRequest): Promise<RuntimeResponse>;
  runtimeAttachStream(request: RuntimeAttachRequest): AsyncIterable<unknown>;
  runtimeDetach(request: RuntimeDetachRequest): Promise<RuntimeOperationResponse>;
  runtimeInput(request: RuntimeInputRequest): Promise<RuntimeOperationResponse>;
  runtimeResize(request: RuntimeResizeRequest): Promise<RuntimeOperationResponse>;
  runtimeSignal(request: RuntimeSignalRequest): Promise<RuntimeOperationResponse>;
  runtimeTerminate(request: RuntimeTerminateRequest): Promise<RuntimeOperationResponse>;
  runtimeRecover(request: RuntimeRecoverRequest): Promise<RuntimeResponse>;
  runtimeDeliverMessage(request: RuntimeDeliverMessageRequest): Promise<RuntimeOperationResponse>;
  runtimeEvents(request: RuntimeEventsRequest): Promise<RuntimeEventsResponse>;
  runtimeQuotaGet(request: RuntimeQuotaGetRequest): Promise<RuntimeQuotaListResponse>;
  runtimeQuotaSet(request: RuntimeQuotaSetRequest): Promise<RuntimeQuotaMutationResponse>;
  runtimeQuotaReset(request: RuntimeQuotaResetRequest): Promise<RuntimeQuotaMutationResponse>;
}

/** Complete implementation shape consumed by the local Rooms daemon. */
export interface RoomsService extends RoomsProtoService, RoomsLocalServiceExtensions {}

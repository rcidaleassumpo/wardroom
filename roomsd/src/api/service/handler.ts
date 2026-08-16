// SPDX-License-Identifier: Apache-2.0
import type {
  AuthenticateRequest,
  AuthenticateResponse,
  ChannelResponse,
  ChannelsResponse,
  CloseChannelRequest,
  CreateChannelRequest,
  CredentialResponse,
  EndSessionRequest,
  UpdateSessionRoleRequest,
  EventsResponse,
  GetEventsRequest,
  GetThreadLifecycleRequest,
  GetMembershipHistoryRequest,
  GetRecipientsRequest,
  GetRosterRequest,
  GetSessionsRequest,
  GetSnapshotRequest,
  JoinRequest,
  LeaveRequest,
  LeaveResponse,
  ListChannelsRequest,
  MembershipHistoryResponse,
  MembershipResponse,
  MessageResponse,
  ReplaceSessionRequest,
  ReplaceSessionResponse,
  RegisterSessionRequest,
  RoomsService,
  RosterResponse,
  SearchRequest,
  SearchResponse,
  SendRequest,
  SessionResponse,
  SessionsResponse,
  ShowChannelRequest,
  UpdateChannelLabelRequest,
  UpdateChannelBroadcastPolicyRequest,
  SnapshotResponse,
  StatusRequest,
  StatusResponse,
  ThreadLifecycleMutationRequest,
  ThreadLifecycleResponse,
  SuspendRequest,
  SuspendResponse,
  WatchEvent,
  WatchRequest,
  ResumeRequest,
  ResumeResponse,
  UpdateSessionRoleResponse,
  CommitControlRequest, ControlResponse, GetControlsRequest, ControlsResponse,
  RuntimeCreateRequest, RuntimeListRequest, RuntimeStatusRequest, RuntimeAttachRequest, RuntimeDetachRequest,
  RuntimeInputRequest, RuntimeResizeRequest, RuntimeSignalRequest, RuntimeTerminateRequest, RuntimeRecoverRequest,
  RuntimeDeliverMessageRequest, RuntimeEventsRequest, RuntimeResponse, RuntimeListResponse, RuntimeOperationResponse,
  RuntimeEventsResponse,
  ChannelStateSnapshotsRequest, ChannelControlPagesRequest, UsageSeriesRequest,
  RegisterChannelSessionRequest, RegisterChannelSessionResponse, LaunchSessionRequest, LaunchSessionResponse,
  CreateChannelProfileRevisionRequest, ListChannelProfileRevisionsRequest, ReadChannelProfileRevisionRequest, ListProfileSkillCatalogRequest,
  GetSessionProfileBindingsRequest, LaunchSessionWithProfileRequest, ChannelProfileRevisionResponse, ChannelProfileRevisionsResponse,
  ProfileSkillCatalogResponse, SessionProfileBindingsResponse,
  InspectSessionRequest, InspectSessionResponse, EndManagedSessionRequest, ListOwnedSessionsRequest, EndOwnedSessionsRequest, LocalSendMessageRequest, UpdateChannelCoordinationPolicyRequest, ResolveSessionRuntimeRequest, ResolveSessionRuntimeResponse,
  LeadBroadcastRequest, LeadBroadcastResponse,
  LocalChannelLifecycleRequest, LocalChannelArchiveRequest, LocalChannelArchiveResponse, LocalChannelResumeOutcome,
  LocalProviderRegistryResponse, LocalProviderWriteRequest, LocalProviderMutationResponse, LocalProviderRemoveRequest,
  RotationSessionRequest, RotationAcknowledgeRequest, RotationCommitRequest, RotationCancelRequest,
  RuntimeQuotaGetRequest, RuntimeQuotaSetRequest, RuntimeQuotaResetRequest,
} from "../../generated/rooms/v1/rooms.js";
import type { ChannelControlPages, ChannelStateSnapshots } from "../../storage/repository.js";
import type { RotationAudit, RotationInspection } from "../../rotation/contracts.js";

/** Transport-neutral implementation consumed by Connect and local listeners. */
export interface RoomsServiceHandler {
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
  updateSessionRole(request: UpdateSessionRoleRequest): Promise<UpdateSessionRoleResponse>;
  commitControl(request: CommitControlRequest): Promise<ControlResponse>;
  getControls(request: GetControlsRequest): Promise<ControlsResponse>;
  replaceSession(request: ReplaceSessionRequest): Promise<ReplaceSessionResponse>;
  send(request: SendRequest): Promise<MessageResponse>;
  authenticate(request: AuthenticateRequest): Promise<AuthenticateResponse>;
  issueCredential(request: { context?: AuthenticateRequest["context"]; sessionId: string; proof: string }): Promise<CredentialResponse>;
  issueBootstrapCredential?(request: { context?: AuthenticateRequest["context"]; sessionId: string; bootstrap: string }): Promise<CredentialResponse>;
  getSessions(request: GetSessionsRequest): Promise<SessionsResponse>;
  getRoster(request: GetRosterRequest): Promise<RosterResponse>;
  getMembershipHistory(request: GetMembershipHistoryRequest): Promise<MembershipHistoryResponse>;
  getSnapshot(request: GetSnapshotRequest): Promise<SnapshotResponse>;
  /** Private local state query; Rooms stays neutral about consumer dispatch policy. */
  channelStateSnapshots?(request: ChannelStateSnapshotsRequest): Promise<ChannelStateSnapshots>;
  /** Private local multi-channel control query; each channel keeps its own cursor. */
  channelControlPages?(request: ChannelControlPagesRequest): Promise<ChannelControlPages>;
  usageSeries?(request: UsageSeriesRequest): Promise<import("../../storage/usage-history.js").UsageSeries>;
  registerChannelSession?(request: RegisterChannelSessionRequest): Promise<RegisterChannelSessionResponse>;
  launchSession?(request: LaunchSessionRequest): Promise<LaunchSessionResponse>;
  createChannelProfileRevision?(request: CreateChannelProfileRevisionRequest): Promise<ChannelProfileRevisionResponse>;
  listChannelProfileRevisions?(request: ListChannelProfileRevisionsRequest): Promise<ChannelProfileRevisionsResponse>;
  readChannelProfileRevision?(request: ReadChannelProfileRevisionRequest): Promise<ChannelProfileRevisionResponse>;
  listProfileSkillCatalog?(request: ListProfileSkillCatalogRequest): Promise<ProfileSkillCatalogResponse>;
  getSessionProfileBindings?(request: GetSessionProfileBindingsRequest): Promise<SessionProfileBindingsResponse>;
  launchSessionWithProfile?(request: LaunchSessionWithProfileRequest): Promise<LaunchSessionResponse>;
  inspectSession?(request: InspectSessionRequest): Promise<InspectSessionResponse>;
  endManagedSession?(request: EndManagedSessionRequest): Promise<void>;
  listOwnedSessions?(request: ListOwnedSessionsRequest): Promise<unknown>;
  endOwnedSessions?(request: EndOwnedSessionsRequest): Promise<unknown>;
  sendMessage?(request: LocalSendMessageRequest): Promise<MessageResponse>;
  updateChannelCoordinationPolicy?(request: UpdateChannelCoordinationPolicyRequest): Promise<ChannelResponse>;
  /** Private authenticated operation; resolves each destination's current planner in Rooms. */
  leadBroadcast?(request: LeadBroadcastRequest): Promise<LeadBroadcastResponse>;
  suspendChannel?(request: LocalChannelLifecycleRequest): Promise<unknown>;
  resumeChannel?(request: LocalChannelLifecycleRequest): Promise<LocalChannelResumeOutcome[]>;
  archiveChannel?(request: LocalChannelArchiveRequest): Promise<LocalChannelArchiveResponse>;
  listProviders?(request: { context?: import("../../generated/rooms/v1/rooms.js").RequestContext }): Promise<LocalProviderRegistryResponse>;
  writeProvider?(request: LocalProviderWriteRequest): Promise<LocalProviderMutationResponse>;
  removeProvider?(request: LocalProviderRemoveRequest): Promise<LocalProviderMutationResponse>;
  resolveSessionRuntime?(request: ResolveSessionRuntimeRequest): Promise<ResolveSessionRuntimeResponse>;
  rotationInspect?(request: RotationSessionRequest): Promise<RotationInspection>;
  rotationPrepare?(request: RotationSessionRequest): Promise<RotationAudit>;
  rotationAcknowledge?(request: RotationAcknowledgeRequest): Promise<RotationAudit>;
  rotationCommit?(request: RotationCommitRequest): Promise<RotationAudit>;
  rotationCancel?(request: RotationCancelRequest): Promise<RotationAudit>;
  getEvents(request: GetEventsRequest): Promise<EventsResponse>;
  getThreadLifecycle(request: GetThreadLifecycleRequest): Promise<ThreadLifecycleResponse>;
  resolveThread(request: ThreadLifecycleMutationRequest): Promise<ThreadLifecycleResponse>;
  reopenThread(request: ThreadLifecycleMutationRequest): Promise<ThreadLifecycleResponse>;
  search(request: SearchRequest): Promise<SearchResponse>;
  getRecipients(request: GetRecipientsRequest): Promise<import("../../generated/rooms/v1/rooms.js").RecipientsResponse>;
  watch(request: WatchRequest): AsyncIterable<WatchEvent>;
  status(request: StatusRequest): Promise<StatusResponse>;
  suspend(request: SuspendRequest): Promise<SuspendResponse>;
  resume(request: ResumeRequest): Promise<ResumeResponse>;
  runtimeCreate(request: RuntimeCreateRequest): Promise<RuntimeResponse>;
  runtimeList(request: RuntimeListRequest): Promise<RuntimeListResponse>;
  runtimeStatus(request: RuntimeStatusRequest): Promise<RuntimeResponse>;
  runtimeAttach(request: RuntimeAttachRequest): Promise<RuntimeResponse>;
  /** Local Unix-only interactive stream; never exposed as a network listener. */
  runtimeAttachStream?(request: RuntimeAttachRequest): AsyncIterable<unknown>;
  runtimeDetach(request: RuntimeDetachRequest): Promise<RuntimeOperationResponse>;
  runtimeInput(request: RuntimeInputRequest): Promise<RuntimeOperationResponse>;
  runtimeResize(request: RuntimeResizeRequest): Promise<RuntimeOperationResponse>;
  runtimeSignal(request: RuntimeSignalRequest): Promise<RuntimeOperationResponse>;
  runtimeTerminate(request: RuntimeTerminateRequest): Promise<RuntimeOperationResponse>;
  runtimeRecover(request: RuntimeRecoverRequest): Promise<RuntimeResponse>;
  runtimeDeliverMessage(request: RuntimeDeliverMessageRequest): Promise<RuntimeOperationResponse>;
  runtimeEvents(request: RuntimeEventsRequest): Promise<RuntimeEventsResponse>;
  runtimeQuotaGet?(request: RuntimeQuotaGetRequest): Promise<{ quotas: unknown[] }>;
  runtimeQuotaSet?(request: RuntimeQuotaSetRequest): Promise<{ quota: unknown }>;
  runtimeQuotaReset?(request: RuntimeQuotaResetRequest): Promise<{ quota: unknown }>;
}

export interface RoomsServiceHandlerDeps {
  service: RoomsService;
}

/** Wrap the generated service implementation without binding it to a transport. */
export function createRoomsServiceHandler({ service }: RoomsServiceHandlerDeps): RoomsServiceHandler {
  const handler: RoomsServiceHandler = {
    createChannel: (request) => service.createChannel(request),
    showChannel: (request) => service.showChannel(request),
    listChannels: (request) => service.listChannels(request),
    updateChannelLabel: (request) => service.updateChannelLabel(request),
    updateChannelBroadcastPolicy: (request) => service.updateChannelBroadcastPolicy(request),
    closeChannel: (request) => service.closeChannel(request),
    registerSession: (request) => service.registerSession(request),
    join: (request) => service.join(request),
    leave: (request) => service.leave(request),
    endSession: (request) => service.endSession(request),
    updateSessionRole: (request) => service.updateSessionRole(request),
    commitControl: (request) => service.commitControl(request),
    getControls: (request) => service.getControls(request),
    replaceSession: (request) => service.replaceSession(request),
    send: (request) => service.send(request),
    authenticate: (request) => service.authenticate(request),
    issueCredential: (request) => service.issueCredential(request),
    getSessions: (request) => service.getSessions(request),
    getRoster: (request) => service.getRoster(request),
    getMembershipHistory: (request) => service.getMembershipHistory(request),
    getSnapshot: (request) => service.getSnapshot(request),
    getEvents: (request) => service.getEvents(request),
    getThreadLifecycle: (request) => service.getThreadLifecycle(request),
    resolveThread: (request) => service.resolveThread(request),
    reopenThread: (request) => service.reopenThread(request),
    search: (request) => service.search(request),
    getRecipients: (request) => service.getRecipients(request),
    watch: (request) => service.watch(request),
    status: (request) => service.status(request),
    suspend: (request) => service.suspend(request),
    resume: (request) => service.resume(request),
    runtimeCreate: (request) => service.runtimeCreate(request),
    runtimeList: (request) => service.runtimeList(request),
    runtimeStatus: (request) => service.runtimeStatus(request),
    runtimeAttach: (request) => service.runtimeAttach(request),
    runtimeDetach: (request) => service.runtimeDetach(request),
    runtimeInput: (request) => service.runtimeInput(request),
    runtimeResize: (request) => service.runtimeResize(request),
    runtimeSignal: (request) => service.runtimeSignal(request),
    runtimeTerminate: (request) => service.runtimeTerminate(request),
    runtimeRecover: (request) => service.runtimeRecover(request),
    runtimeDeliverMessage: (request) => service.runtimeDeliverMessage(request),
    runtimeEvents: (request) => service.runtimeEvents(request),
  };
  for (const method of [
    "channelStateSnapshots", "channelControlPages", "usageSeries", "registerChannelSession", "launchSession", "createChannelProfileRevision", "listChannelProfileRevisions", "readChannelProfileRevision", "listProfileSkillCatalog", "getSessionProfileBindings", "launchSessionWithProfile", "inspectSession",
    "endManagedSession", "listOwnedSessions", "endOwnedSessions", "sendMessage", "leadBroadcast", "suspendChannel", "resumeChannel", "archiveChannel", "listProviders", "writeProvider", "removeProvider",
    "resolveSessionRuntime", "rotationInspect", "rotationPrepare", "rotationAcknowledge", "rotationCommit", "rotationCancel",
    "runtimeAttachStream", "runtimeQuotaGet", "runtimeQuotaSet", "runtimeQuotaReset",
  ] as const) {
    const implementation = service[method] as ((request: never) => unknown) | undefined;
    if (implementation) (handler as unknown as Record<string, unknown>)[method] = (request: never) => implementation.call(service, request);
  }
  return handler;
}

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
  SnapshotResponse,
  StatusRequest,
  StatusResponse,
  SuspendRequest,
  SuspendResponse,
  WatchEvent,
  WatchRequest,
  ResumeRequest,
  ResumeResponse,
  UpdateSessionRoleResponse,
  RuntimeCreateRequest, RuntimeListRequest, RuntimeStatusRequest, RuntimeAttachRequest, RuntimeDetachRequest,
  RuntimeInputRequest, RuntimeResizeRequest, RuntimeSignalRequest, RuntimeTerminateRequest, RuntimeRecoverRequest,
  RuntimeDeliverMessageRequest, RuntimeEventsRequest, RuntimeResponse, RuntimeListResponse, RuntimeOperationResponse,
  RuntimeEventsResponse,
} from "../../generated/rooms/v1/rooms.js";

/** Transport-neutral implementation consumed by Connect and local listeners. */
export interface RoomsServiceHandler {
  createChannel(request: CreateChannelRequest): Promise<ChannelResponse>;
  showChannel(request: ShowChannelRequest): Promise<ChannelResponse>;
  listChannels(request: ListChannelsRequest): Promise<ChannelsResponse>;
  updateChannelLabel(request: UpdateChannelLabelRequest): Promise<ChannelResponse>;
  closeChannel(request: CloseChannelRequest): Promise<void>;
  registerSession(request: RegisterSessionRequest): Promise<SessionResponse>;
  join(request: JoinRequest): Promise<MembershipResponse>;
  leave(request: LeaveRequest): Promise<LeaveResponse>;
  endSession(request: EndSessionRequest): Promise<void>;
  updateSessionRole(request: UpdateSessionRoleRequest): Promise<UpdateSessionRoleResponse>;
  replaceSession(request: ReplaceSessionRequest): Promise<ReplaceSessionResponse>;
  send(request: SendRequest): Promise<MessageResponse>;
  authenticate(request: AuthenticateRequest): Promise<AuthenticateResponse>;
  issueCredential(request: { context?: AuthenticateRequest["context"]; sessionId: string }): Promise<CredentialResponse>;
  getSessions(request: GetSessionsRequest): Promise<SessionsResponse>;
  getRoster(request: GetRosterRequest): Promise<RosterResponse>;
  getMembershipHistory(request: GetMembershipHistoryRequest): Promise<MembershipHistoryResponse>;
  getSnapshot(request: GetSnapshotRequest): Promise<SnapshotResponse>;
  getEvents(request: GetEventsRequest): Promise<EventsResponse>;
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
}

export interface RoomsServiceHandlerDeps {
  service: RoomsService;
}

/** Wrap the generated service implementation without binding it to a transport. */
export function createRoomsServiceHandler({ service }: RoomsServiceHandlerDeps): RoomsServiceHandler {
  return {
    createChannel: (request) => service.createChannel(request),
    showChannel: (request) => service.showChannel(request),
    listChannels: (request) => service.listChannels(request),
    updateChannelLabel: (request) => service.updateChannelLabel(request),
    closeChannel: (request) => service.closeChannel(request),
    registerSession: (request) => service.registerSession(request),
    join: (request) => service.join(request),
    leave: (request) => service.leave(request),
    endSession: (request) => service.endSession(request),
    updateSessionRole: (request) => service.updateSessionRole(request),
    replaceSession: (request) => service.replaceSession(request),
    send: (request) => service.send(request),
    authenticate: (request) => service.authenticate(request),
    issueCredential: (request) => service.issueCredential(request),
    getSessions: (request) => service.getSessions(request),
    getRoster: (request) => service.getRoster(request),
    getMembershipHistory: (request) => service.getMembershipHistory(request),
    getSnapshot: (request) => service.getSnapshot(request),
    getEvents: (request) => service.getEvents(request),
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
}

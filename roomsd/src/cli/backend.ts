export interface ChannelCreateInput {
  name: string;
  credential?: string;
}

export interface SessionCreateInput {
  credential: string;
  channel: string;
  name: string;
  agent: "codex" | "claude" | "grok";
  role?: "planner" | "worker" | "reviewer";
  cwd: string;
  prompt: string;
  command?: string[];
  providerThreadId?: string | null;
}
export interface SessionRegisterInput { channel: string; name: string; role: "operator" | "planner" | "worker" | "reviewer"; externalId: string | null; }
export interface SessionListInput { includeEnded: boolean; }

export interface CommitMessageInput {
  channel: string | null;
  sender: string;
  body: string;
  target: string | null;
}

export interface ListMessagesInput {
  session: string;
  since: string;
  channel: string | null;
  limit: number;
}

export interface SendPromptInput {
  channel: string;
  session: string;
  prompt: string;
}

export interface RuntimeCLIInput { credential: string; runtimeId?: string; homeAuthorityId?: string; sessionId: string; generation?: number; machineId?: string; stateDir?: string; shell?: string; command?: string[]; cwd?: string; channelId?: string; adapterKind?: string; providerThreadId?: string | null; }
export interface RuntimeAttachCLIInput { credential: string; runtimeId: string; homeAuthorityId: string; sessionId: string; generation: number; viewerId: string; mode: "observe" | "controller"; outputCursor?: string; stateDir?: string; }
export interface RuntimeAttachOutput { cursor: string; bytes: Uint8Array }
export interface RuntimeAttachInteractiveHandlers {
  onOutput(value: RuntimeAttachOutput): void;
  onExit(value: { code: number }): void;
  onError(value: { code: number; message: string }): void;
  onClose(): void;
}
export interface RuntimeAttachInteractiveSession {
  hello: { replayFrom: string; head: string; gap: boolean };
  input(bytes: Uint8Array): Promise<unknown>;
  resize(columns: number, rows: number): Promise<unknown>;
  detach(): Promise<unknown>;
}
export interface RuntimeInputCLIInput { credential: string; attachmentId: string; bytes: string }
export interface RuntimeResizeCLIInput { credential: string; attachmentId: string; columns: number; rows: number }
export interface RuntimeSignalCLIInput { credential: string; attachmentId: string; signal: "SIGHUP" | "SIGINT" | "SIGTERM" | "SIGWINCH" }
export interface RuntimeTerminateCLIInput { credential: string; runtimeId: string; generation: number; attachmentId?: string }
export interface RuntimeRecoverCLIInput { credential: string; runtimeId: string; homeAuthorityId: string; sessionId: string; generation: number; viewerId: string; mode: "observe" | "controller"; outputCursor?: string }
export interface RuntimeDeliverCLIInput { credential: string; runtimeId: string; generation: number; messageId: string; frames: string[]; delaysMs: number[] }

export interface RoomsCLIBackend {
  whoami?(): Promise<unknown>;
  createChannel(input: ChannelCreateInput): Promise<unknown>;
  channelMembers?(name: string, credential?: string): Promise<unknown>;
  channelSend?(input: { channel: string; sender: string; body: string }): Promise<unknown>;
  sessionSend?(input: { target: string; sender: string; body: string }): Promise<unknown>;
  listChannels(): Promise<unknown>;
  labelChannel?(name: string, label: string | null, credential: string): Promise<unknown>;
  channelStatus(name: string): Promise<unknown>;
  suspendChannel(name: string): Promise<unknown>;
  resumeChannel(name: string): Promise<unknown>;
  closeChannel?(name: string, credential: string): Promise<unknown>;
  createSession(input: SessionCreateInput): Promise<unknown>;
  registerSession?(input: SessionRegisterInput): Promise<unknown>;
  inspectSession?(sessionId: string): Promise<unknown>;
  listSessions?(input: SessionListInput): Promise<unknown>;
  endSession?(sessionId: string, credential: string): Promise<unknown>;
  commitMessage(input: CommitMessageInput): Promise<unknown>;
  listMessages?(input: ListMessagesInput): Promise<unknown>;
  sendPrompt(input: SendPromptInput): Promise<unknown>;
  runtimeCreate?(input: RuntimeCLIInput): Promise<unknown>;
  runtimeList?(credential: string): Promise<unknown>;
  runtimeStatus?(runtimeId: string, credential: string): Promise<unknown>;
  runtimeAttach?(input: RuntimeAttachCLIInput): Promise<unknown>;
  runtimeAttachInteractive?(input: RuntimeAttachCLIInput, handlers: RuntimeAttachInteractiveHandlers): Promise<RuntimeAttachInteractiveSession>;
  runtimeResolveSessionAttach?(sessionId: string, credential: string, mode: "observe" | "controller", outputCursor?: string): Promise<RuntimeAttachCLIInput>;
  runtimeResolveProviderAttach?(providerThreadId: string, credential: string, mode: "observe" | "controller", outputCursor?: string): Promise<RuntimeAttachCLIInput | undefined>;
  runtimeTerminateSession?(sessionId: string, credential: string): Promise<unknown>;
  runtimeDetach?(attachmentId: string, credential: string): Promise<unknown>;
  runtimeInput?(input: RuntimeInputCLIInput): Promise<unknown>;
  runtimeResize?(input: RuntimeResizeCLIInput): Promise<unknown>;
  runtimeSignal?(input: RuntimeSignalCLIInput): Promise<unknown>;
  runtimeTerminate?(input: RuntimeTerminateCLIInput): Promise<unknown>;
  runtimeRecover?(input: RuntimeRecoverCLIInput): Promise<unknown>;
  runtimeDeliverMessage?(input: RuntimeDeliverCLIInput): Promise<unknown>;
  runtimeEvents?(runtimeId: string, generation: number, afterSeq: number, credential: string): Promise<unknown>;
}

export function defineRoomsCLIBackend(backend: RoomsCLIBackend): RoomsCLIBackend {
  return backend;
}

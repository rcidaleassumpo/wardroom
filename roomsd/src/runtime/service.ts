import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  RuntimeCreateRequest, RuntimeListRequest, RuntimeStatusRequest, RuntimeAttachRequest, RuntimeDetachRequest,
  RuntimeInputRequest, RuntimeResizeRequest, RuntimeSignalRequest, RuntimeTerminateRequest, RuntimeRecoverRequest,
  RuntimeDeliverMessageRequest, RuntimeEventsRequest, RuntimeResponse, RuntimeListResponse, RuntimeOperationResponse,
  RuntimeEventsResponse,
} from "../generated/rooms/v1/rooms.js";
import { RuntimeHostClient } from "./host/client.js";
import { RuntimeHostSupervisor } from "./host/supervisor.js";
import type { HostError, HostExit, HostHelloAck, HostOutput } from "./host/codec.js";
import { ensureRuntimeSocketDirectory, parseRuntimeHandle, runtimeHandleRef, runtimeSocketPath } from "./host/endpoint.js";
import type { RuntimeAction, RuntimeAttachment, RuntimeBinding, RuntimeEvent, Runtime, RuntimeActor } from "./contracts.js";
import { RuntimeRepository } from "../storage/runtime-repository.js";
import { RoomsStoreError } from "../storage/repository.js";
import { readMachineIdentityStatus } from "../identity/machine-identity.js";

/**
 * A provider submission must not place text and Enter in the same PTY write.
 * Interactive TUIs classify a bulk write as pasted text and may keep its final
 * carriage return in the composer. A distinct, slightly delayed Enter frame
 * behaves like a user pressing Enter after the paste.
 */
export function encodeProviderSubmission(body: string): { frames: string[]; delaysMs: number[] } {
  return {
    frames: [Buffer.from(body).toString("base64"), Buffer.from("\r").toString("base64")],
    delaysMs: [0, 75],
  };
}

export function runtimeDeliveryAuditReference(messageId: string, bytesWritten: number, federatedHomeAuthorityId?: string): Readonly<{
  messageId?: string;
  payload: Readonly<Record<string, string | number>>;
}> {
  return federatedHomeAuthorityId
    ? { payload: { bytesWritten, canonicalMessageId: messageId, canonicalHomeAuthorityId: federatedHomeAuthorityId } }
    : { messageId, payload: { bytesWritten } };
}

const toRecord = (runtime: Runtime) => ({ runtimeId: runtime.runtimeId, homeAuthorityId: runtime.homeAuthorityId, sessionId: runtime.sessionId, providerThreadId: runtime.providerThreadId, generation: runtime.generation, protocolVersion: runtime.protocolVersion, transportKind: runtime.transportKind, state: runtime.state, machineId: runtime.machineId, createdAt: runtime.createdAt, updatedAt: runtime.updatedAt, endedAt: runtime.endedAt, exitReason: runtime.exitReason });
const toBinding = (binding: RuntimeBinding) => ({ bindingId: binding.bindingId, runtimeId: binding.runtimeId, sessionId: binding.sessionId, generation: binding.generation, channelId: binding.channelId, adapterKind: binding.adapterKind, handleRef: binding.handleRef, boundAt: binding.boundAt, unboundAt: binding.unboundAt });
const toAttachment = (attachment: RuntimeAttachment) => ({ attachmentId: attachment.attachmentId, runtimeId: attachment.runtimeId, sessionId: attachment.sessionId, generation: attachment.generation, viewerId: attachment.viewerId, mode: attachment.mode, outputCursor: attachment.outputCursor.toString(), leaseExpiresAt: attachment.leaseExpiresAt, attachedAt: attachment.attachedAt, detachedAt: attachment.detachedAt });
const toEvent = (event: RuntimeEvent) => ({ runtimeId: event.runtimeId, generation: event.generation, eventSeq: event.eventSeq, eventId: event.eventId, kind: event.kind, outputCursor: event.outputCursor?.toString() ?? null, messageId: event.messageId, outcome: event.outcome, payload: event.payload, occurredAt: event.occurredAt });

/** Discover provider-native identity emitted by providers that persist a JSONL session transcript. */
export async function discoverProviderThreadId(adapterKind: string | undefined, cwd: string | undefined, launchedAfter: number, homeDirectory = homedir()): Promise<string | null> {
  if (!cwd || (adapterKind !== "claude" && adapterKind !== "codex")) return null;
  const project = cwd.replace(/[^A-Za-z0-9_-]/g, (value) => value === "/" ? "-" : `-${value.charCodeAt(0).toString(16)}-`);
  const directory = adapterKind === "claude"
    ? join(homeDirectory, ".claude", "projects", project)
    : join(homeDirectory, ".codex", "sessions");
  // This poll is asynchronous relative to launch. Providers may spend several
  // seconds initializing integrations before the first Rooms briefing creates
  // their transcript, so keep the identity window generous without delaying
  // the interactive wrapper.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const names = adapterKind === "codex"
        ? readdirSync(directory, { recursive: true }).map(String)
        : readdirSync(directory);
      const candidates = names.filter(name => name.endsWith(".jsonl")).map(name => {
        const path = join(directory, name);
        try { const stat = statSync(path); return { path, created: stat.birthtimeMs || stat.mtimeMs }; } catch { return null; }
      }).filter((value): value is { path: string; created: number } => value !== null && value.created >= launchedAfter - 1_000).sort((a, b) => b.created - a.created);
      for (const candidate of candidates) {
        const first = readFileSync(candidate.path, "utf8").split("\n", 1)[0];
        try {
          const record = JSON.parse(first) as { sessionId?: unknown; payload?: { id?: unknown; cwd?: unknown } };
          const sessionId = adapterKind === "codex" ? record.payload?.id : record.sessionId;
          const recordCwd: unknown = adapterKind === "codex" ? record.payload?.cwd : cwd;
          if (recordCwd === cwd && typeof sessionId === "string" && sessionId.length > 0) return sessionId;
        } catch { /* provider may still be writing its first record */ }
      }
    } catch { /* provider has not created its project directory yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return null;
}

export interface RuntimeServiceOptions { machineId: string; defaultHomeAuthorityId: string; stateDir?: string; socketDirectory?: string; hostExecutable?: string; }
export interface RuntimeAttachHandlers {
  onOutput(value: HostOutput): void;
  onExit(value: HostExit): void;
  onError(value: HostError): void;
  onClose(): void;
}
export interface RuntimeAttachSession {
  response: RuntimeResponse;
  hello: HostHelloAck;
  input(bytes: Uint8Array): Promise<RuntimeOperationResponse>;
  resize(columns: number, rows: number): Promise<RuntimeOperationResponse>;
  detach(): RuntimeOperationResponse;
}

export class RoomsRuntimeService {
  private readonly supervisors = new Map<string, RuntimeHostSupervisor>();
  private readonly clients = new Map<string, RuntimeHostClient>();
  private readonly controllerReady = new Map<string, Promise<HostHelloAck>>();
  private readonly controllerHellos = new Map<string, HostHelloAck>();
  private readonly controllerViewCounts = new Map<string, number>();
  private readonly options: Required<RuntimeServiceOptions>;
  constructor(private readonly repository: RuntimeRepository, options: RuntimeServiceOptions) {
    const stateDir = options.stateDir ?? join(homedir(), ".rooms", "runtimes");
    this.options = { ...options, stateDir, socketDirectory: options.socketDirectory ?? join(dirname(stateDir), "s"), hostExecutable: options.hostExecutable ?? "" };
    mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 });
  }

  async create(request: RuntimeCreateRequest, actor: RuntimeActor): Promise<RuntimeResponse> {
    if (actor.role !== "operator" && actor.sessionId !== request.sessionId) throw new RoomsStoreError("runtimeUnauthorized");
    const runtimeId = request.runtimeId ?? `runtime-${randomUUID()}`;
    const generation = request.generation ?? 1;
    const reconnectSecret = randomBytes(32);
    const runtime = this.repository.create({ runtimeId, homeAuthorityId: request.homeAuthorityId || this.options.defaultHomeAuthorityId, sessionId: request.sessionId, generation, protocolVersion: request.protocolVersion ?? 1, transportKind: (request.transportKind ?? "localPty") as "localPty" | "structured", machineId: request.machineId ?? this.options.machineId, providerThreadId: request.providerThreadId ?? null, reconnectSecret });
    const stateDir = request.stateDir ?? this.options.stateDir;
    ensureRuntimeSocketDirectory(this.options.socketDirectory);
    const socketPath = runtimeSocketPath(runtime, this.options.socketDirectory);
    const supervisor = new RuntimeHostSupervisor({ sessionId: runtime.sessionId, channelId: request.channelId, runtimeId: runtime.runtimeId, homeAuthorityId: runtime.homeAuthorityId, generation: runtime.generation, stateDir, socketPath, executable: this.options.hostExecutable || undefined, shell: request.shell, command: request.command, cwd: request.cwd, secret: reconnectSecret, capabilityRenewal: true });
    this.supervisors.set(runtimeId, supervisor);
    try {
      const launchedAt = Date.now();
      await supervisor.start();
      if (request.providerThreadId) this.repository.setProviderThreadId(runtimeId, request.providerThreadId);
      const binding = this.repository.bind({ bindingId: `binding-${randomUUID()}`, runtimeId, homeAuthorityId: runtime.homeAuthorityId, sessionId: runtime.sessionId, generation, channelId: request.channelId ?? null, adapterKind: request.adapterKind ?? "localPty", handleRef: runtimeHandleRef(socketPath, stateDir), launchPolicyRef: request.launchPolicyRef ?? null });
      const current = this.repository.markState(runtimeId, generation, "running");
      if (!request.providerThreadId) {
        // Fresh interactive providers do not persist a native transcript until
        // the first Rooms briefing is submitted. Discovery therefore runs
        // after create returns: launch/attach is not delayed by a five-second
        // poll, and the newly-created transcript can still become durable
        // runtime/session identity for later native `--resume` recovery.
        void discoverProviderThreadId(request.adapterKind, request.cwd, launchedAt)
          .then((providerThreadId) => {
            if (providerThreadId) this.repository.setProviderThreadId(runtimeId, providerThreadId);
          })
          .catch(() => { /* unsupported providers and absent transcripts are optional */ });
      }
      return { runtime: toRecord(current), binding: toBinding(binding) };
    } catch (error) {
      await supervisor.cleanup();
      this.repository.markState(runtimeId, generation, "crashed", error instanceof Error ? error.message : "host failed");
      throw error;
    }
  }

  list(request: RuntimeListRequest, actor: RuntimeActor): RuntimeListResponse { const runtimes = this.repository.list(request.machineId).filter((runtime) => actor.role === "operator" || runtime.sessionId === actor.sessionId); return { runtimes: runtimes.map(toRecord) }; }
  resolveActiveSessionRuntime(sessionId: string, actor: RuntimeActor, action: RuntimeAction = "observe"): Runtime {
    const runtime = this.repository.list().filter((item) => item.sessionId === sessionId && !item.endedAt && ["running", "recovering"].includes(item.state)).sort((left, right) => right.generation - left.generation)[0];
    if (!runtime) throw new RoomsStoreError("runtimeNotFound");
    if (!this.actorCanAccessRuntime(actor, runtime, action)) throw new RoomsStoreError("runtimeUnauthorized");
    return runtime;
  }
  resolveActiveSessionRuntimeForDelivery(sessionId: string, actor: RuntimeActor): { runtime: Runtime; actor: RuntimeActor } {
    const runtime = this.repository.list().filter((item) => item.sessionId === sessionId && !item.endedAt && ["running", "recovering"].includes(item.state)).sort((left, right) => right.generation - left.generation)[0];
    if (!runtime) throw new RoomsStoreError("runtimeNotFound");
    return { runtime, actor: { ...actor, capability: { capabilityId: `local-delivery-${actor.sessionId}-${runtime.runtimeId}`, runtimeId: runtime.runtimeId, generation: runtime.generation, sessionId: runtime.sessionId, channelId: null, actions: ["deliverMessage"], expiresAt: new Date(Date.now() + 30_000).toISOString() } } };
  }
  status(request: RuntimeStatusRequest, actor: RuntimeActor): RuntimeResponse { const runtime = this.authorizedRuntime(request.runtimeId, actor); const binding = this.repository.getBinding(runtime.runtimeId); return { runtime: toRecord(runtime), binding: binding ? toBinding(binding) : undefined }; }

  async attach(request: RuntimeAttachRequest, actor: RuntimeActor): Promise<RuntimeResponse> {
    const session = await this.openAttachment(request, actor);
    return session.response;
  }

  async attachInteractive(request: RuntimeAttachRequest, actor: RuntimeActor, handlers: RuntimeAttachHandlers): Promise<RuntimeAttachSession> {
    return this.openAttachment(request, actor, handlers);
  }

  private async openAttachment(request: RuntimeAttachRequest, actor: RuntimeActor, handlers?: RuntimeAttachHandlers): Promise<RuntimeAttachSession> {
    const runtime = this.authorizedRuntime(request.runtimeId, actor, request.generation, request.mode === "controller" ? "controller" : "observe");
    const attachment = this.repository.attach({ attachmentId: request.attachmentId ?? `attachment-${randomUUID()}`, runtimeId: runtime.runtimeId, homeAuthorityId: runtime.homeAuthorityId, sessionId: runtime.sessionId, generation: runtime.generation, viewerId: actor.sessionId, mode: request.mode, leaseExpiresAt: request.leaseExpiresAt ?? null, outputCursor: BigInt(request.outputCursor ?? "0"), operatorOverride: request.operatorOverride === true && actor.role === "operator" });
    const supervisor = this.supervisors.get(runtime.runtimeId) ?? this.rehydrateSupervisor(runtime);
    if (request.mode === "controller" && attachment.mode === "controller") {
      const controller = await this.ensureControllerClient(attachment, runtime, supervisor, BigInt(request.outputCursor ?? "0"));
      if (!handlers) {
        return {
          response: { runtime: toRecord(runtime), attachment: toAttachment(attachment) },
          hello: controller.hello,
          input: (bytes) => this.input({ attachmentId: attachment.attachmentId, bytes: Buffer.from(bytes).toString("base64") }, actor),
          resize: (columns, rows) => this.resize({ attachmentId: attachment.attachmentId, columns, rows }, actor),
          detach: () => this.detach({ attachmentId: attachment.attachmentId }, actor),
        };
      }

      // The host deliberately owns one controller connection. Every terminal
      // view is an observer stream, while input is multiplexed through that
      // controller. This gives repeated attaches tmux-style shared I/O without
      // weakening observer authorization or creating competing controller leases.
      const view = new RuntimeHostClient(supervisor.socketEndpoint(), { sessionId: runtime.sessionId, runtimeId: runtime.runtimeId, homeAuthorityId: runtime.homeAuthorityId, generation: runtime.generation, secret: supervisor.secret }, { renewCapabilities: supervisor.supportsCapabilityRenewal });
      view.on("output", handlers.onOutput);
      view.on("exit", handlers.onExit);
      view.on("error", handlers.onError);
      view.on("close", handlers.onClose);
      try {
        const hello = await view.connect("observe", ["observe"], BigInt(request.outputCursor ?? "0"));
        this.controllerViewCounts.set(attachment.attachmentId, (this.controllerViewCounts.get(attachment.attachmentId) ?? 0) + 1);
        let detached = false;
        return {
          response: { runtime: toRecord(runtime), attachment: toAttachment(attachment) },
          hello,
          input: (bytes) => this.input({ attachmentId: attachment.attachmentId, bytes: Buffer.from(bytes).toString("base64") }, actor),
          resize: (columns, rows) => this.resize({ attachmentId: attachment.attachmentId, columns, rows }, actor),
          detach: () => {
            if (detached) return { ok: true, attachment: toAttachment(this.repository.getAttachment(attachment.attachmentId) ?? attachment) };
            detached = true;
            view.close();
            const remaining = Math.max(0, (this.controllerViewCounts.get(attachment.attachmentId) ?? 1) - 1);
            if (remaining > 0) {
              this.controllerViewCounts.set(attachment.attachmentId, remaining);
              return { ok: true, attachment: toAttachment(this.repository.getAttachment(attachment.attachmentId) ?? attachment) };
            }
            this.controllerViewCounts.delete(attachment.attachmentId);
            return this.detach({ attachmentId: attachment.attachmentId }, actor);
          },
        };
      } catch (error) {
        view.close();
        throw error;
      }
    }
    try {
      const client = new RuntimeHostClient(supervisor.socketEndpoint(), { sessionId: runtime.sessionId, runtimeId: runtime.runtimeId, homeAuthorityId: runtime.homeAuthorityId, generation: runtime.generation, secret: supervisor.secret }, { renewCapabilities: supervisor.supportsCapabilityRenewal });
      if (handlers) {
        client.on("output", handlers.onOutput);
        client.on("exit", handlers.onExit);
        client.on("error", handlers.onError);
        client.on("close", handlers.onClose);
      }
      this.registerClient(attachment, runtime, client);
      const hello = await client.connect(request.mode, request.mode === "controller" ? ["observe", "controller", "input", "resize", "signal", "terminate", "deliverMessage"] : ["observe", "deliverMessage"], BigInt(request.outputCursor ?? "0"));
      return {
        response: { runtime: toRecord(runtime), attachment: toAttachment(attachment) },
        hello,
        input: (bytes) => this.input({ attachmentId: attachment.attachmentId, bytes: Buffer.from(bytes).toString("base64") }, actor),
        resize: (columns, rows) => this.resize({ attachmentId: attachment.attachmentId, columns, rows }, actor),
        detach: () => this.detach({ attachmentId: attachment.attachmentId }, actor),
      };
    } catch (error) {
      this.clients.delete(attachment.attachmentId);
      this.repository.detach(attachment.attachmentId);
      if (isAbsentRuntimeHost(error)) {
        const supervisor = this.supervisors.get(runtime.runtimeId) ?? this.rehydrateSupervisor(runtime);
        this.repository.markState(runtime.runtimeId, runtime.generation, "crashed", "runtime host is absent");
        await supervisor.cleanup();
      }
      throw error;
    }
  }

  detach(request: RuntimeDetachRequest, actor: RuntimeActor): RuntimeOperationResponse {
    const attachment = this.repository.getAttachment(request.attachmentId);
    if (!attachment || (actor.role !== "operator" && attachment.viewerId !== actor.sessionId)) throw new RoomsStoreError("runtimeUnauthorized");
    const detached = this.repository.detach(attachment.attachmentId);
    this.clients.get(detached.attachmentId)?.close();
    this.clients.delete(detached.attachmentId);
    if (!attachment.detachedAt) this.repository.appendEvent({ runtimeId: detached.runtimeId, generation: detached.generation, kind: "attachmentDetached", payload: { attachmentId: detached.attachmentId } });
    return { ok: true, attachment: toAttachment(detached) };
  }
  async input(request: RuntimeInputRequest, actor: RuntimeActor): Promise<RuntimeOperationResponse> { const { client, transient } = await this.controllerClient(request.attachmentId, actor, "input"); try { client.input(Buffer.from(request.bytes, "base64")); await client.ping(); return { ok: true }; } finally { if (transient) client.close(); } }
  async resize(request: RuntimeResizeRequest, actor: RuntimeActor): Promise<RuntimeOperationResponse> { const { client, transient } = await this.controllerClient(request.attachmentId, actor, "resize"); try { client.resize(request.columns, request.rows); await client.ping(); return { ok: true }; } finally { if (transient) client.close(); } }
  async signal(request: RuntimeSignalRequest, actor: RuntimeActor): Promise<RuntimeOperationResponse> { const { client, transient } = await this.controllerClient(request.attachmentId, actor); try { client.signal(request.signal); await client.ping(); return { ok: true }; } finally { if (transient) client.close(); } }
  async terminate(request: RuntimeTerminateRequest, actor: RuntimeActor): Promise<RuntimeOperationResponse> {
    const runtime = this.authorizedRuntime(request.runtimeId, actor, request.generation);
    try {
      const connection = request.attachmentId ? await this.controllerClient(request.attachmentId, actor) : undefined;
      if (connection) { try { await connection.client.terminate(); } finally { if (connection.transient) connection.client.close(); } }
      else {
        const supervisor = this.supervisors.get(runtime.runtimeId) ?? this.rehydrateSupervisor(runtime);
        const connected = await supervisor.reconnect("observe", ["observe", "terminate"], 0n);
        try { await connected.terminate(); } finally { connected.close(); }
      }
    } catch (error) {
      if (!isAbsentRuntimeHost(error)) throw error;
      const supervisor = this.supervisors.get(runtime.runtimeId) ?? this.rehydrateSupervisor(runtime);
      await supervisor.cleanup();
    }
    this.repository.markState(runtime.runtimeId, runtime.generation, "terminated", "operator terminated");
    return { ok: true, runtime: toRecord(this.repository.get(runtime.runtimeId)!)};
  }

  async recover(request: RuntimeRecoverRequest, actor: RuntimeActor): Promise<RuntimeResponse> {
    const runtime = this.authorizedRuntime(request.runtimeId, actor, request.generation);
    const hadActiveAttachment = this.repository.listAttachments(runtime.runtimeId, runtime.generation).some((item) => item.viewerId === actor.sessionId && !item.detachedAt);
    const attachment = this.repository.attach({ attachmentId: `attachment-${randomUUID()}`, runtimeId: runtime.runtimeId, homeAuthorityId: runtime.homeAuthorityId, sessionId: runtime.sessionId, generation: runtime.generation, viewerId: actor.sessionId, mode: request.mode ?? "observe", outputCursor: BigInt(request.outputCursor ?? "0"), allowRecovery: true });
    const supervisor = this.supervisors.get(runtime.runtimeId) ?? this.rehydrateSupervisor(runtime);
    try {
      const client = await supervisor.reconnect(request.mode ?? "observe", request.mode === "controller" ? ["observe", "controller", "input", "resize", "signal", "terminate", "deliverMessage"] : ["observe", "deliverMessage"], BigInt(request.outputCursor ?? "0"));
      this.registerClient(attachment, runtime, client);
      this.repository.markState(runtime.runtimeId, runtime.generation, "running");
      return { runtime: toRecord(this.repository.get(runtime.runtimeId)!), attachment: toAttachment(attachment), cursor: supervisor.lastHelloAck?.head.toString() };
    } catch (error) {
      if (!hadActiveAttachment) this.repository.detach(attachment.attachmentId);
      const state = supervisor.state === "recovering" ? "recovering" : "crashed";
      if (state === "crashed") await supervisor.cleanup();
      this.repository.markState(runtime.runtimeId, runtime.generation, state, error instanceof Error ? error.message : "runtime reconnect failed");
      throw error;
    }
  }

  async deliverMessage(request: RuntimeDeliverMessageRequest, actor: RuntimeActor): Promise<RuntimeOperationResponse> {
    const runtime = this.repository.get(request.runtimeId);
    if (!runtime) throw new RoomsStoreError("runtimeNotFound");
    if (runtime.generation !== request.generation) throw new RoomsStoreError("staleRuntimeGeneration");
    const sender = this.repository.canonicalMessageSender(request.messageId);
    if (!sender || (actor.role !== "operator" && sender !== actor.sessionId)) throw new RoomsStoreError("runtimeUnauthorized");
    if (!this.repository.canonicalMessageRecipients(request.messageId).includes(runtime.sessionId)) throw new RoomsStoreError("runtimeUnauthorized");
    return this.deliverToRuntime(runtime, request.messageId, request.frames, request.delaysMs);
  }

  /** Resolve only a runtime named by the canonical message's addressed recipient set. */
  resolveCanonicalMessageRecipientRuntime(sessionId: string, messageId: string): Runtime {
    if (!this.repository.canonicalMessageRecipients(messageId).includes(sessionId)) throw new RoomsStoreError("runtimeUnauthorized");
    const runtime = this.repository.list().filter((item) => item.sessionId === sessionId && !item.endedAt && ["running", "recovering"].includes(item.state)).sort((left, right) => right.generation - left.generation)[0];
    if (!runtime) throw new RoomsStoreError("runtimeNotFound");
    return runtime;
  }

  /** Burn a verified one-use capability before any federated attachment is opened. */
  consumeFederatedTerminalCapability(input: Readonly<{ runtimeId: string; generation: number; capabilityId: string; nonce: string; expiresAt: string }>): void {
    this.repository.consumeCapability({
      runtimeId: input.runtimeId,
      generation: input.generation,
      capabilityId: input.capabilityId,
      nonceHash: createHash("sha256").update(input.nonce).digest("hex"),
      action: "attach",
      expiresAt: input.expiresAt,
      consumedAt: new Date().toISOString(),
    });
  }

  federatedTerminalBindingChannel(runtimeId: string, generation: number): string | null {
    const runtime = this.repository.get(runtimeId);
    if (!runtime || runtime.generation !== generation) throw new RoomsStoreError("staleRuntimeGeneration");
    return this.repository.getBinding(runtimeId)?.channelId ?? null;
  }

  /**
   * Inject a canonical event fetched from its authenticated channel home. The event is
   * deliberately not copied into this machine's message store: only delivery outcome
   * metadata is local, preserving one canonical message authority per channel.
   */
  async deliverFederatedMessage(input: Readonly<{ homeAuthorityId: string; localSessionId: string; messageId: string; body: string; deliveredRecipientSessionIds: readonly string[] }>): Promise<RuntimeOperationResponse> {
    const expectedRecipient = `federation:${readMachineIdentityStatus(dirname(this.options.stateDir)).authorityId}:${input.localSessionId}`;
    if (!input.deliveredRecipientSessionIds.includes(expectedRecipient)) throw new RoomsStoreError("runtimeUnauthorized");
    const runtime = this.repository.list().filter((item) => item.sessionId === input.localSessionId && !item.endedAt && ["running", "recovering"].includes(item.state)).sort((left, right) => right.generation - left.generation)[0];
    if (!runtime) throw new RoomsStoreError("runtimeNotFound");
    const submission = encodeProviderSubmission(input.body);
    return this.deliverToRuntime(runtime, input.messageId, submission.frames, submission.delaysMs, input.homeAuthorityId);
  }

  private async deliverToRuntime(runtime: Runtime, messageId: string, frames: readonly string[], delaysMs: readonly number[], federatedHomeAuthorityId?: string): Promise<RuntimeOperationResponse> {
    const supervisor = this.supervisors.get(runtime.runtimeId) ?? this.rehydrateSupervisor(runtime);
    const deliveryKey = `delivery:${runtime.runtimeId}`;
    let client = this.clients.get(deliveryKey);
    if (!client) {
      client = await supervisor.reconnect("observe", ["observe", "deliverMessage"], 0n);
      this.clients.set(deliveryKey, client);
      client.on("exit", (exit) => { this.repository.markState(runtime.runtimeId, runtime.generation, "exited", `exit:${exit.code}`); });
      client.on("error", () => {});
      client.on("close", () => { if (this.clients.get(deliveryKey) === client) this.clients.delete(deliveryKey); });
    }
    const ack = await client.deliverMessage({ id: messageId, frames: frames.map((frame) => Buffer.from(frame, "base64")), delaysMs: [...delaysMs] });
    const audit = runtimeDeliveryAuditReference(messageId, ack.bytesWritten, federatedHomeAuthorityId);
    this.repository.appendEvent({ runtimeId: runtime.runtimeId, generation: runtime.generation, kind: ack.outcome === "uncertain" ? "deliverMessageRejected" : "deliverMessageAccepted", ...audit, outcome: ack.outcome });
    return { ok: true, outcome: ack.outcome, bytesWritten: ack.bytesWritten };
  }
  events(request: RuntimeEventsRequest, actor: RuntimeActor): RuntimeEventsResponse { const runtime = this.authorizedRuntime(request.runtimeId, actor, request.generation); return { events: this.repository.events(runtime.runtimeId, runtime.generation, request.afterSeq ?? 0).map(toEvent) }; }

  private async controllerClient(attachmentId: string, actor: RuntimeActor, action: RuntimeAction = "controller"): Promise<{ client: RuntimeHostClient; transient: boolean }> { const attachment = this.authorizedAttachment(attachmentId, actor, action); if (attachment.mode !== "controller") throw new RoomsStoreError("controllerLeaseRequired"); const existing = this.clients.get(attachmentId); if (existing) return { client: existing, transient: false }; const runtime = this.authorizedRuntime(attachment.runtimeId, actor, attachment.generation, action); const supervisor = this.supervisors.get(runtime.runtimeId) ?? this.rehydrateSupervisor(runtime); const client = await supervisor.reconnect("controller", ["observe", "controller", "input", "resize", "signal", "terminate", "deliverMessage"], attachment.outputCursor); return { client, transient: true }; }
  private authorizedAttachment(attachmentId: string, actor: RuntimeActor, action: RuntimeAction = "observe"): RuntimeAttachment {
    const attachment = this.repository.getAttachment(attachmentId);
    if (!attachment || attachment.detachedAt || (actor.role !== "operator" && attachment.viewerId !== actor.sessionId)) throw new RoomsStoreError("runtimeUnauthorized");
    const runtime = this.repository.get(attachment.runtimeId);
    if (!runtime || !this.actorCanAccessRuntime(actor, runtime, action)) throw new RoomsStoreError("runtimeUnauthorized");
    return attachment;
  }
  private authorizedRuntime(runtimeId: string, actor: RuntimeActor, generation?: number, action: RuntimeAction = "observe"): Runtime { const runtime = this.repository.get(runtimeId); if (!runtime) throw new RoomsStoreError("runtimeNotFound"); if (generation !== undefined && runtime.generation !== generation) throw new RoomsStoreError("staleRuntimeGeneration"); if (!this.actorCanAccessRuntime(actor, runtime, action)) throw new RoomsStoreError("runtimeUnauthorized"); return runtime; }
  private actorCanAccessRuntime(actor: RuntimeActor, runtime: Runtime, action: RuntimeAction): boolean {
    if (actor.role === "operator" || actor.sessionId === runtime.sessionId) return true;
    const capability = actor.capability;
    return Boolean(capability
      && capability.runtimeId === runtime.runtimeId
      && capability.generation === runtime.generation
      && capability.sessionId === runtime.sessionId
      && capability.actions.includes(action)
      && Date.parse(capability.expiresAt) > Date.now());
  }
  private registerClient(attachment: RuntimeAttachment, runtime: Runtime, client: RuntimeHostClient): void { this.clients.set(attachment.attachmentId, client); client.on("output", (output) => { this.repository.appendEvent({ runtimeId: runtime.runtimeId, generation: runtime.generation, kind: "outputAvailable", outputCursor: output.cursor }); }); client.on("exit", (exit) => { this.repository.markState(runtime.runtimeId, runtime.generation, "exited", `exit:${exit.code}`); }); client.on("error", () => {}); client.on("close", () => { if (this.clients.get(attachment.attachmentId) === client) { this.clients.delete(attachment.attachmentId); this.controllerHellos.delete(attachment.attachmentId); } }); }
  private async ensureControllerClient(attachment: RuntimeAttachment, runtime: Runtime, supervisor: RuntimeHostSupervisor, cursor: bigint): Promise<{ client: RuntimeHostClient; hello: HostHelloAck }> {
    const existing = this.clients.get(attachment.attachmentId);
    if (existing) {
      const ready = this.controllerReady.get(attachment.attachmentId);
      const hello = ready ? await ready : this.controllerHellos.get(attachment.attachmentId);
      if (!hello) throw new Error("runtime controller connection has no HELLO acknowledgement");
      return { client: existing, hello };
    }
    const client = new RuntimeHostClient(supervisor.socketEndpoint(), { sessionId: runtime.sessionId, runtimeId: runtime.runtimeId, homeAuthorityId: runtime.homeAuthorityId, generation: runtime.generation, secret: supervisor.secret }, { renewCapabilities: supervisor.supportsCapabilityRenewal });
    this.registerClient(attachment, runtime, client);
    const ready = client.connect("controller", ["observe", "controller", "input", "resize", "signal", "terminate", "deliverMessage"], cursor);
    this.controllerReady.set(attachment.attachmentId, ready);
    try {
      const hello = await ready;
      this.controllerHellos.set(attachment.attachmentId, hello);
      return { client, hello };
    } catch (error) {
      if (this.clients.get(attachment.attachmentId) === client) this.clients.delete(attachment.attachmentId);
      client.close();
      throw error;
    } finally {
      if (this.controllerReady.get(attachment.attachmentId) === ready) this.controllerReady.delete(attachment.attachmentId);
    }
  }
  private rehydrateSupervisor(runtime: Runtime): RuntimeHostSupervisor {
    const binding = this.repository.getBinding(runtime.runtimeId);
    const endpoint = binding ? parseRuntimeHandle(binding.handleRef) : null;
    const supervisor = new RuntimeHostSupervisor({
      sessionId: runtime.sessionId,
      runtimeId: runtime.runtimeId,
      homeAuthorityId: runtime.homeAuthorityId,
      generation: runtime.generation,
      stateDir: endpoint?.stateDir ?? this.options.stateDir,
      socketPath: endpoint?.socketPath ?? runtimeSocketPath(runtime, this.options.socketDirectory),
      executable: this.options.hostExecutable || undefined,
    });
    this.supervisors.set(runtime.runtimeId, supervisor);
    return supervisor;
  }
}

function isAbsentRuntimeHost(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED" || (error instanceof Error && /connect (?:ENOENT|ECONNREFUSED)/.test(error.message));
}

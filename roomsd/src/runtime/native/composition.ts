import { randomUUID } from "node:crypto";
import { RoomsRepository, RoomsStoreError } from "../../storage/repository.js";
import { prepareCanonicalStorePath } from "../../storage/store-migration.js";
import type { RoomsServiceHandler } from "../../api/service/handler.js";
import { RoomsApplication } from "../../domain/application.js";
import type { RoomsConnectionState } from "../../transports/unix/index.js";
import { RuntimeRepository } from "../../storage/runtime-repository.js";
import { encodeProviderSubmission, RoomsRuntimeService } from "../service.js";
import { hostname } from "node:os";
import type { RuntimeActor } from "../contracts.js";
import { dirname, join } from "node:path";
import { readMachineIdentityStatus } from "../../identity/machine-identity.js";

const now = () => new Date().toISOString();

/**
 * Federation wiring the composition accepts by injection. Absent means a
 * single-machine build: the tree may omit src/federation entirely and this
 * module still compiles and serves every local surface.
 */
export type FederationCompositionPlug = Readonly<{
  createTerminalRuntimeHandler(runtimeService: RoomsRuntimeService, database: RoomsRepository, homeAuthorityId: string, stateDir: string): unknown;
  withChannelHomeRouting(input: Readonly<{ base: unknown; database: RoomsRepository; application: RoomsApplication; runtimeService: RoomsRuntimeService; homeAuthorityId: string }>): unknown;
  withMachineInventory(input: Readonly<{ base: unknown; database: RoomsRepository; authorityId: string; stateDir: string }>): unknown;
}>;

/** Compose the native runtime against the same SQLite authority as the CLI. */
export function createNativeComposition(databasePath: string, hostExecutable = process.env.ROOMS_RUNTIME_HOST_BIN, stateDir = process.env.ROOMS_STATE_DIR ?? dirname(databasePath), federation?: FederationCompositionPlug): { database: RoomsRepository; handler: RoomsServiceHandler; runtimeService: RoomsRuntimeService; relayHandlerFactory: (() => unknown) | null } {
  const database = new RoomsRepository(prepareCanonicalStorePath(databasePath));
  const application = new RoomsApplication(database);
  const homeAuthorityId = readMachineIdentityStatus(stateDir).authorityId;
  const runtimeService = new RoomsRuntimeService(new RuntimeRepository(database.db), { machineId: hostname(), defaultHomeAuthorityId: homeAuthorityId, stateDir: join(stateDir, "runtimes"), socketDirectory: join(stateDir, "s"), hostExecutable });
  const connection = (request: any): RoomsConnectionState => request?.__connection ?? (() => { throw new Error("connection identity unavailable"); })();
  const authenticated = (request: any): string => {
    const state = connection(request);
    const credential = request?.context?.credential;
    const sessionId = credential ? state.credentials.get(credential) : undefined;
    const authenticatedSessionId = sessionId ?? state.authenticatedSessionId;
    if (!authenticatedSessionId || (sessionId && state.authenticatedSessionId !== sessionId)) throw new Error("invalid or missing credential");
    return authenticatedSessionId;
  };
  const runtimeActor = (request: any): RuntimeActor => {
    const state = connection(request);
    const credential = request?.context?.credential;
    if (typeof credential !== "string" || credential.trim() === "") throw new Error("runtime credential is required");
    const sessionId = state.credentials.get(credential);
    if (!sessionId || state.authenticatedSessionId !== sessionId) throw new Error("invalid or missing credential");
    const role = database.sessionRoleValue(sessionId);
    if (!role) throw new Error("runtime actor session is unavailable");
    return { sessionId, role, credentialId: credential };
  };
  const unsupported = (method: string) => async (): Promise<never> => { throw new Error(`${method} is not available in this runtime slice`); };
  const unsupportedWatch = async function* (): AsyncIterable<never> { throw new Error("watch is not available in this runtime slice"); };
  const handler: RoomsServiceHandler = {
    async createChannel(request: any): Promise<any> {
      const actorId = authenticated(request);
      const role = database.sessionRoleValue(actorId);
      if (!role) throw new Error("channel actor session is unavailable");
      const receipt = application.registerChannel({ id: request.channelName }, { credentialId: request.context?.credential ?? "authenticated", actorSessionId: actorId, role });
      return { channel: database.currentChannel(request.channelName), cursor: receipt.cursor };
    },
    showChannel: unsupported("showChannel"),
    async listChannels(): Promise<any> { return { channels: database.listChannels() }; },
    async updateChannelLabel(request: any): Promise<any> {
      const actorId = authenticated(request);
      const role = database.sessionRoleValue(actorId);
      if (!role) throw new Error("channel actor session is unavailable");
      const receipt = application.labelChannel(request.channelId, request.label ?? null, { credentialId: request.context?.credential ?? "authenticated", actorSessionId: actorId, role });
      return { channel: database.currentChannel(request.channelId), cursor: receipt.cursor };
    },
    async registerSession(request: any): Promise<any> {
      if (request.channelId) {
        const receipt = database.registerSession(request.channelId, request.sessionId, request.role ?? "worker", request.externalId ?? null);
        return { session: database.currentSession(request.sessionId), membership: database.roster(request.channelId).find((item: any) => item.sessionId === request.sessionId), idempotent: receipt.idempotent };
      }
      return { session: database.currentSession(request.sessionId) ?? database.insertSession({ id: request.sessionId, displayName: request.displayName ?? null, role: request.role }).changes[0]?.payload };
    },
    async join(request: any): Promise<any> {
      const actorId = request.authorizedBySessionId ?? request.context?.sessionId;
      const role = actorId ? database.sessionRoleValue(actorId) : null;
      if (!actorId || !role) throw new Error("authorizedBySessionId is required");
      const receipt = application.join(request.channelId, request.sessionId, { credentialId: "native-uncredentialed", actorSessionId: actorId, role });
      return { membership: receipt.changes[0]?.payload, cursor: receipt.cursor };
    },
    async leave(request: any): Promise<any> {
      const actorId = request.context?.sessionId ?? request.sessionId;
      const role = database.sessionRoleValue(actorId);
      if (!role) throw new Error("authorizedBySessionId is required");
      const receipt = application.leave(request.channelId, request.sessionId, { credentialId: "native-uncredentialed", actorSessionId: actorId, role });
      return { didLeave: true, cursor: receipt.cursor };
    },
    async send(request: any): Promise<any> {
      const sessionId = authenticated(request);
      if (request.senderSessionId !== sessionId) throw new Error("senderSessionId does not match authenticated session");
      let target = request.target ?? { kind: "here", sessionIds: [] };
      if (target.kind === "broadcast") {
        if (!request.channelId || !database.isActiveMember(request.channelId, sessionId)) throw new Error("broadcast sender is not an active channel member");
        target = { kind: "broadcast", sessionIds: database.roster(request.channelId).map((member: any) => member.sessionId).filter((id: string) => id !== sessionId) };
      }
      const recipients = target.kind === "direct" ? [target.sessionId] : target.sessionIds ?? [];
      if (recipients.length === 0) throw new RoomsStoreError("noAcceptedRecipients", "message has no recipient other than sender");
      if (target.kind === "direct") {
        const senderChannels = new Set(database.activeMembershipChannels(sessionId));
        if (!database.activeMembershipChannels(target.sessionId).some((channelId: string) => senderChannels.has(channelId))) throw new RoomsStoreError("unauthorizedRecipient", "direct recipients must share an active channel with the sender");
      }
      const actor: RuntimeActor = { sessionId, role: database.sessionRoleValue(sessionId) ?? "worker", credentialId: request.context?.credential ?? "native" };
      const statuses: Record<string, "delivered" | "queued" | "undeliverable"> = {};
      const runtimes = new Map<string, { runtimeId: string; generation: number; actor: RuntimeActor }>();
      for (const recipient of recipients) {
        try {
          const resolved = runtimeService.resolveActiveSessionRuntimeForDelivery(recipient, actor);
          runtimes.set(recipient, { ...resolved.runtime, actor: resolved.actor });
          statuses[recipient] = "queued";
        } catch (error) {
          if ((error as { code?: string }).code !== "runtimeNotFound") throw error;
          statuses[recipient] = "undeliverable";
          if (target.kind === "direct") throw new RoomsStoreError("recipientUndeliverable", `recipient session ${recipient} has no live runtime`);
        }
      }
      const receipt = application.commitMessage({ channelId: request.channelId ?? null, senderSessionId: request.senderSessionId, body: request.body, target, correlation: request.correlation, deliveryStatuses: statuses });
      const event = receipt.event as { id: string; body: string };
      for (const recipient of recipients) {
        const runtime = runtimes.get(recipient);
        if (!runtime) continue;
        try {
          const submission = encodeProviderSubmission(event.body);
          await runtimeService.deliverMessage({ runtimeId: runtime.runtimeId, generation: runtime.generation, messageId: event.id, frames: submission.frames, delaysMs: submission.delaysMs }, runtime.actor);
          statuses[recipient] = "delivered";
        } catch { statuses[recipient] = "undeliverable"; }
      }
      database.appendMessageDelivery(event.id, statuses);
      (receipt.event as any).recipientStatuses = statuses;
      (receipt.event as any).deliveredRecipientSessionIds = recipients.filter((id: string) => statuses[id] === "delivered");
      if ((receipt.event as any).deliveredRecipientSessionIds.length === 0) throw new RoomsStoreError(target.kind === "broadcast" ? "noAcceptedRecipients" : "recipientUndeliverable", `no recipient accepted delivery`);
      return { event: receipt.event, cursor: receipt.cursor, wasDeduplicated: receipt.wasDeduplicated ?? false };
    },
    async getEvents(request: any): Promise<any> {
      // A session-scoped request filters and bounds in SQL; an unbounded replay
      // of a busy channel would exceed the socket response limit on its own.
      if (request.sessionId) {
        return database.sessionMessages(request.sessionId, {
          afterCursor: request.afterCursor ?? "0",
          channelId: request.channelId,
          limit: request.limit,
        });
      }
      const changes = database.replay(request.afterCursor ?? "0", request.channelId);
      const messages = changes.filter((change) => change.kind === "message.sent").map((change) => change.payload);
      return { events: messages, cursor: changes.at(-1)?.cursor ?? request.afterCursor ?? "0" };
    },
    async getSnapshot(request: any): Promise<any> { return { snapshot: database.snapshot(request.channelId) }; },
    async getSessions(): Promise<any> { return { sessions: database.listSessions() }; },
    async getRoster(request: any): Promise<any> { return { roster: database.roster(request.channelId) }; },
    async getMembershipHistory(request: any): Promise<any> { return { membershipHistory: database.membershipHistory(request.channelId) }; },
    async status(): Promise<any> { return { status: { state: "running", observedAt: now() } }; },
    async authenticate(request: any): Promise<any> {
      const state = connection(request);
      const sessionId = request?.credential ? state.credentials.get(request.credential) : undefined;
      if (!sessionId) throw new Error("invalid or missing credential");
      state.authenticatedSessionId = sessionId;
      return { authenticatedSessionId: sessionId };
    },
    async issueCredential(request: any): Promise<any> {
      const state = connection(request);
      const sessionId = request?.sessionId;
      if (!sessionId || !database.currentSession(sessionId)) throw new Error("unknown session");
      const credential = `rooms_${randomUUID()}`;
      state.credentials.set(credential, sessionId);
      state.authenticatedSessionId = sessionId;
      return { credential };
    },
    async closeChannel(request: any): Promise<any> {
      const actorId = authenticated(request);
      const role = database.sessionRoleValue(actorId);
      if (!role) throw new Error("channel actor session is unavailable");
      const receipt = application.closeChannel(request.channelId ?? request.channelID, { credentialId: request.context?.credential ?? "authenticated", actorSessionId: actorId, role });
      return { channel: database.currentChannel(request.channelId ?? request.channelID), cursor: receipt.cursor };
    },
    async endSession(request: any): Promise<any> {
      const sessionId = String(request.sessionId ?? request.sessionID ?? "");
      const actorId = authenticated(request);
      const role = database.sessionRoleValue(actorId);
      if (!role) throw new Error("session actor is unavailable");
      const receipt = application.endSession(sessionId, { credentialId: request.context?.credential ?? "authenticated", actorSessionId: actorId, role });
      return { session: database.currentSession(sessionId), cursor: receipt.cursor };
    },
    async updateSessionRole(request: any): Promise<any> {
      if (typeof request.context?.credential !== "string" || request.context.credential.trim() === "") throw new Error("operator credential is required");
      const state = connection(request);
      const actorId = state.credentials.get(request.context.credential);
      if (!actorId || state.authenticatedSessionId !== actorId) throw new Error("invalid or missing credential");
      const actorRole = database.sessionRoleValue(actorId);
      if (actorRole !== "operator") throw new Error("owner operator credential is required");
      const receipt = application.updateSessionRole(request.channelId, request.sessionId, request.role, { credentialId: request.context?.credential ?? "authenticated", actorSessionId: actorId, role: actorRole });
      return { session: database.currentSession(request.sessionId), cursor: receipt.cursor };
    },
    replaceSession: unsupported("replaceSession"),
    async search(request: any): Promise<any> {
      const query = String(request.query ?? "").toLowerCase();
      const changes = database.replay(request.afterCursor ?? "0", request.channelId ?? undefined);
      const events = changes
        .filter((change: any) => change.kind === "message.sent")
        .map((change: any) => change.payload)
        .filter((event: any) => String(event.body ?? "").toLowerCase().includes(query));
      return { events };
    },
    async getRecipients(request: any): Promise<any> {
      const changes = database.replay("0", undefined);
      const event: any = changes.find((change: any) => change.kind === "message.sent" && change.payload?.id === request.eventId)?.payload;
      return { recipients: event?.deliveredRecipientSessionIds ?? [] };
    },
    watch: async function* (request: any): AsyncIterable<any> {
      if (request.channelId) yield { snapshot: database.snapshot(request.channelId) };
      for (const change of database.replay(request.afterCursor ?? "0", request.channelId)) yield { delta: change };
      const queue: any[] = [];
      let wake: (() => void) | null = null;
      const remove = database.onChange((change) => {
        if (request.channelId && change.channelId !== null && change.channelId !== request.channelId) return;
        queue.push(change); wake?.();
      });
      try {
        while (true) {
          if (!queue.length) await new Promise<void>(resolve => { wake = resolve; });
          while (queue.length) yield { delta: queue.shift() };
        }
      } finally { remove(); }
    }, suspend: unsupported("suspend"), resume: unsupported("resume"),
    runtimeCreate: (request: any) => runtimeService.create(request, runtimeActor(request)),
    runtimeList: async (request: any) => runtimeService.list(request, runtimeActor(request)),
    runtimeStatus: async (request: any) => runtimeService.status(request, runtimeActor(request)),
    runtimeAttach: (request: any) => runtimeService.attach(request, runtimeActor(request)),
    runtimeAttachStream: async function* (request: any): AsyncIterable<unknown> {
      const queue: unknown[] = [];
      let wake: (() => void) | undefined;
      let closed = false;
      const push = (value: unknown): void => { queue.push(value); wake?.(); wake = undefined; };
      const session = await runtimeService.attachInteractive(request, runtimeActor(request), {
        onOutput: (value) => push({ kind: "output", cursor: value.cursor.toString(), bytes: Buffer.from(value.bytes).toString("base64") }),
        onExit: (value) => push({ kind: "exit", code: value.code }),
        onError: (value) => push({ kind: "error", code: value.code, message: value.message }),
        onClose: () => { closed = true; wake?.(); wake = undefined; },
      });
      const connectionClose = (): void => {
        closed = true;
        try { session.detach(); } catch { /* transport loss owns attachment cleanup */ }
        wake?.();
        wake = undefined;
      };
      request.__connection?.onClose?.add(connectionClose);
      push({ kind: "hello", response: session.response, hello: { replayFrom: session.hello.replayFrom.toString(), head: session.hello.head.toString(), gap: session.hello.gap } });
      try {
        while (!closed || queue.length > 0) {
          if (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
          while (queue.length > 0) yield queue.shift();
        }
      } finally {
        request.__connection?.onClose?.delete(connectionClose);
        try { session.detach(); } catch {}
      }
    },
    runtimeDetach: async (request: any) => runtimeService.detach(request, runtimeActor(request)),
    runtimeInput: async (request: any) => runtimeService.input(request, runtimeActor(request)),
    runtimeResize: async (request: any) => runtimeService.resize(request, runtimeActor(request)),
    runtimeSignal: async (request: any) => runtimeService.signal(request, runtimeActor(request)),
    runtimeTerminate: (request: any) => runtimeService.terminate(request, runtimeActor(request)),
    runtimeRecover: (request: any) => runtimeService.recover(request, runtimeActor(request)),
    runtimeDeliverMessage: (request: any) => runtimeService.deliverMessage(request, runtimeActor(request)),
    runtimeEvents: async (request: any) => runtimeService.events(request, runtimeActor(request)),
  };
  return {
    database,
    handler,
    runtimeService,
    relayHandlerFactory: federation ? () => federation.withMachineInventory({
      base: federation.withChannelHomeRouting({
        base: federation.createTerminalRuntimeHandler(runtimeService, database, homeAuthorityId, stateDir),
        database,
        application,
        runtimeService,
        homeAuthorityId,
      }),
      database,
      authorityId: homeAuthorityId,
      stateDir,
    }) : null,
  };
}

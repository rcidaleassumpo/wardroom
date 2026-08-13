// SPDX-License-Identifier: Apache-2.0
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
import { DEFAULT_MAX_BUFFERED_DELTA_BATCHES } from "../../api/subscriptions/subscription.js";
import { SQLiteBlueprintStore } from "../../storage/blueprint-repository.js";
import { SQLiteRotationRepository } from "../../rotation/repository.js";
import { AgentRotationService } from "../../rotation/service.js";
import type { RotationRuntime } from "../../rotation/contracts.js";
import { LocalChannelLifecycle } from "./local-channel-lifecycle.js";
import { archiveChannelLifecycle } from "../../lifecycle/archive-channel.js";
import { listRegisteredProviders, registerProvider, registeredProvider, removeProvider, updateProvider, type ProviderRegistration } from "../../cli/provider-registry.js";
import { providerLaunchArguments, providerLaunchOptionsSchema } from "../../cli/provider-launch-options.js";
import { drainRuntimeOutput, waitForProviderReady } from "../../cli/runtime-drain.js";
import type { RoomsCLIBackend, RuntimeAttachCLIInput } from "../../cli/backend.js";
import { stampRoomsProvenance } from "../../domain/message-provenance.js";
import { providerModelCatalog } from "../../providers/model-catalog.js";

const now = () => new Date().toISOString();
export const DEFAULT_QUERY_LIMIT = 50;
export const MAX_QUERY_LIMIT = 500;

function queryLimit(value: unknown): number {
  const parsed = value == null || value === 0 ? DEFAULT_QUERY_LIMIT : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_QUERY_LIMIT) {
    throw new RoomsStoreError("invalidLimit", `limit must be an integer between 1 and ${MAX_QUERY_LIMIT}`);
  }
  return parsed;
}

/**
 * Federation wiring the composition accepts by injection. Absent means a
 * single-machine build: the tree may omit src/federation entirely and this
 * module still compiles and serves every local surface.
 */
export type FederationCompositionPlug = Readonly<{
  createTerminalRuntimeHandler(runtimeService: RoomsRuntimeService, homeAuthorityId: string, stateDir: string): unknown;
  withChannelHomeRouting(input: Readonly<{ base: unknown; database: RoomsRepository; application: RoomsApplication; runtimeService: RoomsRuntimeService; homeAuthorityId: string }>): unknown;
  withMachineInventory(input: Readonly<{ base: unknown; database: RoomsRepository; authorityId: string; stateDir: string }>): unknown;
}>;

/** Compose the native runtime against the same SQLite authority as the CLI. */
export function createNativeComposition(databasePath: string, hostExecutable = process.env.ROOMS_RUNTIME_HOST_BIN, stateDir = process.env.ROOMS_STATE_DIR ?? dirname(databasePath), federation?: FederationCompositionPlug): { database: RoomsRepository; handler: RoomsServiceHandler; runtimeService: RoomsRuntimeService; relayHandlerFactory: (() => unknown) | null } {
  const database = new RoomsRepository(prepareCanonicalStorePath(databasePath));
  const application = new RoomsApplication(database);
  const homeAuthorityId = readMachineIdentityStatus(stateDir).authorityId;
  const runtimeService = new RoomsRuntimeService(new RuntimeRepository(database.db, {
    onLifecycleChange: (change) => { database.recordRuntimeLifecycle(change); },
  }), { machineId: hostname(), defaultHomeAuthorityId: homeAuthorityId, stateDir: join(stateDir, "runtimes"), socketDirectory: join(stateDir, "s"), hostExecutable });
  const blueprints = new SQLiteBlueprintStore(database.db);
  const channelLifecycle = new LocalChannelLifecycle(database, blueprints, runtimeService, homeAuthorityId, stateDir);
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
  const ownerActor = (request: any, channelId?: string): RuntimeActor => {
    const actor = runtimeActor(request);
    if (actor.role !== "operator") throw new Error("owner operator credential is required");
    const owner = channelId ? database.currentChannel(channelId)?.ownerOperatorSessionId : null;
    const activeOperatorMember = channelId ? database.isActiveMember(channelId, actor.sessionId, "operator") : false;
    if (owner && owner !== actor.sessionId && !activeOperatorMember) throw new Error("owning or active channel operator credential is required");
    return actor;
  };
  const describeProvider = (provider: ProviderRegistration): Record<string, unknown> => ({ ...provider, launchOptions: providerLaunchOptionsSchema(provider.name), modelCatalog: providerModelCatalog(provider.name, stateDir) });
  const providerRegistryResponse = (): { providers: Record<string, unknown>[] } => ({ providers: listRegisteredProviders(stateDir).map(describeProvider) });
  const resolveSessionRuntime = async (request: any): Promise<RuntimeAttachCLIInput> => {
    const actor = runtimeActor(request);
    const listed = await runtimeService.list({}, actor) as { runtimes?: Array<{ runtimeId: string; homeAuthorityId: string; sessionId: string; generation: number; state: string; endedAt?: string | null }> };
    const runtime = (listed.runtimes ?? [])
      .filter(item => item.sessionId === request.sessionId && !item.endedAt && ["running", "recovering"].includes(item.state))
      .sort((left, right) => right.generation - left.generation)[0];
    if (!runtime) throw new Error(`session ${request.sessionId} has no active Rooms runtime`);
    return { credential: actor.credentialId, runtimeId: runtime.runtimeId, homeAuthorityId: runtime.homeAuthorityId, sessionId: request.sessionId, generation: runtime.generation, viewerId: actor.sessionId, mode: request.mode ?? "controller", outputCursor: request.outputCursor };
  };
  const attachBackend = (actor: RuntimeActor): Pick<RoomsCLIBackend, "runtimeAttachInteractive"> => ({
    runtimeAttachInteractive: async (input, handlers) => {
      const session = await runtimeService.attachInteractive(input as never, actor, {
        onOutput: value => handlers.onOutput({ cursor: value.cursor.toString(), bytes: value.bytes }),
        onExit: value => handlers.onExit({ code: value.code }),
        onError: value => handlers.onError({ code: value.code, message: value.message }),
        onClose: handlers.onClose,
      });
      return {
        hello: { replayFrom: session.hello.replayFrom.toString(), head: session.hello.head.toString(), gap: session.hello.gap },
        input: bytes => session.input(bytes),
        resize: (columns, rows) => session.resize(columns, rows),
        detach: async () => session.detach(),
      };
    },
  });
  const unsupported = (method: string) => async (): Promise<never> => { throw new Error(`${method} is not available in this runtime slice`); };
  const unsupportedWatch = async function* (): AsyncIterable<never> { throw new Error("watch is not available in this runtime slice"); };
  const inspectRotationRuntime = (channelId: string, sessionId: string): RotationRuntime | null => {
    const membership = database.roster(channelId).find((member: any) => member.sessionId === sessionId);
    if (!membership) return null;
    const inspected = database.inspectSession(sessionId);
    const runtime = inspected.runtime;
    if (!runtime) return null;
    const binding = database.db.prepare("SELECT adapter_kind, launch_policy_ref FROM runtime_bindings WHERE runtime_id=? AND unbound_at IS NULL").get(runtime.runtimeId) as { adapter_kind?: string; launch_policy_ref?: string | null } | undefined;
    const member = blueprints.read(channelId)?.members.find(item => item.priorSessionId === sessionId);
    const persisted = binding?.launch_policy_ref ? JSON.parse(binding.launch_policy_ref) as Record<string, unknown> : null;
    const options = persisted ?? (member ? { command: [member.launch.executable, ...member.launch.args], cwd: member.launch.cwd } : {});
    const identity = launchIdentity(options);
    return { runtimeId: runtime.runtimeId, sessionId, generation: runtime.generation, state: runtime.state,
      providerThreadId: runtime.providerThreadId, providerTurn: { phase: runtime.providerTurn.phase, reason: runtime.providerTurn.reason }, role: (membership as any).role,
      launch: { provider: binding?.adapter_kind ?? member?.adapterKind ?? "unknown", model: identity.model,
        reasoning: identity.reasoning, launchOptions: options } };
  };
  const rotationRepository = new SQLiteRotationRepository(database.db, inspectRotationRuntime);
  const rotationService = new AgentRotationService(rotationRepository, {
    async sendPrepare(input) {
      const actor: RuntimeActor = { sessionId: input.sessionId, role: "operator", credentialId: "rotation-authority" };
      const target = runtimeService.resolveActiveSessionRuntimeForDelivery(input.sessionId, actor);
      const body = `[Rooms rotation prepare] rotation=${input.rotationId} nonce=${input.nonce}. Finish the current turn, then acknowledge with rooms rotation acknowledge --rotation ${input.rotationId} --nonce ${input.nonce} --credential ${input.sessionId}.`;
      const receipt = application.commitMessage({ channelId: input.channelId, senderSessionId: input.sessionId, body, target: { kind: "direct", sessionId: input.sessionId, sessionIds: [input.sessionId] }, deliveryStatuses: { [input.sessionId]: "queued" } });
      const submission = encodeProviderSubmission(body);
      await runtimeService.deliverMessage({ runtimeId: target.runtime.runtimeId, generation: target.runtime.generation, messageId: (receipt.event as any).id, frames: submission.frames, delaysMs: submission.delaysMs }, target.actor);
      database.appendMessageDelivery((receipt.event as any).id, { [input.sessionId]: "delivered" });
    },
    async launchReplacement(input) {
      const replacementSessionId = `${input.prior.sessionId}-rotation-${randomUUID().slice(0, 8)}`;
      database.insertSession({ id: replacementSessionId, displayName: replacementSessionId, role: "worker" });
      const launchOptions = input.prior.launch.launchOptions as { command?: string[]; cwd?: string; model?: string; reasoning?: string };
      const command = Array.isArray(launchOptions.command) ? launchOptions.command : undefined;
      if (!command?.length || typeof launchOptions.cwd !== "string") throw new Error("rotationLaunchConfigurationUnavailable");
      const response = await runtimeService.create({ homeAuthorityId, sessionId: replacementSessionId, generation: 1, channelId: input.channelId,
        adapterKind: input.prior.launch.provider, cwd: launchOptions.cwd, command, launchPolicyRef: JSON.stringify(launchOptions) } as any,
        { sessionId: input.prior.sessionId, role: "operator", credentialId: "rotation-authority" });
      const runtime = (response as any).runtime;
      return { ...input.prior, runtimeId: runtime.runtimeId, sessionId: replacementSessionId, generation: runtime.generation, state: runtime.state, providerThreadId: runtime.providerThreadId };
    },
    async inspectRuntime(runtimeId) {
      let row = database.db.prepare("SELECT session_id FROM runtimes WHERE runtime_id=?").get(runtimeId) as { session_id?: string } | undefined;
      if (!row) return null;
      const binding = database.db.prepare("SELECT channel_id FROM runtime_bindings WHERE runtime_id=? AND unbound_at IS NULL").get(runtimeId) as { channel_id?: string } | undefined;
      if (!binding?.channel_id) return null;
      const sessionId = String(row.session_id);
      let inspected = database.inspectSession(sessionId).runtime;
      for (let attempt = 0; inspected && inspected.state === "running" && !inspected.providerThreadId && attempt < 150; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        inspected = database.inspectSession(sessionId).runtime;
      }
      const policy = database.db.prepare("SELECT adapter_kind, launch_policy_ref FROM runtime_bindings WHERE runtime_id=? AND unbound_at IS NULL").get(runtimeId) as { adapter_kind?: string; launch_policy_ref?: string | null };
      const options = policy.launch_policy_ref ? JSON.parse(policy.launch_policy_ref) as Record<string, unknown> : {};
      const identity = launchIdentity(options);
      return inspected ? { runtimeId, sessionId, generation: inspected.generation, state: inspected.state, providerThreadId: inspected.providerThreadId,
        providerTurn: { phase: inspected.providerTurn.phase, reason: inspected.providerTurn.reason }, role: "worker", launch: { provider: String(policy.adapter_kind), model: identity.model,
          reasoning: identity.reasoning, launchOptions: options } } : null;
    },
    async terminate(input) { await runtimeService.terminate({ runtimeId: input.runtimeId, generation: input.generation } as any, { sessionId: input.sessionId, role: "operator", credentialId: "rotation-authority" }); },
  });
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
    async updateChannelBroadcastPolicy(request: any): Promise<any> {
      const actorId = authenticated(request);
      const role = database.sessionRoleValue(actorId);
      if (!role) throw new Error("channel actor session is unavailable");
      const receipt = application.setChannelBroadcastPolicy(request.channelId, request.broadcastPolicy, { credentialId: request.context?.credential ?? "authenticated", actorSessionId: actorId, role });
      return { channel: database.currentChannel(request.channelId), cursor: receipt.cursor };
    },
    async registerSession(request: any): Promise<any> {
      if (request.channelId) {
        const receipt = database.registerSession(request.channelId, request.sessionId, request.role ?? "worker", request.externalId ?? null, request.deliveryMode ?? null);
        return { session: database.currentSession(request.sessionId), membership: database.roster(request.channelId).find((item: any) => item.sessionId === request.sessionId), idempotent: receipt.idempotent };
      }
      return { session: database.currentSession(request.sessionId) ?? database.insertSession({ id: request.sessionId, displayName: request.displayName ?? null, role: request.role, deliveryMode: request.deliveryMode ?? null }).changes[0]?.payload };
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
      if (request.senderSessionId && request.senderSessionId !== sessionId) throw new Error("senderSessionId does not match authenticated session");
      let target = request.target ?? { kind: "here", sessionIds: [] };
      if (target.kind === "broadcast") {
        if (!request.channelId || !database.isActiveMember(request.channelId, sessionId)) throw new Error("broadcast sender is not an active channel member");
        // A privileged channel accepts broadcasts only from the operator and
        // the planner: a broadcast is typed into every member's terminal, so
        // the channel owner decides who may spend everyone's turn.
        const senderRole = database.sessionRoleValue(sessionId);
        if (database.currentChannel(request.channelId)?.broadcastPolicy === "privileged" && senderRole !== "operator" && senderRole !== "planner") {
          throw new RoomsStoreError("broadcastRestricted", `channel ${request.channelId} restricts broadcasts to the operator and planner; send directly instead: rooms session send <target-session> --body <text>`);
        }
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
        // A log-delivered participant (e.g. a UI operator) has no runtime by
        // design: committing to the channel log IS its delivery.
        if (database.sessionDeliveryModeValue(recipient) === "log") { statuses[recipient] = "delivered"; continue; }
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
      const receipt = application.commitMessage({ channelId: request.channelId ?? null, senderSessionId: sessionId, body: request.body, target, replyToEventId: request.replyToEventId, correlation: request.correlation, deliveryStatuses: statuses });
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
    async commitControl(request: any): Promise<any> {
      const sessionId = authenticated(request);
      const role = database.sessionRoleValue(sessionId);
      if (!role) throw new Error("control actor session is unavailable");
      const receipt = application.commitControl({ channelId: request.channelId, senderSessionId: request.senderSessionId, kind: request.kind, payload: request.payload, requestId: request.requestId }, { credentialId: request.context?.credential ?? "authenticated", actorSessionId: sessionId, role });
      return { event: receipt.event, cursor: receipt.cursor, wasDeduplicated: receipt.wasDeduplicated ?? false };
    },
    async getControls(request: any): Promise<any> {
      const sessionId = authenticated(request);
      if (!database.isActiveMember(request.channelId, sessionId)) throw new Error("control reader is not an active channel member");
      const limit = Math.max(1, Math.min(Number(request.limit ?? 100), 500));
      const changes = database.replay(request.afterCursor ?? "0", request.channelId).filter((change: any) => change.kind === "control.committed");
      const selected = changes.slice(0, limit);
      return { events: selected.map((change: any) => change.payload), cursor: selected.at(-1)?.cursor ?? request.afterCursor ?? "0", hasMore: changes.length > selected.length };
    },
    async getEvents(request: any): Promise<any> {
      const afterCursor = request.afterCursor ?? (request.afterEventId ? database.messageCursor(request.afterEventId, request.channelId) : "0");
      if (request.eventId && request.replyToEventId) throw new RoomsStoreError("invalidMessageQuery", "eventId and replyToEventId cannot be combined");
      if (request.eventId) {
        const exact = database.messageById(request.eventId, request.channelId);
        return { events: [exact.event], cursor: exact.cursor, oldestCursor: exact.cursor, hasMore: false };
      }
      if (request.replyToEventId) {
        return database.messageReplies(request.replyToEventId, {
          afterCursor,
          channelId: request.channelId,
          sessionId: request.sessionId,
          limit: request.limit,
        });
      }
      // A session-scoped request filters and bounds in SQL; an unbounded replay
      // of a busy channel would exceed the socket response limit on its own.
      if (request.sessionId) {
        return database.sessionMessages(request.sessionId, {
          afterCursor,
          channelId: request.channelId,
          limit: request.limit,
        });
      }
      const changes = database.replay(afterCursor, request.channelId);
      const messages = changes.filter((change) => change.kind === "message.sent").map((change) => change.payload);
      return { events: messages, cursor: changes.at(-1)?.cursor ?? afterCursor, hasMore: false };
    },
    async getThreadLifecycle(request: any): Promise<any> {
      const actorId = authenticated(request);
      const thread = database.threadLifecycle(request.threadRootEventId, request.channelId);
      if (!database.isActiveMember(thread.channelId, actorId)) throw new RoomsStoreError("notMember");
      return { thread };
    },
    async resolveThread(request: any): Promise<any> {
      const actorId = authenticated(request);
      const receipt = database.resolveThread(request.threadRootEventId, actorId, request.channelId);
      return { thread: receipt.thread, cursor: receipt.cursor };
    },
    async reopenThread(request: any): Promise<any> {
      const actorId = authenticated(request);
      const receipt = database.reopenThread(request.threadRootEventId, actorId, request.channelId);
      return { thread: receipt.thread, cursor: receipt.cursor };
    },
    async getSnapshot(request: any): Promise<any> { return { snapshot: database.snapshot(request.channelId) }; },
    async channelStateSnapshots(request: any): Promise<any> { return database.channelStateSnapshots(request.channelIds ?? []); },
    async channelControlPages(request: any): Promise<any> { return database.channelControlPages(request.channels ?? [], request.sessionId ?? "", request.limit ?? 100); },
    async usageSeries(request: any): Promise<any> {
      const actor = authenticated(request);
      if (request.scope === "session") {
        if (actor !== request.id && database.sessionRoleValue(actor) !== "operator") throw new RoomsStoreError("usageAccessDenied");
      } else if (request.scope === "channel") {
        if (!database.isActiveMember(request.id, actor)) throw new RoomsStoreError("usageAccessDenied");
      } else throw new RoomsStoreError("invalidUsageScope");
      return database.usageSeries(request.scope, request.id, request.window, request.collect === true);
    },
    async registerChannelSession(request: any): Promise<any> {
      ownerActor(request, request.channelId);
      const receipt = database.registerSession(request.channelId, request.sessionId, request.role ?? "worker", request.externalId ?? null, request.deliveryMode ?? null);
      return { session: database.currentSession(request.sessionId), membership: database.roster(request.channelId).find((item: any) => item.sessionId === request.sessionId), idempotent: receipt.idempotent };
    },
    async launchSession(request: any): Promise<any> {
      const actor = runtimeActor(request);
      const role = request.role ?? "worker";
      if (actor.role !== "operator" && !(actor.role === "planner" && role === "worker" && database.isActiveMember(request.channelId, actor.sessionId, "planner"))) {
        throw new Error("session launch requires an operator or the channel's active planner launching a worker");
      }
      const registration = registeredProvider(request.provider, stateDir);
      const catalog = providerModelCatalog(request.provider, stateDir);
      if (catalog) {
        const model = request.launchOptions?.model;
        const accepted = catalog.models.flatMap(entry => [entry.id, ...entry.aliases]);
        if (model !== undefined && (typeof model !== "string" || !accepted.includes(model))) throw new Error(`model must be an available ${request.provider} catalog id`);
        const reasoning = request.launchOptions?.reasoningEffort;
        const effectiveModel = model ?? registration.defaults.model;
        const entry = catalog.models.find(item => item.id === effectiveModel || item.aliases.includes(String(effectiveModel)));
        if (reasoning !== undefined && entry && !entry.reasoningLevels.includes(reasoning)) throw new Error(`reasoningEffort is not supported by ${effectiveModel}`);
      }
      const providerArguments = Array.isArray(request.providerArguments) ? request.providerArguments.map(String) : [];
      const translatedArguments = providerLaunchArguments(request.provider, registration.adapter, request.launchOptions ?? {}, registration.defaults, providerArguments);
      const command = [registration.executable, ...translatedArguments];
      database.registerSession(request.channelId, request.sessionId, role, null, "runtime");
      let launched: any;
      try {
        launched = await runtimeService.create({
          homeAuthorityId,
          sessionId: request.sessionId,
          generation: 1,
          channelId: request.channelId,
          adapterKind: registration.adapter,
          providerThreadId: null,
          cwd: request.cwd,
          command,
          launchPolicyRef: JSON.stringify({ ...request.launchOptions, command, cwd: request.cwd }),
        } as never, actor);
        const runtime = launched.runtime;
        if (!runtime?.runtimeId) throw new Error("launched runtime did not return an identity");
        const providerThreadId = runtime.providerThreadId ?? null;
        if (providerThreadId) database.setSessionProviderThreadId(request.sessionId, providerThreadId);
        channelLifecycle.canonical.ensureBlueprint(request.channelId, request.channelId, {
          channelId: request.channelId,
          priorSessionId: request.sessionId,
          intent: { role, workUnitId: null },
          launch: { executable: command[0]!, args: command.slice(1), cwd: request.cwd },
          layout: { terminalColumns: null, terminalRows: null, layoutVersion: "1" },
          adapterKind: registration.adapter,
          lastAcknowledgedDeliveryCursor: "0",
          role,
          joinedAt: now(),
          processGeneration: 1,
          provider: providerThreadId ? { conversationId: providerThreadId, resumeDescriptor: { provider: request.provider, cwd: request.cwd, prompt: request.prompt, mode: "runtime" } } : null,
        });
        const attachInput: RuntimeAttachCLIInput = { credential: actor.credentialId, runtimeId: runtime.runtimeId, homeAuthorityId: runtime.homeAuthorityId, sessionId: request.sessionId, generation: runtime.generation, viewerId: actor.sessionId, mode: "observe" };
        const providerReady = await waitForProviderReady(attachInput, attachBackend(actor) as RoomsCLIBackend);
        const timeoutMs = request.promptTimeoutMs == null ? 30_000 : Number(request.promptTimeoutMs);
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error("promptTimeoutMs must be a non-negative integer");
        const prompt = `You are a Rooms session ${request.sessionId}.\n\n${request.prompt}`;
        const delivery = await deliverManagedLaunchPrompt({
          timeoutMs,
          send: () => handler.send({ ...request, senderSessionId: actor.sessionId, body: prompt, target: { kind: "direct", sessionId: request.sessionId, sessionIds: [request.sessionId] } }),
          verify: async () => {
            try {
              const drained = await drainRuntimeOutput({ ...attachInput, outputCursor: providerReady.cursor }, attachBackend(actor) as RoomsCLIBackend, { durationMs: 8_000, idleMs: 3_000, awaitFirstOutput: true, minBytes: 400 });
              return drained.byteCount >= 400;
            } catch { return true; }
          },
          sessionId: request.sessionId,
        });
        return { session: database.currentSession(request.sessionId), runtime: launched, promptDelivered: true, promptAccepted: delivery.verified, promptDeliveryAttempts: delivery.attempts, providerReady };
      } catch (error) {
        const runtime = launched?.runtime;
        if (runtime?.runtimeId) {
          try { await runtimeService.terminate({ runtimeId: runtime.runtimeId, generation: runtime.generation } as never, actor); } catch { /* preserve launch failure */ }
        }
        if (database.currentSession(request.sessionId)?.endedAt === null) {
          try { application.endSession(request.sessionId, { credentialId: actor.credentialId, actorSessionId: actor.sessionId, role: actor.role }); } catch { /* preserve launch failure */ }
        }
        throw error;
      }
    },
    async inspectSession(request: any): Promise<any> {
      ownerActor(request);
      return database.inspectSession(request.sessionId);
    },
    async endManagedSession(request: any): Promise<any> {
      const actor = ownerActor(request);
      const listed = await runtimeService.list({}, actor) as { runtimes?: Array<{ runtimeId: string; sessionId: string; generation: number; state: string; endedAt?: string | null }> };
      for (const runtime of (listed.runtimes ?? []).filter(item => item.sessionId === request.sessionId && !item.endedAt && ["creating", "running", "recovering", "terminating"].includes(item.state))) {
        await runtimeService.terminate({ runtimeId: runtime.runtimeId, generation: runtime.generation } as never, actor);
      }
      const receipt = application.endSession(request.sessionId, { credentialId: actor.credentialId, actorSessionId: actor.sessionId, role: actor.role });
      return { session: database.currentSession(request.sessionId), cursor: receipt.cursor };
    },
    async sendMessage(request: any): Promise<any> {
      const actor = runtimeActor(request);
      return handler.send({
        ...request,
        senderSessionId: actor.sessionId,
        body: stampRoomsProvenance(actor.sessionId, request.body),
        target: request.targetSessionId
          ? { kind: "direct", sessionId: request.targetSessionId, sessionIds: [request.targetSessionId] }
          : { kind: "broadcast", sessionIds: [] },
      });
    },
    async suspendChannel(request: any): Promise<any> { return channelLifecycle.suspend(request.channelId, ownerActor(request, request.channelId)); },
    async resumeChannel(request: any): Promise<any> { return channelLifecycle.resume(request.channelId, ownerActor(request, request.channelId)); },
    async archiveChannel(request: any): Promise<any> {
      const actor = ownerActor(request, request.channelId);
      return archiveChannelLifecycle(database, { channelId: request.channelId, force: request.force === true }, {
        terminateRuntime: runtime => runtimeService.terminate({ runtimeId: runtime.runtimeId, generation: runtime.generation } as never, actor),
        closeChannel: async () => {
          const receipt = application.closeChannel(request.channelId, { credentialId: actor.credentialId, actorSessionId: actor.sessionId, role: actor.role });
          return { channel: database.currentChannel(request.channelId), cursor: receipt.cursor };
        },
      });
    },
    async listProviders(request: any): Promise<any> { ownerActor(request); return providerRegistryResponse(); },
    async writeProvider(request: any): Promise<any> {
      ownerActor(request);
      const input = { executable: request.executable, adapter: request.adapter, enabled: request.enabled, defaults: request.defaults };
      if (request.mode === "register") registerProvider(request.name, input, stateDir);
      else if (request.mode === "update") updateProvider(request.name, input, stateDir);
      else throw new Error("provider write mode must be register or update");
      return providerRegistryResponse();
    },
    async removeProvider(request: any): Promise<any> { ownerActor(request); removeProvider(request.name, stateDir); return providerRegistryResponse(); },
    async resolveSessionRuntime(request: any): Promise<any> { const { credential: _, ...resolved } = await resolveSessionRuntime(request); return resolved; },
    async rotationInspect(request: any): Promise<any> { const actor = authenticated(request); if (database.sessionRoleValue(actor) !== "planner") throw new Error("rotationPlannerRequired"); return rotationService.inspect(request.channelId, request.sessionId); },
    async rotationPrepare(request: any): Promise<any> { const actorSessionId = authenticated(request); return rotationService.prepare({ channelId: request.channelId, sessionId: request.sessionId, actorSessionId }); },
    async rotationAcknowledge(request: any): Promise<any> { const sessionId = authenticated(request); return rotationService.acknowledge({ rotationId: request.rotationId, nonce: request.nonce, sessionId }); },
    async rotationCommit(request: any): Promise<any> { const actorSessionId = authenticated(request); return rotationService.commit({ rotationId: request.rotationId, actorSessionId }); },
    async rotationCancel(request: any): Promise<any> { const actorSessionId = authenticated(request); return rotationService.cancel({ rotationId: request.rotationId, actorSessionId, reason: request.reason }); },
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
      const limit = queryLimit(request.limit);
      const query = String(request.query ?? "").toLowerCase();
      const scope = request.scope ?? (request.channelId ? "channel" : "all");
      if (scope !== "channel" && scope !== "all") throw new RoomsStoreError("invalidSearchScope", "search scope must be channel or all");
      if (scope === "channel" && !String(request.channelId ?? "").trim()) throw new RoomsStoreError("invalidChannel", "channel search requires channelId");
      const changes = database.replay("0", scope === "channel" ? request.channelId : undefined);
      const events = changes
        .reverse()
        .filter((change: any) => change.kind === "message.sent")
        .map((change: any) => change.payload)
        .filter((event: any) => String(event.body ?? "").toLowerCase().includes(query))
        .slice(0, limit);
      return { events };
    },
    async getRecipients(request: any): Promise<any> {
      const changes = database.replay("0", undefined);
      const event: any = changes.find((change: any) => change.kind === "message.sent" && change.payload?.id === request.eventId)?.payload;
      return { recipients: event?.deliveredRecipientSessionIds ?? [] };
    },
    watch: async function* (request: any): AsyncIterable<any> {
      if (request.channelId && request.afterCursor == null) yield { snapshot: database.snapshot(request.channelId) };
      for (const change of database.replay(request.afterCursor ?? "0", request.channelId)) yield { delta: change };
      const queue: any[] = [];
      let wake: (() => void) | null = null;
      const remove = database.onChange((change) => {
        if (request.channelId && change.channelId !== null && change.channelId !== request.channelId) return;
        queue.push(change);
        if (queue.length > DEFAULT_MAX_BUFFERED_DELTA_BATCHES) {
          wake?.();
          return;
        }
        wake?.();
      });
      try {
        while (true) {
          if (!queue.length) await new Promise<void>(resolve => { wake = resolve; });
          if (queue.length > DEFAULT_MAX_BUFFERED_DELTA_BATCHES) throw new RoomsStoreError("backpressure", `watch buffered more than ${DEFAULT_MAX_BUFFERED_DELTA_BATCHES} deltas`);
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
    runtimeQuotaGet: async (request: any) => ({ quotas: runtimeService.quotaStatuses(request.machineId) }),
    runtimeQuotaSet: async (request: any) => ({ quota: runtimeService.setActiveRuntimeQuota(request.machineId, request.limit, runtimeActor(request)) }),
    runtimeQuotaReset: async (request: any) => ({ quota: runtimeService.resetActiveRuntimeQuota(request.machineId, runtimeActor(request)) }),
  };
  return {
    database,
    handler,
    runtimeService,
    relayHandlerFactory: federation ? () => federation.withMachineInventory({
      base: federation.withChannelHomeRouting({
        base: federation.createTerminalRuntimeHandler(runtimeService, homeAuthorityId, stateDir),
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

function launchIdentity(options: Readonly<Record<string, unknown>>): { model: string | null; reasoning: string | null } {
  const command = Array.isArray(options.command) ? options.command.map(String) : [];
  const valueAfter = (flag: string): string | null => { const index = command.indexOf(flag); return index >= 0 ? command[index + 1] ?? null : command.find(item => item.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? null; };
  const model = typeof options.model === "string" ? options.model : valueAfter("--model");
  const reasoning = typeof options.reasoning === "string" ? options.reasoning
    : valueAfter("--reasoning-effort") ?? valueAfter("--effort")
      ?? command.find(item => item.startsWith("model_reasoning_effort="))?.split("=", 2)[1] ?? null;
  return { model, reasoning };
}

async function deliverManagedLaunchPrompt(input: Readonly<{
  sessionId: string;
  timeoutMs: number;
  send(): Promise<unknown>;
  verify(): Promise<boolean>;
}>): Promise<{ attempts: number; verified: boolean }> {
  const deadline = Date.now() + input.timeoutMs;
  const backoffMs = [250, 500, 1_000, 2_000];
  let attempts = 0;
  let lastFailure = "the runtime never accepted the prompt";
  while (true) {
    attempts += 1;
    try {
      const result = await input.send() as { event?: { recipientStatuses?: Record<string, string> } };
      const status = result?.event?.recipientStatuses?.[input.sessionId];
      if (status === undefined || status === "delivered") {
        if (await input.verify()) return { attempts, verified: true };
        lastFailure = "the runtime took the prompt but the provider never acted on it";
      } else lastFailure = `the runtime reported delivery status "${status}"`;
    } catch (error) { lastFailure = error instanceof Error ? error.message : String(error); }
    const wait = backoffMs[Math.min(attempts - 1, backoffMs.length - 1)]!;
    if (Date.now() + wait >= deadline) throw new Error(`session ${input.sessionId} launched but its first prompt was never delivered after ${attempts} attempts: ${lastFailure}`);
    await new Promise(resolve => setTimeout(resolve, wait));
  }
}

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
import { listChannelProfileRevisions, readChannelProfileRevision } from "../../profiles/profile-revision-store.js";
import { captureProviderReplyScanState, scanProviderFinalReply, supportsProviderFinalReply, type ProviderReplyScanState } from "../provider-final-reply.js";
import { ProviderReplyBridge } from "../provider-reply-bridge.js";
import { prepareManagedProviderLaunch } from "../provider-managed-launch.js";
import { SessionProofBootstrap } from "../../credentials/session-proof-bootstrap.js";
import { OperatorCredentialStore } from "../../credentials/operator-credential.js";
import { materializeCodexControlledHome } from "../../cli/codex-controlled-home.js";
import { listSessionProfileBindings, persistSessionProfileBinding } from "../../profiles/session-profile-binding-store.js";
import { materializeProfileToolEnvironment } from "../../profiles/profile-tool-environment.js";
import { createNextChannelProfileRevision, listProfileSkillCatalog, readChannelProfileRevisionForChannel } from "../../profiles/channel-profile-api.js";
import { sessionLaunchProvenance } from "../../domain/session-provenance.js";

const now = () => new Date().toISOString();
export const DEFAULT_QUERY_LIMIT = 50;
export const MAX_QUERY_LIMIT = 500;

/**
 * A profile launch keeps provider-owned context and caller-owned task content
 * distinct. The profile materializer supplies the former through Codex
 * developer instructions.
 */
export function composeSessionLaunchPrompt(sessionId: string, callerPrompt: string, controlledProfile: boolean): string {
  return controlledProfile ? callerPrompt : `You are a Rooms session ${sessionId}.\n\n${callerPrompt}`;
}

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
export function createNativeComposition(databasePath: string, hostExecutable = process.env.ROOMS_RUNTIME_HOST_BIN, stateDir = process.env.ROOMS_STATE_DIR ?? dirname(databasePath), federation?: FederationCompositionPlug): { database: RoomsRepository; handler: RoomsServiceHandler; runtimeService: RoomsRuntimeService; providerReplyBridge: ProviderReplyBridge; relayHandlerFactory: (() => unknown) | null; homeAuthorityId: string } {
  const database = new RoomsRepository(prepareCanonicalStorePath(databasePath));
  const application = new RoomsApplication(database);
  const homeAuthorityId = readMachineIdentityStatus(stateDir).authorityId;
  const runtimeService = new RoomsRuntimeService(new RuntimeRepository(database.db, {
    onLifecycleChange: (change) => { database.recordRuntimeLifecycle(change); },
  }), { machineId: hostname(), defaultHomeAuthorityId: homeAuthorityId, stateDir: join(stateDir, "runtimes"), socketDirectory: join(stateDir, "s"), hostExecutable });
  const runtimeRepository = new RuntimeRepository(database.db);
  const proofBootstrap = new SessionProofBootstrap(stateDir, runtimeRepository.legacyOperatorSessionsNeedingProof());
  const operatorCredentials = new OperatorCredentialStore(stateDir);
  let handler: RoomsServiceHandler;
  const providerReplyBridge = new ProviderReplyBridge(database, application, undefined, async (reply) => handler.send({
    senderSessionId: reply.senderSessionId,
    channelId: reply.channelId,
    target: { kind: "direct", sessionId: reply.targetSessionId },
    body: reply.body,
    replyToEventId: reply.replyToEventId,
    correlation: reply.correlation,
    __connection: { authenticatedSessionId: reply.senderSessionId, credentials: new Map(), onClose: new Set() },
  } as never) as Promise<{ event: { id: string } }>);
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
    if (state.bootstrapCredentials?.has(credential)) throw new Error("bootstrap credential permits only its session relaunch");
    const role = database.sessionRoleValue(sessionId);
    if (!role) throw new Error("runtime actor session is unavailable");
    return { sessionId, role, credentialId: credential };
  };
  const consumedBootstrapActor = (request: any): RuntimeActor | null => {
    const state = connection(request);
    const credential = request?.context?.credential;
    const bootstrapSessionId = typeof credential === "string" ? state.bootstrapCredentials?.get(credential) : undefined;
    if (!bootstrapSessionId) return null;
    return { sessionId: bootstrapSessionId, role: "operator", credentialId: credential };
  };
  const runtimeCreateActor = (request: any): { actor: RuntimeActor; bootstrap: boolean } => {
    const state = connection(request);
    const bootstrapActor = consumedBootstrapActor(request);
    if (!bootstrapActor) return { actor: runtimeActor(request), bootstrap: false };
    const bootstrapSessionId = bootstrapActor.sessionId;
    if (state.authenticatedSessionId !== bootstrapSessionId || request.sessionId !== bootstrapSessionId || database.sessionRoleValue(bootstrapSessionId) !== "operator") {
      throw new Error("bootstrap credential permits only its session relaunch");
    }
    return { actor: bootstrapActor, bootstrap: true };
  };
  const revokeBootstrapCredential = (request: any, actor: RuntimeActor): void => {
    const state = connection(request);
    state.bootstrapCredentials?.delete(actor.credentialId);
    state.credentials.delete(actor.credentialId);
    if (state.authenticatedSessionId === actor.sessionId) state.authenticatedSessionId = undefined;
    if (state.authenticatedCredential === actor.credentialId) state.authenticatedCredential = undefined;
  };
  const ownerActor = (request: any, channelId?: string): RuntimeActor => {
    const actor = runtimeActor(request);
    if (actor.role !== "operator") throw new Error("owner operator credential is required");
    const owner = channelId ? database.currentChannel(channelId)?.ownerOperatorSessionId : null;
    const activeOperatorMember = channelId ? database.isActiveMember(channelId, actor.sessionId, "operator") : false;
    if (owner && owner !== actor.sessionId && !activeOperatorMember) throw new Error("owning or active channel operator credential is required");
    return actor;
  };
  const profileChannelActor = (request: any, requireActive = false): RuntimeActor => {
    const channelId = typeof request.channelId === "string" ? request.channelId : "";
    const channel = channelId ? database.currentChannel(channelId) : null;
    if (!channel) throw new Error("profile channel does not exist");
    if (requireActive && channel.lifecycleState !== "active") throw new Error("profile channel is not active");
    return ownerActor(request, channelId);
  };
  const externalOwnerActor = (request: any): RuntimeActor => {
    const actor = ownerActor(request, request.channelId);
    const owner = typeof request.externalOwner === "string" ? request.externalOwner.trim() : "";
    const legacyOwner = database.currentSession(actor.sessionId)?.externalOwner;
    if (!owner || (owner !== actor.sessionId && legacyOwner !== owner)) throw new RoomsStoreError("externalOwnerAccessDenied");
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
      // The replacement resumes the prior provider thread, whose transcript
      // lives inside the prior generation's home; a controlled home must
      // therefore survive rotation.
      const priorHome = database.db.prepare("SELECT effective_home FROM runtimes WHERE runtime_id=?").get(input.prior.runtimeId) as { effective_home?: string | null } | undefined;
      const response = await runtimeService.create({ homeAuthorityId, sessionId: replacementSessionId, generation: 1, channelId: input.channelId,
        adapterKind: input.prior.launch.provider, cwd: launchOptions.cwd, effectiveHome: priorHome?.effective_home ?? null, command, launchPolicyRef: JSON.stringify(launchOptions) } as any,
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
  handler = {
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
    async updateChannelCoordinationPolicy(request: any): Promise<any> {
      const actorId = authenticated(request);
      const role = database.sessionRoleValue(actorId);
      if (!role) throw new RoomsStoreError("unauthorized");
      const receipt = application.setChannelCoordinationPolicy(request.channelId, request.coordinationPolicy, { credentialId: request.context?.credential ?? "authenticated", actorSessionId: actorId, role });
      return { channel: database.currentChannel(request.channelId), cursor: receipt.cursor };
    },
    async registerSession(request: any): Promise<any> {
      if (request.channelId) {
        const receipt = database.registerSession(request.channelId, request.sessionId, request.role ?? "worker", request.externalId ?? null, request.deliveryMode ?? null);
        return { session: database.currentSession(request.sessionId), membership: database.roster(request.channelId).find((item: any) => item.sessionId === request.sessionId), idempotent: receipt.idempotent };
      }
      const existing = database.currentSession(request.sessionId);
      if (existing?.role === "operator" && request.context?.credential) {
        const actor = authenticated(request);
        if (actor !== request.sessionId) throw new RoomsStoreError("operatorSessionNotRecoverable");
        database.reactivateOperatorSession(request.sessionId);
      } else if (existing?.endedAt) {
        throw new RoomsStoreError("operatorSessionNotRecoverable");
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
      const channel = request.channelId ? database.currentChannel(request.channelId) : null;
      const senderRole = database.sessionRoleValue(sessionId);
      if (channel?.coordinationPolicy === "lead-upstream" && senderRole === "worker") {
        const planners = database.roster(request.channelId).filter((member: any) => member.role === "planner") as Array<{ sessionId: string }>;
        const upstreamSessionId = planners.length === 1 ? planners[0].sessionId : channel.ownerOperatorSessionId;
        if (!upstreamSessionId) throw new RoomsStoreError("upstreamUnavailable", `channel ${request.channelId} has no active lead or owning operator`);
        if (target.kind !== "direct" || target.sessionId !== upstreamSessionId) {
          throw new RoomsStoreError("upstreamRestricted", `worker messages in channel ${request.channelId} must target the active lead, or the owning operator when no lead exists`);
        }
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
      const replyScans = new Map<string, { adapterKind: string; providerThreadId: string | null; state: ProviderReplyScanState }>();
      const shouldBridgeProviderReply = target.kind === "direct"
        && typeof request.channelId === "string"
        && request.channelId.length > 0
        && (database.sessionDeliveryModeValue(sessionId) === "log" || channel?.coordinationPolicy === "lead-upstream")
        && request.correlation?.purpose !== "sessionLaunchPrompt";
      for (const recipient of recipients) {
        // A log-delivered participant (e.g. a UI operator) has no runtime by
        // design: committing to the channel log IS its delivery.
        if (database.sessionDeliveryModeValue(recipient) === "log") { statuses[recipient] = "delivered"; continue; }
        try {
          const resolved = runtimeService.resolveActiveSessionRuntimeForDelivery(recipient, actor);
          runtimes.set(recipient, { ...resolved.runtime, actor: resolved.actor });
          if (shouldBridgeProviderReply) {
            const identity = database.activeRuntimeIdentityForSession(recipient);
            if (identity?.provider && supportsProviderFinalReply(identity.provider)) {
              replyScans.set(recipient, {
                adapterKind: identity.provider,
                providerThreadId: identity.providerThreadId,
                state: captureProviderReplyScanState(identity.provider, identity.providerThreadId, identity.effectiveHome ?? undefined),
              });
            }
          }
          statuses[recipient] = "queued";
        } catch (error) {
          if ((error as { code?: string }).code !== "runtimeNotFound") throw error;
          statuses[recipient] = "undeliverable";
          if (target.kind === "direct") throw new RoomsStoreError("recipientUndeliverable", `recipient session ${recipient} has no live runtime`);
        }
      }
      const receipt = application.commitMessage({ channelId: request.channelId ?? null, senderSessionId: sessionId, body: request.body, target, replyToEventId: request.replyToEventId, correlation: request.correlation, deliveryStatuses: statuses, attachmentReferences: request.attachmentReferences });
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
      if (target.kind === "direct" && statuses[target.sessionId] === "delivered") {
        const runtime = runtimes.get(target.sessionId);
        const scan = replyScans.get(target.sessionId);
        if (runtime && scan && request.channelId) {
          providerReplyBridge.enqueue({
            sourceEventId: event.id,
            sourceCursor: receipt.cursor,
            sourceBody: event.body,
            channelId: request.channelId,
            sourceSenderSessionId: sessionId,
            providerSessionId: target.sessionId,
            runtimeId: runtime.runtimeId,
            generation: runtime.generation,
            adapterKind: scan.adapterKind,
            providerThreadId: scan.providerThreadId,
            scanState: scan.state,
          });
        }
      }
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
      // A channel request that states a limit is paged in SQL for the same
      // reason: the caller asked for a page, not the channel's whole history.
      if (request.channelId && request.limit) {
        return database.channelMessages(request.channelId, { afterCursor, limit: request.limit });
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
      const receipt = database.registerSession(request.channelId, request.sessionId, request.role ?? "worker", request.externalId ?? null, request.deliveryMode ?? null, { externalOwner: request.externalOwner, externalAgentId: request.externalAgentId });
      return { session: database.currentSession(request.sessionId), membership: database.roster(request.channelId).find((item: any) => item.sessionId === request.sessionId), idempotent: receipt.idempotent };
    },
    async createChannelProfileRevision(request: any): Promise<any> {
      const actor = profileChannelActor(request, true);
      const draft = request.draft;
      if (!draft || typeof draft !== "object" || Array.isArray(draft)) throw new Error("profile draft is required");
      const requestedSkillCount = Array.isArray(draft.modelSkillSets)
        ? draft.modelSkillSets.reduce((count: number, set: any) => count + (Array.isArray(set?.skills) ? set.skills.length : 0), 0)
        : 0;
      const skillCatalog = requestedSkillCount > 0 ? listProfileSkillCatalog() : [];
      const skillsByPath = new Map(skillCatalog.map((skill) => [skill.sourcePath, skill]));
      for (const set of draft.modelSkillSets ?? []) {
        const catalog = providerModelCatalog(set.provider, stateDir);
        if (!catalog || catalog.version !== set.catalogVersion) throw new Error(`profile model set requires the current ${set.provider} catalog version`);
        const entry = catalog.models.find((model) => model.id === set.model);
        if (!entry || entry.availability !== "available" || entry.deprecated) throw new Error(`profile model must be a canonical available ${set.provider} catalog id`);
        for (const skill of set.skills ?? []) {
          const available = skillsByPath.get(skill.path);
          if (!available || available.name !== skill.name || !available.providers.includes(set.provider)) {
            throw new Error(`profile skill is not available for ${set.provider}: ${skill.name}`);
          }
        }
      }
      const profile = createNextChannelProfileRevision({ stateDir, channelId: request.channelId, name: request.name, createdBySessionId: actor.sessionId, draft });
      return { profile };
    },
    async readChannelProfileRevision(request: any): Promise<any> {
      profileChannelActor(request);
      return { profile: readChannelProfileRevisionForChannel(stateDir, request.channelId, request.revisionId) };
    },
    async listProfileSkillCatalog(request: any): Promise<any> {
      ownerActor(request);
      return { skills: listProfileSkillCatalog() };
    },
    async getSessionProfileBindings(request: any): Promise<any> {
      profileChannelActor(request);
      const bindings = listSessionProfileBindings(stateDir, request.sessionId).filter((binding) => binding.channelId === request.channelId);
      return { bindings };
    },
    async launchSession(request: any): Promise<any> {
      const actor = runtimeActor(request);
      const role = request.role ?? "worker";
      if (actor.role !== "operator" && !(actor.role === "planner" && role === "worker" && database.isActiveMember(request.channelId, actor.sessionId, "planner"))) {
        throw new Error("session launch requires an operator or the channel's active planner launching a worker");
      }
      const actorSession = database.currentSession(actor.sessionId);
      const { externalOwner, externalAgentId } = sessionLaunchProvenance({
        actorRole: actor.role,
        actorExternalOwner: actorSession?.externalOwner ?? null,
        targetSessionId: request.sessionId,
        externalOwner: request.externalOwner,
        externalAgentId: request.externalAgentId,
      });
      const registration = registeredProvider(request.provider, stateDir);
      let effectiveHome: string | null = request.effectiveHome ?? null;
      let profileEnvironment: Readonly<Record<string, string>> = {};
      const requestedProfile = request.provider === "codex" ? request.launchOptions?.profile : undefined;
      if (requestedProfile !== undefined) {
        if (typeof requestedProfile !== "string" || !requestedProfile.trim()) throw new Error("profile must be a non-empty revision ID");
        const profile = readChannelProfileRevision(stateDir, requestedProfile);
        if (profile.channelId !== request.channelId) throw new Error("profile revision does not belong to this channel");
        const requestedModel = request.launchOptions?.model;
        const modelSkillSet = profile.modelSkillSets.find(set => set.provider === "codex" && (requestedModel === undefined || set.model === requestedModel));
        if (!modelSkillSet) throw new Error("profile revision has no matching codex model skill set");
        effectiveHome = join(stateDir, "controlled", request.sessionId, "home");
        const projectInstructions = profile.projectInstructions.mode === "snapshot"
          ? { mode: "snapshot" as const, text: profile.projectInstructions.snapshots.map(snapshot => snapshot.text).join("\n") }
          : { mode: "exclude" as const };
        materializeCodexControlledHome({
          instructionsText: profile.instructions.text,
          systemContext: `You are a Rooms session ${request.sessionId}.`,
          projectInstructions,
          skills: modelSkillSet.skills.map(skill => ({ name: skill.name, snapshotPath: skill.snapshotPath, sha256: skill.rootSha256 })),
          model: modelSkillSet.model,
        }, { sessionDir: join(stateDir, "controlled", request.sessionId), homeDir: join(effectiveHome, ".codex"), authHomeDir: join(stateDir, "codex-auth-home"), trustedWorkingDirectory: request.cwd });
        profileEnvironment = materializeProfileToolEnvironment(effectiveHome, modelSkillSet.toolEnvironment).environment;
        persistSessionProfileBinding(stateDir, {
          id: `binding-${request.sessionId}`,
          sessionId: request.sessionId,
          channelId: request.channelId,
          profileRevisionId: profile.id,
          profileSha256: profile.sha256,
          modelSkillSetId: modelSkillSet.id,
          provider: "codex",
          requestedModel: String(requestedModel ?? modelSkillSet.model),
          effectiveModel: modelSkillSet.model,
          executablePath: registration.executable,
          executableVersion: "unknown",
          authAttestation: { requiredMode: modelSkillSet.authMode, resolvedMode: "unknown", credentialSource: "unknown", accountPresent: false, apiKeyEnvironmentVariables: [], verifiedAt: now() },
          resolvedStateAttestation: null,
          boundAt: now(),
        });
      }
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
      // A controlled profile carries Rooms identity and immutable channel rules
      // through Codex developer instructions. Keep the caller's task as the
      // exact initial user message so neither source is conflated with the other.
      const prompt = composeSessionLaunchPrompt(request.sessionId, request.prompt, requestedProfile !== undefined);
      const managedLaunch = prepareManagedProviderLaunch({
        adapterKind: registration.adapter,
        arguments: translatedArguments,
        prompt,
      });
      const homePrefix = effectiveHome
        ? ["/usr/bin/env", `CODEX_HOME=${effectiveHome}/.codex`, ...Object.entries(profileEnvironment).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => `${name}=${value}`)]
        : [];
      const relaunchCommand = [...homePrefix, registration.executable, ...translatedArguments];
      const command = [...homePrefix, registration.executable, ...managedLaunch.arguments];
      // Session generated home root (user-home-shaped, dot-dirs under it).
      // Profile launches materialize one and set it here; null stays ambient.
      const promptScan = managedLaunch.providerThreadId
        ? captureProviderReplyScanState(registration.adapter, managedLaunch.providerThreadId, effectiveHome ?? undefined)
        : null;
      database.registerSession(request.channelId, request.sessionId, role, null, "runtime", { externalOwner, externalAgentId });
      let launched: any;
      try {
        launched = await runtimeService.create({
          homeAuthorityId,
          sessionId: request.sessionId,
          generation: 1,
          channelId: request.channelId,
          adapterKind: registration.adapter,
          providerThreadId: managedLaunch.providerThreadId,
          cwd: request.cwd,
          effectiveHome,
          command,
          launchPolicyRef: JSON.stringify({ ...request.launchOptions, command: relaunchCommand, cwd: request.cwd }),
        } as never, actor);
        const runtime = launched.runtime;
        if (!runtime?.runtimeId) throw new Error("launched runtime did not return an identity");
        const providerThreadId = runtime.providerThreadId ?? null;
        if (providerThreadId) database.setSessionProviderThreadId(request.sessionId, providerThreadId);
        channelLifecycle.canonical.ensureBlueprint(request.channelId, request.channelId, {
          channelId: request.channelId,
          priorSessionId: request.sessionId,
          intent: { role, workUnitId: null },
          launch: { executable: relaunchCommand[0]!, args: relaunchCommand.slice(1), cwd: request.cwd, home: effectiveHome },
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
        const delivery = managedLaunch.promptPreloaded
          ? await acceptPreloadedProviderPrompt({
              adapterKind: registration.adapter,
              providerThreadId: managedLaunch.providerThreadId,
              prompt,
              scanState: promptScan,
              homeDirectory: effectiveHome,
              timeoutMs,
              resolveProviderThreadId: () => {
                const status = runtimeService.status({ runtimeId: runtime.runtimeId } as never, actor);
                return status.runtime?.providerThreadId ?? null;
              },
              commit: () => application.commitMessage({
                channelId: request.channelId,
                senderSessionId: actor.sessionId,
                body: prompt,
                target: { kind: "direct", sessionId: request.sessionId, sessionIds: [request.sessionId] },
                correlation: { purpose: "sessionLaunchPrompt" },
                deliveryStatuses: { [request.sessionId]: "delivered" },
              }),
            })
          : await deliverManagedLaunchPrompt({
              timeoutMs,
              send: () => handler.send({
                ...request,
                senderSessionId: actor.sessionId,
                body: prompt,
                target: { kind: "direct", sessionId: request.sessionId, sessionIds: [request.sessionId] },
                correlation: { purpose: "sessionLaunchPrompt" },
              }),
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
    async launchSessionWithProfile(request: any): Promise<any> {
      if (typeof request.profileRevisionId !== "string" || !request.profileRevisionId.trim()) throw new Error("profileRevisionId is required");
      if (typeof request.modelSkillSetId !== "string" || !request.modelSkillSetId.trim()) throw new Error("modelSkillSetId is required");
      const actor = runtimeActor(request);
      const role = request.role ?? "worker";
      if (actor.role !== "operator" && !(actor.role === "planner" && role === "worker" && database.isActiveMember(request.channelId, actor.sessionId, "planner"))) {
        throw new Error("session launch requires an operator or the channel's active planner launching a worker");
      }
      readChannelProfileRevisionForChannel(stateDir, request.channelId, request.profileRevisionId);
      throw new Error("controlled profile launch is not ready until resolved-state verification is installed");
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
    async listOwnedSessions(request: any): Promise<any> {
      externalOwnerActor(request);
      return { sessions: database.ownedSessions(request.channelId, request.externalOwner) };
    },
    async endOwnedSessions(request: any): Promise<any> {
      const actor = externalOwnerActor(request);
      const owned = database.ownedSessions(request.channelId, request.externalOwner);
      const requested = request.sessionIds == null ? null : new Set(request.sessionIds.map(String));
      if (requested && [...requested].some(id => !owned.some(session => session.id === id))) throw new RoomsStoreError("externalOwnerAccessDenied");
      const targets = requested ? owned.filter(session => requested.has(session.id)) : owned;
      const listed = await runtimeService.list({}, actor) as { runtimes?: Array<{ runtimeId: string; sessionId: string; generation: number; state: string; endedAt?: string | null }> };
      const ended: Array<{ sessionId: string; runtimes: Array<{ runtimeId: string; generation: number }> }> = [];
      for (const session of targets) {
        const runtimes = (listed.runtimes ?? []).filter(item => item.sessionId === session.id && !item.endedAt && ["creating", "running", "recovering", "terminating"].includes(item.state));
        for (const runtime of runtimes) await runtimeService.terminate({ runtimeId: runtime.runtimeId, generation: runtime.generation } as never, actor);
        application.endSession(session.id, { credentialId: actor.credentialId, actorSessionId: actor.sessionId, role: actor.role });
        ended.push({ sessionId: session.id, runtimes: runtimes.map(({ runtimeId, generation }) => ({ runtimeId, generation })) });
      }
      return { ended };
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
    async leadBroadcast(request: any): Promise<any> {
      const actor = runtimeActor(request);
      const idempotencyKey = typeof request.idempotencyKey === "string" ? request.idempotencyKey.trim() : "";
      const body = typeof request.body === "string" ? request.body : "";
      const channelIds: string[] = Array.isArray(request.channelIds) ? request.channelIds.map(String) : [];
      const attachmentReferences = request.attachmentReferences == null ? [] : request.attachmentReferences;
      if (!idempotencyKey || Buffer.byteLength(idempotencyKey, "utf8") > 512) throw new RoomsStoreError("invalidIdempotencyKey", "idempotencyKey must be 1-512 bytes");
      if (!body.trim()) throw new RoomsStoreError("emptyMessage");
      if (channelIds.length === 0 || channelIds.length > 100 || new Set(channelIds).size !== channelIds.length || channelIds.some(id => !id.trim())) throw new RoomsStoreError("invalidChannelIds", "channelIds must contain 1-100 distinct non-empty channel ids");
      if (!Array.isArray(attachmentReferences) || attachmentReferences.length > 32 || attachmentReferences.some(value => typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 2048)) throw new RoomsStoreError("invalidAttachmentReferences", "attachmentReferences must contain at most 32 non-empty references of at most 2048 bytes");
      const results: any[] = [];
      for (const channelId of channelIds) {
        const channel = database.currentChannel(channelId);
        if (!channel || channel.lifecycleState !== "active") {
          results.push({ channelId, status: "unavailable", error: { code: channel ? "channelClosed" : "channelNotFound", message: `channel ${channelId} is unavailable` } });
          continue;
        }
        const authorized = actor.role === "operator"
          && (channel.ownerOperatorSessionId === actor.sessionId || database.isActiveMember(channelId, actor.sessionId, "operator"));
        if (!authorized) {
          results.push({ channelId, status: "unauthorized", error: { code: "channelAuthorizationRequired", message: `caller is not an owning or active operator of ${channelId}` } });
          continue;
        }
        const deduplicationKey = `lead-broadcast:${actor.sessionId}:${idempotencyKey}:${channelId}`;
        const prior = database.messageByDeduplicationKey(deduplicationKey, channelId)?.event as any;
        if (prior?.deliveredRecipientSessionIds?.length > 0) {
          results.push({ channelId, status: "sent", leadSessionId: prior.target?.sessionId, eventId: prior.id, wasDeduplicated: true });
          continue;
        }
        const leads = database.roster(channelId).filter((member: any) => member.role === "planner" && !member.sessionEndedAt) as Array<{ sessionId: string }>;
        if (leads.length !== 1) {
          results.push({ channelId, status: "unavailable", error: { code: leads.length === 0 ? "leadUnavailable" : "leadAmbiguous", message: `channel ${channelId} has ${leads.length} current leads` } });
          continue;
        }
        const leadSessionId = String(leads[0].sessionId);
        try {
          // Resolve liveness immediately before the canonical send. The send
          // resolves it again and commits the current direct target, so a stale
          // cached lead/runtime never enters this contract.
          runtimeService.resolveActiveSessionRuntimeForDelivery(leadSessionId, actor);
          const response = await handler.send({
            ...request,
            channelId,
            senderSessionId: actor.sessionId,
            body: stampRoomsProvenance(actor.sessionId, body),
            target: { kind: "direct", sessionId: leadSessionId, sessionIds: [leadSessionId] },
            correlation: {
              requestId: idempotencyKey,
              deduplicationKey,
              purpose: "leadScopedMultiChannelBroadcast",
              originSessionId: actor.sessionId,
              targetSessionId: leadSessionId,
            },
            attachmentReferences: [...attachmentReferences],
          }) as any;
          results.push({ channelId, status: "sent", leadSessionId, eventId: response.event?.id, wasDeduplicated: response.wasDeduplicated === true });
        } catch (error) {
          const code = String((error as any)?.code ?? "deliveryFailed");
          const unavailable = ["runtimeNotFound", "recipientUndeliverable", "noAcceptedRecipients"].includes(code);
          results.push({ channelId, status: unavailable ? "unavailable" : "failed", leadSessionId, error: { code, message: error instanceof Error ? error.message : String(error) } });
        }
      }
      return { idempotencyKey, results };
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
    async listChannelProfileRevisions(request: any): Promise<any> {
      const actor = authenticated(request);
      if (!database.isActiveMember(request.channelId, actor)) throw new RoomsStoreError("notMember");
      return { revisions: listChannelProfileRevisions(stateDir, request.channelId).map((profile) => ({
        id: profile.id,
        name: profile.name,
        version: profile.version,
        sha256: profile.sha256,
        createdAt: profile.createdAt,
        modelSkillSets: profile.modelSkillSets.map((set) => ({ id: set.id, provider: set.provider, model: set.model })),
      })) };
    },
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
      const proof = typeof request?.proof === "string" ? Buffer.from(request.proof, "base64url") : Buffer.alloc(0);
      // A live runtime's session proof still authenticates (internal work item). A
      // trusted local operator client may instead prove possession of its
      // durable owner-only operator credential, which survives daemon restarts.
      // Both require a real 32-byte secret; a missing, forged, or cross-session
      // proof stays denied because the operator secret lives only in a mode-0600
      // file bound to that operator session.
      const provesPossession = runtimeService.provesSessionPossession(sessionId, proof)
        || (database.currentSession(sessionId)?.role === "operator" && operatorCredentials.verify(sessionId, proof));
      if (!provesPossession) throw new Error("session possession proof is required");
      const credential = `rooms_${randomUUID()}`;
      state.credentials.set(credential, sessionId);
      state.authenticatedSessionId = sessionId;
      return { credential };
    },
    async issueBootstrapCredential(request: any): Promise<any> {
      const state = connection(request);
      const sessionId = typeof request?.sessionId === "string" ? request.sessionId : "";
      if (!sessionId || database.sessionRoleValue(sessionId) !== "operator") throw new Error("owner operator bootstrap is required");
      if (!runtimeRepository.legacyOperatorSessionsNeedingProof().includes(sessionId)) throw new Error("session proof bootstrap is unavailable");
      if (!proofBootstrap.consume(sessionId, typeof request?.bootstrap === "string" ? request.bootstrap : "")) throw new Error("session proof bootstrap is invalid or expired");
      const credential = `rooms_${randomUUID()}`;
      state.credentials.set(credential, sessionId);
      (state.bootstrapCredentials ??= new Map()).set(credential, sessionId);
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
      const query = String(request.query ?? "");
      const scope = request.scope ?? (request.channelId ? "channel" : "all");
      if (scope !== "channel" && scope !== "all") throw new RoomsStoreError("invalidSearchScope", "search scope must be channel or all");
      if (scope === "channel" && !String(request.channelId ?? "").trim()) throw new RoomsStoreError("invalidChannel", "channel search requires channelId");
      const events = request.includeEvents === false
        ? []
        : database.searchMessages(query, { channelId: scope === "channel" ? request.channelId : null, limit }).events;
      if (!request.includeChannelDigests) return { events, channels: [] };
      const channels = database.searchChannels(query, {
        limit,
        includeControl: request.includeControl !== false,
        activeOnly: Boolean(request.activeOnly),
      });
      return { events, channels: scope === "channel" ? channels.filter((hit) => hit.channelId === request.channelId) : channels };
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
    runtimeCreate: async (request: any) => {
      const consumedBootstrap = consumedBootstrapActor(request);
      try {
        const resolved = runtimeCreateActor(request);
        const result = await runtimeService.create(request, resolved.actor);
        if (resolved.bootstrap) revokeBootstrapCredential(request, resolved.actor);
        return result;
      } catch (error) {
        if (consumedBootstrap) {
          revokeBootstrapCredential(request, consumedBootstrap);
          proofBootstrap.rearm(consumedBootstrap.sessionId);
        }
        throw error;
      }
    },
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
  providerReplyBridge.start();
  return {
    database,
    handler,
    runtimeService,
    providerReplyBridge,
    homeAuthorityId,
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

async function acceptPreloadedProviderPrompt(input: Readonly<{
  adapterKind: string;
  providerThreadId: string | null;
  prompt: string;
  scanState: ProviderReplyScanState | null;
  homeDirectory: string | null;
  timeoutMs: number;
  resolveProviderThreadId(): string | null;
  commit: () => unknown;
}>): Promise<{ verified: boolean; attempts: number }> {
  const deadline = Date.now() + input.timeoutMs;
  let providerThreadId = input.providerThreadId;
  let state = input.scanState;
  while (Date.now() <= deadline) {
    providerThreadId ??= input.resolveProviderThreadId();
    if (!providerThreadId) {
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }
    state ??= { offsets: {}, inputSeen: false, candidateText: null, completed: false, completedAt: null, failureReason: null };
    const observed = scanProviderFinalReply({
      adapterKind: input.adapterKind,
      providerThreadId,
      state,
      expectedInput: input.prompt,
      homeDirectory: input.homeDirectory ?? undefined,
    });
    state = observed.state;
    if (state.inputSeen) {
      input.commit();
      return { verified: true, attempts: 1 };
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`session ${providerThreadId ?? "pending"} did not record its managed prompt within ${input.timeoutMs}ms`);
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

// SPDX-License-Identifier: Apache-2.0
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { RoomsCLIBackend, ArchiveChannelInput, ChannelCreateInput, CommitMessageInput, LeadBroadcastInput, ListMessagesInput, ListRepliesInput, SearchInput, SendPromptInput, SessionCreateInput, SessionRegisterInput, SessionListInput, ShowMessageInput, ThreadLifecycleInput, RuntimeCLIInput, RuntimeAttachCLIInput, RuntimeAttachInteractiveHandlers, RuntimeInputCLIInput, RuntimeResizeCLIInput, RuntimeSignalCLIInput, RuntimeTerminateCLIInput, RuntimeRecoverCLIInput, RuntimeDeliverCLIInput } from "./backend.js";
import { RoomsRepository } from "../storage/repository.js";
import { storeSchemaVersion } from "../storage/migrations.js";
import { SQLiteBlueprintStore, SQLiteRuntimeOwnershipStore } from "../storage/blueprint-repository.js";
import { DurableChannelLifecycle, type CanonicalDeliveryPort, type CanonicalMemberReattachmentPort, type RuntimeGenerationPort } from "../lifecycle/suspend-resume.js";
import { archiveChannelLifecycle } from "../lifecycle/archive-channel.js";
import { createCodexAdapters } from "../runtime/codex-adapter.js";
import { listRegisteredProviders } from "./provider-registry.js";
import type { ResumableChannelBlueprint, ResumableMemberBlueprint } from "../blueprints/resumable.js";
import type { RuntimeActor } from "../runtime/contracts.js";
import { assertAbsolutePath, roomsPaths, type RoomsPaths } from "../provisioning/paths.js";
import { readInstalledReleaseContract } from "../provisioning/release.js";
import { readMachineIdentityStatus } from "../identity/machine-identity.js";
import { RoomsDaemonRuntimeClient } from "./daemon-runtime-client.js";
import { stampRoomsProvenance } from "../domain/message-provenance.js";
import { requireFederationModule } from "../federation-loader.js";
import type { AuthorityId } from "../identity/authority.js";
import { registeredProviderExecutable } from "./provider-registry.js";
import { sessionLaunchProvenance } from "../domain/session-provenance.js";

const isoNow = () => new Date().toISOString();

/** The built-in CLI composition. It keeps the CLI on the same local SQLite authority as Rooms. */
export function createDefaultRoomsCLIBackend(): RoomsCLIBackend {
  const paths = roomsPaths(process.env.ROOMS_STATE_DIR);
  const homeAuthorityId = readMachineIdentityStatus(paths.stateDir).authorityId;
  const storePath = assertAbsolutePath(process.env.ROOMSD_STORE_PATH || process.env.ROOMS_STORE_PATH || paths.storePath, "Rooms store path");
  const repository = new RoomsRepository(storePath, { schemaPolicy: "require-current", schemaActor: "Rooms CLI" });
  const blueprintStore = new SQLiteBlueprintStore(repository.db);
  const ownership = new SQLiteRuntimeOwnershipStore(repository.db);
  // Explicit legacy drain-only boundary: suspend/resume teardown keeps the
  // historical adapter until its migration unit is complete. New sessions
  // below never launch through this adapter.
  const providerRegistrations = listRegisteredProviders(paths.stateDir)
    .filter((provider): provider is typeof provider & { name: "codex" | "claude" | "grok" } =>
      provider.name === "codex" || provider.name === "claude" || provider.name === "grok");
  const legacyDrainOnlyAdapters = createCodexAdapters(blueprintStore, { runtimeOwnership: ownership, providerRegistrations });
  const canonical = new SQLiteCanonicalMembers(repository);
  const daemonRuntime = new RoomsDaemonRuntimeClient(paths.endpoint, () => daemonUnavailableReason(paths, storePath), paths.stateDir);
  const lifecycleRuntime: RuntimeGenerationPort = {
    activeGenerations(input) {
      if (input.length === 0) return new Set<string>();
      const tuplePlaceholders = input.map(() => "(?, ?)").join(", ");
      const parameters = input.flatMap(member => [member.priorSessionId, member.generation]);
      const rows = repository.db.prepare(`SELECT DISTINCT session_id, generation FROM runtimes WHERE ended_at IS NULL AND state IN ('creating','running','recovering','terminating') AND (session_id, generation) IN (${tuplePlaceholders})`).all(...parameters) as Array<{ session_id: string; generation: number }>;
      return new Set(rows.map(row => `${row.session_id}:${Number(row.generation)}`));
    },
    async launch(input) {
      const actor = runtimeActor(repository, currentRoomsSession(repository));
      const member = blueprintStore.read(input.channelId)?.members.find(item => item.priorSessionId === input.priorSessionId);
      const launched = await daemonRuntime.callAs(actor.sessionId, "runtimeCreate", {
        homeAuthorityId,
        sessionId: input.priorSessionId,
        generation: input.generation,
        channelId: input.channelId,
        adapterKind: input.adapterKind,
        providerThreadId: member?.provider?.conversationId ?? null,
        cwd: input.launch.cwd,
        effectiveHome: input.launch.home ?? member?.launch.home ?? null,
        command: [input.launch.executable, ...input.launch.args],
      }) as { runtime?: { runtimeId?: string; sessionId?: string; providerThreadId?: string | null } };
      const runtime = launched.runtime;
      if (!runtime?.runtimeId) throw new Error("resumed runtime did not return an identity");
      const providerThreadId = runtime.providerThreadId ?? member?.provider?.conversationId ?? null;
      if (providerThreadId && member) {
        repository.setSessionProviderThreadId(input.priorSessionId, providerThreadId);
        canonical.ensureBlueprint(input.channelId, input.channelId, {
          ...member,
          processGeneration: input.generation,
          provider: {
            conversationId: providerThreadId,
            resumeDescriptor: {
              ...(typeof member.provider?.resumeDescriptor === "object" && member.provider.resumeDescriptor ? member.provider.resumeDescriptor as Record<string, unknown> : {}),
              provider: member.adapterKind,
              mode: "runtime",
              cwd: member.launch.cwd,
            },
          },
        });
      }
      return { sessionId: runtime.sessionId ?? input.priorSessionId, runtimeId: runtime.runtimeId };
    },
    async stop(input) {
      const actor = runtimeActor(repository, currentRoomsSession(repository));
      const row = repository.db.prepare("SELECT generation, state, ended_at FROM runtimes WHERE runtime_id=?").get(input.runtimeId) as { generation?: number; state?: string; ended_at?: string | null } | undefined;
      if (!row || row.ended_at || ["exited", "terminated"].includes(row.state ?? "")) return;
      await daemonRuntime.callAs(actor.sessionId, "runtimeTerminate", { runtimeId: input.runtimeId, generation: Number(row.generation) });
    },
    async stopGeneration(input) {
      const actor = runtimeActor(repository, currentRoomsSession(repository));
      const row = repository.db.prepare("SELECT runtime_id, state, ended_at FROM runtimes WHERE session_id=? AND generation=? ORDER BY created_at DESC LIMIT 1").get(input.priorSessionId, input.generation) as { runtime_id?: string; state?: string; ended_at?: string | null } | undefined;
      if (!row || row.ended_at || ["exited", "terminated"].includes(row.state ?? "")) return;
      await daemonRuntime.callAs(actor.sessionId, "runtimeTerminate", { runtimeId: row.runtime_id, generation: input.generation });
    },
  };
  const delivery: CanonicalDeliveryPort = { deliver: async () => true };
  const lifecycle = new DurableChannelLifecycle(blueprintStore, lifecycleRuntime, legacyDrainOnlyAdapters.provider, delivery, canonical);

  return {
    providerExecutable(name) {
      return registeredProviderExecutable(name, paths.stateDir);
    },
    async whoami() {
      return resolveRoomsIdentity(repository, process.env, homeAuthorityId);
    },
    async createChannel(input: ChannelCreateInput) {
      const actor = runtimeActor(repository, input.credential ?? currentRoomsSession(repository));
      if (actor.role !== "operator") throw new Error("channel creation requires an operator credential");
      return daemonRuntime.callAs(actor.sessionId, "createChannel", { channelName: input.name });
    },

    async listChannels() {
      return daemonRuntime.call("listChannels", {});
    },

    async labelChannel(name: string, label: string | null, credential: string) {
      const actor = runtimeActor(repository, credential);
      if (actor.role !== "operator") throw new Error("channel labeling requires an operator credential");
      return daemonRuntime.callAs(actor.sessionId, "updateChannelLabel", { channelId: name, label });
    },

    async setChannelBroadcastPolicy(name: string, policy: "all" | "privileged", credential: string) {
      const actor = runtimeActor(repository, credential);
      if (actor.role !== "operator") throw new Error("channel broadcast policy requires an operator credential");
      return daemonRuntime.callAs(actor.sessionId, "updateChannelBroadcastPolicy", { channelId: name, broadcastPolicy: policy });
    },

    async channelMembers(name: string, credential?: string) {
      const sender = credential
        ? runtimeActor(repository, credential).sessionId
        : currentRoomsSession(repository);
      const roster = await daemonRuntime.callAs(sender, "getRoster", { channelId: name }) as { roster?: unknown[] };
      return { channel: name, members: roster.roster ?? [] };
    },

    async channelStateSnapshots(channelIds: string[]) {
      return daemonRuntime.call("channelStateSnapshots", { channelIds });
    },

    async usageSeries(scope: "session" | "channel", id: string, window: string, collect: boolean) {
      return daemonRuntime.callAs(currentRoomsSession(repository), "usageSeries", { scope, id, window, collect });
    },

    async channelSend(input) {
      const sender = input.sender || currentRoomsSession(repository);
      return daemonRuntime.callAs(sender, "send", { channelId: input.channel, senderSessionId: sender, body: stampRoomsProvenance(sender, input.body), target: { kind: "broadcast", sessionIds: [] }, replyToEventId: input.replyToEventId });
    },

    async leadBroadcast(input: LeadBroadcastInput) {
      const actor = runtimeActor(repository, input.credential);
      return daemonRuntime.callAs(actor.sessionId, "leadBroadcast", {
        idempotencyKey: input.idempotencyKey,
        body: input.body,
        channelIds: input.channelIds,
        attachmentReferences: input.attachmentReferences ?? [],
      });
    },

    async commitControl(input) {
      const sender = input.sender || currentRoomsSession(repository);
      return daemonRuntime.callAs(sender, "commitControl", { channelId: input.channel, senderSessionId: sender, kind: input.kind, payload: input.payload, requestId: input.requestId });
    },
    async listControls(input) {
      const sender = input.sender || currentRoomsSession(repository);
      return daemonRuntime.callAs(sender, "getControls", { channelId: input.channel, afterCursor: input.since, limit: input.limit });
    },

    async threadLifecycle(input: ThreadLifecycleInput) {
      const actor = runtimeActor(repository, input.credential || currentRoomsSession(repository));
      return daemonRuntime.callAs(actor.sessionId, "getThreadLifecycle", { threadRootEventId: input.eventId, channelId: input.channel });
    },

    async resolveThread(input: ThreadLifecycleInput) {
      const actor = runtimeActor(repository, input.credential || currentRoomsSession(repository));
      return daemonRuntime.callAs(actor.sessionId, "resolveThread", { threadRootEventId: input.eventId, channelId: input.channel });
    },

    async reopenThread(input: ThreadLifecycleInput) {
      const actor = runtimeActor(repository, input.credential || currentRoomsSession(repository));
      return daemonRuntime.callAs(actor.sessionId, "reopenThread", { threadRootEventId: input.eventId, channelId: input.channel });
    },

    async sessionSend(input) {
      const sender = input.sender || currentRoomsSession(repository);
      const federated = parseFederatedSessionTarget(input.target);
      if (federated) {
        if (input.replyToEventId) throw new Error("structured replies to federated direct messages are unavailable because the parent event belongs to another Rooms authority");
        const federation = await requireFederationModule("federated session send");
        const route = federation.readMachineRoute(federated.authorityId, paths.stateDir);
        const peer = federation.readActivePeerTrust(federated.authorityId, paths.stateDir);
        if (!peer || peer.transportPolicy.kind !== "loopbackSsh") throw new Error(`Rooms has no active SSH route to ${federated.authorityId}`);
        const flags = new Map<string, string>([
          ["ssh-host", route?.sshHost ?? peer.transportPolicy.sshDestination],
          ["peer-authority-id", federated.authorityId],
          ["session", sender],
          ["target-session", federated.sessionId],
          ["body", input.body],
          ["local-state-dir", paths.stateDir],
        ]);
        if (input.replyToEventId) flags.set("reply-to-event", input.replyToEventId);
        if (route?.remoteStateDir) flags.set("remote-state-dir", route.remoteStateDir);
        return federation.runRoomsFederationChannelCommand("direct-send", flags);
      }
      const body = stampRoomsProvenance(sender, input.body);
      const channelId = resolveRoomsIdentity(repository, process.env, homeAuthorityId).channelId;
      const result = await daemonRuntime.callAs(sender, "send", { channelId, senderSessionId: sender, body, target: { kind: "direct", sessionId: input.target, sessionIds: [input.target] }, replyToEventId: input.replyToEventId }) as Record<string, unknown>;
      return result;
    },

    async channelStatus(name: string) {
      const status = lifecycle.status(name) as Record<string, unknown>;
      return { ...status, label: repository.currentChannel(name)?.label ?? null };
    },

    async suspendChannel(name: string) {
      if (!repository.currentChannel(name)) throw new Error(`cannot suspend channel "${name}": channel does not exist`);
      ensureChannelBlueprint(repository, blueprintStore, name);
      const activeMembers = repository.db.prepare(`SELECT m.session_id
        FROM memberships m
        JOIN sessions s ON s.id=m.session_id
        WHERE m.channel_id=? AND m.left_at IS NULL AND m.session_ended_at IS NULL AND s.ended_at IS NULL`).all(name) as Array<{ session_id: string }>;
      blueprintStore.retainMembers(name, new Set(activeMembers.map(member => member.session_id)));
      // Refresh every blueprint member from the latest runtime row so mass
      // termination still leaves a resumeable providerThreadId when known.
      for (const member of blueprintStore.read(name)?.members ?? []) {
        const row = repository.db.prepare("SELECT generation, provider_thread_id, state, ended_at FROM runtimes WHERE session_id=? ORDER BY generation DESC, created_at DESC LIMIT 1").get(member.priorSessionId) as { generation?: number; provider_thread_id?: string | null; state?: string; ended_at?: string | null } | undefined;
        const providerThreadId = row?.provider_thread_id ?? repository.currentSession(member.priorSessionId)?.providerThreadId ?? member.provider?.conversationId ?? null;
        canonical.ensureBlueprint(name, name, {
          ...member,
          processGeneration: Number(row?.generation ?? member.processGeneration),
          provider: providerThreadId ? {
            conversationId: providerThreadId,
            resumeDescriptor: {
              ...(typeof member.provider?.resumeDescriptor === "object" && member.provider.resumeDescriptor ? member.provider.resumeDescriptor as Record<string, unknown> : {}),
              provider: member.adapterKind,
              mode: "runtime",
              cwd: member.launch.cwd,
            },
          } : null,
        });
      }
      const blueprint = blueprintStore.read(name)!;
      return lifecycle.suspend(name, `cli-suspend-${name}`, blueprint);
    },

    async resumeChannel(name: string) {
      const channel = repository.currentChannel(name);
      if (!channel) throw new Error(`cannot resume channel "${name}": channel does not exist`);
      if (channel.lifecycleState === "closed") return repository.reopenChannel(name);
      if (!blueprintStore.read(name)) throw new Error(`cannot resume channel "${name}": channel has not been suspended`);
      const status = lifecycle.status(name) as { state?: string; generation?: number };
      const blueprintGeneration = Math.max(0, ...(blueprintStore.read(name)?.members.map(member => member.processGeneration) ?? []));
      // Reuse an incomplete resume generation/key so a failed attempt can be
      // claimed again after its lease expires, instead of reporting
      // "resume is in progress" forever under a new key.
      const generation = resolveResumeGeneration(status, blueprintGeneration);
      return lifecycle.resume(name, `cli-resume-${name}-${generation}`, generation);
    },

    async closeChannel(name: string, credential: string) {
      const actor = runtimeActor(repository, credential);
      if (actor.role !== "operator") throw new Error("channel closure requires an operator credential");
      return daemonRuntime.callAs(actor.sessionId, "closeChannel", { channelId: name });
    },

    async archiveChannel(input: ArchiveChannelInput) {
      const actor = runtimeActor(repository, input.credential);
      if (actor.role !== "operator") throw new Error("channel archive requires an operator credential");
      const channel = repository.currentChannel(input.channel);
      const activeOperatorMember = repository.isActiveMember(input.channel, actor.sessionId, "operator");
      if (channel?.ownerOperatorSessionId && channel.ownerOperatorSessionId !== actor.sessionId && !activeOperatorMember) throw new Error("channel archive requires the owning or active channel operator credential");
      return archiveChannelLifecycle(repository, { channelId: input.channel, force: input.force }, {
        terminateRuntime: (runtime) => daemonRuntime.callAs(actor.sessionId, "runtimeTerminate", { runtimeId: runtime.runtimeId, generation: runtime.generation }),
        closeChannel: () => daemonRuntime.callAs(actor.sessionId, "closeChannel", { channelId: input.channel }),
      });
    },

    async createSession(input: SessionCreateInput) {
      const actor = runtimeActor(repository, input.credential);
      const role = input.role ?? "worker";
      if (actor.role !== "operator" && !(actor.role === "planner" && role === "worker" && repository.isActiveMember(input.channel, actor.sessionId, "planner"))) {
        throw new Error("session launch requires an operator or the channel's active planner launching a worker");
      }
      const actorSession = repository.currentSession(actor.sessionId);
      const { externalOwner, externalAgentId } = sessionLaunchProvenance({
        actorRole: actor.role,
        actorExternalOwner: actorSession?.externalOwner ?? null,
        targetSessionId: input.name,
        externalOwner: input.externalOwner,
        externalAgentId: input.externalAgentId,
      });
      await daemonRuntime.call("registerSession", { channelId: input.channel, sessionId: input.name, role, externalOwner, externalAgentId });
      let launched: unknown;
      try {
        launched = await daemonRuntime.callAs(actor.sessionId, "runtimeCreate", {
          homeAuthorityId,
          sessionId: input.name,
          generation: 1,
          channelId: input.channel,
          adapterKind: input.adapter ?? input.agent,
          providerThreadId: input.providerThreadId ?? null,
          cwd: input.cwd,
          effectiveHome: input.effectiveHome ?? null,
          command: normalizeProviderCommand(input.command ?? providerCommand(input.agent, input.prompt), input.agent),
        });
      } catch (error) {
        // Runtime/provider launch failed: remove the just-created Rooms
        // session so a failed resume/launch cannot leave an orphan identity.
        try { await daemonRuntime.callAs(actor.sessionId, "endSession", { sessionId: input.name }); } catch { /* preserve the launch error */ }
        throw error;
      }
      const launchedRuntime = (launched as { runtime?: { providerThreadId?: string | null } }).runtime ?? launched as { providerThreadId?: string | null };
      const providerThreadId = launchedRuntime.providerThreadId ?? input.providerThreadId ?? null;
      if (providerThreadId) repository.setSessionProviderThreadId(input.name, providerThreadId);
      const member: ResumableMemberBlueprint = {
        channelId: input.channel,
        priorSessionId: input.name,
        intent: { role, workUnitId: null },
        launch: { executable: normalizeProviderCommand(input.command ?? providerCommand(input.agent, input.prompt), input.agent)[0]!, args: normalizeProviderCommand(input.command ?? providerCommand(input.agent, input.prompt), input.agent).slice(1), cwd: input.cwd, home: input.effectiveHome ?? null },
        layout: { terminalColumns: null, terminalRows: null, layoutVersion: "1" },
        adapterKind: input.adapter ?? input.agent,
        lastAcknowledgedDeliveryCursor: "0",
        role,
        joinedAt: isoNow(),
        processGeneration: 1,
        provider: providerThreadId ? { conversationId: providerThreadId, resumeDescriptor: { provider: input.agent, cwd: input.cwd, prompt: input.prompt } } : null,
      };
      canonical.ensureBlueprint(input.channel, input.channel, member);
      return { session: repository.currentSession(input.name), runtime: launched };
    },

    async registerSession(input: SessionRegisterInput) {
      return daemonRuntime.call("registerSession", { channelId: input.channel, sessionId: input.name, role: input.role, externalId: input.externalId, deliveryMode: input.deliveryMode });
    },

    async updateSessionRole(input) {
      const actor = runtimeActor(repository, input.credential);
      return daemonRuntime.callAs(actor.sessionId, "updateSessionRole", { channelId: input.channel, sessionId: input.sessionId, role: input.role });
    },

    async inspectSession(sessionId: string) {
      // Runtime configuration belongs to the authority that hosts the
      // generation. Ask roomsd over its authenticated connection so a remote
      // or relaunched runtime reports its own persisted cwd; never infer it
      // from this CLI process or local provider files.
      return daemonRuntime.call("inspectSession", { sessionId });
    },

    async listSessions(input: SessionListInput) {
      const listed = await daemonRuntime.call("getSessions", { includeEnded: input.includeEnded }) as { sessions?: Array<{ endedAt?: string | null }> };
      return { sessions: input.includeEnded ? listed.sessions ?? [] : (listed.sessions ?? []).filter((session) => !session.endedAt) };
    },

    async endSession(sessionId: string, credential: string) {
      const actor = runtimeActor(repository, credential);
      return daemonRuntime.callAs(actor.sessionId, "endSession", { sessionId });
    },

    async commitMessage(input: CommitMessageInput) {
      return daemonRuntime.callAs(input.sender, "send", { channelId: input.channel, senderSessionId: input.sender, body: input.body, target: input.target ? { kind: "direct", sessionId: input.target, sessionIds: [input.target] } : { kind: "broadcast", sessionIds: [] }, replyToEventId: input.replyToEventId });
    },

    async listMessages(input: ListMessagesInput) {
      return await daemonRuntime.call("getEvents", {
        channelId: input.channel ?? undefined,
        afterCursor: input.since,
        sessionId: input.session || undefined,
        limit: input.limit,
        replyToEventId: input.replyToEventId,
      });
    },

    async search(input: SearchInput) {
      return await daemonRuntime.call("search", {
        query: input.query,
        scope: input.channel ? "channel" : "all",
        channelId: input.channel ?? undefined,
        limit: input.limit,
        includeControl: input.includeControl,
        includeChannelDigests: input.channelDigests,
        includeEvents: input.events,
        activeOnly: input.activeOnly,
      });
    },

    async showMessage(input: ShowMessageInput) {
      const result = await daemonRuntime.call("getEvents", { channelId: input.channel ?? undefined, eventId: input.eventId }) as { events?: unknown[]; cursor?: string };
      return { event: result.events?.[0], cursor: result.cursor };
    },

    async listReplies(input: ListRepliesInput) {
      return daemonRuntime.call("getEvents", {
        channelId: input.channel ?? undefined,
        afterCursor: input.since,
        sessionId: input.session,
        limit: input.limit,
        replyToEventId: input.eventId,
      });
    },

    async sendPrompt(input: SendPromptInput) {
      const actor = runtimeActor(repository, input.credential);
      return daemonRuntime.callAs(actor.sessionId, "send", { channelId: input.channel, senderSessionId: actor.sessionId, body: input.prompt, target: { kind: "direct", sessionId: input.session, sessionIds: [input.session] } });
    },
    async runtimeCreate(input: RuntimeCLIInput) { const actor = runtimeActor(repository, input.credential); return daemonRuntime.callAs(actor.sessionId, "runtimeCreate", { runtimeId: input.runtimeId, homeAuthorityId: input.homeAuthorityId ?? homeAuthorityId, sessionId: input.sessionId, generation: input.generation, machineId: input.machineId, stateDir: input.stateDir, shell: input.shell, command: input.command, cwd: input.cwd, effectiveHome: input.effectiveHome ?? null, channelId: input.channelId, adapterKind: input.adapterKind, providerThreadId: input.providerThreadId ?? null }); },
    async runtimeList(credential: string) { const actor = runtimeActor(repository, credential); return daemonRuntime.callAs(actor.sessionId, "runtimeList", {}); },
    async runtimeQuotaGet(machineId?: string) { return daemonRuntime.call("runtimeQuotaGet", { machineId }); },
    async runtimeQuotaSet(machineId: string, limit: number, credential: string) { const actor = runtimeActor(repository, credential); return daemonRuntime.callAs(actor.sessionId, "runtimeQuotaSet", { machineId, limit }); },
    async runtimeQuotaReset(machineId: string, credential: string) { const actor = runtimeActor(repository, credential); return daemonRuntime.callAs(actor.sessionId, "runtimeQuotaReset", { machineId }); },
    async runtimeStatus(runtimeId: string, credential: string) { const actor = runtimeActor(repository, credential); return daemonRuntime.callAs(actor.sessionId, "runtimeStatus", { runtimeId }); },
    async runtimeAttach(input: RuntimeAttachCLIInput) { const actor = runtimeActor(repository, input.credential); return daemonRuntime.callAs(actor.sessionId, "runtimeAttach", input); },
    async runtimeResolveSessionAttach(sessionId: string, credential: string, mode: "observe" | "controller", outputCursor?: string) {
      const actor = runtimeActor(repository, credential);
      const listed = await daemonRuntime.callAs(actor.sessionId, "runtimeList", {}) as { runtimes?: Array<{ runtimeId: string; homeAuthorityId: string; sessionId: string; generation: number; state: string; endedAt?: string | null }> };
      // runtimeList is already scoped: operators see all, sessions see self, and
      // channel planners see workers they may supervise (internal work item).
      const runtime = (listed.runtimes ?? []).filter((item) => item.sessionId === sessionId && !item.endedAt && ["running", "recovering"].includes(item.state)).sort((left, right) => right.generation - left.generation)[0];
      if (!runtime) throw new Error(`session ${sessionId} has no active Rooms runtime`);
      return { credential, runtimeId: runtime.runtimeId, homeAuthorityId: runtime.homeAuthorityId, sessionId, generation: runtime.generation, viewerId: actor.sessionId, mode, outputCursor };
    },
    async runtimeResolveProviderAttach(providerThreadId: string, credential: string, mode: "observe" | "controller", outputCursor?: string) {
      const actor = runtimeActor(repository, credential);
      const listed = await daemonRuntime.callAs(actor.sessionId, "runtimeList", {}) as { runtimes?: Array<{ runtimeId: string; homeAuthorityId: string; sessionId: string; providerThreadId?: string | null; generation: number; state: string; endedAt?: string | null }> };
      const runtime = (listed.runtimes ?? []).filter((item) => item.providerThreadId === providerThreadId && !item.endedAt && ["running", "recovering"].includes(item.state)).sort((left, right) => right.generation - left.generation)[0];
      if (!runtime) return undefined;
      return { credential: runtime.sessionId, runtimeId: runtime.runtimeId, homeAuthorityId: runtime.homeAuthorityId, sessionId: runtime.sessionId, generation: runtime.generation, viewerId: runtime.sessionId, mode, outputCursor };
    },
    async runtimeAttachInteractive(input: RuntimeAttachCLIInput, handlers: RuntimeAttachInteractiveHandlers) {
      const actor = runtimeActor(repository, input.credential);
      return daemonRuntime.attachInteractive(actor.sessionId, input, handlers);
    },
    async runtimeTerminateSession(sessionId: string, credential: string) {
      const actor = runtimeActor(repository, credential);
      const listed = await daemonRuntime.callAs(actor.sessionId, "runtimeList", {}) as { runtimes?: Array<{ runtimeId: string; sessionId: string; generation: number; state: string; endedAt?: string | null }> };
      const runtime = (listed.runtimes ?? []).filter((item) => item.sessionId === sessionId && !item.endedAt && ["running", "recovering"].includes(item.state)).sort((left, right) => right.generation - left.generation)[0];
      if (!runtime) throw new Error(`session ${sessionId} has no active Rooms runtime`);
      return daemonRuntime.callAs(actor.sessionId, "runtimeTerminate", { runtimeId: runtime.runtimeId, generation: runtime.generation });
    },
    async runtimeDetach(attachmentId: string, credential: string) { const actor = runtimeActor(repository, credential); return daemonRuntime.callAs(actor.sessionId, "runtimeDetach", { attachmentId }); },
    async runtimeInput(input: RuntimeInputCLIInput) { const actor = runtimeActor(repository, input.credential); return daemonRuntime.callAs(actor.sessionId, "runtimeInput", input); },
    async runtimeResize(input: RuntimeResizeCLIInput) { const actor = runtimeActor(repository, input.credential); return daemonRuntime.callAs(actor.sessionId, "runtimeResize", input); },
    async runtimeSignal(input: RuntimeSignalCLIInput) { const actor = runtimeActor(repository, input.credential); return daemonRuntime.callAs(actor.sessionId, "runtimeSignal", input); },
    async runtimeTerminate(input: RuntimeTerminateCLIInput) { const actor = runtimeActor(repository, input.credential); return daemonRuntime.callAs(actor.sessionId, "runtimeTerminate", input); },
    async runtimeRecover(input: RuntimeRecoverCLIInput) { const actor = runtimeActor(repository, input.credential); return daemonRuntime.callAs(actor.sessionId, "runtimeRecover", input); },
    async runtimeDeliverMessage(input: RuntimeDeliverCLIInput) { const actor = runtimeActor(repository, input.credential); return daemonRuntime.callAs(actor.sessionId, "runtimeDeliverMessage", input); },
    async runtimeEvents(runtimeId: string, generation: number, afterSeq: number, credential: string) { const actor = runtimeActor(repository, credential); return daemonRuntime.callAs(actor.sessionId, "runtimeEvents", { runtimeId, generation, afterSeq }); },
    async rotationInspect(channelId: string, sessionId: string, credential: string) { const actor = runtimeActor(repository, credential); return daemonRuntime.callAs(actor.sessionId, "rotationInspect", { channelId, sessionId }); },
    async rotationPrepare(channelId: string, sessionId: string, credential: string) { const actor = runtimeActor(repository, credential); return daemonRuntime.callAs(actor.sessionId, "rotationPrepare", { channelId, sessionId }); },
    async rotationAcknowledge(rotationId: string, nonce: string, credential: string) { const actor = runtimeActor(repository, credential); return daemonRuntime.callAs(actor.sessionId, "rotationAcknowledge", { rotationId, nonce }); },
    async rotationCommit(rotationId: string, credential: string) { const actor = runtimeActor(repository, credential); return daemonRuntime.callAs(actor.sessionId, "rotationCommit", { rotationId }); },
    async rotationCancel(rotationId: string, reason: string, credential: string) { const actor = runtimeActor(repository, credential); return daemonRuntime.callAs(actor.sessionId, "rotationCancel", { rotationId, reason }); },
  };
}

export function nextResumeGeneration(lifecycleGeneration: number | undefined, blueprintGeneration: number): number {
  return Math.max(Number(lifecycleGeneration ?? 0), blueprintGeneration) + 1;
}

/** Prefer an incomplete resume generation so CLI retries keep a stable claim key. */
export function resolveResumeGeneration(status: { state?: string; generation?: number }, blueprintGeneration: number): number {
  if (status.state === "resuming" && Number(status.generation) > 0) return Number(status.generation);
  return nextResumeGeneration(status.generation, blueprintGeneration);
}

export function daemonUnavailableReason(paths: RoomsPaths, storePath: string): string {
  try {
    const installedSchema = readInstalledReleaseContract(paths).storeSchemaVersion;
    const currentStoreSchema = storeSchemaVersion(storePath);
    if (currentStoreSchema !== installedSchema) {
      return `roomsd is incompatible with the Rooms store: installed daemon supports schema ${installedSchema}, store is at schema ${currentStoreSchema}; run \`rooms doctor\` and install a matching Rooms release`;
    }
  } catch { /* the normal unavailable error still points the operator at doctor */ }
  return `roomsd is not running at ${paths.endpoint}; run \`rooms doctor\``;
}

function runtimeActor(repository: RoomsRepository, credential: string): RuntimeActor {
  if (typeof credential !== "string" || credential.trim() === "") throw new Error("runtime credential is required");
  const sessions = repository.sessionsForExternalId(credential);
  if (sessions.length === 0 && repository.currentSession(credential)?.endedAt === null) sessions.push(credential);
  if (sessions.length !== 1) throw new Error("invalid runtime credential");
  const session = repository.currentSession(sessions[0]!);
  if (!session || !session.role || session.endedAt !== null) throw new Error("invalid runtime credential");
  return { sessionId: session.id, role: session.role, credentialId: credential };
}

function currentRoomsSession(repository: RoomsRepository): string {
  try { return resolveRoomsIdentity(repository).sessionId; } catch { /* fall back to an explicit operator credential */ }
  const credential = String(process.env.ROOMS_OPERATOR_CREDENTIAL || "").trim();
  if (credential) return runtimeActor(repository, credential).sessionId;
  const operator = repository.listSessions().find((item) => item.role === "operator" && item.endedAt === null);
  if (operator) return operator.id;
  throw new Error("Rooms identity is unavailable (set ROOMS_SESSION_ID or register an operator session)");
}

/**
 * Resolve identity from Rooms' canonical session metadata. Agent tool
 * subprocesses do not always inherit the PTY's ROOMS_SESSION_ID, but provider
 * runtimes expose their native thread identity. A unique active mapping is
 * sufficient; ambiguity fails closed.
 */
export function resolveRoomsIdentity(
  repository: RoomsRepository,
  environment: NodeJS.ProcessEnv = process.env,
  machineAuthorityId: string | null = null,
): {
  sessionId: string;
  channelId: string | null;
  provider: string | null;
  sessionThreadId: string | null;
  machine: { id: string; authorityId: string | null };
} {
  let sessionId = String(environment.ROOMS_SESSION_ID || "").trim();
  if (!sessionId) {
    const providerThreadId = String(environment.ROOMS_PROVIDER_THREAD_ID || environment.CODEX_THREAD_ID || "").trim();
    const matches = providerThreadId ? repository.activeRuntimeSessionIdsForProviderThread(providerThreadId) : [];
    if (matches.length !== 1) throw new Error("Rooms identity is unavailable (set ROOMS_SESSION_ID)");
    sessionId = matches[0]!;
  }
  const session = repository.currentSession(sessionId);
  if (!session || session.endedAt !== null) throw new Error("Rooms identity is unavailable (session is not active)");
  const explicitChannel = String(environment.ROOMS_CHANNEL_ID || "").trim();
  const channels = repository.activeMembershipChannels(sessionId);
  const channelId = explicitChannel || (channels.length === 1 ? channels[0]! : null);
  const runtime = repository.activeRuntimeIdentityForSession(sessionId);
  return {
    sessionId,
    channelId,
    provider: runtime?.provider ?? (String(environment.ROOMS_PROVIDER || "").trim() || null),
    sessionThreadId: runtime?.providerThreadId ?? session.providerThreadId,
    machine: { id: runtime?.machineId ?? hostname(), authorityId: machineAuthorityId },
  };
}

function providerCommand(agent: SessionCreateInput["agent"], prompt: string): string[] {
  if (agent === "codex") return [agent, "exec", "--json", "--ephemeral", prompt];
  if (agent === "claude") return [agent, "-p", prompt];
  return [agent, prompt];
}

function normalizeProviderCommand(command: string[], agent: SessionCreateInput["agent"]): string[] {
  if (command[0] !== agent) return command;
  const configured = process.env[`ROOMS_${agent.toUpperCase()}_BIN`];
  return [configured || executableFromPath(agent) || agent, ...command.slice(1)];
}

function executableFromPath(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the caller's PATH.
    }
  }
  return undefined;
}

function parseFederatedSessionTarget(value: string): Readonly<{ authorityId: AuthorityId; sessionId: string }> | undefined {
  const match = /^federation:(authority-[0-9a-f]{64}):(.+)$/.exec(value);
  if (!match || !match[2]?.trim()) return undefined;
  return { authorityId: match[1] as AuthorityId, sessionId: match[2] };
}

/** Ordinary channels may have no runtime member yet; make them lifecycle-ready. */
function ensureChannelBlueprint(repository: RoomsRepository, store: SQLiteBlueprintStore, channelId: string): ResumableChannelBlueprint {
  const existing = store.read(channelId);
  if (existing) return existing;
  const blueprint: ResumableChannelBlueprint = {
    version: 1,
    channelId,
    channelName: channelId,
    goal: "",
    suspendedAt: isoNow(),
    historyCursor: "0",
    members: [],
  };
  repository.db.prepare("INSERT INTO channel_blueprints(channel_id, blueprint_json, state, updated_at) VALUES (?, ?, 'active', ?)").run(channelId, JSON.stringify(blueprint), isoNow());
  return blueprint;
}

class SQLiteCanonicalMembers implements CanonicalMemberReattachmentPort {
  private readonly resumed = new Map<number, string[]>();

  constructor(private readonly repository: RoomsRepository) {}

  ensureBlueprint(channelId: string, channelName: string, member: ResumableMemberBlueprint): void {
    const existing = this.repository.db.prepare("SELECT blueprint_json FROM channel_blueprints WHERE channel_id=?").get(channelId) as { blueprint_json?: string } | undefined;
    const blueprint: ResumableChannelBlueprint = existing?.blueprint_json
      ? JSON.parse(existing.blueprint_json) as ResumableChannelBlueprint
      : { version: 1, channelId, channelName, goal: "", suspendedAt: isoNow(), historyCursor: "0", members: [] };
    const members = blueprint.members.some(item => item.priorSessionId === member.priorSessionId)
      ? blueprint.members.map(item => item.priorSessionId === member.priorSessionId ? member : item)
      : [...blueprint.members, member];
    this.repository.db.prepare("INSERT INTO channel_blueprints(channel_id, blueprint_json, state, updated_at) VALUES (?, ?, 'active', ?) ON CONFLICT(channel_id) DO UPDATE SET blueprint_json=excluded.blueprint_json, updated_at=excluded.updated_at").run(channelId, JSON.stringify({ ...blueprint, members }), isoNow());
  }

  async reattachMembers(input: readonly { channelId: string; priorSessionId: string; sessionId: string; runtimeId: string; generation: number; role: string | null }[], _fence: { token: string; assertCurrent(): Promise<void> }): Promise<void> {
    for (const member of input) {
      if (!this.repository.currentSession(member.sessionId)) this.repository.insertSession({ id: member.sessionId, role: member.role as "operator" | "planner" | "worker" | "reviewer" | null });
      if (!this.repository.isActiveMember(member.channelId, member.sessionId)) this.repository.insertMembership(member.channelId, member.sessionId, member.role as "operator" | "planner" | "worker" | "reviewer" | null);
      this.resumed.set(member.generation, [...(this.resumed.get(member.generation) ?? []), member.sessionId]);
    }
  }

  async rollbackGeneration(_channelId: string, generation: number, _fence: { token: string; assertCurrent(): Promise<void> }): Promise<void> {
    for (const sessionId of this.resumed.get(generation) ?? []) if (this.repository.currentSession(sessionId)?.endedAt === null) this.repository.markSessionEnded(sessionId);
    this.resumed.delete(generation);
  }
}

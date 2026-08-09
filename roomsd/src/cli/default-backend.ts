import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { RoomsCLIBackend, ChannelCreateInput, CommitMessageInput, ListMessagesInput, SendPromptInput, SessionCreateInput, SessionRegisterInput, SessionListInput, RuntimeCLIInput, RuntimeAttachCLIInput, RuntimeAttachInteractiveHandlers, RuntimeInputCLIInput, RuntimeResizeCLIInput, RuntimeSignalCLIInput, RuntimeTerminateCLIInput, RuntimeRecoverCLIInput, RuntimeDeliverCLIInput } from "./backend.js";
import { RoomsRepository } from "../storage/repository.js";
import { storeSchemaVersion } from "../storage/migrations.js";
import { SQLiteBlueprintStore, SQLiteRuntimeOwnershipStore } from "../storage/blueprint-repository.js";
import { DurableChannelLifecycle, type CanonicalDeliveryPort, type CanonicalMemberReattachmentPort } from "../lifecycle/suspend-resume.js";
import { createCodexAdapters } from "../runtime/codex-adapter.js";
import type { ResumableChannelBlueprint, ResumableMemberBlueprint } from "../blueprints/resumable.js";
import type { RuntimeActor } from "../runtime/contracts.js";
import { assertAbsolutePath, roomsPaths, type RoomsPaths } from "../provisioning/paths.js";
import { readInstalledReleaseContract } from "../provisioning/release.js";
import { readMachineIdentityStatus } from "../identity/machine-identity.js";
import { RoomsDaemonRuntimeClient } from "./daemon-runtime-client.js";
import { stampRoomsProvenance } from "../domain/message-provenance.js";
import { requireFederationModule } from "../federation-loader.js";
import type { AuthorityId } from "../identity/authority.js";

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
  const legacyDrainOnlyAdapters = createCodexAdapters(blueprintStore, { runtimeOwnership: ownership });
  const canonical = new SQLiteCanonicalMembers(repository);
  const delivery: CanonicalDeliveryPort = { deliver: async () => true };
  const lifecycle = new DurableChannelLifecycle(blueprintStore, legacyDrainOnlyAdapters.runtime, legacyDrainOnlyAdapters.provider, delivery, canonical);
  const daemonRuntime = new RoomsDaemonRuntimeClient(paths.endpoint, () => daemonUnavailableReason(paths, storePath));

  return {
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

    async channelMembers(name: string, credential?: string) {
      const sender = credential
        ? runtimeActor(repository, credential).sessionId
        : currentRoomsSession(repository);
      const roster = await daemonRuntime.callAs(sender, "getRoster", { channelId: name }) as { roster?: unknown[] };
      return { channel: name, members: roster.roster ?? [] };
    },

    async channelSend(input) {
      const sender = input.sender || currentRoomsSession(repository);
      return daemonRuntime.callAs(sender, "send", { channelId: input.channel, senderSessionId: sender, body: stampRoomsProvenance(sender, input.body), target: { kind: "broadcast", sessionIds: [] } });
    },

    async sessionSend(input) {
      const sender = input.sender || currentRoomsSession(repository);
      const federated = parseFederatedSessionTarget(input.target);
      if (federated) {
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
        if (route?.remoteStateDir) flags.set("remote-state-dir", route.remoteStateDir);
        return federation.runRoomsFederationChannelCommand("direct-send", flags);
      }
      const body = stampRoomsProvenance(sender, input.body);
      const channelId = resolveRoomsIdentity(repository, process.env, homeAuthorityId).channelId;
      const result = await daemonRuntime.callAs(sender, "send", { channelId, senderSessionId: sender, body, target: { kind: "direct", sessionId: input.target, sessionIds: [input.target] } }) as Record<string, unknown>;
      return result;
    },

    async channelStatus(name: string) {
      const status = lifecycle.status(name) as Record<string, unknown>;
      return { ...status, label: repository.currentChannel(name)?.label ?? null };
    },

    async suspendChannel(name: string) {
      if (!repository.currentChannel(name)) throw new Error(`cannot suspend channel "${name}": channel does not exist`);
      const blueprint = ensureChannelBlueprint(repository, blueprintStore, name);
      return lifecycle.suspend(name, `cli-suspend-${name}`, blueprint);
    },

    async resumeChannel(name: string) {
      if (!repository.currentChannel(name)) throw new Error(`cannot resume channel "${name}": channel does not exist`);
      if (!blueprintStore.read(name)) throw new Error(`cannot resume channel "${name}": channel has not been suspended`);
      const status = lifecycle.status(name) as { generation?: number };
      const generation = Number(status.generation ?? 0) + 1;
      return lifecycle.resume(name, `cli-resume-${name}-${generation}`, generation);
    },

    async closeChannel(name: string, credential: string) {
      const actor = runtimeActor(repository, credential);
      if (actor.role !== "operator") throw new Error("channel closure requires an operator credential");
      return daemonRuntime.callAs(actor.sessionId, "closeChannel", { channelId: name });
    },

    async createSession(input: SessionCreateInput) {
      const actor = runtimeActor(repository, input.credential);
      const role = input.role ?? "worker";
      await daemonRuntime.call("registerSession", { channelId: input.channel, sessionId: input.name, role });
      let launched: unknown;
      try {
        launched = await daemonRuntime.callAs(actor.sessionId, "runtimeCreate", {
          homeAuthorityId,
          sessionId: input.name,
          generation: 1,
          channelId: input.channel,
          adapterKind: input.agent,
          providerThreadId: input.providerThreadId ?? null,
          cwd: input.cwd,
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
        launch: { executable: normalizeProviderCommand(input.command ?? providerCommand(input.agent, input.prompt), input.agent)[0]!, args: normalizeProviderCommand(input.command ?? providerCommand(input.agent, input.prompt), input.agent).slice(1), cwd: input.cwd },
        layout: { terminalColumns: null, terminalRows: null, layoutVersion: "1" },
        adapterKind: input.agent,
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
      return daemonRuntime.call("registerSession", { channelId: input.channel, sessionId: input.name, role: input.role, externalId: input.externalId });
    },

    async inspectSession(sessionId: string) {
      return repository.inspectSession(sessionId);
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
      return daemonRuntime.callAs(input.sender, "send", { channelId: input.channel, senderSessionId: input.sender, body: input.body, target: input.target ? { kind: "direct", sessionId: input.target, sessionIds: [input.target] } : { kind: "broadcast", sessionIds: [] } });
    },

    async listMessages(input: ListMessagesInput) {
      return await daemonRuntime.call("getEvents", {
        channelId: input.channel ?? undefined,
        afterCursor: input.since,
        sessionId: input.session,
        limit: input.limit,
      });
    },

    async sendPrompt(input: SendPromptInput) {
      return daemonRuntime.callAs(input.session, "send", { channelId: input.channel, senderSessionId: input.session, body: input.prompt, target: { kind: "direct", sessionId: input.session, sessionIds: [input.session] } });
    },
    async runtimeCreate(input: RuntimeCLIInput) { const actor = runtimeActor(repository, input.credential); return daemonRuntime.callAs(actor.sessionId, "runtimeCreate", { runtimeId: input.runtimeId, homeAuthorityId: input.homeAuthorityId ?? homeAuthorityId, sessionId: input.sessionId, generation: input.generation, machineId: input.machineId, stateDir: input.stateDir, shell: input.shell, command: input.command, cwd: input.cwd, channelId: input.channelId, adapterKind: input.adapterKind, providerThreadId: input.providerThreadId ?? null }); },
    async runtimeList(credential: string) { const actor = runtimeActor(repository, credential); return daemonRuntime.callAs(actor.sessionId, "runtimeList", {}); },
    async runtimeStatus(runtimeId: string, credential: string) { const actor = runtimeActor(repository, credential); return daemonRuntime.callAs(actor.sessionId, "runtimeStatus", { runtimeId }); },
    async runtimeAttach(input: RuntimeAttachCLIInput) { const actor = runtimeActor(repository, input.credential); return daemonRuntime.callAs(actor.sessionId, "runtimeAttach", input); },
    async runtimeResolveSessionAttach(sessionId: string, credential: string, mode: "observe" | "controller", outputCursor?: string) {
      const actor = runtimeActor(repository, credential);
      const listed = await daemonRuntime.callAs(actor.sessionId, "runtimeList", {}) as { runtimes?: Array<{ runtimeId: string; homeAuthorityId: string; sessionId: string; generation: number; state: string; endedAt?: string | null }> };
      const runtime = (listed.runtimes ?? []).filter((item) => item.sessionId === sessionId && !item.endedAt && ["running", "recovering"].includes(item.state)).sort((left, right) => right.generation - left.generation)[0];
      if (!runtime) throw new Error(`session ${sessionId} has no active Rooms runtime`);
      if (actor.role !== "operator" && actor.sessionId !== sessionId) throw new Error("runtimeUnauthorized");
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
  };
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
      ? blueprint.members
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

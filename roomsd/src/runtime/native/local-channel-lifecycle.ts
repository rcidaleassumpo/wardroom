// SPDX-License-Identifier: Apache-2.0
import type { RuntimeActor } from "../contracts.js";
import type { RoomsRuntimeService } from "../service.js";
import type { ResumableChannelBlueprint, ResumableMemberBlueprint } from "../../blueprints/resumable.js";
import { SQLiteBlueprintStore, SQLiteRuntimeOwnershipStore } from "../../storage/blueprint-repository.js";
import { RoomsRepository } from "../../storage/repository.js";
import { createCodexAdapters } from "../codex-adapter.js";
import { listRegisteredProviders } from "../../cli/provider-registry.js";
import { DurableChannelLifecycle, type CanonicalDeliveryPort, type CanonicalMemberReattachmentPort, type RuntimeGenerationPort } from "../../lifecycle/suspend-resume.js";

const isoNow = (): string => new Date().toISOString();

/** Daemon-owned suspend/resume composition shared by every local client. */
export class LocalChannelLifecycle {
  readonly canonical: SQLiteCanonicalMembers;

  constructor(
    private readonly repository: RoomsRepository,
    private readonly blueprintStore: SQLiteBlueprintStore,
    private readonly runtimeService: RoomsRuntimeService,
    private readonly homeAuthorityId: string,
    private readonly stateDir: string,
  ) {
    this.canonical = new SQLiteCanonicalMembers(repository);
  }

  async suspend(channelId: string, actor: RuntimeActor): Promise<unknown> {
    if (!this.repository.currentChannel(channelId)) throw new Error(`cannot suspend channel "${channelId}": channel does not exist`);
    ensureChannelBlueprint(this.repository, this.blueprintStore, channelId);
    const activeMembers = this.repository.db.prepare(`SELECT m.session_id
      FROM memberships m
      JOIN sessions s ON s.id=m.session_id
      WHERE m.channel_id=? AND m.left_at IS NULL AND m.session_ended_at IS NULL AND s.ended_at IS NULL`).all(channelId) as Array<{ session_id: string }>;
    this.blueprintStore.retainMembers(channelId, new Set(activeMembers.map(member => member.session_id)));
    for (const member of this.blueprintStore.read(channelId)?.members ?? []) {
      const row = this.repository.db.prepare("SELECT generation, provider_thread_id FROM runtimes WHERE session_id=? ORDER BY generation DESC, created_at DESC LIMIT 1").get(member.priorSessionId) as { generation?: number; provider_thread_id?: string | null } | undefined;
      const providerThreadId = row?.provider_thread_id ?? this.repository.currentSession(member.priorSessionId)?.providerThreadId ?? member.provider?.conversationId ?? null;
      this.canonical.ensureBlueprint(channelId, channelId, {
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
    return this.lifecycle(actor).suspend(channelId, `service-suspend-${channelId}`, this.blueprintStore.read(channelId)!);
  }

  async resume(channelId: string, actor: RuntimeActor): Promise<readonly import("../../lifecycle/suspend-resume.js").MemberResumeOutcome[]> {
    const channel = this.repository.currentChannel(channelId);
    if (!channel) throw new Error(`cannot resume channel "${channelId}": channel does not exist`);
    if (channel.lifecycleState === "closed") {
      this.repository.reopenChannel(channelId);
      return [];
    }
    const blueprint = this.blueprintStore.read(channelId);
    if (!blueprint) throw new Error(`cannot resume channel "${channelId}": channel has not been suspended`);
    const status = this.lifecycle(actor).status(channelId) as { state?: string; generation?: number };
    const blueprintGeneration = Math.max(0, ...blueprint.members.map(member => member.processGeneration));
    const generation = status.state === "resuming" && Number(status.generation) > 0
      ? Number(status.generation)
      : Math.max(Number(status.generation ?? 0), blueprintGeneration) + 1;
    return this.lifecycle(actor).resume(channelId, `service-resume-${channelId}-${generation}`, generation);
  }

  private lifecycle(actor: RuntimeActor): DurableChannelLifecycle {
    const ownership = new SQLiteRuntimeOwnershipStore(this.repository.db);
    const providers = listRegisteredProviders(this.stateDir)
      .filter((provider): provider is typeof provider & { name: "codex" | "claude" | "grok" } => ["codex", "claude", "grok"].includes(provider.name));
    const legacyDrainOnlyAdapters = createCodexAdapters(this.blueprintStore, { runtimeOwnership: ownership, providerRegistrations: providers });
    const runtime: RuntimeGenerationPort = {
      activeGenerations: (input) => {
        if (input.length === 0) return new Set<string>();
        const placeholders = input.map(() => "(?, ?)").join(", ");
        const rows = this.repository.db.prepare(`SELECT DISTINCT session_id, generation FROM runtimes
          WHERE ended_at IS NULL AND state IN ('creating','running','recovering','terminating')
          AND (session_id, generation) IN (${placeholders})`).all(...input.flatMap(member => [member.priorSessionId, member.generation])) as Array<{ session_id: string; generation: number }>;
        return new Set(rows.map(row => `${row.session_id}:${Number(row.generation)}`));
      },
      launch: async (input) => {
        const member = this.blueprintStore.read(input.channelId)?.members.find(item => item.priorSessionId === input.priorSessionId);
        const launched = await this.runtimeService.create({
          homeAuthorityId: this.homeAuthorityId,
          sessionId: input.priorSessionId,
          generation: input.generation,
          channelId: input.channelId,
          adapterKind: input.adapterKind,
          providerThreadId: member?.provider?.conversationId ?? null,
          cwd: input.launch.cwd,
          effectiveHome: input.launch.home ?? member?.launch.home ?? null,
          command: [input.launch.executable, ...input.launch.args],
        } as never, actor) as { runtime?: { runtimeId?: string; sessionId?: string; providerThreadId?: string | null } };
        if (!launched.runtime?.runtimeId) throw new Error("resumed runtime did not return an identity");
        const providerThreadId = launched.runtime.providerThreadId ?? member?.provider?.conversationId ?? null;
        if (providerThreadId && member) {
          this.repository.setSessionProviderThreadId(input.priorSessionId, providerThreadId);
          this.canonical.ensureBlueprint(input.channelId, input.channelId, {
            ...member,
            processGeneration: input.generation,
            provider: { conversationId: providerThreadId, resumeDescriptor: { provider: member.adapterKind, mode: "runtime", cwd: member.launch.cwd } },
          });
        }
        return { sessionId: launched.runtime.sessionId ?? input.priorSessionId, runtimeId: launched.runtime.runtimeId };
      },
      stop: async (input) => {
        const row = this.repository.db.prepare("SELECT generation, state, ended_at FROM runtimes WHERE runtime_id=?").get(input.runtimeId) as { generation?: number; state?: string; ended_at?: string | null } | undefined;
        if (!row || row.ended_at || ["exited", "terminated"].includes(row.state ?? "")) return;
        await this.runtimeService.terminate({ runtimeId: input.runtimeId, generation: Number(row.generation) } as never, actor);
      },
      stopGeneration: async (input) => {
        const row = this.repository.db.prepare("SELECT runtime_id, state, ended_at FROM runtimes WHERE session_id=? AND generation=? ORDER BY created_at DESC LIMIT 1").get(input.priorSessionId, input.generation) as { runtime_id?: string; state?: string; ended_at?: string | null } | undefined;
        if (!row || row.ended_at || ["exited", "terminated"].includes(row.state ?? "")) return;
        await this.runtimeService.terminate({ runtimeId: String(row.runtime_id), generation: input.generation } as never, actor);
      },
    };
    const delivery: CanonicalDeliveryPort = { deliver: async () => true };
    return new DurableChannelLifecycle(this.blueprintStore, runtime, legacyDrainOnlyAdapters.provider, delivery, this.canonical);
  }
}

/** Ordinary channels may have no runtime member yet; make them lifecycle-ready. */
export function ensureChannelBlueprint(repository: RoomsRepository, store: SQLiteBlueprintStore, channelId: string): ResumableChannelBlueprint {
  const existing = store.read(channelId);
  if (existing) return existing;
  const blueprint: ResumableChannelBlueprint = { version: 1, channelId, channelName: channelId, goal: "", suspendedAt: isoNow(), historyCursor: "0", members: [] };
  repository.db.prepare("INSERT INTO channel_blueprints(channel_id, blueprint_json, state, updated_at) VALUES (?, ?, 'active', ?)").run(channelId, JSON.stringify(blueprint), isoNow());
  return blueprint;
}

export class SQLiteCanonicalMembers implements CanonicalMemberReattachmentPort {
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
    this.repository.db.prepare("INSERT INTO channel_blueprints(channel_id, blueprint_json, state, updated_at) VALUES (?, ?, 'active', ?) ON CONFLICT(channel_id) DO UPDATE SET blueprint_json=excluded.blueprint_json, updated_at=excluded.updated_at")
      .run(channelId, JSON.stringify({ ...blueprint, members }), isoNow());
  }

  async reattachMembers(input: readonly { channelId: string; priorSessionId: string; sessionId: string; runtimeId: string; generation: number; role: string | null }[]): Promise<void> {
    for (const member of input) {
      if (!this.repository.currentSession(member.sessionId)) this.repository.insertSession({ id: member.sessionId, role: member.role as "operator" | "planner" | "worker" | "reviewer" | null });
      if (!this.repository.isActiveMember(member.channelId, member.sessionId)) this.repository.insertMembership(member.channelId, member.sessionId, member.role as "operator" | "planner" | "worker" | "reviewer" | null);
      this.resumed.set(member.generation, [...(this.resumed.get(member.generation) ?? []), member.sessionId]);
    }
  }

  async rollbackGeneration(_channelId: string, generation: number): Promise<void> {
    for (const sessionId of this.resumed.get(generation) ?? []) if (this.repository.currentSession(sessionId)?.endedAt === null) this.repository.markSessionEnded(sessionId);
    this.resumed.delete(generation);
  }
}

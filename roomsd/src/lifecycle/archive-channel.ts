import type { RoomsRepository } from "../storage/repository.js";

export type ChannelArchiveInput = Readonly<{ channelId: string; force: boolean }>;
export type ChannelArchiveRuntime = Readonly<{ runtimeId: string; sessionId: string; generation: number }>;

export async function archiveChannelLifecycle(
  repository: RoomsRepository,
  input: ChannelArchiveInput,
  operations: Readonly<{
    terminateRuntime(runtime: ChannelArchiveRuntime): Promise<unknown>;
    closeChannel(): Promise<unknown>;
  }>,
): Promise<Record<string, unknown>> {
  const channel = repository.currentChannel(input.channelId);
  if (!channel) throw new Error(`cannot archive channel "${input.channelId}": channel does not exist`);
  const memberRows = activeChannelMemberships(repository, input.channelId);
  const runtimeRows = activeChannelRuntimes(repository, input.channelId);
  const requiresForce = channel.lifecycleState === "active" && (memberRows.length > 0 || runtimeRows.length > 0);
  const policy = { requiresForce, activeMemberships: memberRows.length, activeRuntimes: runtimeRows.length };
  if (requiresForce && !input.force) {
    return { channelId: input.channelId, completed: false, policy, steps: [], error: { code: "archiveForceRequired", message: "channel archive requires explicit force while sessions or runtimes remain attached" } };
  }

  const runtimeSteps: Array<Record<string, unknown>> = [];
  for (const runtime of runtimeRows) {
    try {
      const result = await operations.terminateRuntime(runtime);
      runtimeSteps.push({ ...runtime, outcome: "terminated", result });
    } catch (error) {
      runtimeSteps.push({ ...runtime, outcome: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (runtimeSteps.some((step) => step.outcome === "failed")) {
    return { channelId: input.channelId, completed: false, policy, steps: [{ step: "runtimes", ok: false, results: runtimeSteps }], error: { code: "archiveRuntimeTerminationFailed", message: "one or more channel runtimes could not be terminated" } };
  }

  const closeResult = await operations.closeChannel();
  const remainingMemberships = activeChannelMemberships(repository, input.channelId);
  const remainingRuntimes = activeChannelRuntimes(repository, input.channelId);
  const closed = repository.currentChannel(input.channelId)?.lifecycleState === "closed";
  const completed = closed && remainingMemberships.length === 0 && remainingRuntimes.length === 0;
  return {
    channelId: input.channelId,
    completed,
    policy,
    steps: [
      { step: "runtimes", ok: remainingRuntimes.length === 0, results: runtimeSteps },
      { step: "memberships", ok: remainingMemberships.length === 0, ended: memberRows.length, remaining: remainingMemberships.length },
      { step: "channel", ok: closed, state: repository.currentChannel(input.channelId)?.lifecycleState, result: closeResult },
    ],
  };
}

function activeChannelMemberships(repository: RoomsRepository, channelId: string): Array<{ sessionId: string }> {
  return repository.db.prepare(`SELECT session_id FROM memberships
    WHERE channel_id=? AND left_at IS NULL AND session_ended_at IS NULL
    ORDER BY joined_at, session_id`).all(channelId).map((row) => ({ sessionId: String((row as Record<string, unknown>).session_id) }));
}

function activeChannelRuntimes(repository: RoomsRepository, channelId: string): ChannelArchiveRuntime[] {
  return repository.db.prepare(`SELECT r.runtime_id, r.session_id, r.generation
    FROM runtimes r
    JOIN runtime_bindings b ON b.runtime_id=r.runtime_id AND b.unbound_at IS NULL
    WHERE b.channel_id=? AND r.ended_at IS NULL AND r.state IN ('creating','running','recovering','terminating')
    ORDER BY r.created_at, r.runtime_id`).all(channelId).map((row) => {
      const value = row as Record<string, unknown>;
      return { runtimeId: String(value.runtime_id), sessionId: String(value.session_id), generation: Number(value.generation) };
    });
}

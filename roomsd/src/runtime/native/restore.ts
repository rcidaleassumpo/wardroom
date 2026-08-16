// SPDX-License-Identifier: Apache-2.0
import type { RoomsRepository } from "../../storage/repository.js";
import type { RuntimeRepository } from "../../storage/runtime-repository.js";
import type { Runtime } from "../contracts.js";
import type { RoomsRuntimeService } from "../service.js";
import { HOST_ABSENT_REASON } from "../service.js";
import { planSessionResume, type SessionResumePlan } from "../../cli/session-resume.js";

export interface RestoreOutcome {
  restored: readonly string[];
  skipped: readonly { sessionId: string; reason: string }[];
  failed: readonly { sessionId: string; reason: string }[];
}

export interface RestoreInput {
  runtimeService: RoomsRuntimeService;
  runtimes: RuntimeRepository;
  database: RoomsRepository;
  homeAuthorityId: string;
  stateDir: string;
  log?: (message: string) => void;
  plan?: (sessionId: string, stateDir: string) => SessionResumePlan;
}

/**
 * Sessions this machine was running when it lost its runtime hosts.
 *
 * The test is the unbroken run of crashed generations on top of the session,
 * not the newest row alone. A restore that fails leaves its own crashed
 * generation above the absent one, and the session is still down, so the next
 * start must try again once the operator has fixed whatever refused to launch.
 * Any other newest state ends the outage: running means it came back, exited
 * means the provider closed itself, terminated means somebody decided.
 */
export function interruptedSessions(runtimes: RuntimeRepository, homeAuthorityId: string): { sessionId: string; channelId: string | null }[] {
  const generations = new Map<string, Runtime[]>();
  for (const runtime of runtimes.list()) {
    if (runtime.homeAuthorityId !== homeAuthorityId) continue;
    generations.set(runtime.sessionId, [...(generations.get(runtime.sessionId) ?? []), runtime]);
  }
  const interrupted: { sessionId: string; channelId: string | null }[] = [];
  for (const [sessionId, rows] of generations) {
    const newestFirst = [...rows].sort((left, right) => right.generation - left.generation);
    const crashed: Runtime[] = [];
    for (const runtime of newestFirst) {
      if (runtime.state !== "crashed") break;
      crashed.push(runtime);
    }
    if (!crashed.some((runtime) => runtime.exitReason === HOST_ABSENT_REASON)) continue;
    // A launch that never bound has no channel of its own, so the channel comes
    // from the newest generation that got far enough to bind one.
    const channelId = newestFirst.map((runtime) => runtimes.getBinding(runtime.runtimeId)?.channelId ?? null).find((value) => value !== null) ?? null;
    interrupted.push({ sessionId, channelId });
  }
  return interrupted;
}

/**
 * Put the agents back after an outage. A machine that sleeps, loses power, or
 * upgrades Rooms takes every provider process with it, and until now the
 * operator had to notice the silence and relaunch each session by hand.
 *
 * Each session resumes onto its own stored provider thread at the next
 * generation, so an agent returns with its work rather than as a stranger.
 * Restores run one at a time: a login that starts thirty providers at once
 * costs more than it saves, and the runtime quota is per machine.
 *
 * A session that cannot come back is reported once and never retried in a
 * loop, because a missing provider binary or a deleted working directory
 * needs a person.
 */
export async function restoreInterruptedSessions(input: RestoreInput): Promise<RestoreOutcome> {
  const plan = input.plan ?? ((sessionId, stateDir) => planSessionResume(sessionId, stateDir));
  const log = input.log ?? ((message: string) => console.error(message));
  const restored: string[] = [];
  const skipped: { sessionId: string; reason: string }[] = [];
  const failed: { sessionId: string; reason: string }[] = [];
  for (const candidate of interruptedSessions(input.runtimes, input.homeAuthorityId)) {
    const { sessionId } = candidate;
    const session = input.database.currentSession(sessionId);
    if (!session || session.endedAt) { skipped.push({ sessionId, reason: "session ended" }); continue; }
    // A closed or suspended channel was put down on purpose. Its agents stay
    // down until the channel itself is resumed.
    const lifecycle = candidate.channelId ? input.database.currentChannel(candidate.channelId)?.lifecycleState ?? null : null;
    if (lifecycle && lifecycle !== "active") { skipped.push({ sessionId, reason: `channel is ${lifecycle}` }); continue; }
    try {
      const resume = plan(sessionId, input.stateDir);
      if (resume.alreadyRunning) { skipped.push({ sessionId, reason: "already running" }); continue; }
      await input.runtimeService.create({
        homeAuthorityId: input.homeAuthorityId,
        sessionId,
        generation: resume.generation,
        channelId: resume.channelId ?? undefined,
        adapterKind: resume.adapterKind,
        providerThreadId: resume.providerThreadId,
        cwd: resume.cwd ?? undefined,
        effectiveHome: resume.effectiveHome,
        command: resume.command,
      } as never, { sessionId, role: input.database.sessionRoleValue(sessionId) ?? "worker", credentialId: "runtime-restore" });
      restored.push(sessionId);
    } catch (error) {
      failed.push({ sessionId, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  if (restored.length) log(`roomsd: restored ${restored.length} session(s) whose runtime host was lost`);
  for (const item of failed) log(`roomsd: session ${item.sessionId} could not be restored: ${item.reason}`);
  return { restored, skipped, failed };
}

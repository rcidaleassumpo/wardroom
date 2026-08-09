import type { ResumableChannelBlueprint } from "../blueprints/resumable.js";
import type { DurableChannelLifecycle, MemberResumeOutcome } from "../lifecycle/suspend-resume.js";

export interface LifecycleCLI {
  suspend(channelId: string, idempotencyKey: string, blueprint: ResumableChannelBlueprint): Promise<unknown>;
  resume(channelId: string, idempotencyKey: string, generation: number): Promise<readonly MemberResumeOutcome[]>;
  status(channelId: string): Promise<unknown>;
}

export async function runLifecycleCLI(argv: readonly string[], lifecycle: LifecycleCLI): Promise<string> {
  const [command, channelId, idempotencyKey, generationOrBlueprint] = argv;
  if (!command || !channelId) throw new Error("usage: rooms lifecycle <suspend|resume|status> <channel-id> [idempotency-key] [generation|blueprint-json]");
  if (!new Set(["suspend", "resume", "status"]).has(command)) throw new Error(`unknown lifecycle command: ${command}`);
  let result: unknown;
  if (command === "resume") {
    if (!idempotencyKey || !generationOrBlueprint) throw new Error("resume requires idempotency-key and generation");
    const generation = Number(generationOrBlueprint);
    if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error("generation must be a positive integer");
    result = await lifecycle.resume(channelId, idempotencyKey, generation);
  }
  else if (command === "suspend") {
    if (!idempotencyKey) throw new Error("suspend requires idempotency-key and blueprint JSON");
    if (!generationOrBlueprint) throw new Error("suspend requires blueprint JSON as the fourth argument");
    result = await lifecycle.suspend(channelId, idempotencyKey, JSON.parse(generationOrBlueprint) as ResumableChannelBlueprint);
  }
  else if (command === "status") result = await lifecycle.status(channelId);
  return JSON.stringify({ channelId, command, result });
}

export function lifecycleCLI(lifecycle: DurableChannelLifecycle): LifecycleCLI {
  return { suspend: (channelId, key, blueprint) => lifecycle.suspend(channelId, key, blueprint), resume: (channelId, key, generation) => lifecycle.resume(channelId, key, generation), status: async channelId => lifecycle.status(channelId) };
}

/** Process-facing composition seam: callers create one lifecycle per process and pass it here. */
export async function executeLifecycleCLI(argv: readonly string[], createLifecycle: () => LifecycleCLI): Promise<string> {
  return runLifecycleCLI(argv, createLifecycle());
}

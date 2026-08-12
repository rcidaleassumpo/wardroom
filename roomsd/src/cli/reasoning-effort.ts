import type { RoomsProvider } from "./provider-registry.js";

export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

/**
 * How each provider CLI accepts an explicit reasoning effort, verified against
 * the installed CLIs rather than assumed:
 *   codex  -c model_reasoning_effort=<value>   (config override)
 *   grok   --reasoning-effort <value>          (alias --effort)
 *   claude no equivalent flag exists
 *
 * A provider with no way to accept it must fail closed. Silently dropping the
 * request is what this ticket was filed about: the caller asked for low effort
 * and the preset default quietly selected high.
 */
const FORWARDING: Readonly<Record<RoomsProvider, ((effort: ReasoningEffort) => string[]) | null>> = {
  codex: (effort) => ["-c", `model_reasoning_effort=${effort}`],
  grok: (effort) => ["--reasoning-effort", effort],
  claude: null,
  gemini: null,
};

export function parseReasoningEffort(value: string): ReasoningEffort {
  if (!(REASONING_EFFORTS as readonly string[]).includes(value)) {
    throw new Error(`--effort must be one of ${REASONING_EFFORTS.join(", ")}`);
  }
  return value as ReasoningEffort;
}

export function providerHonorsReasoningEffort(provider: RoomsProvider): boolean {
  return FORWARDING[provider] !== null;
}

/**
 * Arguments that force the effort for this provider, or a thrown error when the
 * provider cannot honor it. Placed ahead of caller-supplied passthrough args so
 * an explicit user flag still wins.
 */
export function reasoningEffortArguments(provider: RoomsProvider, effort: ReasoningEffort): string[] {
  const forward = FORWARDING[provider];
  if (!forward) {
    throw new Error(
      `${provider} does not accept an explicit reasoning effort, so Rooms cannot honor --effort ${effort}. Remove --effort, or launch a provider that supports it (${Object.keys(FORWARDING).filter((name) => FORWARDING[name as RoomsProvider]).join(", ")}).`,
    );
  }
  return forward(effort);
}

/** True when the caller already set the provider's own effort flag themselves. */
export function argsAlreadySetReasoningEffort(provider: RoomsProvider, args: readonly string[]): boolean {
  if (provider === "grok") return args.some((arg) => arg === "--reasoning-effort" || arg === "--effort" || arg.startsWith("--reasoning-effort=") || arg.startsWith("--effort="));
  if (provider === "codex") return args.some((arg, index) => /^model_reasoning_effort=/.test(arg) || ((arg === "-c" || arg === "--config") && /^model_reasoning_effort=/.test(args[index + 1] ?? "")));
  return false;
}

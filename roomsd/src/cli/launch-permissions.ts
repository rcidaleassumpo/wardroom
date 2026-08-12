import type { RoomsProvider } from "./provider-registry.js";

export const LAUNCH_PERMISSION_MODES = ["headless", "manual"] as const;
export type LaunchPermissionMode = typeof LAUNCH_PERMISSION_MODES[number];

/**
 * A launched session has no human at its terminal. Every provider CLI defaults
 * to asking for approval before the first non-allowlisted tool call, so a
 * launch that keeps the interactive default stalls forever on a prompt nobody
 * can answer: the session looks alive, burns CPU, and never produces a second
 * turn (internal work item).
 *
 * Rooms therefore owns the headless default and each provider's way of saying
 * "do not ask":
 *   claude  --dangerously-skip-permissions
 *   codex   --yolo
 *   grok    --permission-mode bypassPermissions
 *
 * The claude and codex forms are the ones already proven on this machine by the
 * Mycelia launcher; grok's is the documented flag from its own --help. A
 * provider added later must be entered here deliberately rather than defaulting
 * to silence, so the map is exhaustive over RoomsProvider.
 */
const HEADLESS_ARGUMENTS: Readonly<Record<RoomsProvider, readonly string[]>> = {
  claude: ["--dangerously-skip-permissions"],
  codex: ["--yolo"],
  grok: ["--permission-mode", "bypassPermissions"],
  gemini: ["--approval-mode", "yolo"],
};

/** Provider flags that already decide permission handling for the caller. */
const CALLER_SET_PATTERNS: Readonly<Record<RoomsProvider, readonly RegExp[]>> = {
  claude: [/^--permission-mode(=|$)/, /^--dangerously-skip-permissions$/, /^--allow-dangerously-skip-permissions$/],
  codex: [/^--yolo$/, /^--full-auto$/, /^--dangerously-bypass-approvals-and-sandbox$/, /^-a(=|$)/, /^--ask-for-approval(=|$)/, /^--sandbox(=|$)/],
  grok: [/^--permission-mode(=|$)/, /^--always-approve$/, /^--sandbox(=|$)/],
  gemini: [/^--approval-mode(=|$)/, /^--yolo$/],
};

export function parseLaunchPermissionMode(value: string): LaunchPermissionMode {
  if (!(LAUNCH_PERMISSION_MODES as readonly string[]).includes(value)) {
    throw new Error(`--permissions must be one of ${LAUNCH_PERMISSION_MODES.join(", ")}`);
  }
  return value as LaunchPermissionMode;
}

/** True when the caller already chose this provider's permission handling. */
export function argsAlreadySetPermissions(provider: RoomsProvider, args: readonly string[]): boolean {
  return args.some((arg) => CALLER_SET_PATTERNS[provider].some((pattern) => pattern.test(arg)));
}

/**
 * Arguments that make an unattended launch answer its own permission prompts.
 * An explicit caller flag wins, so a caller who passed their own permission
 * handling gets nothing added. `manual` opts out entirely, which only makes
 * sense when a controller will attach and answer the prompts by hand.
 */
export function launchPermissionArguments(provider: RoomsProvider, args: readonly string[], mode: LaunchPermissionMode): string[] {
  if (mode === "manual") return [];
  if (argsAlreadySetPermissions(provider, args)) return [];
  return [...HEADLESS_ARGUMENTS[provider]];
}

// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";

export type ManagedProviderLaunch = Readonly<{
  arguments: readonly string[];
  providerThreadId: string | null;
  promptPreloaded: boolean;
}>;

/**
 * Start providers with their supported initial-prompt argument when possible.
 * This keeps the first prompt in the provider's launch contract instead of
 * racing terminal setup through a later PTY write.
 */
export function prepareManagedProviderLaunch(input: Readonly<{
  adapterKind: string;
  arguments: readonly string[];
  prompt: string;
  createThreadId?: () => string;
}>): ManagedProviderLaunch {
  if (input.adapterKind === "codex") {
    return {
      arguments: [...input.arguments, input.prompt],
      providerThreadId: null,
      promptPreloaded: true,
    };
  }
  if (input.adapterKind !== "gemini") {
    return { arguments: [...input.arguments], providerThreadId: null, promptPreloaded: false };
  }
  if (input.arguments.some((argument) => argument === "-i"
    || argument === "--prompt-interactive"
    || argument.startsWith("--prompt-interactive=")
    || argument === "--session-id"
    || argument.startsWith("--session-id="))) {
    throw new Error("Rooms owns Gemini --session-id and --prompt-interactive for managed launches");
  }
  const providerThreadId = (input.createThreadId ?? randomUUID)();
  return {
    arguments: [...input.arguments, "--session-id", providerThreadId, "--prompt-interactive", input.prompt],
    providerThreadId,
    promptPreloaded: true,
  };
}

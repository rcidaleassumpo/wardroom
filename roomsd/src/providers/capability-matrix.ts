// SPDX-License-Identifier: Apache-2.0
import { ROOM_PROVIDERS, type RoomsProvider } from "../cli/provider-registry.js";

/** Normative capability paths from PROTOCOL.md section 8. */
export type ProviderCapabilityPath = "runtime" | "providerDriver" | "mcpToolCall";

/**
 * Sub-capabilities that justify the three normative paths.
 * These are derived from Rooms adapters and CLI composition, not from
 * provider marketing claims.
 */
export type ProviderCapabilityDetails = Readonly<{
  /** `rooms session launch|create` can bind a durable Rooms runtime. */
  sessionLaunch: boolean;
  /** Rooms can discover a native provider thread id after launch. */
  nativeThreadDiscovery: boolean;
  /** Provider conversation adapter can resume an existing thread. */
  conversationResume: boolean;
  /** Suspend/resume can rewrite launch args to resume in-process. */
  runtimeCommandResume: boolean;
  /** `rooms skills install` can install the Rooms coordination skill. */
  roomsSkillInstall: boolean;
}>;

export type ProviderCapabilityRow = Readonly<{
  provider: RoomsProvider;
  runtime: boolean;
  providerDriver: boolean;
  mcpToolCall: boolean;
  details: ProviderCapabilityDetails;
}>;

/**
 * Single tested source for the public provider capability matrix.
 * Documentation must publish this table rather than hand-maintained claims.
 */
export function providerCapabilityMatrix(): readonly ProviderCapabilityRow[] {
  return ROOM_PROVIDERS.map((provider) => rowFor(provider));
}

export function providerCapabilityRow(provider: RoomsProvider): ProviderCapabilityRow {
  return rowFor(provider);
}

/** Markdown table for PROTOCOL and public docs. */
export function formatProviderCapabilityMatrixMarkdown(
  rows: readonly ProviderCapabilityRow[] = providerCapabilityMatrix(),
): string {
  const lines = [
    "| Provider | Runtime | Provider driver | MCP / tool skill |",
    "| --- | --- | --- | --- |",
    ...rows.map((row) =>
      `| ${row.provider} | ${flag(row.runtime)} | ${flag(row.providerDriver)} | ${flag(row.mcpToolCall)} |`,
    ),
  ];
  return lines.join("\n");
}

function flag(value: boolean): string {
  return value ? "yes" : "no";
}

function rowFor(provider: RoomsProvider): ProviderCapabilityRow {
  const details = detailsFor(provider);
  return {
    provider,
    // Canonical runtime service accepts all registered adapter kinds.
    runtime: details.sessionLaunch,
    // Driver means Rooms can start the provider under a Rooms runtime.
    providerDriver: details.sessionLaunch,
    // MCP path is the Rooms coordination skill installed for the provider.
    mcpToolCall: details.roomsSkillInstall,
    details,
  };
}

function detailsFor(provider: RoomsProvider): ProviderCapabilityDetails {
  switch (provider) {
    case "codex":
      return {
        sessionLaunch: true,
        nativeThreadDiscovery: true,
        conversationResume: true,
        runtimeCommandResume: true,
        roomsSkillInstall: true,
      };
    case "claude":
      return {
        sessionLaunch: true,
        nativeThreadDiscovery: true,
        conversationResume: true,
        runtimeCommandResume: true,
        roomsSkillInstall: true,
      };
    case "grok":
      return {
        sessionLaunch: true,
        nativeThreadDiscovery: true,
        // ProviderConversationAdapter resume validates codex/claude only.
        conversationResume: false,
        // resumeLaunch rewrites args only for codex and claude runtime mode.
        runtimeCommandResume: false,
        roomsSkillInstall: true,
      };
    case "gemini":
      return {
        sessionLaunch: true,
        nativeThreadDiscovery: true,
        conversationResume: false,
        runtimeCommandResume: false,
        roomsSkillInstall: true,
      };
    default: {
      const _exhaustive: never = provider;
      throw new Error(`unknown Rooms provider: ${String(_exhaustive)}`);
    }
  }
}

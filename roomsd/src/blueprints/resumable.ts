// SPDX-License-Identifier: Apache-2.0
/** Durable, provider-neutral state needed to recreate a suspended member. */
export interface ProviderConversationRef {
  /** An opaque provider-owned identifier. Never interpret or log its contents. */
  conversationId: string;
  /** Provider-specific resume data, kept opaque by Rooms. */
  resumeDescriptor: unknown;
}

export interface AllowlistedLaunchConfig {
  executable: string;
  args: readonly string[];
  cwd: string;
  /**
   * Session generated home root, user-home-shaped (provider dot-dirs under
   * it). Absent or null means the ambient user home. A resumed generation
   * must reuse it: the provider transcript lives inside this home.
   */
  home?: string | null;
  /** Deliberately no environment map: secrets and arbitrary env are not durable state. */
}

export interface LayoutMetadata {
  terminalColumns: number | null;
  terminalRows: number | null;
  layoutVersion: string;
}

export interface MemberIntent {
  role: string | null;
  workUnitId: string | null;
}

export interface ResumableMemberBlueprint {
  channelId: string;
  priorSessionId: string;
  intent: MemberIntent;
  launch: AllowlistedLaunchConfig;
  layout: LayoutMetadata;
  adapterKind: string;
  lastAcknowledgedDeliveryCursor: string;
  role: string | null;
  joinedAt: string;
  processGeneration: number;
  provider: ProviderConversationRef | null;
}

export interface ResumableChannelBlueprint {
  version: 1;
  channelId: string;
  channelName: string;
  goal: string;
  suspendedAt: string;
  /** The last canonical history cursor included in this suspension. */
  historyCursor: string;
  members: readonly ResumableMemberBlueprint[];
}

export function cloneBlueprint(blueprint: ResumableChannelBlueprint): ResumableChannelBlueprint {
  return structuredClone(blueprint);
}

export function validateBlueprint(blueprint: ResumableChannelBlueprint): void {
  if (blueprint.version !== 1 || !blueprint.channelId || !blueprint.channelName || !blueprint.suspendedAt) {
    throw new Error("invalid resumable blueprint");
  }
  if (!/^(0|[1-9][0-9]*)$/.test(blueprint.historyCursor)) {
    throw new Error("invalid blueprint history cursor");
  }
  const ids = new Set<string>();
  for (const member of blueprint.members) {
    if (!member.priorSessionId || ids.has(member.priorSessionId) || member.processGeneration < 0 || !member.launch.executable || !member.launch.cwd || !member.adapterKind) {
      throw new Error("invalid resumable member");
    }
    ids.add(member.priorSessionId);
    if (member.channelId !== blueprint.channelId) throw new Error("member channel ID mismatch");
    if (!/^(0|[1-9][0-9]*)$/.test(member.lastAcknowledgedDeliveryCursor)) throw new Error("invalid member delivery cursor");
    if (member.provider && !member.provider.conversationId) throw new Error("invalid provider conversation");
  }
}

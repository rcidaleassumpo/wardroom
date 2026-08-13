// SPDX-License-Identifier: Apache-2.0
import type { CanonicalMessageCommitInput, Channel, ChannelBroadcastPolicy, MutationReceipt, Session, SessionRole } from "./contracts.js";
import { RoomsCommandError } from "./contracts.js";

export interface AuthenticatedCommandContext { credentialId: string; actorSessionId: string; role: SessionRole }
export interface DomainRepository {
  command<T>(operation: (repository: DomainRepository) => T): T;
  currentSession(id: string): Session | null;
  currentChannel(id: string): Channel | null;
  insertSession(input: { id: string; displayName?: string | null; role?: SessionRole | null }): MutationReceipt;
  insertChannel(input: { id: string; ownerOperatorSessionId?: string | null }): MutationReceipt;
  insertMembership(channelId: string, sessionId: string, role: SessionRole | null): MutationReceipt;
  leaveMembership(channelId: string, sessionId: string): MutationReceipt;
  markSessionEnded(sessionId: string): MutationReceipt;
  closeChannel(channelId: string): MutationReceipt;
  updateChannelLabel(channelId: string, label: string | null): MutationReceipt;
  updateChannelBroadcastPolicy(channelId: string, policy: ChannelBroadcastPolicy): MutationReceipt;
  sessionRoleValue(id: string): SessionRole | null;
  isActiveMember(channelId: string, sessionId: string, role?: SessionRole): boolean;
  activeMembershipCount(channelId: string, role: SessionRole): number;
  activeMembershipCountExcept(channelId: string, role: SessionRole, sessionId: string): number;
  activeMembershipChannels(sessionId: string): string[];
  updateSessionRole(channelId: string, sessionId: string, role: Exclude<SessionRole, "operator">): MutationReceipt;
  commitMessage(input: CanonicalMessageCommitInput): MutationReceipt & { event: unknown; wasDeduplicated?: boolean };
  commitControl(input: { channelId: string; senderSessionId: string; kind: string; payload: unknown; requestId: string }): MutationReceipt & { event: unknown; wasDeduplicated?: boolean };
}
export class RoomsApplication {
  constructor(private readonly store: DomainRepository) {}
  registerSession(input: { id: string; displayName?: string | null }, context: AuthenticatedCommandContext) {
    return this.store.command((store) => {
      const actor = store.currentSession(context.actorSessionId);
      if (actor && (actor.endedAt || actor.role !== context.role)) throw new RoomsCommandError("unauthorized");
      if (input.id !== context.actorSessionId) throw new RoomsCommandError("unauthorized");
      return store.insertSession({ ...input, role: context.role });
    });
  }
  registerChannel(input: { id: string }, context: AuthenticatedCommandContext) {
    return this.store.command((store) => {
      const actor = store.currentSession(context.actorSessionId);
      if (context.role !== "operator" || !actor || actor.endedAt || actor.role !== "operator") throw new RoomsCommandError("unauthorized");
      return store.insertChannel({ id: input.id, ownerOperatorSessionId: actor.id });
    });
  }
  join(channelId: string, sessionId: string, context: AuthenticatedCommandContext) {
    return this.store.command((store) => {
      const channel = store.currentChannel(channelId); const actor = store.currentSession(context.actorSessionId); const target = store.currentSession(sessionId);
      if (!channel) throw new RoomsCommandError("unknownChannel");
      if (channel.lifecycleState !== "active") throw new RoomsCommandError("channelClosed");
      if (!actor || actor.endedAt || actor.role !== context.role) throw new RoomsCommandError("unauthorizedActor");
      if (!target || target.endedAt) throw new RoomsCommandError("unknownSession");
      const ownerOperator = context.role === "operator" && channel.ownerOperatorSessionId === context.actorSessionId;
      // The actor's session role is authoritative; membership rows may carry
      // a legacy/null role after Swift-store import. Swift authorizes planner
      // workers by active planner membership, not by requiring both copies of
      // the role field to match.
      const plannerMember = context.role === "planner" && store.isActiveMember(channelId, context.actorSessionId);
      if (target.role === "worker" && !plannerMember) throw new RoomsCommandError("plannerAuthorizationRequired", `planner ${context.actorSessionId} is not an active member of ${channelId}`);
      if (target.role !== "worker" && !ownerOperator) throw new RoomsCommandError("ownerAuthorizationRequired", `operator does not own ${channelId}`);
      if ((target.role === "planner" && store.activeMembershipCount(channelId, "planner") > 0) || (target.role === "reviewer" && store.activeMembershipCount(channelId, "reviewer") > 0)) throw new RoomsCommandError("alreadyMember");
      return store.insertMembership(channelId, sessionId, target.role);
    });
  }
  endSession(sessionId: string, context: AuthenticatedCommandContext) {
    return this.store.command((store) => {
      const actor = store.currentSession(context.actorSessionId);
      if (!actor || actor.endedAt || actor.role !== context.role) throw new RoomsCommandError("unauthorized");
      if (context.actorSessionId === sessionId || context.role === "operator") {
        return store.markSessionEnded(sessionId);
      }
      // Channel planners may end workers they supervise so failed planner-
      // authorized launches can roll the session back (internal work item).
      if (context.role === "planner") {
        const target = store.currentSession(sessionId);
        if (!target || target.endedAt || target.role !== "worker") throw new RoomsCommandError("unauthorized");
        const canSupervise = store.activeMembershipChannels(context.actorSessionId).some((channelId) =>
          store.isActiveMember(channelId, context.actorSessionId, "planner")
          && store.isActiveMember(channelId, sessionId, "worker"),
        );
        if (!canSupervise) throw new RoomsCommandError("unauthorized");
        return store.markSessionEnded(sessionId);
      }
      throw new RoomsCommandError("unauthorized");
    });
  }
  closeChannel(channelId: string, context: AuthenticatedCommandContext) {
    return this.store.command((store) => {
      const actor = store.currentSession(context.actorSessionId);
      const channel = store.currentChannel(channelId);
      // Keep a channel manageable after its original operator retires. The
      // owner may close it, as may a later operator that is an active member.
      const ownedByAnotherOperator = channel !== null && channel.ownerOperatorSessionId !== null && channel.ownerOperatorSessionId !== actor?.id;
      const activeOperatorMember = channel !== null && store.isActiveMember(channelId, context.actorSessionId, "operator");
      if (!actor || actor.endedAt || actor.role !== "operator" || context.role !== "operator" || (ownedByAnotherOperator && !activeOperatorMember)) throw new RoomsCommandError("unauthorized");
      return store.closeChannel(channelId);
    });
  }
  labelChannel(channelId: string, label: string | null, context: AuthenticatedCommandContext) {
    return this.store.command((store) => {
      const actor = store.currentSession(context.actorSessionId);
      const channel = store.currentChannel(channelId);
      const ownedByAnotherOperator = channel !== null && channel.ownerOperatorSessionId !== null && channel.ownerOperatorSessionId !== actor?.id;
      const activeOperatorMember = channel !== null && store.isActiveMember(channelId, context.actorSessionId, "operator");
      if (!actor || actor.endedAt || actor.role !== "operator" || context.role !== "operator" || (ownedByAnotherOperator && !activeOperatorMember)) throw new RoomsCommandError("unauthorized");
      if (!channel) throw new RoomsCommandError("unknownChannel");
      return store.updateChannelLabel(channelId, label);
    });
  }
  setChannelBroadcastPolicy(channelId: string, policy: ChannelBroadcastPolicy, context: AuthenticatedCommandContext) {
    return this.store.command((store) => {
      const actor = store.currentSession(context.actorSessionId);
      const channel = store.currentChannel(channelId);
      // Same authority rule as updateSessionRole: the owning operator, or any
      // operator actively member of the channel (channels created by a since-
      // retired operator session would otherwise be unmanageable).
      const ownedByAnotherOperator = channel !== null && channel.ownerOperatorSessionId !== null && channel.ownerOperatorSessionId !== actor?.id;
      const activeOperatorMember = channel !== null && store.isActiveMember(channelId, context.actorSessionId, "operator");
      if (!actor || actor.endedAt || actor.role !== "operator" || context.role !== "operator" || (ownedByAnotherOperator && !activeOperatorMember)) throw new RoomsCommandError("unauthorized");
      if (!channel) throw new RoomsCommandError("unknownChannel");
      if (policy !== "all" && policy !== "privileged") throw new RoomsCommandError("invalidBroadcastPolicy", "broadcast policy must be all or privileged");
      return store.updateChannelBroadcastPolicy(channelId, policy);
    });
  }
  commitMessage(input: CanonicalMessageCommitInput) {
    if (!input.senderSessionId?.trim()) throw new RoomsCommandError("senderSessionIdRequired");
    if (!input.body?.trim()) throw new RoomsCommandError("emptyMessage");
    return this.store.command((store) => store.commitMessage(input));
  }
  commitControl(input: { channelId: string; senderSessionId: string; kind: string; payload: unknown; requestId: string }, context: AuthenticatedCommandContext) {
    if (!input.kind?.trim()) throw new RoomsCommandError("controlKindRequired");
    if (!input.requestId?.trim()) throw new RoomsCommandError("requestIdRequired");
    return this.store.command((store) => {
      const actor = store.currentSession(context.actorSessionId);
      const channel = store.currentChannel(input.channelId);
      if (!actor || actor.endedAt || actor.role !== context.role || input.senderSessionId !== actor.id) throw new RoomsCommandError("unauthorized");
      if (!channel) throw new RoomsCommandError("unknownChannel");
      if (channel.lifecycleState !== "active") throw new RoomsCommandError("channelClosed");
      if (!store.isActiveMember(input.channelId, actor.id)) throw new RoomsCommandError("notMember");
      return store.commitControl(input);
    });
  }
  leave(channelId: string, sessionId: string, context: AuthenticatedCommandContext) {
    return this.store.command((store) => {
      const actor = store.currentSession(context.actorSessionId);
      if (!actor || actor.endedAt || actor.role !== context.role || (context.actorSessionId !== sessionId && context.role !== "operator")) throw new RoomsCommandError("unauthorized");
      if (!store.isActiveMember(channelId, sessionId)) throw new RoomsCommandError("notMember");
      return store.leaveMembership(channelId, sessionId);
    });
  }

  updateSessionRole(channelId: string, sessionId: string, role: Exclude<SessionRole, "operator">, context: AuthenticatedCommandContext) {
    return this.store.command((store) => {
      const actor = store.currentSession(context.actorSessionId);
      const channel = store.currentChannel(channelId);
      const target = store.currentSession(sessionId);
      const ownedByAnotherOperator = channel !== null && channel.ownerOperatorSessionId !== null && channel.ownerOperatorSessionId !== context.actorSessionId;
      const activeOperatorMember = channel !== null && store.isActiveMember(channelId, context.actorSessionId, "operator");
      if (!actor || actor.endedAt || actor.role !== context.role || context.role !== "operator" || !channel || (ownedByAnotherOperator && !activeOperatorMember)) {
        throw new RoomsCommandError("ownerAuthorizationRequired", `operator does not own ${channelId}`);
      }
      if (!target || target.endedAt) throw new RoomsCommandError("unknownSession");
      if (!(role === "planner" || role === "worker" || role === "reviewer")) throw new RoomsCommandError("invalidRole", "role must be planner, worker, or reviewer");
      const affectedChannels = store.activeMembershipChannels(sessionId);
      for (const affectedChannelId of affectedChannels) {
        const plannerHandoffInTargetChannel = role === "planner" && affectedChannelId === channelId;
        if (!plannerHandoffInTargetChannel && (role === "planner" || role === "reviewer") && store.activeMembershipCountExcept(affectedChannelId, role, sessionId) > 0) {
          throw new RoomsCommandError("alreadyMember", `an active ${role} already exists in ${affectedChannelId}`);
        }
      }
      return store.updateSessionRole(channelId, sessionId, role);
    });
  }
}

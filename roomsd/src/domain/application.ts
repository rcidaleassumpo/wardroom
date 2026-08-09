import type { Channel, MutationReceipt, Session, SessionRole } from "./contracts.js";
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
  sessionRoleValue(id: string): SessionRole | null;
  isActiveMember(channelId: string, sessionId: string, role?: SessionRole): boolean;
  activeMembershipCount(channelId: string, role: SessionRole): number;
  activeMembershipCountExcept(channelId: string, role: SessionRole, sessionId: string): number;
  activeMembershipChannels(sessionId: string): string[];
  updateSessionRole(channelId: string, sessionId: string, role: Exclude<SessionRole, "operator">): MutationReceipt;
  commitMessage(input: { channelId: string | null; senderSessionId: string; body: string; target: unknown; correlation?: unknown; deliveryStatuses?: Record<string, "delivered" | "queued" | "undeliverable"> }): MutationReceipt & { event: unknown; wasDeduplicated?: boolean };
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
      if (!actor || actor.endedAt || actor.role !== context.role || (context.actorSessionId !== sessionId && context.role !== "operator")) throw new RoomsCommandError("unauthorized");
      return store.markSessionEnded(sessionId);
    });
  }
  closeChannel(channelId: string, context: AuthenticatedCommandContext) {
    return this.store.command((store) => {
      const actor = store.currentSession(context.actorSessionId);
      const channel = store.currentChannel(channelId);
      // An owned channel is closable only by its owning operator. A channel
      // with no recorded owner predates ownership (or was registered through
      // an ownerless path) and is closable by any operator.
      const ownedByAnotherOperator = channel !== null && channel.ownerOperatorSessionId !== null && channel.ownerOperatorSessionId !== actor?.id;
      if (!actor || actor.endedAt || actor.role !== "operator" || context.role !== "operator" || ownedByAnotherOperator) throw new RoomsCommandError("unauthorized");
      return store.closeChannel(channelId);
    });
  }
  labelChannel(channelId: string, label: string | null, context: AuthenticatedCommandContext) {
    return this.store.command((store) => {
      const actor = store.currentSession(context.actorSessionId);
      const channel = store.currentChannel(channelId);
      const ownedByAnotherOperator = channel !== null && channel.ownerOperatorSessionId !== null && channel.ownerOperatorSessionId !== actor?.id;
      if (!actor || actor.endedAt || actor.role !== "operator" || context.role !== "operator" || ownedByAnotherOperator) throw new RoomsCommandError("unauthorized");
      if (!channel) throw new RoomsCommandError("unknownChannel");
      return store.updateChannelLabel(channelId, label);
    });
  }
  commitMessage(input: { channelId: string | null; senderSessionId: string; body: string; target: unknown; correlation?: unknown; deliveryStatuses?: Record<string, "delivered" | "queued" | "undeliverable"> }) {
    if (!input.senderSessionId?.trim()) throw new RoomsCommandError("senderSessionIdRequired");
    if (!input.body?.trim()) throw new RoomsCommandError("emptyMessage");
    return this.store.command((store) => store.commitMessage(input));
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
      if (!actor || actor.endedAt || actor.role !== context.role || context.role !== "operator" || channel?.ownerOperatorSessionId !== context.actorSessionId) {
        throw new RoomsCommandError("ownerAuthorizationRequired", `operator does not own ${channelId}`);
      }
      if (!target || target.endedAt) throw new RoomsCommandError("unknownSession");
      if (!(role === "planner" || role === "worker" || role === "reviewer")) throw new RoomsCommandError("invalidRole", "role must be planner, worker, or reviewer");
      const affectedChannels = store.activeMembershipChannels(sessionId);
      for (const affectedChannelId of affectedChannels) {
        if ((role === "planner" || role === "reviewer") && store.activeMembershipCountExcept(affectedChannelId, role, sessionId) > 0) {
          throw new RoomsCommandError("alreadyMember", `an active ${role} already exists in ${affectedChannelId}`);
        }
      }
      return store.updateSessionRole(channelId, sessionId, role);
    });
  }
}

// SPDX-License-Identifier: Apache-2.0

export function sessionLaunchProvenance(input: {
  actorRole: "operator" | "planner" | "worker" | "reviewer";
  actorExternalOwner: string | null;
  targetSessionId: string;
  externalOwner?: string | null;
  externalAgentId?: string | null;
}): { externalOwner: string | null; externalAgentId: string | null } {
  const inheritedOwner = input.actorRole === "planner" ? input.actorExternalOwner : null;
  const externalOwner = input.externalOwner?.trim() || inheritedOwner;
  const externalAgentId = input.externalAgentId?.trim() || (externalOwner ? input.targetSessionId : null);
  if ((externalOwner === null) !== (externalAgentId === null)) {
    throw new Error("external owner and agent id must be supplied together");
  }
  return { externalOwner, externalAgentId };
}

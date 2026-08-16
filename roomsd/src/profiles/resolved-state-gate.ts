// SPDX-License-Identifier: Apache-2.0
import type {
  ChannelProfileRevision,
  ProviderModelSkillSet,
  ResolvedStateGate,
  ResolvedStateGateDecision,
  ResolvedStateGateInput,
  ResolvedStateGateRejection,
  ResolvedStateItem,
  ResolvedStateSurface,
} from "./contracts.js";

export const CONTROLLED_PROFILE_SURFACES: readonly ResolvedStateSurface[] = [
  "instructions",
  "projectInstructions",
  "skills",
  "plugins",
  "hooks",
  "memories",
  "mcpServers",
  "apps",
  "webAccess",
  "subagents",
  "tools",
] as const;

export const failClosedResolvedStateGate: ResolvedStateGate = {
  evaluate: evaluateResolvedState,
};

export function evaluateResolvedState(input: ResolvedStateGateInput): ResolvedStateGateDecision {
  const { profile, binding, attestation } = input;
  const rejections: ResolvedStateGateRejection[] = [];
  const modelSet = profile.modelSkillSets.find((candidate) => candidate.id === binding.modelSkillSetId);

  if (binding.profileRevisionId !== profile.id || binding.profileSha256 !== profile.sha256) {
    reject(rejections, "profileRevisionMismatch", "binding does not match the immutable profile revision");
  }
  if (!modelSet || modelSet.provider !== binding.provider || modelSet.model !== binding.effectiveModel) {
    reject(rejections, "modelProfileMismatch", "binding does not match one exact provider model profile");
  }
  if (!binding.executablePath.trim() || !binding.executableVersion.trim()) {
    reject(rejections, "executableUnverified", "provider executable path and version are required");
  }
  if (binding.authAttestation.requiredMode !== "subscription" || binding.authAttestation.resolvedMode !== "subscription"
    || binding.authAttestation.credentialSource === "apiKey" || binding.authAttestation.credentialSource === "unknown") {
    reject(rejections, "authModeMismatch", "controlled v1 launches require verified subscription authentication");
  }
  if (!binding.authAttestation.accountPresent) {
    reject(rejections, "authAccountMissing", "subscription account evidence is missing");
  }
  if (binding.authAttestation.apiKeyEnvironmentVariables.length > 0) {
    reject(rejections, "apiKeyEnvironmentPresent", "API-key environment variables are present");
  }

  if (!attestationMatchesBinding(input)) {
    reject(rejections, "attestationMetadataMismatch", "resolved-state metadata does not match the session binding");
  }

  const surfaceRows = new Map<ResolvedStateSurface, typeof attestation.surfaces>();
  for (const surface of CONTROLLED_PROFILE_SURFACES) surfaceRows.set(surface, []);
  for (const row of attestation.surfaces) {
    const rows = surfaceRows.get(row.surface);
    if (rows) surfaceRows.set(row.surface, [...rows, row]);
  }

  for (const surface of CONTROLLED_PROFILE_SURFACES) {
    const rows = surfaceRows.get(surface) ?? [];
    if (rows.length === 0) {
      reject(rejections, "surfaceMissing", `provider did not inspect ${surface}`);
      continue;
    }
    if (rows.length > 1) {
      reject(rejections, "surfaceDuplicate", `provider returned ${rows.length} inventories for ${surface}`);
      continue;
    }
    if (rows[0]!.inspection !== "verified") {
      reject(rejections, "surfaceUnverified", `${surface} inspection is ${rows[0]!.inspection}`);
    }
  }

  if (modelSet) compareInventory(profile, modelSet, attestation.surfaces, rejections);
  return rejections.length === 0 ? { accepted: true, rejections: [] } : { accepted: false, rejections };
}

function attestationMatchesBinding({ binding, attestation }: ResolvedStateGateInput): boolean {
  return attestation.profileRevisionId === binding.profileRevisionId
    && attestation.profileSha256 === binding.profileSha256
    && attestation.modelSkillSetId === binding.modelSkillSetId
    && attestation.provider === binding.provider
    && attestation.requestedModel === binding.requestedModel
    && attestation.effectiveModel === binding.effectiveModel;
}

function compareInventory(
  profile: ChannelProfileRevision,
  modelSet: ProviderModelSkillSet,
  surfaces: ResolvedStateGateInput["attestation"]["surfaces"],
  rejections: ResolvedStateGateRejection[],
): void {
  const expected = expectedItems(profile, modelSet);
  const actual = surfaces.flatMap((row) => row.items.map((item) => ({ surface: row.surface, ...item })));
  const expectedKeys = new Map(expected.map((item) => [itemKey(item.surface, item), item]));
  const actualKeys = new Map(actual.map((item) => [itemKey(item.surface, item), item]));

  for (const [key, item] of expectedKeys) {
    if (!actualKeys.has(key)) reject(rejections, "requiredItemMissing", `${item.surface}:${item.id}`);
  }
  for (const [key, item] of actualKeys) {
    if (!expectedKeys.has(key)) reject(rejections, "unexpectedItem", `${item.surface}:${item.id}`);
  }
}

function expectedItems(profile: ChannelProfileRevision, modelSet: ProviderModelSkillSet) {
  const projectInstructions = profile.projectInstructions.mode === "snapshot"
    ? profile.projectInstructions.snapshots.map((snapshot) => ({ surface: "projectInstructions" as const, id: snapshot.id, sha256: snapshot.sha256 }))
    : [];
  return [
    { surface: "instructions" as const, id: profile.instructions.id, sha256: profile.instructions.sha256 },
    ...projectInstructions,
    ...modelSet.skills.map((skill) => ({ surface: "skills" as const, id: skill.id, sha256: skill.rootSha256 })),
    ...modelSet.allowedBuiltinTools.map((id) => ({ surface: "tools" as const, id, sha256: null })),
    ...modelSet.providerSpecificResolvedItems,
  ];
}

function itemKey(surface: ResolvedStateSurface, item: ResolvedStateItem): string {
  return `${surface}\u0000${item.id}\u0000${item.sha256 ?? ""}`;
}

function reject(rejections: ResolvedStateGateRejection[], code: ResolvedStateGateRejection["code"], detail: string): void {
  rejections.push({ code, detail });
}

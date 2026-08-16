import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CONTROLLED_PROFILE_SURFACES,
  PROFILE_REVISIONS_STATE_PATH,
  canonicalChannelProfileRevisionContent,
  canonicalSkillSnapshotManifest,
  evaluateResolvedState,
  type ChannelProfileRevision,
  type ProviderResolvedStateAttestation,
  type ResolvedStateSurface,
  type SessionProfileBinding,
} from "../src/index.js";

const channelInstructions = {
  id: "channel-instructions",
  sourcePath: null,
  snapshotPath: "/state/profiles/revision-1/channel.md",
  sha256: "channel-sha",
  byteSize: 18,
  text: "Use the pinned skill.",
} as const;
const projectInstructions = {
  id: "project-instructions",
  sourcePath: "/work/AGENTS.md",
  snapshotPath: "/state/profiles/revision-1/project/AGENTS.md",
  sha256: "project-sha",
  byteSize: 20,
  text: "Pinned project rules.",
} as const;
const skillInstruction = {
  id: "skill-instructions",
  sourcePath: "/skills/example/SKILL.md",
  snapshotPath: "/state/profiles/revision-1/skills/example/SKILL.md",
  sha256: "skill-instruction-sha",
  byteSize: 15,
  text: "Exact skill text",
} as const;

const profile: ChannelProfileRevision = {
  id: "revision-1",
  name: "Example profile",
  channelId: "channel-1",
  version: 1,
  sha256: "profile-sha",
  createdAt: "2026-08-14T00:00:00.000Z",
  createdBySessionId: "operator-1",
  harnessMode: "controlled",
  instructions: channelInstructions,
  projectInstructions: { mode: "snapshot", snapshots: [projectInstructions] },
  modelSkillSets: [{
    id: "codex-gpt-5.6",
    provider: "codex",
    model: "gpt-5.6-sol",
    catalogVersion: "2026-08-12",
    authMode: "subscription",
    skills: [{
      id: "example-skill",
      name: "example",
      sourcePath: "/skills/example",
      snapshotPath: "/state/profiles/revision-1/skills/example",
      rootSha256: "skill-root-sha",
      instruction: skillInstruction,
      files: [{ relativePath: "SKILL.md", sha256: "skill-instruction-sha", byteSize: 15, executable: false }],
    }],
    allowedBuiltinTools: ["shell"],
    providerSpecificResolvedItems: [],
    toolEnvironment: { npmUserConfig: false, browserRuntime: false, sandyboxySandbox: null },
  }],
};

const binding: SessionProfileBinding = {
  id: "binding-1",
  sessionId: "session-1",
  channelId: "channel-1",
  profileRevisionId: "revision-1",
  profileSha256: "profile-sha",
  modelSkillSetId: "codex-gpt-5.6",
  provider: "codex",
  requestedModel: "gpt-5.6",
  effectiveModel: "gpt-5.6-sol",
  executablePath: "/usr/local/bin/codex",
  executableVersion: "1.2.3",
  authAttestation: {
    requiredMode: "subscription",
    resolvedMode: "subscription",
    credentialSource: "chatgptSubscription",
    accountPresent: true,
    apiKeyEnvironmentVariables: [],
    verifiedAt: "2026-08-14T00:00:01.000Z",
  },
  resolvedStateAttestation: null,
  boundAt: "2026-08-14T00:00:00.000Z",
};

function verifiedAttestation(): ProviderResolvedStateAttestation {
  const items = new Map<ResolvedStateSurface, Array<{ id: string; sha256: string | null }>>([
    ["instructions", [{ id: "channel-instructions", sha256: "channel-sha" }]],
    ["projectInstructions", [{ id: "project-instructions", sha256: "project-sha" }]],
    ["skills", [{ id: "example-skill", sha256: "skill-root-sha" }]],
    ["tools", [{ id: "shell", sha256: null }]],
  ]);
  return {
    profileRevisionId: binding.profileRevisionId,
    profileSha256: binding.profileSha256,
    modelSkillSetId: binding.modelSkillSetId,
    provider: binding.provider,
    requestedModel: binding.requestedModel,
    effectiveModel: binding.effectiveModel,
    inspectedAt: "2026-08-14T00:00:02.000Z",
    surfaces: CONTROLLED_PROFILE_SURFACES.map((surface) => ({
      surface,
      inspection: "verified",
      items: items.get(surface) ?? [],
    })),
  };
}

describe("controlled channel profile contracts", () => {
  it("defines stable snapshot storage and canonical bytes for adapter re-verification", () => {
    expect(PROFILE_REVISIONS_STATE_PATH).toBe("profiles/revisions");
    const manifest = canonicalSkillSnapshotManifest([
      { relativePath: "scripts/run.sh", sha256: "b".repeat(64), byteSize: 20, executable: true },
      { relativePath: "SKILL.md", sha256: "a".repeat(64), byteSize: 15, executable: false },
    ]);
    expect(new TextDecoder().decode(manifest)).toBe(
      `rooms-skill-snapshot-v1\u0000SKILL.md\u0000${"a".repeat(64)}\u000015\u0000false\u0000scripts/run.sh\u0000${"b".repeat(64)}\u000020\u0000true\u0000`,
    );

    const first = canonicalChannelProfileRevisionContent(profile);
    const reordered = canonicalChannelProfileRevisionContent({
      ...profile,
      channelId: "another-channel",
      createdAt: "later",
      modelSkillSets: profile.modelSkillSets.map((set) => ({ ...set, allowedBuiltinTools: [...set.allowedBuiltinTools].reverse() })),
    });
    expect(createHash("sha256").update(first).digest("hex")).toBe(createHash("sha256").update(reordered).digest("hex"));
  });

  it("keeps exact pinned skill instructions visible and accepts an exact resolved state", () => {
    expect(profile.modelSkillSets[0]!.skills[0]!.instruction.text).toBe("Exact skill text");
    expect(evaluateResolvedState({ profile, binding, attestation: verifiedAttestation() })).toEqual({ accepted: true, rejections: [] });
  });

  it("fails closed on API auth, unverified surfaces, and unexpected provider-visible items", () => {
    const attestation = verifiedAttestation();
    const result = evaluateResolvedState({
      profile,
      binding: {
        ...binding,
        authAttestation: {
          ...binding.authAttestation,
          resolvedMode: "api",
          credentialSource: "apiKey",
          apiKeyEnvironmentVariables: ["OPENAI_API_KEY"],
        },
      },
      attestation: {
        ...attestation,
        surfaces: attestation.surfaces.map((row) => row.surface === "plugins"
          ? { ...row, inspection: "unsupported", items: [{ id: "ambient-plugin", sha256: null }] }
          : row),
      },
    });

    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("expected rejection");
    expect(result.rejections.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "authModeMismatch",
      "apiKeyEnvironmentPresent",
      "surfaceUnverified",
      "unexpectedItem",
    ]));
  });

  it("rejects a missing inspection surface instead of treating absent evidence as empty", () => {
    const attestation = verifiedAttestation();
    const result = evaluateResolvedState({
      profile,
      binding,
      attestation: { ...attestation, surfaces: attestation.surfaces.filter(({ surface }) => surface !== "memories") },
    });

    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("expected rejection");
    expect(result.rejections).toContainEqual({ code: "surfaceMissing", detail: "provider did not inspect memories" });
  });
});

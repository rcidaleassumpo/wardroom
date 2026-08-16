import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTROLLED_PROFILE_SURFACES,
  canonicalChannelProfileRevisionContent,
  createChannelProfileRevision,
  listChannelProfileRevisions,
  persistSessionProfileBinding,
  profileRevisionPath,
  readChannelProfileRevision,
  readSessionProfileBinding,
  sessionProfileBindingPath,
  type CreateChannelProfileRevisionInput,
  type ProviderResolvedStateAttestation,
  type SessionProfileBinding,
} from "../src/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  for (const path of temporaryRoots.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("channel profile revision store", () => {
  it("lists only verified revisions for the requested channel in newest-version order", () => {
    const fixture = createFixture();
    createChannelProfileRevision(fixture.input);
    createChannelProfileRevision({ ...fixture.input, id: "revision-2", version: 2 });
    createChannelProfileRevision({ ...fixture.input, id: "other-channel", channelId: "other", version: 1 });

    expect(listChannelProfileRevisions(fixture.stateDir, "channel-1").map((profile) => profile.id)).toEqual(["revision-2", "revision-1"]);
  });

  it("copies exact instruction and skill bytes into an immutable owner-only revision", () => {
    const fixture = createFixture();
    const profile = createChannelProfileRevision(fixture.input);
    const revisionRoot = profileRevisionPath(fixture.stateDir, "revision-1");

    expect(profile.instructions.text).toBe("Channel rules\n");
    expect(profile.projectInstructions.mode).toBe("snapshot");
    if (profile.projectInstructions.mode !== "snapshot") throw new Error("expected project snapshots");
    expect(profile.projectInstructions.snapshots[0]!.text).toBe("Project rules\n");
    expect(profile.modelSkillSets.map(({ provider }) => provider)).toEqual(["codex", "claude"]);
    expect(profile.modelSkillSets[0]!.skills[0]).toBe(profile.modelSkillSets[1]!.skills[0]);
    expect(profile.modelSkillSets[0]!.skills[0]!.instruction.text).toBe("# Example skill\n\nUse exact input.\n");
    expect(readFileSync(join(revisionRoot, "skills", "example-skill", "scripts", "run.sh"), "utf8")).toBe("#!/bin/sh\necho exact\n");
    expect(profile.modelSkillSets[0]!.skills[0]!.files.find(({ relativePath }) => relativePath === "scripts/run.sh")?.executable).toBe(true);
    expect(lstatSync(join(revisionRoot, "skills", "example-skill", "scripts", "run.sh")).mode & 0o777).toBe(0o700);
    expect(profile.sha256).toBe(createHash("sha256").update(canonicalChannelProfileRevisionContent(profile)).digest("hex"));
    expect(readChannelProfileRevision(fixture.stateDir, profile.id)).toEqual(profile);
    expect(lstatSync(revisionRoot).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(revisionRoot, "profile.json")).mode & 0o777).toBe(0o600);
    expect(lstatSync(profile.modelSkillSets[0]!.skills[0]!.instruction.snapshotPath).mode & 0o777).toBe(0o600);
  });

  it("fails closed on live symlinks, revision collisions, and stored inventory drift", () => {
    const fixture = createFixture();
    symlinkSync(join(fixture.skillDir, "scripts", "run.sh"), join(fixture.skillDir, "linked.sh"));
    expect(() => createChannelProfileRevision(fixture.input)).toThrow(/symbolic link/);
    expect(() => lstatSync(profileRevisionPath(fixture.stateDir, "revision-1"))).toThrow();

    const clean = createFixture();
    const profile = createChannelProfileRevision(clean.input);
    expect(() => createChannelProfileRevision(clean.input)).toThrow(/already exists/);
    const extra = join(profile.modelSkillSets[0]!.skills[0]!.snapshotPath, "ambient.txt");
    writeFileSync(extra, "ambient", { mode: 0o600 });
    chmodSync(extra, 0o600);
    expect(() => readChannelProfileRevision(clean.stateDir, profile.id)).toThrow(/inventory mismatch/);
  });

  it("defaults a legacy revision name to its id", () => {
    const fixture = createFixture();
    const profile = createChannelProfileRevision(fixture.input);
    const path = join(profileRevisionPath(fixture.stateDir, profile.id), "profile.json");
    const legacy = JSON.parse(readFileSync(path, "utf8"));
    delete legacy.name;
    writeFileSync(path, `${JSON.stringify(legacy, null, 2)}\n`);
    chmodSync(path, 0o600);
    expect(readChannelProfileRevision(fixture.stateDir, profile.id).name).toBe(profile.id);
  });
});

describe("session profile binding store", () => {
  it("persists one binding and permits only its first resolved-state attestation", () => {
    const fixture = createFixture();
    const profile = createChannelProfileRevision(fixture.input);
    const binding = makeBinding(profile.sha256);
    expect(() => persistSessionProfileBinding(fixture.stateDir, { ...binding, credential: "secret" } as SessionProfileBinding)).toThrow(/unknown or missing fields/);
    persistSessionProfileBinding(fixture.stateDir, binding);
    expect(readSessionProfileBinding(fixture.stateDir, binding.id)).toEqual(binding);
    expect(lstatSync(sessionProfileBindingPath(fixture.stateDir, binding.id)).mode & 0o777).toBe(0o600);

    const attestation = makeAttestation(binding);
    const attested = { ...binding, resolvedStateAttestation: attestation };
    persistSessionProfileBinding(fixture.stateDir, attested);
    expect(readSessionProfileBinding(fixture.stateDir, binding.id)).toEqual(attested);
    expect(() => persistSessionProfileBinding(fixture.stateDir, { ...attested, executableVersion: "changed" })).toThrow(/immutable fields changed/);
    expect(() => persistSessionProfileBinding(fixture.stateDir, { ...binding })).toThrow(/attestation is already fixed|cannot be removed/);
    expect(() => persistSessionProfileBinding(fixture.stateDir, { ...attested, resolvedStateAttestation: { ...attestation, inspectedAt: "2026-08-14T00:00:09.000Z" } })).toThrow(/already fixed/);
  });

  it("rejects a binding for the wrong stored profile or model", () => {
    const fixture = createFixture();
    const profile = createChannelProfileRevision(fixture.input);
    expect(() => persistSessionProfileBinding(fixture.stateDir, { ...makeBinding(profile.sha256), profileSha256: "0".repeat(64) })).toThrow(/does not match its profile revision/);
    expect(() => persistSessionProfileBinding(fixture.stateDir, { ...makeBinding(profile.sha256), effectiveModel: "wrong-model" })).toThrow(/does not match its provider model profile/);
  });
});

function createFixture(): { stateDir: string; skillDir: string; input: CreateChannelProfileRevisionInput } {
  const root = mkdtempSync(join(tmpdir(), "rooms-profile-store-"));
  temporaryRoots.push(root);
  const stateDir = join(root, "state");
  const skillDir = join(root, "skill");
  const projectPath = join(root, "AGENTS.md");
  mkdirSync(stateDir, { mode: 0o700 });
  mkdirSync(join(skillDir, "scripts"), { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# Example skill\n\nUse exact input.\n");
  writeFileSync(join(skillDir, "scripts", "run.sh"), "#!/bin/sh\necho exact\n");
  chmodSync(join(skillDir, "scripts", "run.sh"), 0o755);
  writeFileSync(projectPath, "Project rules\n");
  return {
    stateDir,
    skillDir,
    input: {
      stateDir,
      id: "revision-1",
      name: "Example profile",
      channelId: "channel-1",
      version: 1,
      createdAt: "2026-08-14T00:00:00.000Z",
      createdBySessionId: "operator-1",
      instructions: { id: "channel-instructions", text: "Channel rules\n" },
      projectInstructions: { mode: "snapshot", files: [{ id: "project-instructions", path: projectPath }] },
      modelSkillSets: [
        {
          id: "codex-model",
          provider: "codex",
          model: "gpt-5.6-sol",
          catalogVersion: "2026-08-14",
          authMode: "subscription",
          skills: [{ id: "example-skill", name: "example", path: skillDir }],
          allowedBuiltinTools: ["shell"],
          providerSpecificResolvedItems: [],
          toolEnvironment: { npmUserConfig: true, browserRuntime: true, sandyboxySandbox: "packa-e2e" },
        },
        {
          id: "claude-model",
          provider: "claude",
          model: "claude-opus-4-1",
          catalogVersion: "2026-08-14",
          authMode: "subscription",
          skills: [{ id: "example-skill", name: "example", path: skillDir }],
          allowedBuiltinTools: ["shell"],
          providerSpecificResolvedItems: [],
          toolEnvironment: { npmUserConfig: false, browserRuntime: false, sandyboxySandbox: null },
        },
      ],
    },
  };
}

function makeBinding(profileSha256: string): SessionProfileBinding {
  return {
    id: "binding-1",
    sessionId: "session-1",
    channelId: "channel-1",
    profileRevisionId: "revision-1",
    profileSha256,
    modelSkillSetId: "codex-model",
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
}

function makeAttestation(binding: SessionProfileBinding): ProviderResolvedStateAttestation {
  return {
    profileRevisionId: binding.profileRevisionId,
    profileSha256: binding.profileSha256,
    modelSkillSetId: binding.modelSkillSetId,
    provider: binding.provider,
    requestedModel: binding.requestedModel,
    effectiveModel: binding.effectiveModel,
    inspectedAt: "2026-08-14T00:00:02.000Z",
    surfaces: CONTROLLED_PROFILE_SURFACES.map((surface) => ({ surface, inspection: "verified", items: [] })),
  };
}

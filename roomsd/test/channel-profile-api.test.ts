// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listProfileSkillCatalog,
  persistSessionProfileBinding,
  type ChannelProfileRevision,
  type SessionProfileBinding,
} from "../src/index.js";
import { setupMachineIdentity } from "../src/identity/machine-identity.js";
import { createNativeComposition } from "../src/runtime/native/composition.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("channel profile local API", () => {
  it("assigns immutable revision metadata and enforces channel ownership", async () => {
    const stateDir = temporaryDirectory("rooms-profile-api-");
    setupMachineIdentity(stateDir);
    const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
    composition.database.insertSession({ id: "operator", role: "operator" });
    composition.database.insertSession({ id: "outside", role: "operator" });
    composition.database.insertChannel({ id: "alpha", ownerOperatorSessionId: "operator" });
    composition.database.insertChannel({ id: "beta", ownerOperatorSessionId: "outside" });
    composition.database.insertMembership("alpha", "operator", "operator");
    const authenticated = requestIdentity("operator", "operator-credential");
    const outside = requestIdentity("outside", "outside-credential");
    const draft = {
      instructions: { id: "channel", text: "Use only pinned context.\n" },
      projectInstructions: { mode: "exclude" as const },
      modelSkillSets: [{
        id: "codex-sol",
        provider: "codex" as const,
        model: "gpt-5.6-sol",
        catalogVersion: "2026-08-12",
        authMode: "subscription" as const,
        skills: [],
        allowedBuiltinTools: [],
        providerSpecificResolvedItems: [],
      }],
    };

    await expect(composition.handler.createChannelProfileRevision!({ ...authenticated, channelId: "alpha", name: "", draft } as never))
      .rejects.toThrow(/profile name/);
    const first = await composition.handler.createChannelProfileRevision!({ ...authenticated, channelId: "alpha", name: "Focused profile", draft } as never);
    const second = await composition.handler.createChannelProfileRevision!({ ...authenticated, channelId: "alpha", name: "Focused profile v2", draft: { ...draft, instructions: { id: "channel", text: "Second revision.\n" } } } as never);
    expect(first.profile).toMatchObject({ name: "Focused profile", channelId: "alpha", version: 1, createdBySessionId: "operator", harnessMode: "controlled" });
    expect(second.profile).toMatchObject({ name: "Focused profile v2", channelId: "alpha", version: 2, createdBySessionId: "operator" });
    expect(second.profile.id).not.toBe(first.profile.id);

    await expect(composition.handler.listChannelProfileRevisions!({ ...authenticated, channelId: "alpha" } as never))
      .resolves.toMatchObject({ revisions: [{ id: second.profile.id, name: "Focused profile v2" }, { id: first.profile.id, name: "Focused profile" }] });
    await expect(composition.handler.readChannelProfileRevision!({ ...authenticated, channelId: "alpha", revisionId: first.profile.id } as never))
      .resolves.toEqual({ profile: first.profile });
    await expect(composition.handler.readChannelProfileRevision!({ ...outside, channelId: "beta", revisionId: first.profile.id } as never))
      .rejects.toThrow(/does not belong/);
    await expect(composition.handler.listChannelProfileRevisions!({ ...outside, channelId: "alpha" } as never))
      .rejects.toThrow(/notMember/);

    const binding = bindingFor(first.profile);
    persistSessionProfileBinding(stateDir, binding);
    await expect(composition.handler.getSessionProfileBindings!({ ...authenticated, channelId: "alpha", sessionId: binding.sessionId } as never))
      .resolves.toEqual({ bindings: [binding] });
    await expect(composition.handler.getSessionProfileBindings!({ ...outside, channelId: "beta", sessionId: binding.sessionId } as never))
      .resolves.toEqual({ bindings: [] });
    composition.database.close();
  });

  it("rejects stale catalogs and keeps profile launches closed until the resolved-state gate is installed", async () => {
    const stateDir = temporaryDirectory("rooms-profile-launch-api-");
    setupMachineIdentity(stateDir);
    const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
    composition.database.insertSession({ id: "operator", role: "operator" });
    composition.database.insertChannel({ id: "alpha", ownerOperatorSessionId: "operator" });
    composition.database.insertMembership("alpha", "operator", "operator");
    const authenticated = requestIdentity("operator", "operator-credential");
    const base = {
      instructions: { id: "channel", text: "Pinned.\n" },
      projectInstructions: { mode: "exclude" as const },
      modelSkillSets: [{ id: "codex-sol", provider: "codex" as const, model: "gpt-5.6-sol", catalogVersion: "2026-08-12", authMode: "subscription" as const, skills: [], allowedBuiltinTools: [], providerSpecificResolvedItems: [] }],
    };
    await expect(composition.handler.createChannelProfileRevision!({ ...authenticated, channelId: "alpha", name: "Stale profile", draft: { ...base, modelSkillSets: [{ ...base.modelSkillSets[0], catalogVersion: "old" }] } } as never))
      .rejects.toThrow(/current codex catalog version/);
    await expect(composition.handler.createChannelProfileRevision!({ ...authenticated, channelId: "alpha", name: "Alias profile", draft: { ...base, modelSkillSets: [{ ...base.modelSkillSets[0], model: "gpt-5.6" }] } } as never))
      .rejects.toThrow(/canonical available codex catalog id/);
    const created = await composition.handler.createChannelProfileRevision!({ ...authenticated, channelId: "alpha", name: "Launch profile", draft: base } as never);
    await expect(composition.handler.launchSessionWithProfile!({
      ...authenticated,
      channelId: "alpha",
      sessionId: "worker",
      provider: "codex",
      role: "worker",
      prompt: "Start.",
      cwd: stateDir,
      profileRevisionId: created.profile.id,
      modelSkillSetId: "codex-sol",
    } as never)).rejects.toThrow(/not ready until resolved-state verification/);
    expect(composition.database.currentSession("worker")).toBeNull();
    composition.database.close();
  });
});

describe("profile skill catalog", () => {
  it("shows exact source instructions and provider compatibility", () => {
    const home = temporaryDirectory("rooms-profile-catalog-");
    const shared = join(home, ".agents", "skills", "shared");
    const codexOnly = join(home, ".codex", "skills", "codex-only");
    const claudeOnly = join(home, ".claude", "skills", "claude-only");
    writeSkill(shared, "shared", "Shared instructions.\n");
    writeSkill(codexOnly, "codex-only", "Codex instructions.\n");
    writeSkill(claudeOnly, "claude-only", "Claude instructions.\n");

    const catalog = listProfileSkillCatalog({ homeDirectory: home });
    expect(catalog.map(({ name, instructionText, providers }) => ({ name, instructionText, providers }))).toEqual([
      { name: "claude-only", instructionText: "---\nname: claude-only\n---\n\nClaude instructions.\n", providers: ["claude"] },
      { name: "codex-only", instructionText: "---\nname: codex-only\n---\n\nCodex instructions.\n", providers: ["codex"] },
      { name: "shared", instructionText: "---\nname: shared\n---\n\nShared instructions.\n", providers: ["claude", "codex"] },
    ]);
    expect(catalog.every((skill) => /^[0-9a-f]{64}$/.test(skill.instructionSha256))).toBe(true);
  });
});

function requestIdentity(sessionId: string, credential: string): Record<string, unknown> {
  return { context: { credential }, __connection: { authenticatedSessionId: sessionId, credentials: new Map([[credential, sessionId]]), onClose: new Set<() => void>() } };
}

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(path);
  return path;
}

function writeSkill(path: string, name: string, body: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), `---\nname: ${name}\n---\n\n${body}`);
}

function bindingFor(profile: ChannelProfileRevision): SessionProfileBinding {
  return {
    id: "binding-1",
    sessionId: "worker",
    channelId: profile.channelId,
    profileRevisionId: profile.id,
    profileSha256: profile.sha256,
    modelSkillSetId: "codex-sol",
    provider: "codex",
    requestedModel: "gpt-5.6-sol",
    effectiveModel: "gpt-5.6-sol",
    executablePath: "/synthetic/bin/codex",
    executableVersion: "1.0.0",
    authAttestation: { requiredMode: "subscription", resolvedMode: "subscription", credentialSource: "chatgptSubscription", accountPresent: true, apiKeyEnvironmentVariables: [], verifiedAt: "2026-08-14T00:00:00.000Z" },
    resolvedStateAttestation: null,
    boundAt: "2026-08-14T00:00:00.000Z",
  };
}

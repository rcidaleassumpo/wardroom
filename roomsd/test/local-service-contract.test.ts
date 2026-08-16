import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setupMachineIdentity } from "../src/identity/machine-identity.js";
import { createNativeComposition } from "../src/runtime/native/composition.js";
import { RoomsRepository } from "../src/storage/repository.js";
import { createChannelProfileRevision } from "../src/profiles/profile-revision-store.js";

describe("owner-only local service contract", () => {
  it("lists and ends only authenticated external-owner sessions with exact runtime generations", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-owned-sessions-"));
    try {
      setupMachineIdentity(stateDir);
      const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
      composition.database.insertSession({ id: "operator", role: "operator", externalOwner: "mycelia", externalAgentId: "operator" });
      composition.database.insertChannel({ id: "proof", ownerOperatorSessionId: "operator" });
      composition.database.insertMembership("proof", "operator", "operator");
      composition.database.registerSession("proof", "owned", "worker", null, "runtime", { externalOwner: "mycelia", externalAgentId: "agent-1" });
      composition.database.registerSession("proof", "other", "worker", null, "runtime", { externalOwner: "other-product", externalAgentId: "agent-2" });
      composition.database.registerSession("proof", "legacy", "worker");
      const connection = { authenticatedSessionId: "operator", credentials: new Map([["credential", "operator"]]), onClose: new Set<() => void>() };
      const authenticated = { context: { credential: "credential" }, __connection: connection, channelId: "proof", externalOwner: "mycelia" };
      const terminated: Array<{ runtimeId: string; generation: number }> = [];
      composition.runtimeService.list = async () => ({ runtimes: [
        { runtimeId: "remote-owned", sessionId: "owned", generation: 7, state: "running", endedAt: null },
        { runtimeId: "remote-other", sessionId: "other", generation: 9, state: "running", endedAt: null },
      ] }) as never;
      composition.runtimeService.terminate = async (request: any) => { terminated.push(request); return { ok: true } as never; };

      await expect(composition.handler.listOwnedSessions!({ ...authenticated } as never)).resolves.toMatchObject({ sessions: [{ id: "operator" }, { id: "owned" }] });
      await expect(composition.handler.endOwnedSessions!({ ...authenticated, sessionIds: ["other"] } as never)).rejects.toThrow("externalOwnerAccessDenied");
      await expect(composition.handler.endOwnedSessions!({ ...authenticated, sessionIds: ["owned"] } as never)).resolves.toEqual({ ended: [{ sessionId: "owned", runtimes: [{ runtimeId: "remote-owned", generation: 7 }] }] });
      expect(terminated).toEqual([{ runtimeId: "remote-owned", generation: 7 }]);
      expect(composition.database.currentSession("owned")?.endedAt).not.toBeNull();
      expect(composition.database.currentSession("other")?.endedAt).toBeNull();
      expect(composition.database.currentSession("legacy")?.externalOwner).toBeNull();
      composition.database.close();
      const reopened = new RoomsRepository(join(stateDir, "rooms.sqlite"));
      expect(reopened.currentSession("owned")).toMatchObject({ externalOwner: "mycelia", externalAgentId: "agent-1" });
      expect(reopened.currentSession("other")).toMatchObject({ externalOwner: "other-product", externalAgentId: "agent-2", endedAt: null });
      reopened.close();
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  it("covers the Mycelia channel, session, message, lifecycle, and provider operations without the CLI", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-local-service-"));
    const executable = join(stateDir, "codex-test");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o700);
    try {
      setupMachineIdentity(stateDir);
      const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
      composition.database.insertSession({ id: "operator", role: "operator", deliveryMode: "log" });
      composition.database.insertChannel({ id: "proof", ownerOperatorSessionId: "operator" });
      composition.database.insertMembership("proof", "operator", "operator");
      const connection = { authenticatedSessionId: "operator", credentials: new Map([["credential", "operator"]]), onClose: new Set<() => void>() };
      const authenticated = { context: { credential: "credential" }, __connection: connection };

      createChannelProfileRevision({
        stateDir,
        id: "profile-1",
        name: "Proof profile",
        channelId: "proof",
        version: 1,
        createdAt: "2026-08-14T00:00:00.000Z",
        createdBySessionId: "operator",
        instructions: { id: "channel", text: "Rules\n" },
        projectInstructions: { mode: "exclude" },
        modelSkillSets: [{ id: "codex-default", provider: "codex", model: "gpt-5", catalogVersion: "test", authMode: "subscription", skills: [], allowedBuiltinTools: [], providerSpecificResolvedItems: [] }],
      });

      await expect(composition.handler.listProviders!({ ...authenticated } as never)).resolves.toEqual({ providers: [] });
      const saved = await composition.handler.writeProvider!({ ...authenticated, mode: "register", name: "codex", executable, adapter: "codex", enabled: true, defaults: { permissions: "manual" } } as never);
      expect(saved.providers).toMatchObject([{ name: "codex", adapter: "codex", enabled: true, launchOptions: { type: "object" } }]);
      expect(saved.providers[0]?.executable).toMatch(/codex-test$/);
      await expect(composition.handler.listChannelProfileRevisions!({ ...authenticated, channelId: "proof" } as never)).resolves.toMatchObject({ revisions: [{ id: "profile-1", name: "Proof profile", modelSkillSets: [{ id: "codex-default", provider: "codex", model: "gpt-5" }] }] });
      composition.database.insertSession({ id: "outsider", role: "worker" });
      const outsiderConnection = { authenticatedSessionId: "outsider", credentials: new Map([["outsider-credential", "outsider"]]), onClose: new Set<() => void>() };
      await expect(composition.handler.listChannelProfileRevisions!({ channelId: "proof", context: { credential: "outsider-credential" }, __connection: outsiderConnection } as never)).rejects.toThrow("notMember");

      const registered = await composition.handler.registerChannelSession!({ ...authenticated, channelId: "proof", sessionId: "log-worker", role: "worker", deliveryMode: "log" } as never);
      expect(registered).toMatchObject({ session: { id: "log-worker" }, membership: { sessionId: "log-worker" } });
      await expect(composition.handler.inspectSession!({ ...authenticated, sessionId: "log-worker" } as never)).resolves.toMatchObject({ session: { id: "log-worker" } });

      const sent = await composition.handler.sendMessage!({ ...authenticated, channelId: "proof", targetSessionId: "log-worker", body: "hello" } as never) as any;
      expect(sent.event).toMatchObject({ senderSessionId: "operator", deliveredRecipientSessionIds: ["log-worker"] });
      expect(sent.event.body).toContain("hello");

      await composition.handler.endManagedSession!({ ...authenticated, sessionId: "log-worker" } as never);
      expect(composition.database.currentSession("log-worker")?.endedAt).not.toBeNull();

      const suspended = await composition.handler.suspendChannel!({ ...authenticated, channelId: "proof" } as never);
      expect(suspended).toMatchObject({ channelId: "proof" });
      await expect(composition.handler.resumeChannel!({ ...authenticated, channelId: "proof" } as never)).resolves.toEqual([]);

      const archived = await composition.handler.archiveChannel!({ ...authenticated, channelId: "proof", force: true } as never);
      expect(archived).toMatchObject({ channelId: "proof", completed: true });
      expect(composition.database.currentChannel("proof")?.lifecycleState).toBe("closed");

      await expect(composition.handler.removeProvider!({ ...authenticated, name: "codex" } as never)).resolves.toEqual({ providers: [] });
      composition.database.close();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects local owner operations from a worker credential", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-local-service-auth-"));
    try {
      setupMachineIdentity(stateDir);
      const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
      composition.database.insertSession({ id: "operator", role: "operator" });
      composition.database.insertSession({ id: "worker", role: "worker" });
      composition.database.insertChannel({ id: "proof", ownerOperatorSessionId: "operator" });
      const connection = { authenticatedSessionId: "worker", credentials: new Map([["worker-credential", "worker"]]), onClose: new Set<() => void>() };
      await expect(composition.handler.archiveChannel!({ channelId: "proof", force: true, context: { credential: "worker-credential" }, __connection: connection } as never))
        .rejects.toThrow("owner operator credential is required");
      composition.database.close();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("allows a current channel operator to archive a channel owned by an older operator", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-local-service-current-operator-"));
    try {
      setupMachineIdentity(stateDir);
      const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
      composition.database.insertSession({ id: "original-operator", role: "operator" });
      composition.database.insertSession({ id: "desktop-operator", role: "operator" });
      composition.database.insertChannel({ id: "proof", ownerOperatorSessionId: "original-operator" });
      composition.database.insertMembership("proof", "desktop-operator", "operator");
      const connection = { authenticatedSessionId: "desktop-operator", credentials: new Map([["desktop-credential", "desktop-operator"]]), onClose: new Set<() => void>() };

      await expect(composition.handler.archiveChannel!({ channelId: "proof", force: true, context: { credential: "desktop-credential" }, __connection: connection } as never))
        .resolves.toMatchObject({ channelId: "proof", completed: true });
      expect(composition.database.currentChannel("proof")?.lifecycleState).toBe("closed");
      composition.database.close();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects an operator that is neither the owner nor an active channel operator", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-local-service-outside-operator-"));
    try {
      setupMachineIdentity(stateDir);
      const composition = createNativeComposition(join(stateDir, "rooms.sqlite"), undefined, stateDir);
      composition.database.insertSession({ id: "owner", role: "operator" });
      composition.database.insertSession({ id: "outside-operator", role: "operator" });
      composition.database.insertChannel({ id: "proof", ownerOperatorSessionId: "owner" });
      const connection = { authenticatedSessionId: "outside-operator", credentials: new Map([["outside-credential", "outside-operator"]]), onClose: new Set<() => void>() };

      await expect(composition.handler.archiveChannel!({ channelId: "proof", force: true, context: { credential: "outside-credential" }, __connection: connection } as never))
        .rejects.toThrow("owning or active channel operator credential is required");
      composition.database.close();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

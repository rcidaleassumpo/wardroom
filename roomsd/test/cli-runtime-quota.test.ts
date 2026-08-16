import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { RoomsCLIBackend } from "../src/cli/backend.js";
import { runRoomsCLI } from "../src/cli/main.js";
import { createDefaultRoomsCLIBackend } from "../src/cli/default-backend.js";
import { createNativeComposition } from "../src/runtime/native/composition.js";
import { setupMachineIdentity } from "../src/identity/machine-identity.js";
import { bindRoomsService } from "../src/transports/unix/index.js";
import { roomsPaths } from "../src/provisioning/paths.js";
import { RoomsRepository } from "../src/storage/repository.js";
import { RuntimeRepository } from "../src/storage/runtime-repository.js";

const backend = (overrides: Partial<RoomsCLIBackend>): RoomsCLIBackend => ({
  createChannel: async () => ({}), listChannels: async () => ({}), channelStatus: async () => ({}), suspendChannel: async () => ({}), resumeChannel: async () => ({}),
  createSession: async () => ({}), commitMessage: async () => ({}), sendPrompt: async () => ({}), ...overrides,
});

describe("rooms runtime quota", () => {
  it("lists all machines or one selected machine", async () => {
    const calls: Array<string | undefined> = [];
    const subject = backend({ runtimeQuotaGet: async machine => { calls.push(machine); return { quotas: [] }; }, runtimeQuotaSet: async () => ({}), runtimeQuotaReset: async () => ({}) });
    await runRoomsCLI(["runtime", "quota"], subject);
    await runRoomsCLI(["runtime", "quota", "--machine", "work-mac"], subject);
    expect(calls).toEqual([undefined, "work-mac"]);
  });

  it("sets a positive integer limit with an explicit credential", async () => {
    const calls: unknown[] = [];
    const subject = backend({ runtimeQuotaGet: async () => ({}), runtimeQuotaSet: async (...args) => { calls.push(args); return { quota: {} }; }, runtimeQuotaReset: async () => ({}) });
    await runRoomsCLI(["runtime", "quota", "set", "--machine", "work-mac", "--limit", "64", "--credential", "operator"], subject);
    expect(calls).toEqual([["work-mac", 64, "operator"]]);
    await expect(runRoomsCLI(["runtime", "quota", "set", "--machine", "work-mac", "--limit", "0", "--credential", "operator"], subject)).rejects.toThrow("--limit must be a positive integer");
  });

  it("persists an operator override through the real daemon boundary", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-cli-quota-"));
    const paths = roomsPaths(stateDir);
    const previous = { stateDir: process.env.ROOMS_STATE_DIR, sessionProof: process.env.ROOMS_SESSION_PROOF };
    setupMachineIdentity(stateDir);
    const seed = new RoomsRepository(paths.storePath);
    seed.insertSession({ id: "operator", role: "operator" });
    seed.close();
    const composition = createNativeComposition(paths.storePath, undefined, stateDir);
    const proof = randomBytes(32);
    new RuntimeRepository(composition.database.db).create({ runtimeId: "runtime-operator", homeAuthorityId: "test-authority", sessionId: "operator", generation: 1, protocolVersion: 1, transportKind: "localPty", machineId: "test-machine", reconnectSecret: randomBytes(32), sessionProof: proof });
    const server = await bindRoomsService(composition.handler, { kind: "unix", path: paths.endpoint });
    try {
      process.env.ROOMS_STATE_DIR = stateDir;
      process.env.ROOMS_SESSION_PROOF = proof.toString("base64url");
      const subject = createDefaultRoomsCLIBackend();
      const changed = JSON.parse(await runRoomsCLI(["runtime", "quota", "set", "--machine", "work-mac", "--limit", "64", "--credential", "operator"], subject));
      expect(changed.quota).toMatchObject({ machineId: "work-mac", maxActiveRuntimes: 64, source: "override", activeRuntimes: 0, availableRuntimes: 64 });
      const shown = JSON.parse(await runRoomsCLI(["runtime", "quota", "--machine", "work-mac"], subject));
      expect(shown.quotas).toMatchObject([{ machineId: "work-mac", maxActiveRuntimes: 64, source: "override" }]);
      const reset = JSON.parse(await runRoomsCLI(["runtime", "quota", "reset", "--machine", "work-mac", "--credential", "operator"], subject));
      expect(reset.quota).toMatchObject({ machineId: "work-mac", maxActiveRuntimes: 32, source: "default" });
    } finally {
      if (previous.stateDir === undefined) delete process.env.ROOMS_STATE_DIR; else process.env.ROOMS_STATE_DIR = previous.stateDir;
      if (previous.sessionProof === undefined) delete process.env.ROOMS_SESSION_PROOF; else process.env.ROOMS_SESSION_PROOF = previous.sessionProof;
      await server.close();
      composition.database.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

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

function unused(): never {
  throw new Error("unused");
}

/**
 * The default CLI backend resolves channel commands through the roomsd daemon
 * endpoint, never a store fallback. Hermetic tests therefore bind the real
 * native composition on a temporary state dir instead of touching the
 * developer's live daemon.
 */
async function withTemporaryRoomsDaemon(prefix: string, seed: (store: RoomsRepository) => void, run: () => Promise<void>, authenticatedSessionId?: string): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), prefix));
  const paths = roomsPaths(stateDir);
  const previous = {
    stateDir: process.env.ROOMS_STATE_DIR,
    storePath: process.env.ROOMS_STORE_PATH,
    daemonStorePath: process.env.ROOMSD_STORE_PATH,
    sessionProof: process.env.ROOMS_SESSION_PROOF,
  };
  setupMachineIdentity(stateDir);
  const seedStore = new RoomsRepository(paths.storePath);
  try { seed(seedStore); } finally { seedStore.close(); }
  const composition = createNativeComposition(paths.storePath, undefined, stateDir);
  if (authenticatedSessionId) {
    const proof = randomBytes(32);
    new RuntimeRepository(composition.database.db).create({ runtimeId: `runtime-${authenticatedSessionId}`, homeAuthorityId: "test-authority", sessionId: authenticatedSessionId, generation: 1, protocolVersion: 1, transportKind: "localPty", machineId: "test-machine", reconnectSecret: randomBytes(32), sessionProof: proof });
    process.env.ROOMS_SESSION_PROOF = proof.toString("base64url");
  }
  const server = await bindRoomsService(composition.handler, { kind: "unix", path: paths.endpoint });
  try {
    process.env.ROOMS_STATE_DIR = stateDir;
    delete process.env.ROOMS_STORE_PATH;
    delete process.env.ROOMSD_STORE_PATH;
    await run();
  } finally {
    if (previous.stateDir === undefined) delete process.env.ROOMS_STATE_DIR; else process.env.ROOMS_STATE_DIR = previous.stateDir;
    if (previous.storePath === undefined) delete process.env.ROOMS_STORE_PATH; else process.env.ROOMS_STORE_PATH = previous.storePath;
    if (previous.daemonStorePath === undefined) delete process.env.ROOMSD_STORE_PATH; else process.env.ROOMSD_STORE_PATH = previous.daemonStorePath;
    if (previous.sessionProof === undefined) delete process.env.ROOMS_SESSION_PROOF; else process.env.ROOMS_SESSION_PROOF = previous.sessionProof;
    await server.close();
    composition.database.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function mockBackend(overrides: Partial<RoomsCLIBackend> = {}): RoomsCLIBackend {
  return {
    createChannel: async () => unused(),
    listChannels: async () => unused(),
    channelStatus: async () => unused(),
    suspendChannel: async () => unused(),
    resumeChannel: async () => unused(),
    createSession: async () => unused(),
    commitMessage: async () => unused(),
    sendPrompt: async () => unused(),
    ...overrides,
  };
}

describe("rooms channel close", () => {
  it("lets an operator close a channel that has no recorded owner", async () => {
    await withTemporaryRoomsDaemon("rooms-cli-close-ownerless-", (store) => {
      store.insertSession({ id: "operator", role: "operator" });
      store.insertChannel({ id: "stale" });
    }, async () => {
      const output = await runRoomsCLI(["channel", "close", "stale", "--credential", "operator"], createDefaultRoomsCLIBackend());
      const payload = JSON.parse(output) as { channel: { id: string; lifecycleState: string; closedAt: string | null } };
      expect(payload.channel).toMatchObject({ id: "stale", lifecycleState: "closed" });
      expect(payload.channel.closedAt).not.toBeNull();
    }, "operator");
  });

  it("lets the owning operator close their channel", async () => {
    await withTemporaryRoomsDaemon("rooms-cli-close-owned-", (store) => {
      store.insertSession({ id: "operator", role: "operator" });
      store.insertChannel({ id: "mine", ownerOperatorSessionId: "operator" });
    }, async () => {
      const output = await runRoomsCLI(["channel", "close", "mine", "--credential", "operator"], createDefaultRoomsCLIBackend());
      const payload = JSON.parse(output) as { channel: { lifecycleState: string } };
      expect(payload.channel.lifecycleState).toBe("closed");
    }, "operator");
  });

  it("rejects closing a channel owned by another operator", async () => {
    await withTemporaryRoomsDaemon("rooms-cli-close-foreign-", (store) => {
      store.insertSession({ id: "owner", role: "operator" });
      store.insertSession({ id: "intruder", role: "operator" });
      store.insertChannel({ id: "guarded", ownerOperatorSessionId: "owner" });
    }, async () => {
      await expect(runRoomsCLI(["channel", "close", "guarded", "--credential", "intruder"], createDefaultRoomsCLIBackend())).rejects.toThrow(/unauthorized/);
    }, "intruder");
  });

  it("rejects a non-operator credential", async () => {
    await withTemporaryRoomsDaemon("rooms-cli-close-worker-", (store) => {
      store.insertSession({ id: "operator", role: "operator" });
      store.insertSession({ id: "grunt", role: "worker" });
      store.insertChannel({ id: "stale" });
    }, async () => {
      await expect(runRoomsCLI(["channel", "close", "stale", "--credential", "grunt"], createDefaultRoomsCLIBackend())).rejects.toThrow("channel closure requires an operator credential");
    }, "grunt");
  });

  it("falls back to ROOMS_SESSION_ID when --credential is omitted", async () => {
    await withTemporaryRoomsDaemon("rooms-cli-close-env-", (store) => {
      store.insertSession({ id: "operator", role: "operator" });
      store.insertChannel({ id: "stale" });
    }, async () => {
      const previous = process.env.ROOMS_SESSION_ID;
      process.env.ROOMS_SESSION_ID = "operator";
      try {
        const output = await runRoomsCLI(["channel", "close", "stale"], createDefaultRoomsCLIBackend());
        const payload = JSON.parse(output) as { channel: { lifecycleState: string } };
        expect(payload.channel.lifecycleState).toBe("closed");
      } finally {
        if (previous === undefined) delete process.env.ROOMS_SESSION_ID; else process.env.ROOMS_SESSION_ID = previous;
      }
    }, "operator");
  });

  it("routes channel close through the CLI backend", async () => {
    const calls: Array<{ name: string; credential: string }> = [];
    const output = await runRoomsCLI(
      ["channel", "close", "target", "--credential", "op-token"],
      mockBackend({
        closeChannel: async (name, credential) => {
          calls.push({ name, credential });
          return { channel: { id: name, lifecycleState: "closed" } };
        },
      }),
    );
    expect(calls).toEqual([{ name: "target", credential: "op-token" }]);
    expect(JSON.parse(output)).toEqual({ channel: { id: "target", lifecycleState: "closed" } });
  });

  it("advertises channel close in help", async () => {
    const help = await runRoomsCLI(["--help"]);
    expect(help).toContain("rooms channel close");
  });
});

describe("rooms channel label", () => {
  it("sets, reads, and clears a canonical channel label", async () => {
    await withTemporaryRoomsDaemon("rooms-cli-label-", (store) => {
      store.insertSession({ id: "operator", role: "operator" });
      store.insertChannel({ id: "labeled", ownerOperatorSessionId: "operator" });
    }, async () => {
      const set = JSON.parse(await runRoomsCLI(["channel", "label", "labeled", "--label", "Customer investigation", "--credential", "operator"], createDefaultRoomsCLIBackend())) as { channel: { label: string | null } };
      expect(set.channel.label).toBe("Customer investigation");

      const listed = JSON.parse(await runRoomsCLI(["channel", "list"], createDefaultRoomsCLIBackend())) as { channels: Array<{ id: string; label: string | null }> };
      expect(listed.channels.find((channel) => channel.id === "labeled")?.label).toBe("Customer investigation");

      const status = JSON.parse(await runRoomsCLI(["channel", "status", "labeled"], createDefaultRoomsCLIBackend())) as { label: string | null };
      expect(status.label).toBe("Customer investigation");

      const cleared = JSON.parse(await runRoomsCLI(["channel", "label", "labeled", "--label", "", "--credential", "operator"], createDefaultRoomsCLIBackend())) as { channel: { label: string | null } };
      expect(cleared.channel.label).toBeNull();
    }, "operator");
  });

  it("rejects labeling a channel owned by another operator", async () => {
    await withTemporaryRoomsDaemon("rooms-cli-label-auth-", (store) => {
      store.insertSession({ id: "owner", role: "operator" });
      store.insertSession({ id: "intruder", role: "operator" });
      store.insertChannel({ id: "guarded", ownerOperatorSessionId: "owner" });
    }, async () => {
      await expect(runRoomsCLI(["channel", "label", "guarded", "--label", "Nope", "--credential", "intruder"], createDefaultRoomsCLIBackend())).rejects.toThrow(/unauthorized/);
    }, "intruder");
  });

  it("routes channel labels through the CLI backend", async () => {
    const calls: Array<{ name: string; label: string | null; credential: string }> = [];
    await runRoomsCLI(["channel", "label", "target", "--label", "Build", "--credential", "owner"], mockBackend({
      labelChannel: async (name, label, credential) => {
        calls.push({ name, label, credential });
        return { channel: { id: name, label } };
      },
    }));
    expect(calls).toEqual([{ name: "target", label: "Build", credential: "owner" }]);
  });
});

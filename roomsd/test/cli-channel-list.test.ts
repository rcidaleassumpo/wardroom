import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoomsCLIBackend } from "../src/cli/backend.js";
import { runRoomsCLI } from "../src/cli/main.js";
import { createDefaultRoomsCLIBackend } from "../src/cli/default-backend.js";
import { createNativeComposition } from "../src/runtime/native/composition.js";
import { setupMachineIdentity } from "../src/identity/machine-identity.js";
import { bindRoomsService } from "../src/transports/unix/index.js";
import { roomsPaths } from "../src/provisioning/paths.js";
import { RoomsRepository } from "../src/storage/repository.js";

function unused(): never {
  throw new Error("unused");
}

/**
 * The default CLI backend resolves channel queries through the roomsd daemon
 * endpoint, never a store fallback. Hermetic tests therefore bind the real
 * native composition on a temporary state dir instead of touching the
 * developer's live daemon.
 */
async function withTemporaryRoomsDaemon(prefix: string, seed: (store: RoomsRepository) => void, run: () => Promise<void>): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), prefix));
  const paths = roomsPaths(stateDir);
  const previous = {
    stateDir: process.env.ROOMS_STATE_DIR,
    storePath: process.env.ROOMS_STORE_PATH,
    daemonStorePath: process.env.ROOMSD_STORE_PATH,
  };
  setupMachineIdentity(stateDir);
  const seedStore = new RoomsRepository(paths.storePath);
  try { seed(seedStore); } finally { seedStore.close(); }
  const composition = createNativeComposition(paths.storePath, undefined, stateDir);
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

describe("rooms channel list", () => {
  it("lists channels from the local store in registration order", async () => {
    await withTemporaryRoomsDaemon("rooms-cli-list-", (store) => {
      store.insertSession({ id: "operator", role: "operator" });
      store.insertChannel({ id: "alpha" });
      store.insertChannel({ id: "beta", ownerOperatorSessionId: "operator" });
    }, async () => {
      const output = await runRoomsCLI(["channel", "list"], createDefaultRoomsCLIBackend());
      const payload = JSON.parse(output) as {
        channels: Array<{ id: string; label: string | null; ownerOperatorSessionId: string | null; lifecycleState: string }>;
      };
      expect(payload.channels.map((channel) => channel.id)).toEqual(["alpha", "beta"]);
      expect(payload.channels[0]).toMatchObject({
        id: "alpha",
        label: null,
        lifecycleState: "active",
        ownerOperatorSessionId: null,
      });
      expect(payload.channels[1]).toMatchObject({
        id: "beta",
        label: null,
        lifecycleState: "active",
        ownerOperatorSessionId: "operator",
      });
    });
  });

  it("returns an empty list when no channels exist", async () => {
    await withTemporaryRoomsDaemon("rooms-cli-list-empty-", () => {}, async () => {
      const output = await runRoomsCLI(["channel", "list"], createDefaultRoomsCLIBackend());
      expect(JSON.parse(output)).toEqual({ channels: [] });
    });
  });

  it("routes channel list through the CLI backend", async () => {
    const output = await runRoomsCLI(
      ["channel", "list"],
      mockBackend({
        listChannels: async () => ({ channels: [{ id: "from-backend", lifecycleState: "active" }] }),
      }),
    );
    expect(JSON.parse(output)).toEqual({
      channels: [{ id: "from-backend", lifecycleState: "active" }],
    });
  });

  it("advertises channel list in help", async () => {
    const help = await runRoomsCLI(["--help"]);
    expect(help).toContain("rooms channel list");
  });
});

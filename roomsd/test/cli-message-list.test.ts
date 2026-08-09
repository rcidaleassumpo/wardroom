import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRoomsCLI, booleanFlag, boundedLimit, DEFAULT_MESSAGE_LIST_LIMIT } from "../src/cli/main.js";
import { createDefaultRoomsCLIBackend } from "../src/cli/default-backend.js";
import { createNativeComposition } from "../src/runtime/native/composition.js";
import { setupMachineIdentity } from "../src/identity/machine-identity.js";
import { bindRoomsService } from "../src/transports/unix/index.js";
import { roomsPaths } from "../src/provisioning/paths.js";
import { RoomsRepository } from "../src/storage/repository.js";

async function withTemporaryRoomsDaemon(
  prefix: string,
  seed: (store: RoomsRepository) => void,
  run: () => Promise<void>,
): Promise<void> {
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

function seedBusyChannel(store: RoomsRepository, options: { bodyBytes: number; mine: number; theirs: number }): void {
  store.insertSession({ id: "mine" });
  store.insertSession({ id: "theirs" });
  store.insertSession({ id: "other" });
  store.insertChannel({ id: "busy" });
  const body = "x".repeat(options.bodyBytes);
  for (let index = 0; index < options.theirs; index += 1) {
    store.commitMessage({
      channelId: "busy",
      senderSessionId: "theirs",
      body: `${body} theirs-${index}`,
      target: { kind: "direct", sessionId: "other", sessionIds: ["other"] },
      deliveryStatuses: { other: "delivered" },
    });
  }
  for (let index = 0; index < options.mine; index += 1) {
    store.commitMessage({
      channelId: "busy",
      senderSessionId: "mine",
      body: `mine-${index}`,
      target: { kind: "direct", sessionId: "other", sessionIds: ["other"] },
      deliveryStatuses: { other: "delivered" },
    });
  }
}

describe("rooms message list", () => {
  it("stays under the socket response limit on a channel larger than 1 MiB", async () => {
    await withTemporaryRoomsDaemon(
      "rooms-cli-messages-big-",
      // ~1.5 MiB of unrelated traffic: the old client-side filter pulled all of
      // it across the socket and failed with "roomsd response exceeded 1 MiB".
      (store) => seedBusyChannel(store, { bodyBytes: 3000, mine: 3, theirs: 500 }),
      async () => {
        const output = await runRoomsCLI(
          ["message", "list", "--session", "mine", "--channel", "busy"],
          createDefaultRoomsCLIBackend(),
        );
        const payload = JSON.parse(output) as { events: Array<{ body: string }>; hasMore: boolean };
        expect(payload.events).toHaveLength(3);
        expect(payload.events.map((event) => event.body)).toEqual(["mine-0", "mine-1", "mine-2"]);
        expect(payload.hasMore).toBe(false);
      },
    );
  });

  it("returns the newest page and reports that older history remains", async () => {
    await withTemporaryRoomsDaemon(
      "rooms-cli-messages-page-",
      (store) => seedBusyChannel(store, { bodyBytes: 10, mine: 5, theirs: 2 }),
      async () => {
        const output = await runRoomsCLI(
          ["message", "list", "--session", "mine", "--channel", "busy", "--limit", "2"],
          createDefaultRoomsCLIBackend(),
        );
        const payload = JSON.parse(output) as {
          events: Array<{ body: string }>;
          hasMore: boolean;
          oldestCursor: string | null;
          cursor: string;
        };
        // Newest two, still in cursor order.
        expect(payload.events.map((event) => event.body)).toEqual(["mine-3", "mine-4"]);
        expect(payload.hasMore).toBe(true);
        expect(payload.oldestCursor).not.toBeNull();
      },
    );
  });

  it("advances past a --since cursor without re-reading old messages", async () => {
    await withTemporaryRoomsDaemon(
      "rooms-cli-messages-since-",
      (store) => seedBusyChannel(store, { bodyBytes: 10, mine: 4, theirs: 1 }),
      async () => {
        const backend = createDefaultRoomsCLIBackend();
        const first = JSON.parse(await runRoomsCLI(
          ["message", "list", "--session", "mine", "--channel", "busy", "--limit", "2"],
          backend,
        )) as { events: Array<{ body: string }>; cursor: string };
        const next = JSON.parse(await runRoomsCLI(
          ["message", "list", "--session", "mine", "--channel", "busy", "--since", first.cursor],
          backend,
        )) as { events: Array<{ body: string }> };
        expect(next.events).toHaveLength(0);
      },
    );
  });

  it("rejects an out-of-range --limit instead of returning everything", async () => {
    await withTemporaryRoomsDaemon(
      "rooms-cli-messages-limit-",
      (store) => seedBusyChannel(store, { bodyBytes: 10, mine: 1, theirs: 0 }),
      async () => {
        await expect(runRoomsCLI(
          ["message", "list", "--session", "mine", "--limit", "0"],
          createDefaultRoomsCLIBackend(),
        )).rejects.toThrow(/--limit must be an integer between 1 and 500/);
      },
    );
  });
});

describe("boundedLimit", () => {
  it("defaults when the flag is absent", () => {
    expect(boundedLimit(undefined)).toBe(DEFAULT_MESSAGE_LIST_LIMIT);
  });

  it("accepts the documented range and rejects anything outside it", () => {
    expect(boundedLimit("1")).toBe(1);
    expect(boundedLimit("500")).toBe(500);
    for (const value of ["0", "501", "-1", "abc", "1.5"]) {
      expect(() => boundedLimit(value)).toThrow(/--limit must be an integer between 1 and 500/);
    }
  });
});

describe("booleanFlag", () => {
  it("treats a bare flag and explicit true as enabled", () => {
    expect(booleanFlag(new Map([["all", ""]]), "all")).toBe(true);
    expect(booleanFlag(new Map([["all", "true"]]), "all")).toBe(true);
  });

  it("treats an absent flag and explicit false as disabled", () => {
    expect(booleanFlag(new Map(), "all")).toBe(false);
    expect(booleanFlag(new Map([["all", "false"]]), "all")).toBe(false);
  });

  it("rejects a non-boolean value instead of silently filtering", () => {
    // `--all 1` used to return the filtered list with exit code 0, which reads
    // as "that session does not exist".
    for (const value of ["1", "yes", "TRUE", "0"]) {
      expect(() => booleanFlag(new Map([["all", value]]), "all")).toThrow(/boolean flag/);
    }
  });
});

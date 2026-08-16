import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRoomsCLI } from "../src/cli/main.js";
import { createDefaultRoomsCLIBackend } from "../src/cli/default-backend.js";
import { createNativeComposition } from "../src/runtime/native/composition.js";
import { setupMachineIdentity } from "../src/identity/machine-identity.js";
import { bindRoomsService } from "../src/transports/unix/index.js";
import { roomsPaths } from "../src/provisioning/paths.js";
import { RoomsRepository } from "../src/storage/repository.js";

type ChannelHit = {
  channelId: string;
  label: string | null;
  lifecycleState: string;
  messageMatches: number;
  controlMatches: number;
  matchedIn: string[];
  lastMatchAt: string | null;
  lastActivityAt: string | null;
  excerpt: string | null;
};

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

function message(store: RoomsRepository, channelId: string, body: string): void {
  store.commitMessage({
    channelId,
    senderSessionId: "planner",
    body,
    target: { kind: "broadcast", sessionIds: [] },
    deliveryStatuses: {},
  });
}

/** Pin recorded times so the recency order under test cannot depend on clock resolution. */
function stamp(store: RoomsRepository, channelId: string, occurredAt: string): void {
  store.db.prepare("UPDATE changes SET occurred_at = ? WHERE channel_id = ?").run(occurredAt, channelId);
  store.db.prepare("UPDATE channels SET registered_at = ? WHERE id = ?").run(occurredAt, channelId);
}

/**
 * One channel names the query, one only discusses it, one only records it in a
 * committed control payload, and one closed channel discussed it long ago.
 */
function seedRecoverableChannels(store: RoomsRepository): void {
  store.insertSession({ id: "planner" });
  store.insertChannel({ id: "named-4102-channel" });
  store.insertChannel({ id: "talked-about-it" });
  store.insertChannel({ id: "control-only" });
  store.insertChannel({ id: "old-and-closed" });
  message(store, "old-and-closed", "we looked at 4102 last month and moved on");
  store.closeChannel("old-and-closed");
  message(store, "talked-about-it", "the three-model loop on 4102 is complete and the verdict is pending");
  store.commitControl({
    channelId: "control-only",
    senderSessionId: "planner",
    kind: "task.add",
    payload: { title: "PEN-4102 independent investigation and fix - Luna" },
    requestId: "seed-control-1",
  });
  // An unused channel that only matches by name ranks by its own age.
  stamp(store, "named-4102-channel", "2026-06-01T09:00:00.000Z");
  stamp(store, "old-and-closed", "2026-07-01T09:00:00.000Z");
  stamp(store, "talked-about-it", "2026-08-15T08:15:00.000Z");
  stamp(store, "control-only", "2026-08-16T07:43:00.000Z");
}

describe("rooms channel search", () => {
  it("finds every channel that mentions a query, newest match first", async () => {
    await withTemporaryRoomsDaemon("rooms-cli-search-", seedRecoverableChannels, async () => {
      const output = await runRoomsCLI(["channel", "search", "4102"], createDefaultRoomsCLIBackend());

      const payload = JSON.parse(output) as { channels: ChannelHit[]; events: unknown[] };
      expect(payload.channels.map((hit) => hit.channelId)).toEqual([
        "control-only",
        "talked-about-it",
        "old-and-closed",
        "named-4102-channel",
      ]);
      // A channel search answers which channel; it does not dump the messages.
      expect(payload.events).toEqual([]);
    });
  });

  it("reports why each channel matched and shows the matching text", async () => {
    await withTemporaryRoomsDaemon("rooms-cli-search-why-", seedRecoverableChannels, async () => {
      const output = await runRoomsCLI(["channel", "search", "4102"], createDefaultRoomsCLIBackend());

      const byId = new Map(
        (JSON.parse(output) as { channels: ChannelHit[] }).channels.map((hit) => [hit.channelId, hit]),
      );
      expect(byId.get("named-4102-channel")).toMatchObject({ matchedIn: ["id"], messageMatches: 0, controlMatches: 0, excerpt: null });
      expect(byId.get("talked-about-it")).toMatchObject({ matchedIn: ["message"], messageMatches: 1, controlMatches: 0 });
      expect(byId.get("talked-about-it")?.excerpt).toContain("three-model loop on 4102");
      expect(byId.get("control-only")).toMatchObject({ matchedIn: ["control"], messageMatches: 0, controlMatches: 1 });
      expect(byId.get("control-only")?.excerpt).toContain("PEN-4102 independent investigation");
      expect(byId.get("old-and-closed")?.lifecycleState).toBe("closed");
      expect(byId.get("old-and-closed")?.lastActivityAt).not.toBeNull();
    });
  });

  it("narrows to open channels and to message bodies on request", async () => {
    await withTemporaryRoomsDaemon("rooms-cli-search-narrow-", seedRecoverableChannels, async () => {
      const backend = createDefaultRoomsCLIBackend();

      const open = JSON.parse(await runRoomsCLI(["channel", "search", "4102", "--active-only"], backend)) as { channels: ChannelHit[] };
      const messagesOnly = JSON.parse(await runRoomsCLI(["channel", "search", "4102", "--messages-only"], backend)) as { channels: ChannelHit[] };

      expect(open.channels.map((hit) => hit.channelId)).not.toContain("old-and-closed");
      expect(messagesOnly.channels.map((hit) => hit.channelId)).not.toContain("control-only");
      expect(messagesOnly.channels.map((hit) => hit.channelId)).toContain("talked-about-it");
    });
  });

  it("treats a query as literal text, not as a wildcard pattern", async () => {
    await withTemporaryRoomsDaemon(
      "rooms-cli-search-literal-",
      (store) => {
        store.insertSession({ id: "planner" });
        store.insertChannel({ id: "literal" });
        store.insertChannel({ id: "decoy" });
        message(store, "literal", "the run reached 100% of the fixture");
        message(store, "decoy", "nothing here matches that shape");
      },
      async () => {
        const output = await runRoomsCLI(["channel", "search", "100%"], createDefaultRoomsCLIBackend());

        const payload = JSON.parse(output) as { channels: ChannelHit[] };
        expect(payload.channels.map((hit) => hit.channelId)).toEqual(["literal"]);
      },
    );
  });

  it("bounds the result and rejects an empty query", async () => {
    await withTemporaryRoomsDaemon("rooms-cli-search-bounds-", seedRecoverableChannels, async () => {
      const backend = createDefaultRoomsCLIBackend();

      const bounded = JSON.parse(await runRoomsCLI(["channel", "search", "4102", "--limit", "2"], backend)) as { channels: ChannelHit[] };

      expect(bounded.channels).toHaveLength(2);
      await expect(runRoomsCLI(["channel", "search", "   "], backend)).rejects.toThrow(/query/);
    });
  });
});

describe("rooms message search", () => {
  it("returns the matching message events instead of channel hits", async () => {
    await withTemporaryRoomsDaemon("rooms-cli-message-search-", seedRecoverableChannels, async () => {
      const output = await runRoomsCLI(["message", "search", "4102"], createDefaultRoomsCLIBackend());

      const payload = JSON.parse(output) as { events: Array<{ body: string; channelId: string }>; channels: ChannelHit[] };
      expect(payload.channels).toEqual([]);
      expect(payload.events.map((event) => event.channelId)).toEqual(["talked-about-it", "old-and-closed"]);
    });
  });

  it("restricts a channel-scoped search to that channel", async () => {
    await withTemporaryRoomsDaemon("rooms-cli-message-search-channel-", seedRecoverableChannels, async () => {
      const output = await runRoomsCLI(
        ["message", "search", "4102", "--channel", "talked-about-it"],
        createDefaultRoomsCLIBackend(),
      );

      const payload = JSON.parse(output) as { events: Array<{ channelId: string }> };
      expect(payload.events).toHaveLength(1);
      expect(payload.events[0]?.channelId).toBe("talked-about-it");
    });
  });
});

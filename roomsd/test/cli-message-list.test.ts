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
    sessionId: process.env.ROOMS_SESSION_ID,
    channelId: process.env.ROOMS_CHANNEL_ID,
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
    if (previous.sessionId === undefined) delete process.env.ROOMS_SESSION_ID; else process.env.ROOMS_SESSION_ID = previous.sessionId;
    if (previous.channelId === undefined) delete process.env.ROOMS_CHANNEL_ID; else process.env.ROOMS_CHANNEL_ID = previous.channelId;
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

  it("advances the cursor past unrelated channel traffic in the same query", async () => {
    let latestCursor = "0";
    await withTemporaryRoomsDaemon(
      "rooms-cli-messages-unrelated-cursor-",
      (store) => {
        store.insertSession({ id: "mine" });
        store.insertSession({ id: "theirs" });
        store.insertSession({ id: "other" });
        store.insertChannel({ id: "busy" });
        store.commitMessage({
          channelId: "busy",
          senderSessionId: "mine",
          body: "mine-0",
          target: { kind: "direct", sessionId: "other", sessionIds: ["other"] },
          deliveryStatuses: { other: "delivered" },
        });
        for (let index = 0; index < 40; index += 1) {
          latestCursor = store.commitMessage({
            channelId: "busy",
            senderSessionId: "theirs",
            body: `theirs-${index}`,
            target: { kind: "direct", sessionId: "other", sessionIds: ["other"] },
            deliveryStatuses: { other: "delivered" },
          }).cursor;
        }
      },
      async () => {
        const backend = createDefaultRoomsCLIBackend();
        const first = JSON.parse(await runRoomsCLI(
          ["message", "list", "--session", "mine", "--channel", "busy"],
          backend,
        )) as { events: Array<{ body: string }>; cursor: string };
        expect(first.events.map((event) => event.body)).toEqual(["mine-0"]);
        expect(first.cursor).toBe(latestCursor);
        const next = JSON.parse(await runRoomsCLI(
          ["message", "list", "--session", "mine", "--channel", "busy", "--since", first.cursor],
          backend,
        )) as { events: unknown[]; cursor: string };
        expect(next.events).toEqual([]);
        expect(next.cursor).toBe(first.cursor);
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

describe("Rooms structured replies", () => {
  it("sends, shows, and queries exact replies without changing the body", async () => {
    let parentEventId = "";
    await withTemporaryRoomsDaemon(
      "rooms-cli-replies-",
      (store) => {
        store.insertSession({ id: "sender", role: "worker", deliveryMode: "log" });
        store.insertSession({ id: "recipient", role: "worker", deliveryMode: "log" });
        store.insertChannel({ id: "build" });
        store.insertMembership("build", "sender", "worker");
        store.insertMembership("build", "recipient", "worker");
        const parent = store.commitMessage({
          channelId: "build",
          senderSessionId: "recipient",
          body: "parent body",
          target: { kind: "direct", sessionId: "sender", sessionIds: ["sender"] },
          deliveryStatuses: { sender: "delivered" },
        });
        parentEventId = (parent.event as { id: string }).id;
      },
      async () => {
        process.env.ROOMS_SESSION_ID = "sender";
        process.env.ROOMS_CHANNEL_ID = "build";
        const backend = createDefaultRoomsCLIBackend();
        const sent = JSON.parse(await runRoomsCLI([
          "session", "send", "recipient", "--body", "reply body", "--reply-to", parentEventId,
        ], backend)) as { event: { id: string; body: string; correlation: { replyToEventId: string } } };

        expect(sent.event.body).toBe("@sender reply body");
        expect(sent.event.body).not.toContain(parentEventId);
        expect(sent.event.correlation).toEqual({ replyToEventId: parentEventId });

        const shown = JSON.parse(await runRoomsCLI(["message", "show", sent.event.id], backend)) as { event: typeof sent.event };
        expect(shown.event).toMatchObject({ id: sent.event.id, correlation: { replyToEventId: parentEventId } });

        const replies = JSON.parse(await runRoomsCLI(["message", "replies", parentEventId], backend)) as { events: Array<typeof sent.event>; hasMore: boolean };
        expect(replies.events).toEqual([expect.objectContaining({ id: sent.event.id, correlation: { replyToEventId: parentEventId } })]);
        expect(replies.hasMore).toBe(false);

        const listed = JSON.parse(await runRoomsCLI([
          "message", "list", "--session", "sender", "--reply-to", parentEventId,
        ], backend)) as { events: Array<typeof sent.event> };
        expect(listed.events.map((event) => event.id)).toEqual([sent.event.id]);
      },
    );
  });

  it("rejects replies to missing messages and messages from another channel", async () => {
    let otherEventId = "";
    await withTemporaryRoomsDaemon(
      "rooms-cli-replies-stale-",
      (store) => {
        store.insertSession({ id: "sender", role: "worker", deliveryMode: "log" });
        store.insertSession({ id: "recipient", role: "worker", deliveryMode: "log" });
        store.insertChannel({ id: "build" });
        store.insertChannel({ id: "other" });
        store.insertMembership("build", "sender", "worker");
        store.insertMembership("build", "recipient", "worker");
        otherEventId = (store.commitMessage({
          channelId: "other",
          senderSessionId: "recipient",
          body: "other parent",
          target: { kind: "direct", sessionId: "sender", sessionIds: ["sender"] },
          deliveryStatuses: { sender: "delivered" },
        }).event as { id: string }).id;
      },
      async () => {
        process.env.ROOMS_SESSION_ID = "sender";
        process.env.ROOMS_CHANNEL_ID = "build";
        const backend = createDefaultRoomsCLIBackend();
        await expect(runRoomsCLI([
          "session", "send", "recipient", "--body", "reply", "--reply-to", "event_missing",
        ], backend)).rejects.toThrow("staleReply");
        await expect(runRoomsCLI([
          "session", "send", "recipient", "--body", "reply", "--reply-to", otherEventId,
        ], backend)).rejects.toThrow("staleReply");
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

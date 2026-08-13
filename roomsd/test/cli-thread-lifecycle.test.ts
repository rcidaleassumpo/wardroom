import { describe, expect, it } from "vitest";
import type { RoomsCLIBackend } from "../src/cli/backend.js";
import { runRoomsCLI } from "../src/cli/main.js";

function backend(overrides: Partial<RoomsCLIBackend>): RoomsCLIBackend {
  const unused = async (): Promise<never> => { throw new Error("unused"); };
  return {
    createChannel: unused,
    listChannels: unused,
    channelStatus: unused,
    suspendChannel: unused,
    resumeChannel: unused,
    createSession: unused,
    commitMessage: unused,
    sendPrompt: unused,
    ...overrides,
  };
}

describe("Rooms thread lifecycle CLI", () => {
  it("routes show, resolve, and reopen with the canonical root identity", async () => {
    const calls: string[] = [];
    const lifecycle = backend({
      threadLifecycle: async (input) => { calls.push(`show:${input.eventId}:${input.channel}:${input.credential}`); return { thread: { state: "open" } }; },
      resolveThread: async (input) => { calls.push(`resolve:${input.eventId}:${input.channel}:${input.credential}`); return { thread: { state: "resolved" } }; },
      reopenThread: async (input) => { calls.push(`reopen:${input.eventId}:${input.channel}:${input.credential}`); return { thread: { state: "open" } }; },
    });

    await runRoomsCLI(["thread", "show", "event-root", "--channel", "proof", "--credential", "operator"], lifecycle);
    await runRoomsCLI(["thread", "resolve", "event-root", "--channel", "proof", "--credential", "operator"], lifecycle);
    await runRoomsCLI(["thread", "reopen", "event-root", "--channel", "proof", "--credential", "operator"], lifecycle);

    expect(calls).toEqual([
      "show:event-root:proof:operator",
      "resolve:event-root:proof:operator",
      "reopen:event-root:proof:operator",
    ]);
  });

  it("advertises the thread commands", async () => {
    await expect(runRoomsCLI(["--help"])).resolves.toContain("rooms thread show|resolve|reopen");
  });
});

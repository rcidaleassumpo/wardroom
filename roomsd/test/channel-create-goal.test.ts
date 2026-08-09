import { describe, expect, it } from "vitest";
import type { RoomsCLIBackend, ChannelCreateInput } from "../src/cli/backend.js";
import { runRoomsCLI } from "../src/cli/main.js";
import { composeRoomsAgentBriefing } from "../src/cli/agent-briefing.js";

function unused(): never {
  throw new Error("unused");
}

function recordingBackend(calls: ChannelCreateInput[]): RoomsCLIBackend {
  return {
    createChannel: async (input) => { calls.push(input); return { channel: { id: input.name } }; },
    listChannels: async () => unused(),
    channelStatus: async () => unused(),
    suspendChannel: async () => unused(),
    resumeChannel: async () => unused(),
    createSession: async () => unused(),
    commitMessage: async () => unused(),
    sendPrompt: async () => unused(),
  };
}

describe("rooms channel create --goal", () => {
  it("refuses the flag instead of accepting and discarding it", async () => {
    // Rooms stores no channel goal: the channels table has no goal column, so
    // the value previously vanished while the command exited 0.
    const calls: ChannelCreateInput[] = [];
    await expect(runRoomsCLI(["channel", "create", "demo", "--goal", "ship it"], recordingBackend(calls)))
      .rejects.toThrow(/does not accept --goal/);
    expect(calls).toHaveLength(0);
  });

  it("names the working alternative in the error", async () => {
    await expect(runRoomsCLI(["channel", "create", "demo", "--goal", "ship it"], recordingBackend([])))
      .rejects.toThrow(/rooms run/);
  });

  it("still creates a channel without the flag", async () => {
    const calls: ChannelCreateInput[] = [];
    const output = await runRoomsCLI(["channel", "create", "demo"], recordingBackend(calls));
    expect(JSON.parse(output)).toMatchObject({ channel: { id: "demo" } });
    expect(calls).toEqual([{ name: "demo", credential: undefined }]);
  });

  it("no longer carries a goal field into the create call at all", async () => {
    const calls: ChannelCreateInput[] = [];
    await runRoomsCLI(["channel", "create", "demo", "--credential", "operator"], recordingBackend(calls));
    expect(Object.keys(calls[0]).sort()).toEqual(["credential", "name"]);
  });
});

describe("goal where it is real", () => {
  it("still reaches an agent briefing", () => {
    // The briefing is composed in process, which is why the missing column went
    // unnoticed: a launched agent always received its goal correctly.
    const briefing = composeRoomsAgentBriefing({ sessionId: "session-1", channel: "rooms-1", goal: "ship the fix", peers: [] });
    expect(briefing).toContain("whose goal is: ship the fix");
  });

  it("omits the goal sentence when there is none", () => {
    const briefing = composeRoomsAgentBriefing({ sessionId: "session-1", channel: "rooms-1", peers: [] });
    expect(briefing).not.toContain("whose goal is");
  });
});

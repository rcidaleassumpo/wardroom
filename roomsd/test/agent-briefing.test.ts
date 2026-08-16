import { describe, expect, it } from "vitest";
import { composeRoomsAgentBriefing } from "../src/cli/agent-briefing.js";

describe("Rooms-owned agent briefing", () => {
  it("contains only the Rooms coordination contract", () => {
    const text = composeRoomsAgentBriefing({ sessionId: "s1", channel: "c1", goal: "g" });
    expect(text).toContain("You are a Rooms session s1.");
    expect(text).toContain("Your launch roster is: none.");
    expect(text).toContain("already establishes your launch identity and roster");
    expect(text).toContain("Do not run commands or reply merely to confirm it");
    expect(text).toContain("Do not inspect CLI help, channel status, global session lists, or message history as startup checks");
    expect(text).not.toContain("Use `rooms whoami` to confirm");
    expect(text).toContain("rooms channel send");
    expect(text).toContain("rooms session send");
    expect(text).toContain("rooms session locate");
    expect(text).toContain("never construct a federation target");
  });

  it("includes named peers in the launch roster without requiring a refresh", () => {
    const text = composeRoomsAgentBriefing({
      sessionId: "s1",
      channel: "c1",
      peers: [{ id: "s2", name: "planner" }],
    });

    expect(text).toContain("Your launch roster is: planner (s2).");
    expect(text).toContain("Use `rooms channel members <channel>` only when a fresh roster is needed");
  });

  it("omits an empty goal instead of presenting setup flags as work", () => {
    const text = composeRoomsAgentBriefing({ sessionId: "s1", channel: "c1", goal: "" });

    expect(text).toContain("You are in Rooms channel c1.");
    expect(text).not.toContain("whose goal is:");
  });
});

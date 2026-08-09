import { describe, expect, it } from "vitest";
import { parseProviderInvocation, roomsLaunchPrompt } from "../src/cli/main.js";
import { composeRoomsAgentBriefing } from "../src/cli/agent-briefing.js";

/**
 * Provider passthrough arguments must never become Rooms prompt or goal text.
 * This defect class has recurred in more than one launcher, so the boundary is
 * pinned here rather than left to the parser's shape.
 */
const PROVIDER_FLAGS = [
  ["--dangerously-skip-permissions"],
  ["--dangerously-skip-permissions", "--verbose"],
  ["--model", "sonnet"],
  ["--model=sonnet"],
  ["-p"],
  ["--resume", "abc123", "--verbose"],
];

function launched(argv: readonly string[]) {
  const parsed = parseProviderInvocation(["run", "claude", ...argv]);
  const prompt = roomsLaunchPrompt(parsed.flags);
  return {
    providerArgs: parsed.positionals.slice(2),
    prompt,
    // Mirrors runRoomsSession: an absent goal must stay null, never a flag.
    goal: (parsed.flags.get("goal") ?? prompt) || null,
  };
}

describe("rooms run provider passthrough", () => {
  for (const argv of PROVIDER_FLAGS) {
    it(`keeps ${argv.join(" ")} out of the prompt and goal`, () => {
      const result = launched(argv);
      expect(result.providerArgs).toEqual([...argv]);
      expect(result.prompt).toBe("");
      expect(result.goal).toBeNull();
    });
  }

  it("never puts a provider flag into the briefing text", () => {
    const result = launched(["--dangerously-skip-permissions"]);
    const briefing = composeRoomsAgentBriefing({
      sessionId: "session-1",
      channel: "rooms-1",
      goal: result.goal ?? undefined,
      peers: [],
    });
    expect(briefing).not.toContain("--dangerously-skip-permissions");
    expect(briefing).not.toContain("whose goal is");
    expect(briefing).toContain("You are in Rooms channel rooms-1.");
  });

  it("uses an explicit --goal and --prompt without consuming provider args", () => {
    const parsed = parseProviderInvocation([
      "run", "claude", "--model", "sonnet", "--goal", "ship the fix", "--dangerously-skip-permissions",
    ]);
    expect(parsed.positionals.slice(2)).toEqual(["--model", "sonnet", "--dangerously-skip-permissions"]);
    expect(parsed.flags.get("goal")).toBe("ship the fix");
    expect(roomsLaunchPrompt(parsed.flags)).toBe("ship the fix");
  });

  it("passes everything after a bare -- to the provider, even Rooms flag names", () => {
    // Without the separator Rooms swallows --name; the provider never sees it.
    const parsed = parseProviderInvocation(["run", "claude", "--", "--name", "provider-side-name"]);
    expect(parsed.positionals.slice(2)).toEqual(["--name", "provider-side-name"]);
    expect(parsed.flags.has("name")).toBe(false);
    expect(roomsLaunchPrompt(parsed.flags)).toBe("");
  });

  it("still reads Rooms flags before the separator", () => {
    const parsed = parseProviderInvocation([
      "run", "claude", "--goal", "ship it", "--", "--goal", "provider-goal",
    ]);
    expect(parsed.flags.get("goal")).toBe("ship it");
    expect(parsed.positionals.slice(2)).toEqual(["--goal", "provider-goal"]);
  });

  it("does not emit the separator itself as a provider argument", () => {
    const parsed = parseProviderInvocation(["run", "claude", "--"]);
    expect(parsed.positionals.slice(2)).toEqual([]);
  });
});

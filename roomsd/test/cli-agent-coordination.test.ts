import { describe, expect, it, afterEach } from "vitest";
import type { RoomsCLIBackend } from "../src/cli/backend.js";
import { createSessionId, parseProviderInvocation, providerResumeThreadId, roomsLaunchPrompt, runRoomsCLI } from "../src/cli/main.js";

function backend(overrides: Partial<RoomsCLIBackend>): RoomsCLIBackend {
  return {
    createChannel: async () => ({}), listChannels: async () => ({}), channelStatus: async () => ({}),
    suspendChannel: async () => ({}), resumeChannel: async () => ({}), createSession: async () => ({}),
    commitMessage: async () => ({}), sendPrompt: async () => ({}), ...overrides,
  };
}

afterEach(() => {
  delete process.env.ROOMS_SESSION_ID;
  delete process.env.ROOMS_CHANNEL_ID;
});

describe("Rooms agent coordination commands", () => {
  it("creates provider-neutral session IDs", () => {
    const sessionId = createSessionId();
    expect(sessionId).toMatch(/^session-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(sessionId).not.toMatch(/rooms|codex|claude|grok/);
  });

  it("parses only Rooms flags and preserves native provider argv", () => {
    const threadId = "019fc64b-3ba6-74f1-a951-bc099b4a259d";
    const parsed = parseProviderInvocation(["run", "codex", "--credential", "operator", "--yolo", "resume", threadId]);
    expect(parsed.positionals).toEqual(["run", "codex", "--yolo", "resume", threadId]);
    expect(Object.fromEntries(parsed.flags)).toEqual({ credential: "operator" });
    expect(providerResumeThreadId("codex", parsed.positionals.slice(2))).toBe(threadId);
    expect(roomsLaunchPrompt(parsed.flags)).toBe("");
  });

  it("uses only explicit Rooms prompt or goal metadata", () => {
    expect(roomsLaunchPrompt(parseProviderInvocation(["run", "codex", "--yolo"]).flags)).toBe("");
    expect(roomsLaunchPrompt(parseProviderInvocation(["run", "codex", "--yolo", "--prompt", "do the work"]).flags)).toBe("do the work");
    expect(roomsLaunchPrompt(parseProviderInvocation(["run", "codex", "--goal", "coordinate the work", "--yolo"]).flags)).toBe("coordinate the work");
  });

  it("recognizes Claude resume without consuming provider flags", () => {
    const threadId = "89f104ed-06bd-461f-bdba-7500a0030c36";
    const parsed = parseProviderInvocation(["run", "claude", "--dangerously-skip-permissions", "--resume", threadId]);
    expect(parsed.positionals.slice(2)).toEqual(["--dangerously-skip-permissions", "--resume", threadId]);
    expect(providerResumeThreadId("claude", parsed.positionals.slice(2))).toBe(threadId);
  });

  it("keeps --naked in Rooms and forwards the remaining Codex arguments", () => {
    const parsed = parseProviderInvocation(["run", "codex", "--naked", "--yolo", "resume", "thread-id"]);
    expect(Object.fromEntries(parsed.flags)).toEqual({ naked: "true" });
    expect(parsed.positionals.slice(2)).toEqual(["--yolo", "resume", "thread-id"]);
  });

  it("reports Rooms identity", async () => {
    process.env.ROOMS_SESSION_ID = "session-1";
    process.env.ROOMS_CHANNEL_ID = "channel-1";
    const identity = { sessionId: "session-1", channelId: "channel-1", provider: "codex", sessionThreadId: "thread-1", machine: { id: "machine-1", authorityId: "authority-1" } };
    const result = await runRoomsCLI(["whoami"], backend({ whoami: async () => identity }));
    expect(JSON.parse(result)).toEqual(identity);
  });

  it("routes roster and broadcast/direct messages through Rooms", async () => {
    process.env.ROOMS_SESSION_ID = "session-1";
    const calls: unknown[] = [];
    const result = await runRoomsCLI(["channel", "members", "channel-1"], backend({
      channelMembers: async (channel) => ({ channel, members: [{ sessionId: "session-1" }] }),
    }));
    expect(JSON.parse(result).members).toEqual([{ sessionId: "session-1" }]);
    await runRoomsCLI(["channel", "send", "channel-1", "--body", "hello"], backend({ channelSend: async (input) => { calls.push(input); return { ok: true }; } }));
    await runRoomsCLI(["session", "send", "session-2", "--body", "private"], backend({ sessionSend: async (input) => { calls.push(input); return { ok: true }; } }));
    expect(calls).toEqual([
      { channel: "channel-1", sender: "session-1", body: "hello" },
      { target: "session-2", sender: "session-1", body: "private" },
    ]);
  });

  it("points an unknown local direct recipient to machine-aware lookup", async () => {
    await expect(runRoomsCLI(["session", "send", "session-remote", "--body", "private"], backend({
      sessionSend: async () => { throw new Error("unknown Rooms recipient session"); },
    }))).rejects.toThrow("rooms session locate session-remote");
  });

  it("passes an explicit operator credential to channel creation", async () => {
    const calls: unknown[] = [];
    // --goal is deliberately absent: Rooms stores no channel goal and the CLI now
    // rejects the flag rather than discarding it (internal work item). The credential is
    // what this case is about.
    await runRoomsCLI(["channel", "create", "proof-room", "--credential", "operator-1"], backend({
      createChannel: async (input) => { calls.push(input); return { ok: true }; },
    }));
    expect(calls).toEqual([{ name: "proof-room", credential: "operator-1" }]);
  });

  it("launches a detached persistent reviewer and delivers its first prompt through Rooms", async () => {
    const calls: unknown[] = [];
    const output = await runRoomsCLI([
      "session", "launch",
      "--credential", "operator-1",
      "--channel", "review-room",
      "--name", "session-reviewer-1",
      "--agent", "codex",
      "--role", "reviewer",
      "--cwd", "/tmp/review-target",
      "--prompt", "review RVW-000001",
      "--provider-args-json", "[\"--yolo\"]",
    ], backend({
      createSession: async (input) => { calls.push({ createSession: input }); return { session: { id: input.name, role: input.role } }; },
      sendPrompt: async (input) => { calls.push({ sendPrompt: input }); return { delivered: true }; },
    }));
    expect(calls).toEqual([
      { createSession: {
        credential: "operator-1", channel: "review-room", name: "session-reviewer-1", agent: "codex", role: "reviewer",
        cwd: "/tmp/review-target", prompt: "review RVW-000001", command: ["codex", "--yolo"],
      } },
      { sendPrompt: { channel: "review-room", session: "session-reviewer-1", prompt: "review RVW-000001" } },
    ]);
    expect(JSON.parse(output)).toMatchObject({ session: { id: "session-reviewer-1", role: "reviewer" }, promptDelivered: true });
  });

});

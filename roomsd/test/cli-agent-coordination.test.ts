import { describe, expect, it, afterEach } from "vitest";
import type { RoomsCLIBackend } from "../src/cli/backend.js";
import { createSessionId, deliverLaunchPrompt, parseProviderInvocation, providerResumeThreadId, roomsLaunchPrompt, runRoomsCLI } from "../src/cli/main.js";

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

  it("passes canonical reply metadata through channel, session, and message commands", async () => {
    process.env.ROOMS_SESSION_ID = "session-1";
    const calls: unknown[] = [];
    const configured = backend({
      channelSend: async (input) => { calls.push(input); return { ok: true }; },
      sessionSend: async (input) => { calls.push(input); return { ok: true }; },
      commitMessage: async (input) => { calls.push(input); return { ok: true }; },
    });
    await runRoomsCLI(["channel", "send", "channel-1", "--body", "channel reply", "--reply-to", "event-root"], configured);
    await runRoomsCLI(["session", "send", "session-2", "--body", "direct reply", "--reply-to", "event-root"], configured);
    await runRoomsCLI(["message", "commit", "--sender", "session-1", "--body", "stored reply", "--reply-to-event", "event-root"], configured);
    expect(calls).toEqual([
      { channel: "channel-1", sender: "session-1", body: "channel reply", replyToEventId: "event-root" },
      { target: "session-2", sender: "session-1", body: "direct reply", replyToEventId: "event-root" },
      { channel: null, sender: "session-1", body: "stored reply", target: null, replyToEventId: "event-root" },
    ]);
  });

  it("rejects a reply flag with no event id", async () => {
    await expect(runRoomsCLI(["session", "send", "session-2", "--body", "private", "--reply-to"], backend({
      sessionSend: async () => ({ ok: true }),
    }))).rejects.toThrow("--reply-to requires an event id");
  });
  it("commits typed private controls with the caller identity and channel environment", async () => {
    process.env.ROOMS_SESSION_ID = "worker-1";
    process.env.ROOMS_CHANNEL_ID = "channel-1";
    const calls: unknown[] = [];
    const result = await runRoomsCLI(["control", "commit", "--kind", "mycelia.task.claim", "--payload-json", "{\"taskId\":\"task-1\"}", "--request-id", "request-1"], backend({
      commitControl: async (input) => { calls.push(input); return { accepted: true }; },
    }));
    expect(calls).toEqual([{ channel: "channel-1", sender: "worker-1", kind: "mycelia.task.claim", payload: { taskId: "task-1" }, requestId: "request-1" }]);
    expect(JSON.parse(result)).toEqual({ accepted: true });
  });

  it("points an unknown local direct recipient to machine-aware lookup", async () => {
    await expect(runRoomsCLI(["session", "send", "session-remote", "--body", "private"], backend({
      sessionSend: async () => { throw new Error("unknown Rooms recipient session"); },
    }))).rejects.toThrow("rooms session locate session-remote");
  });

  it("terminates a provider runtime before ending its canonical session", async () => {
    const cleanup: string[] = [];
    await runRoomsCLI(["session", "end", "session-worker", "--credential", "operator-1"], backend({
      runtimeTerminateSession: async (session, credential) => { cleanup.push(`terminate:${session}:${credential}`); return {}; },
      endSession: async (session, credential) => { cleanup.push(`end:${session}:${credential}`); return {}; },
    }));
    expect(cleanup).toEqual(["terminate:session-worker:operator-1", "end:session-worker:operator-1"]);
  });

  it("ends a session whose runtime has already stopped", async () => {
    const cleanup: string[] = [];
    await runRoomsCLI(["session", "end", "session-worker", "--credential", "operator-1"], backend({
      runtimeTerminateSession: async () => { throw new Error("session session-worker has no active Rooms runtime"); },
      endSession: async (session) => { cleanup.push(session); return {}; },
    }));
    expect(cleanup).toEqual(["session-worker"]);
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
      registerSession: async (input) => { calls.push({ registerSession: input }); return { membership: { sessionId: input.name } }; },
      createSession: async (input) => { calls.push({ createSession: input }); return { session: { id: input.name, role: input.role } }; },
      sendPrompt: async (input) => { calls.push({ sendPrompt: input }); return { delivered: true }; },
    }));
    expect(calls).toEqual([
      { registerSession: { channel: "review-room", name: "operator-1", role: "operator", externalId: null } },
      { createSession: {
        credential: "operator-1", channel: "review-room", name: "session-reviewer-1", agent: "codex", adapter: "codex", role: "reviewer",
        cwd: "/tmp/review-target", prompt: "review RVW-000001", command: ["codex", "--yolo"],
      } },
      { sendPrompt: { credential: "operator-1", channel: "review-room", session: "session-reviewer-1", prompt: "You are a Rooms session session-reviewer-1.\n\nreview RVW-000001" } },
    ]);
    expect(JSON.parse(output)).toMatchObject({ session: { id: "session-reviewer-1", role: "reviewer" }, promptDelivered: true });
  });

  it("launches a session with the selected registry executable", async () => {
    const commands: unknown[] = [];
    await runRoomsCLI([
      "session", "launch", "--credential", "operator-1", "--channel", "review-room",
      "--name", "session-worker-registry", "--agent", "codex", "--cwd", "/tmp/target", "--prompt", "do the work",
    ], backend({
      providerExecutable: () => "/tmp/isolated-provider-registry/codex",
      registerSession: async () => ({}),
      createSession: async (input) => { commands.push(input.command); return {}; },
      sendPrompt: async () => ({}),
    }));
    expect(commands).toEqual([["/tmp/isolated-provider-registry/codex", "--yolo"]]);
  });

  it("passes neutral Gemini launch options through the registered agy adapter", async () => {
    const launches: unknown[] = [];
    await runRoomsCLI([
      "session", "launch", "--credential", "operator-1", "--channel", "review-room",
      "--name", "session-gemini", "--agent", "gemini", "--cwd", "/tmp/target", "--prompt", "do the work",
      "--provider-options-json", '{"permissions":"headless","model":"gemini-test"}',
    ], backend({
      providerExecutable: () => "/tmp/isolated-provider-registry/agy",
      registerSession: async () => ({}),
      createSession: async (input) => { launches.push({ agent: input.agent, adapter: input.adapter, command: input.command }); return {}; },
      sendPrompt: async () => ({}),
    }));
    expect(launches).toEqual([{
      agent: "gemini",
      adapter: "agy",
      command: ["/tmp/isolated-provider-registry/agy", "--model", "gemini-test", "--approval-mode", "yolo"],
    }]);
  });

  it("launches unattended sessions with permission prompts already answered", async () => {
    const calls: unknown[] = [];
    await runRoomsCLI([
      "session", "launch", "--credential", "operator-1", "--channel", "review-room",
      "--name", "session-worker-1", "--agent", "claude", "--cwd", "/tmp/target", "--prompt", "do the work",
    ], backend({
      registerSession: async () => ({}),
      createSession: async (input) => { calls.push(input.command); return {}; },
      sendPrompt: async () => ({}),
    }));
    await runRoomsCLI([
      "session", "launch", "--credential", "operator-1", "--channel", "review-room",
      "--name", "session-worker-2", "--agent", "claude", "--cwd", "/tmp/target", "--prompt", "do the work",
      "--permissions", "manual",
    ], backend({
      registerSession: async () => ({}),
      createSession: async (input) => { calls.push(input.command); return {}; },
      sendPrompt: async () => ({}),
    }));
    expect(calls).toEqual([["claude", "--dangerously-skip-permissions"], ["claude"]]);
  });

  it("retries the first prompt until the booting runtime accepts it", async () => {
    const statuses = ["queued", "queued", "delivered"];
    const waits: number[] = [];
    const result = await deliverLaunchPrompt(
      { sendPrompt: async () => ({ event: { recipientStatuses: { "session-worker-1": statuses.shift() } } }) },
      { credential: "operator-1", channel: "review-room", session: "session-worker-1", prompt: "do the work" },
      { sleep: async (ms) => { waits.push(ms); } },
    );
    expect(result).toEqual({ attempts: 3, verified: false });
    expect(waits).toEqual([250, 500]);
  });

  it("retries delivered prompts until the provider produces new activity", async () => {
    const acceptance = [false, true];
    const waits: number[] = [];
    const result = await deliverLaunchPrompt(
      { sendPrompt: async () => ({ event: { recipientStatuses: { "session-worker-1": "delivered" } } }) },
      { credential: "operator-1", channel: "review-room", session: "session-worker-1", prompt: "do the work" },
      { verify: async () => acceptance.shift() ?? false, sleep: async (ms) => { waits.push(ms); } },
    );
    expect(result).toEqual({ attempts: 2, verified: true });
    expect(waits).toEqual([250]);
  });

  it("fails the launch instead of reporting a prompt it never delivered", async () => {
    await expect(deliverLaunchPrompt(
      { sendPrompt: async () => { throw new Error("recipient session has no live runtime"); } },
      { credential: "operator-1", channel: "review-room", session: "session-worker-1", prompt: "do the work" },
      { timeoutMs: 1_200, sleep: async () => {} },
    )).rejects.toThrow(/session-worker-1 launched but its first prompt was never delivered.*no live runtime/s);
  });

  it("rolls the session back when its first prompt cannot be delivered", async () => {
    const cleanup: string[] = [];
    await expect(runRoomsCLI([
      "session", "launch", "--credential", "operator-1", "--channel", "review-room",
      "--name", "session-worker-3", "--agent", "claude", "--cwd", "/tmp/target", "--prompt", "do the work",
      "--prompt-timeout-ms", "0",
    ], backend({
      registerSession: async () => ({}),
      createSession: async () => ({}),
      sendPrompt: async () => ({ event: { recipientStatuses: { "session-worker-3": "undeliverable" } } }),
      runtimeTerminateSession: async (session) => { cleanup.push(`terminate:${session}`); return {}; },
      endSession: async (session) => { cleanup.push(`end:${session}`); return {}; },
    }))).rejects.toThrow("never delivered");
    expect(cleanup).toEqual(["terminate:session-worker-3", "end:session-worker-3"]);
  });

  it("fails launch and clears the session when the provider exits before readiness", async () => {
    const cleanup: string[] = [];
    const state = { runtime: "running", sessionEnded: false };
    await expect(runRoomsCLI([
      "session", "launch", "--credential", "operator-1", "--channel", "review-room",
      "--name", "session-worker-exited", "--agent", "claude", "--cwd", "/tmp/target", "--prompt", "do the work",
    ], backend({
      registerSession: async () => ({}),
      createSession: async () => ({}),
      runtimeResolveSessionAttach: async () => ({ credential: "operator-1", runtimeId: "runtime-exited", homeAuthorityId: "authority-1", sessionId: "session-worker-exited", generation: 1, viewerId: "operator-1", mode: "observe" }),
      runtimeAttachInteractive: async (_input, handlers) => {
        queueMicrotask(() => handlers.onExit({ code: 23 }));
        return { hello: { replayFrom: "0", head: "0", gap: false }, input: async () => ({}), resize: async () => ({}), detach: async () => ({}) };
      },
      runtimeTerminateSession: async (session) => { cleanup.push(`terminate:${session}`); state.runtime = "terminated"; return {}; },
      endSession: async (session) => { cleanup.push(`end:${session}`); state.sessionEnded = true; return {}; },
    }))).rejects.toThrow("provider runtime runtime-exited exited before readiness (exit code 23)");
    expect(cleanup).toEqual(["terminate:session-worker-exited", "end:session-worker-exited"]);
    expect(state).toEqual({ runtime: "terminated", sessionEnded: true });
  });

});

import { describe, expect, it } from "vitest";
import type { RoomsCLIBackend, RuntimeAttachCLIInput, RuntimeAttachInteractiveHandlers } from "../src/cli/backend.js";
import { drainRuntimeOutput, stripTerminalSequences, waitForProviderReady } from "../src/cli/runtime-drain.js";

const input: RuntimeAttachCLIInput = {
  credential: "operator-1", runtimeId: "runtime-1", homeAuthorityId: "authority-1",
  sessionId: "w-1", generation: 1, viewerId: "operator-1", mode: "observe",
};

/** An immediate timer, so a drain test measures behavior rather than wall clock. */
const instantTimer = (callback: () => void) => { const handle = setTimeout(callback, 0); return { cancel: () => clearTimeout(handle) }; };

function backend(attach: RoomsCLIBackend["runtimeAttachInteractive"]): RoomsCLIBackend {
  return {
    createChannel: async () => ({}), listChannels: async () => ({}), channelStatus: async () => ({}),
    suspendChannel: async () => ({}), resumeChannel: async () => ({}), createSession: async () => ({}),
    commitMessage: async () => ({}), sendPrompt: async () => ({}), runtimeAttachInteractive: attach,
  };
}

describe("headless runtime observation", () => {
  it("collects the replayed screen and detaches without writing to the session", async () => {
    const calls: string[] = [];
    const result = await drainRuntimeOutput(input, backend(async (attachInput, handlers: RuntimeAttachInteractiveHandlers) => {
      calls.push(`attach:${attachInput.mode}`);
      queueMicrotask(() => {
        handlers.onOutput({ cursor: "10", bytes: Buffer.from("Welcome to ") });
        handlers.onOutput({ cursor: "21", bytes: Buffer.from("Claude Code") });
      });
      return {
        hello: { replayFrom: "0", head: "21", gap: false },
        input: async () => { calls.push("input"); return {}; },
        resize: async () => ({}),
        detach: async () => { calls.push("detach"); return {}; },
      };
    }), { setTimer: instantTimer });
    expect(result).toMatchObject({ sessionId: "w-1", runtimeId: "runtime-1", cursor: "32", byteCount: 22, exited: false, text: "Welcome to Claude Code" });
    expect(calls).toEqual(["attach:observe", "detach"]);
  });

  it("returns the boundary after replayed boot paint", async () => {
    const bootPaint = Buffer.alloc(1_120, "x");
    const result = await drainRuntimeOutput(input, backend(async (_attachInput, handlers: RuntimeAttachInteractiveHandlers) => {
      queueMicrotask(() => handlers.onOutput({ cursor: "0", bytes: bootPaint }));
      return {
        hello: { replayFrom: "0", head: "1120", gap: false },
        input: async () => ({}), resize: async () => ({}), detach: async () => ({}),
      };
    }), { setTimer: instantTimer });

    expect(result).toMatchObject({ cursor: "1120", byteCount: 1_120 });
  });

  it("reports an exited runtime rather than waiting out the deadline", async () => {
    const result = await drainRuntimeOutput(input, backend(async (_attachInput, handlers: RuntimeAttachInteractiveHandlers) => {
      queueMicrotask(() => { handlers.onOutput({ cursor: "4", bytes: Buffer.from("bye") }); handlers.onExit({ code: 0 }); });
      return { hello: { replayFrom: "0", head: "4", gap: false }, input: async () => ({}), resize: async () => ({}), detach: async () => ({}) };
    }), { setTimer: instantTimer });
    expect(result).toMatchObject({ exited: true, exitCode: 0 });
    expect(result.text).toBe("bye");
  });

  it("fails readiness with the provider exit cause", async () => {
    await expect(waitForProviderReady(input, backend(async (_attachInput, handlers: RuntimeAttachInteractiveHandlers) => {
      queueMicrotask(() => handlers.onExit({ code: 17 }));
      return { hello: { replayFrom: "0", head: "0", gap: false }, input: async () => ({}), resize: async () => ({}), detach: async () => ({}) };
    }))).rejects.toThrow("provider runtime runtime-1 exited before readiness (exit code 17)");
  });

  it("says observation is unavailable rather than failing obscurely", async () => {
    await expect(drainRuntimeOutput(input, backend(undefined))).rejects.toThrow("runtime observation is unavailable");
  });

  it("makes a redrawn provider screen readable", () => {
    const screen = "\x1b[2J\x1b[H\x1b]0;claude\x07\x1b[32m> \x1b[0mDo you trust the files in this folder?\r\n";
    expect(stripTerminalSequences(screen)).toBe("> Do you trust the files in this folder?\r\n");
  });
});

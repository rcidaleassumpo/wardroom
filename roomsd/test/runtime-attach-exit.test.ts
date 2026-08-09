import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { RoomsCLIBackend, RuntimeAttachCLIInput } from "../src/cli/backend.js";
import { runInteractiveRuntimeAttach } from "../src/cli/runtime-attach.js";

const input: RuntimeAttachCLIInput = {
  credential: "session-1",
  runtimeId: "runtime-1",
  homeAuthorityId: "authority-1",
  sessionId: "session-1",
  generation: 1,
  viewerId: "session-1",
  mode: "controller",
};

describe("interactive runtime lifecycle result", () => {
  it("never resizes from observe mode on attach, terminal resize, or reconnect", async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
    const stderr = new PassThrough();
    const firstResize = vi.fn(async () => ({}));
    const replacementResize = vi.fn(async () => ({}));
    const firstDetach = vi.fn(async () => ({}));
    const replacementDetach = vi.fn(async () => ({}));
    let attachCount = 0;
    const backend = {
      runtimeAttachInteractive: async (_request, handlers) => {
        attachCount += 1;
        if (attachCount === 1) {
          setImmediate(() => {
            stdout.emit("resize");
            handlers.onClose();
          });
          return {
            hello: { replayFrom: "0", head: "0", gap: false },
            input: async () => ({}),
            resize: firstResize,
            detach: firstDetach,
          };
        }
        setImmediate(() => process.emit("SIGINT"));
        return {
          hello: { replayFrom: "0", head: "0", gap: false },
          input: async () => ({}),
          resize: replacementResize,
          detach: replacementDetach,
        };
      },
    } as Partial<RoomsCLIBackend> as RoomsCLIBackend;

    const result = await runInteractiveRuntimeAttach(
      { ...input, mode: "observe" },
      backend,
      { stdin, stdout, stderr } as never,
    );

    expect(result).toEqual({ exited: false });
    expect(attachCount).toBe(2);
    expect(firstResize).not.toHaveBeenCalled();
    expect(replacementResize).not.toHaveBeenCalled();
    expect(firstDetach).not.toHaveBeenCalled();
    expect(replacementDetach).toHaveBeenCalledOnce();
    expect(stdin.setRawMode).not.toHaveBeenCalled();
  });

  it("still resizes controller mode on attach and terminal resize", async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
    const stderr = new PassThrough();
    const resize = vi.fn(async () => ({}));
    const detach = vi.fn(async () => ({}));
    const backend = {
      runtimeAttachInteractive: async () => {
        setImmediate(() => {
          stdout.emit("resize");
          process.emit("SIGINT");
        });
        return {
          hello: { replayFrom: "0", head: "0", gap: false },
          input: async () => ({}),
          resize,
          detach,
        };
      },
    } as Partial<RoomsCLIBackend> as RoomsCLIBackend;

    const result = await runInteractiveRuntimeAttach(input, backend, { stdin, stdout, stderr } as never);

    expect(result).toEqual({ exited: false });
    expect(resize.mock.calls).toEqual([[80, 24], [80, 24]]);
    expect(stdin.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(detach).toHaveBeenCalledOnce();
  });

  it("reports a provider exit separately from a controller detach", async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
    const stderr = new PassThrough();
    const detach = vi.fn(async () => ({}));
    const backend = {
      runtimeAttachInteractive: async (_request, handlers) => {
        handlers.onExit({ code: 0 });
        return {
          hello: { replayFrom: "0", head: "0", gap: false },
          input: async () => ({}),
          resize: async () => ({}),
          detach,
        };
      },
    } as Partial<RoomsCLIBackend> as RoomsCLIBackend;

    const result = await runInteractiveRuntimeAttach(input, backend, { stdin, stdout, stderr } as never);

    expect(result).toEqual({ exited: true });
    expect(detach).toHaveBeenCalledOnce();
  });

  it("reports an operator interrupt as a detach without ending the provider", async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
    const stderr = new PassThrough();
    const detach = vi.fn(async () => ({}));
    const backend = {
      runtimeAttachInteractive: async () => {
        setImmediate(() => process.emit("SIGINT"));
        return {
          hello: { replayFrom: "0", head: "0", gap: false },
          input: async () => ({}),
          resize: async () => ({}),
          detach,
        };
      },
    } as Partial<RoomsCLIBackend> as RoomsCLIBackend;

    const result = await runInteractiveRuntimeAttach(input, backend, { stdin, stdout, stderr } as never);

    expect(result).toEqual({ exited: false });
    expect(detach).toHaveBeenCalledOnce();
  });
});

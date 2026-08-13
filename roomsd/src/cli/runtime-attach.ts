// SPDX-License-Identifier: Apache-2.0
import type {
  RoomsCLIBackend, RuntimeAttachCLIInput, RuntimeAttachInteractiveHandlers,
  RuntimeAttachInteractiveSession,
} from "./backend.js";

interface InteractiveTerminal {
  stdin: NodeJS.ReadStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
  stdout: NodeJS.WriteStream & { isTTY?: boolean; columns?: number; rows?: number };
  stderr: NodeJS.WriteStream;
}

const processTerminal = (): InteractiveTerminal => ({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });

/**
 * Keep terminal concerns at the CLI edge. The backend session remains the
 * Rooms-authorized owner of the host connection and controller operations.
 */
export async function runInteractiveRuntimeAttach(
  input: RuntimeAttachCLIInput,
  backend: RoomsCLIBackend,
  terminal: InteractiveTerminal = processTerminal(),
): Promise<{ exited: boolean }> {
  const attach = backend.runtimeAttachInteractive;
  if (!attach) throw new Error("interactive runtime attach is unavailable");
  if (!terminal.stdin.isTTY || !terminal.stdout.isTTY) throw new Error("runtime attach requires an interactive terminal");

  let session: RuntimeAttachInteractiveSession | undefined;
  let attached = false;
  let exited = false;
  let finished = false;
  let finish!: (error?: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      if (error) reject(error);
      else resolve();
    };
  });
  let helloReceived = false;
  let expectedCursor: bigint | undefined;
  let observedCursor: bigint | undefined;
  let firstObservedCursor: bigint | undefined;
  let gapReported = false;
  let operationChain = Promise.resolve();
  let lifecycleTimer: NodeJS.Timeout | undefined;
  let reconnectTask: Promise<void> | undefined;

  const reportGap = (message: string): void => {
    if (gapReported) return;
    gapReported = true;
    terminal.stderr.write(`rooms: runtime output gap: ${message}\n`);
  };

  const handlers: RuntimeAttachInteractiveHandlers = {
    onOutput(value) {
      const start = BigInt(value.cursor);
      if (firstObservedCursor === undefined) firstObservedCursor = start;
      if (observedCursor !== undefined && observedCursor !== start) {
        reportGap(`expected cursor ${observedCursor}, received ${start}`);
      }
      if (helloReceived && expectedCursor !== undefined && expectedCursor !== start) {
        reportGap(`expected cursor ${expectedCursor}, received ${start}`);
      }
      try {
        terminal.stdout.write(Buffer.from(value.bytes));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      observedCursor = start + BigInt(value.bytes.byteLength);
      expectedCursor = observedCursor;
    },
    onExit() {
      exited = true;
      finish();
    },
    onError(value) {
      finish(new Error(`runtime host error ${value.code}: ${value.message}`));
    },
    onClose() {
      if (exited || finished || reconnectTask) return;
      session = undefined;
      attached = false;
      reconnectTask = (async () => {
        let delayMs = 50;
        while (!exited && !finished) {
          try {
            const outputCursor = observedCursor?.toString() ?? input.outputCursor;
            const replacement = await attach({ ...input, outputCursor }, handlers);
            session = replacement;
            attached = true;
            helloReceived = true;
            expectedCursor = observedCursor ?? BigInt(replacement.hello.replayFrom);
            onResize();
            return;
          } catch {
            await new Promise(resolve => setTimeout(resolve, delayMs));
            delayMs = Math.min(delayMs * 2, 1_000);
          }
        }
      })().finally(() => { reconnectTask = undefined; });
    },
  };

  const queueOperation = (operation: () => Promise<unknown>): void => {
    operationChain = operationChain.then(operation).then(() => undefined).catch((error: unknown) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  };

  const onInput = (chunk: Buffer | string): void => {
    if (!session || finished) return;
    const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk);
    queueOperation(() => session!.input(bytes));
  };
  const onResize = (): void => {
    if (input.mode !== "controller") return;
    if (!session || finished) return;
    const columns = terminal.stdout.columns;
    const rows = terminal.stdout.rows;
    if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1) return;
    queueOperation(() => session!.resize(columns, rows));
  };
  const onInterrupt = (): void => finish();

  try {
    session = await attach(input, handlers);
    attached = true;
    if (backend.runtimeStatus) {
      lifecycleTimer = setInterval(() => {
        void backend.runtimeStatus!(input.runtimeId, input.credential).then((status: any) => {
          const state = status?.runtime?.state ?? status?.state;
          if (["exited", "terminated", "crashed"].includes(state)) {
            exited = true;
            finish();
          }
        }).catch(() => { /* the live host connection remains authoritative */ });
      }, 250);
      lifecycleTimer.unref();
    }
    const requestedCursor = BigInt(input.outputCursor ?? "0");
    const replayFrom = BigInt(session.hello.replayFrom);
    if (session.hello.gap) reportGap(`requested cursor ${requestedCursor}, replay begins at ${replayFrom}`);
    if (firstObservedCursor !== undefined && firstObservedCursor !== replayFrom) {
      reportGap(`replay begins at ${replayFrom}, received ${firstObservedCursor}`);
    }
    helloReceived = true;
    // The HELLO acknowledgement may arrive in a packet before replay frames.
    // Start at replayFrom so a delayed bounded replay is not mistaken for a
    // live-stream gap; output events advance the cursor to head naturally.
    expectedCursor = observedCursor ?? replayFrom;
    if (exited) return { exited: true };

    terminal.stdout.on("resize", onResize);
    if (input.mode === "controller") {
      if (!terminal.stdin.setRawMode) throw new Error("controller attach requires a raw-mode terminal");
      terminal.stdin.setRawMode(true);
      terminal.stdin.resume();
      terminal.stdin.on("data", onInput);
    }
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
    onResize();
    await done;
  } finally {
    if (lifecycleTimer) clearInterval(lifecycleTimer);
    terminal.stdout.removeListener("resize", onResize);
    terminal.stdin.removeListener("data", onInput);
    if (input.mode === "controller" && terminal.stdin.setRawMode) {
      terminal.stdin.setRawMode(false);
      terminal.stdin.pause();
    }
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
    await reconnectTask;
    await operationChain;
    if (attached && session) await session.detach();
  }
  return { exited };
}

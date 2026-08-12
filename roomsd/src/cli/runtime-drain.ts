import type { RoomsCLIBackend, RuntimeAttachCLIInput } from "./backend.js";

export interface RuntimeDrainResult {
  sessionId: string;
  runtimeId: string;
  cursor: string;
  byteCount: number;
  exited: boolean;
  exitCode: number | null;
  runtimeError: { code: number; message: string } | null;
  closed: boolean;
  /** True when output went quiet, false when the deadline cut the drain short. */
  settled: boolean;
  text: string;
}

export interface RuntimeDrainOptions {
  /** Hard stop, so a chatty runtime cannot hold the drain open forever. */
  durationMs?: number;
  /** Quiet period that ends the drain early once the screen has settled. */
  idleMs?: number;
  plain?: boolean;
  /**
   * Start the quiet timer only once the runtime has actually said something. A
   * process that has not printed yet is silent for the same reason a finished
   * one is, and only this flag tells the two apart.
   */
  awaitFirstOutput?: boolean;
  /**
   * Bytes the runtime must produce before quiet counts as finished. A provider
   * emits a few bytes early and then pauses before painting, so a byte-blind
   * quiet check calls it ready while the TUI is still starting.
   */
  minBytes?: number;
  setTimer?: (callback: () => void, ms: number) => { cancel: () => void };
}

/**
 * A launched runtime can only be inspected by attaching a terminal, and attach
 * refuses without a TTY. That left a headless supervisor unable to see why a
 * session was wedged: Rooms could report that it wrote bytes into the PTY but
 * not what the provider did with them (internal work item).
 *
 * Draining is the same observe attachment an interactive viewer opens, with
 * the terminal replaced by a buffer: replay the ring from the requested
 * cursor, collect until the output settles or the deadline passes, then detach.
 * It reads and never writes, so it cannot disturb the session it inspects.
 */
export async function drainRuntimeOutput(
  input: RuntimeAttachCLIInput,
  backend: RoomsCLIBackend,
  options: RuntimeDrainOptions = {},
): Promise<RuntimeDrainResult> {
  const attach = backend.runtimeAttachInteractive;
  if (!attach) throw new Error("runtime observation is unavailable");
  const durationMs = options.durationMs ?? 3_000;
  const idleMs = options.idleMs ?? 500;
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => {
    const handle = setTimeout(callback, ms);
    if (typeof handle.unref === "function") handle.unref();
    return { cancel: () => clearTimeout(handle) };
  });

  const chunks: Uint8Array[] = [];
  let cursor = input.outputCursor ?? "0";
  let exited = false;
  let exitCode: number | null = null;
  let runtimeError: { code: number; message: string } | null = null;
  let closed = false;
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  let wentQuiet = false;
  let byteCount = 0;
  const armIdle = (): { cancel: () => void } => setTimer(() => {
    if (byteCount < (options.minBytes ?? 0)) { idleTimer = armIdle(); return; }
    wentQuiet = true;
    settle();
  }, idleMs);
  let idleTimer = options.awaitFirstOutput ? { cancel: () => {} } : armIdle();
  const deadline = setTimer(settle, durationMs);

  const session = await attach(input, {
    onOutput(value) {
      chunks.push(value.bytes);
      byteCount += value.bytes.byteLength;
      // Host output cursors identify the first byte in the frame. Resume from
      // its end so a later acceptance check cannot count this replayed paint
      // as activity caused by the launch prompt.
      const outputEnd = BigInt(value.cursor) + BigInt(value.bytes.byteLength);
      if (outputEnd > BigInt(cursor)) cursor = outputEnd.toString();
      idleTimer.cancel();
      idleTimer = armIdle();
    },
    onExit(value) { exited = true; exitCode = value.code; settle(); },
    onError(value) { runtimeError = value; settle(); },
    onClose() { closed = true; settle(); },
  });

  try {
    await settled;
  } finally {
    idleTimer.cancel();
    deadline.cancel();
    try { await session.detach(); } catch { /* the drain result still stands */ }
  }

  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  return {
    sessionId: input.sessionId,
    runtimeId: input.runtimeId,
    cursor,
    byteCount,
    exited,
    exitCode,
    runtimeError,
    closed,
    settled: wentQuiet,
    text: options.plain ? stripTerminalSequences(text) : text,
  };
}

export interface ProviderReadiness { settled: boolean; byteCount: number; cursor: string; }

/**
 * A provider TUI does not own the terminal the moment its process starts. Bytes
 * written before it installs its input handler are echoed into the line buffer
 * and its Enter is discarded, so the prompt lands in the composer and is never
 * submitted: the exact wedge in internal work item, confirmed by observing a launched
 * session whose composer held the prompt while the session sat idle.
 *
 * Readiness is therefore "the screen stopped changing". It is provider-neutral,
 * it needs no knowledge of any TUI's layout, and a provider that stays silent
 * is not punished for it: the wait ends at the deadline and the caller still
 * delivers, no worse off than before.
 */
export async function waitForProviderReady(
  input: RuntimeAttachCLIInput,
  backend: RoomsCLIBackend,
  options: { settleMs?: number; timeoutMs?: number; minBytes?: number; setTimer?: RuntimeDrainOptions["setTimer"] } = {},
): Promise<ProviderReadiness> {
  const drained = await drainRuntimeOutput(input, backend, {
    idleMs: options.settleMs ?? 1_000,
    durationMs: options.timeoutMs ?? 25_000,
    awaitFirstOutput: true,
    minBytes: options.minBytes ?? 512,
    setTimer: options.setTimer,
  });
  if (drained.exited) throw new Error(`provider runtime ${input.runtimeId} exited before readiness (exit code ${drained.exitCode ?? "unknown"})`);
  if (drained.runtimeError) throw new Error(`provider runtime ${input.runtimeId} failed before readiness (${drained.runtimeError.code}: ${drained.runtimeError.message})`);
  if (drained.closed) throw new Error(`provider runtime ${input.runtimeId} closed before readiness`);
  return { settled: drained.settled, byteCount: drained.byteCount, cursor: drained.cursor };
}

/**
 * Enough of the terminal vocabulary to make a provider's screen readable in a
 * log or a ticket. This is a diagnostic aid, not a terminal emulator: it drops
 * escape sequences rather than applying them, so overwritten cells still show.
 */
export function stripTerminalSequences(value: string): string {
  return value
    .replace(/\x1b\][^]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

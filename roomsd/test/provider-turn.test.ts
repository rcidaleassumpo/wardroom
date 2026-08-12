import { describe, expect, it } from "vitest";
import { resolveProviderTurn, readJsonlTail, clearProviderTurnPathCache, loadProviderTranscriptLines } from "../src/runtime/provider-turn.js";
import { mkdtempSync, writeFileSync, openSync, writeSync, closeSync, fstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("resolveProviderTurn", () => {
  it("is idle when the runtime is live and no prompt has been delivered", () => {
    expect(resolveProviderTurn({
      alive: true,
      adapterKind: "codex",
      lastDeliverAt: null,
      transcriptLines: [],
    })).toMatchObject({ phase: "idle", reason: "awaiting-input" });
  });

  it("is offline-shaped when the runtime is not live", () => {
    expect(resolveProviderTurn({
      alive: false,
      adapterKind: "codex",
      lastDeliverAt: "2026-01-01T00:00:00.000Z",
      transcriptLines: [],
    })).toMatchObject({ phase: null, reason: "runtime-not-live" });
  });

  it("tracks a codex task from start through tool work to complete", () => {
    const deliverAt = "2026-01-01T00:00:00.000Z";
    expect(resolveProviderTurn({
      alive: true,
      adapterKind: "codex",
      lastDeliverAt: deliverAt,
      transcriptLines: [
        { timestamp: "2026-01-01T00:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
      ],
    })).toMatchObject({ phase: "thinking", reason: "task_started" });

    expect(resolveProviderTurn({
      alive: true,
      adapterKind: "codex",
      lastDeliverAt: deliverAt,
      transcriptLines: [
        { timestamp: "2026-01-01T00:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
        { timestamp: "2026-01-01T00:00:02.000Z", type: "response_item", payload: { type: "function_call" } },
      ],
    })).toMatchObject({ phase: "tool", reason: "tool_call" });

    expect(resolveProviderTurn({
      alive: true,
      adapterKind: "codex",
      lastDeliverAt: deliverAt,
      transcriptLines: [
        { timestamp: "2026-01-01T00:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
        { timestamp: "2026-01-01T00:00:02.000Z", type: "response_item", payload: { type: "function_call" } },
        { timestamp: "2026-01-01T00:00:05.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } },
      ],
    })).toMatchObject({ phase: "idle", reason: "task_complete" });
  });

  it("uses claude turn_duration as idle", () => {
    expect(resolveProviderTurn({
      alive: true,
      adapterKind: "claude",
      lastDeliverAt: "2026-01-01T00:00:00.000Z",
      transcriptLines: [
        { timestamp: "2026-01-01T00:00:01.000Z", type: "assistant" } as never,
        { timestamp: "2026-01-01T00:00:02.000Z", type: "system", subtype: "turn_duration" } as never,
      ],
    })).toMatchObject({ phase: "idle", reason: "turn_duration" });
  });

  it("tracks grok turns from events.jsonl lifecycle, not Rooms chat messages", () => {
    const deliverAt = "2026-01-01T00:00:00.000Z";
    expect(resolveProviderTurn({
      alive: true,
      adapterKind: "grok",
      lastDeliverAt: deliverAt,
      transcriptLines: [],
    })).toMatchObject({ phase: "busy", reason: "prompt-delivered" });

    expect(resolveProviderTurn({
      alive: true,
      adapterKind: "grok",
      lastDeliverAt: deliverAt,
      transcriptLines: [
        { ts: "2026-01-01T00:00:01.000Z", type: "turn_started" },
        { ts: "2026-01-01T00:00:02.000Z", type: "phase_changed", phase: "tool_execution" },
      ],
    })).toMatchObject({ phase: "tool", reason: "tool_execution" });

    expect(resolveProviderTurn({
      alive: true,
      adapterKind: "grok",
      lastDeliverAt: deliverAt,
      transcriptLines: [
        { ts: "2026-01-01T00:00:01.000Z", type: "turn_started" },
        { ts: "2026-01-01T00:00:02.000Z", type: "phase_changed", phase: "tool_execution" },
        { ts: "2026-01-01T00:00:05.000Z", type: "turn_ended", outcome: "completed" },
      ],
    })).toMatchObject({ phase: "idle", reason: "turn_ended:completed" });
  });

  it("exposes unsupported for unknown adapters instead of permanent busy", () => {
    expect(resolveProviderTurn({
      alive: true,
      adapterKind: "other",
      lastDeliverAt: "2026-01-01T00:00:00.000Z",
      transcriptLines: [],
    })).toMatchObject({ phase: "unsupported", reason: "provider-turn-unsupported" });
  });

  it("readJsonlTail uses a bounded tail and does not require a full-file string", () => {
    clearProviderTurnPathCache();
    const dir = mkdtempSync(join(tmpdir(), "rooms-tail-"));
    const path = join(dir, "big.jsonl");
    const fd = openSync(path, "w");
    // Write more than the default tail window.
    const pad = `${"x".repeat(200)}\n`;
    for (let i = 0; i < 2000; i++) writeSync(fd, pad);
    writeSync(fd, `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", type: "turn_started" })}\n`);
    writeSync(fd, `${JSON.stringify({ ts: "2026-01-01T00:00:01.000Z", type: "turn_ended", outcome: "completed" })}\n`);
    closeSync(fd);

    // Prove the implementation can read only a window: file is large, result is small.
    const size = fstatSync(openSync(path, "r")).size;
    expect(size).toBeGreaterThan(256 * 1024);
    const lines = readJsonlTail(path, 8192);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.some((line) => line.type === "turn_ended")).toBe(true);
  });

  it("Grok loader requires an exact providerThreadId binding and never returns the newest global file", () => {
    clearProviderTurnPathCache();
    const home = mkdtempSync(join(tmpdir(), "rooms-grok-bind-"));
    const cwdKey = encodeURIComponent("/tmp/p");
    const boundId = "bound-sess";
    const otherId = "other-newer-sess";
    const boundDir = join(home, ".grok", "sessions", cwdKey, boundId);
    const otherDir = join(home, ".grok", "sessions", cwdKey, otherId);
    mkdirSync(boundDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(boundDir, "events.jsonl"), `${JSON.stringify({ ts: "2026-01-01T00:00:01.000Z", type: "turn_started" })}\n`);
    writeFileSync(join(otherDir, "events.jsonl"), `${JSON.stringify({ ts: "2026-01-01T00:00:02.000Z", type: "turn_ended", outcome: "completed" })}\n`);

    // Without a binding: empty (never invent a global newest).
    expect(loadProviderTranscriptLines("grok", null, home)).toEqual([]);

    const lines = loadProviderTranscriptLines("grok", boundId, home);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.type).toBe("turn_started");
    expect(lines.some((line) => line.type === "turn_ended")).toBe(false);
  });
});

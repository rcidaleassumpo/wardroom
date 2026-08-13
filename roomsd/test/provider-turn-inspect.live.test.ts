import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, appendFileSync, mkdtempSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RoomsRepository } from "../src/storage/repository.js";
import { RuntimeRepository } from "../src/storage/runtime-repository.js";
import { clearProviderTurnPathCache } from "../src/runtime/provider-turn.js";

/**
 * Proves rooms session inspect providerTurn transitions using the real
 * inspectSession code path against controlled provider lifecycle files.
 * This is not parser-only evidence: each snapshot is repository.inspectSession().
 */
function seedRuntime(repo: RoomsRepository, input: {
  sessionId: string;
  adapterKind: string;
  providerThreadId: string | null;
  deliverAt?: string | null;
}) {
  const runtimes = new RuntimeRepository(repo.db);
  runtimes.create({
    runtimeId: `runtime-${input.sessionId}`,
    homeAuthorityId: "authority-live",
    sessionId: input.sessionId,
    generation: 1,
    protocolVersion: 1,
    transportKind: "localPty",
    machineId: "machine-live",
    providerThreadId: input.providerThreadId,
    reconnectSecret: new Uint8Array(32),
  });
  runtimes.markState(`runtime-${input.sessionId}`, 1, "running");
  runtimes.bind({
    bindingId: `binding-${input.sessionId}`,
    runtimeId: `runtime-${input.sessionId}`,
    homeAuthorityId: "authority-live",
    sessionId: input.sessionId,
    generation: 1,
    channelId: null,
    adapterKind: input.adapterKind,
    handleRef: "unix:///tmp/live.sock",
    launchPolicyRef: null,
  });
  if (input.deliverAt) {
    insertDeliver(repo, `runtime-${input.sessionId}`, input.deliverAt);
  }
}

function insertDeliver(repo: RoomsRepository, runtimeId: string, deliverAt: string) {
  // Bypass appendEvent's canonical-message FK so tests control occurred_at.
  repo.db.prepare(
    `INSERT INTO runtime_events(runtime_id, generation, event_seq, event_id, kind, output_cursor, message_id, outcome, payload_json, occurred_at)
     VALUES (?, 1, COALESCE((SELECT MAX(event_seq) FROM runtime_events WHERE runtime_id=?), 0) + 1, ?, 'deliverMessageAccepted', NULL, NULL, 'written', '{}', ?)`,
  ).run(runtimeId, runtimeId, `evt-${runtimeId}-${deliverAt}`, deliverAt);
}

describe("live inspectSession providerTurn transitions", () => {
  it("Codex inspect moves ready -> working(tool) -> ready from growing transcript + deliver event", () => {
    clearProviderTurnPathCache();
    const home = mkdtempSync(join(tmpdir(), "rooms-codex-live-"));
    const threadId = "thread-codex-live-proof";
    const sessionDir = join(home, ".codex", "sessions", "2026", "01", "01");
    mkdirSync(sessionDir, { recursive: true });
    const transcript = join(sessionDir, `rollout-${threadId}.jsonl`);
    // Identity line used by path matching.
    writeFileSync(transcript, `${JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id: threadId, cwd: "/tmp" } })}\n`);

    const deliverAt = "2026-01-01T00:00:10.000Z";
    const repo = new RoomsRepository(":memory:");
    try {
      repo.insertSession({ id: "codex-session", role: "worker" });
      seedRuntime(repo, { sessionId: "codex-session", adapterKind: "codex", providerThreadId: threadId, deliverAt: null });

      // Monkey-patch home via env is not wired; loadProviderTranscriptLines takes homeDirectory.
      // inspectSession uses default homedir(). Point the loader by writing under real structure
      // under a temp home and temporarily overriding HOME.
      const previousHome = process.env.HOME;
      process.env.HOME = home;
      clearProviderTurnPathCache();

      try {
        // 1) ready before deliver
        let snap = repo.inspectSession("codex-session");
        expect(snap.runtime?.providerTurn).toMatchObject({ phase: "idle", reason: "awaiting-input" });

        // 2) deliver accepted, turn starts
        insertDeliver(repo, "runtime-codex-session", deliverAt);
        appendFileSync(transcript, `${JSON.stringify({ timestamp: "2026-01-01T00:00:11.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "t1" } })}\n`);
        clearProviderTurnPathCache();
        snap = repo.inspectSession("codex-session");
        expect(snap.runtime?.providerTurn).toMatchObject({ phase: "thinking", reason: "task_started" });

        // 3) tool call during turn
        appendFileSync(transcript, `${JSON.stringify({ timestamp: "2026-01-01T00:00:12.000Z", type: "response_item", payload: { type: "function_call" } })}\n`);
        clearProviderTurnPathCache();
        snap = repo.inspectSession("codex-session");
        expect(snap.runtime?.providerTurn).toMatchObject({ phase: "tool", reason: "tool_call" });

        // 4) turn complete -> ready
        appendFileSync(transcript, `${JSON.stringify({ timestamp: "2026-01-01T00:00:15.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } })}\n`);
        clearProviderTurnPathCache();
        snap = repo.inspectSession("codex-session");
        expect(snap.runtime?.providerTurn).toMatchObject({ phase: "idle", reason: "task_complete" });
      } finally {
        process.env.HOME = previousHome;
        clearProviderTurnPathCache();
      }
    } finally {
      repo.close();
    }
  });

  it("Grok inspect moves ready -> working(tool) -> ready from events.jsonl, not Rooms messages", () => {
    clearProviderTurnPathCache();
    const home = mkdtempSync(join(tmpdir(), "rooms-grok-live-"));
    const sessionId = "grok-session-live";
    const grokSessionId = "grok-native-sess-1";
    const eventsDir = join(home, ".grok", "sessions", "proj", grokSessionId);
    mkdirSync(eventsDir, { recursive: true });
    const eventsPath = join(eventsDir, "events.jsonl");
    writeFileSync(eventsPath, "");

    const deliverAt = "2026-01-01T00:00:10.000Z";
    const repo = new RoomsRepository(":memory:");
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      repo.insertSession({ id: sessionId, role: "worker" });
      // Canonical binding: runtime generation owns this exact Grok session id.
      seedRuntime(repo, { sessionId, adapterKind: "grok", providerThreadId: grokSessionId, deliverAt: null });

      // 1) ready — no deliver
      clearProviderTurnPathCache();
      let snap = repo.inspectSession(sessionId);
      expect(snap.runtime?.providerTurn).toMatchObject({ phase: "idle", reason: "awaiting-input" });
      expect(snap.runtime?.providerThreadId).toBe(grokSessionId);
      expect(snap.runtime?.providerThreadIdState).toBe("attached");

      // 2) deliver + turn_started -> working/thinking
      insertDeliver(repo, `runtime-${sessionId}`, deliverAt);

      // A Rooms progress message must NOT flip Grok to idle.
      repo.insertChannel({ id: "ch" });
      repo.insertSession({ id: "operator", role: "operator" });
      repo.commitMessage({
        channelId: "ch",
        senderSessionId: sessionId,
        body: "!task claim abc123 progress checkpoint",
        target: { kind: "direct", sessionId: "operator" },
      });

      appendFileSync(eventsPath, `${JSON.stringify({ ts: "2026-01-01T00:00:11.000Z", type: "turn_started" })}\n`);
      clearProviderTurnPathCache();
      snap = repo.inspectSession(sessionId);
      expect(snap.runtime?.providerTurn).toMatchObject({ phase: "thinking", reason: "turn_started" });
      // Still working despite Rooms progress message existing after deliver.
      expect(snap.runtime?.providerTurn?.phase).not.toBe("idle");

      // 3) tool phase
      appendFileSync(eventsPath, `${JSON.stringify({ ts: "2026-01-01T00:00:12.000Z", type: "phase_changed", phase: "tool_execution" })}\n`);
      clearProviderTurnPathCache();
      snap = repo.inspectSession(sessionId);
      expect(snap.runtime?.providerTurn).toMatchObject({ phase: "tool", reason: "tool_execution" });

      // 4) turn_ended -> ready
      appendFileSync(eventsPath, `${JSON.stringify({ ts: "2026-01-01T00:00:15.000Z", type: "turn_ended", outcome: "completed" })}\n`);
      clearProviderTurnPathCache();
      snap = repo.inspectSession(sessionId);
      expect(snap.runtime?.providerTurn).toMatchObject({ phase: "idle", reason: "turn_ended:completed" });
    } finally {
      process.env.HOME = previousHome;
      clearProviderTurnPathCache();
      repo.close();
    }
  });

  it("two concurrent Grok runtimes never cross-contaminate lifecycle state", () => {
    clearProviderTurnPathCache();
    const home = mkdtempSync(join(tmpdir(), "rooms-grok-iso-"));
    const cwdKey = encodeURIComponent("/tmp/project-a");
    const idA = "grok-session-aaa";
    const idB = "grok-session-bbb";
    const pathA = join(home, ".grok", "sessions", cwdKey, idA, "events.jsonl");
    const pathB = join(home, ".grok", "sessions", cwdKey, idB, "events.jsonl");
    mkdirSync(join(home, ".grok", "sessions", cwdKey, idA), { recursive: true });
    mkdirSync(join(home, ".grok", "sessions", cwdKey, idB), { recursive: true });
    writeFileSync(pathA, "");
    writeFileSync(pathB, "");

    const deliverAt = "2026-01-01T00:00:10.000Z";
    const repo = new RoomsRepository(":memory:");
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      repo.insertSession({ id: "agent-a", role: "worker" });
      repo.insertSession({ id: "agent-b", role: "worker" });
      seedRuntime(repo, { sessionId: "agent-a", adapterKind: "grok", providerThreadId: idA, deliverAt });
      seedRuntime(repo, { sessionId: "agent-b", adapterKind: "grok", providerThreadId: idB, deliverAt });

      // Opposing phases: A thinking, B idle after turn_ended.
      appendFileSync(pathA, `${JSON.stringify({ ts: "2026-01-01T00:00:11.000Z", type: "turn_started" })}\n`);
      appendFileSync(pathA, `${JSON.stringify({ ts: "2026-01-01T00:00:12.000Z", type: "phase_changed", phase: "tool_execution" })}\n`);
      appendFileSync(pathB, `${JSON.stringify({ ts: "2026-01-01T00:00:11.000Z", type: "turn_started" })}\n`);
      appendFileSync(pathB, `${JSON.stringify({ ts: "2026-01-01T00:00:13.000Z", type: "turn_ended", outcome: "completed" })}\n`);
      clearProviderTurnPathCache();

      const snapA = repo.inspectSession("agent-a");
      const snapB = repo.inspectSession("agent-b");
      expect(snapA.runtime?.providerThreadId).toBe(idA);
      expect(snapB.runtime?.providerThreadId).toBe(idB);
      expect(snapA.runtime?.providerTurn).toMatchObject({ phase: "tool", reason: "tool_execution" });
      expect(snapB.runtime?.providerTurn).toMatchObject({ phase: "idle", reason: "turn_ended:completed" });

      // Newer unrelated Grok file becomes active (would win a global mtime scan).
      const idNoise = "grok-session-noise-newer";
      const pathNoise = join(home, ".grok", "sessions", cwdKey, idNoise, "events.jsonl");
      mkdirSync(join(home, ".grok", "sessions", cwdKey, idNoise), { recursive: true });
      writeFileSync(
        pathNoise,
        `${JSON.stringify({ ts: "2026-01-01T00:00:20.000Z", type: "turn_started" })}\n` +
        `${JSON.stringify({ ts: "2026-01-01T00:00:21.000Z", type: "phase_changed", phase: "streaming_text" })}\n`,
      );
      // Touch noise file later so it is strictly newest by mtime.
      const later = (Date.now() + 5_000) / 1000;
      utimesSync(pathNoise, later, later);

      clearProviderTurnPathCache();
      const snapA2 = repo.inspectSession("agent-a");
      const snapB2 = repo.inspectSession("agent-b");
      // Agent A stays on its bound file (tool), not the newer noise streaming phase.
      expect(snapA2.runtime?.providerTurn).toMatchObject({ phase: "tool", reason: "tool_execution" });
      expect(snapB2.runtime?.providerTurn).toMatchObject({ phase: "idle", reason: "turn_ended:completed" });
      expect(snapA2.runtime?.providerTurn?.phase).not.toBe("streaming");
    } finally {
      process.env.HOME = previousHome;
      clearProviderTurnPathCache();
      repo.close();
    }
  });
});

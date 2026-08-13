import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { canonicalProviderCwd, claudeProjectKey, discoverProviderThreadId, fileContainsMarker } from "../src/runtime/service.js";
import { RoomsRepository } from "../src/storage/repository.js";
import { RuntimeRepository } from "../src/storage/runtime-repository.js";

function writeClaudeTranscript(sessionId: string, cwd?: string): { home: string; cwd: string } {
  const home = mkdtempSync(join(tmpdir(), "rooms-provider-id-"));
  const actualCwd = cwd ?? join(home, "project");
  mkdirSync(actualCwd, { recursive: true });
  const project = claudeProjectKey(canonicalProviderCwd(actualCwd)!);
  mkdirSync(join(home, ".claude", "projects", project), { recursive: true });
  writeFileSync(join(home, ".claude", "projects", project, `${sessionId}.jsonl`), JSON.stringify({ type: "mode", sessionId }) + "\n");
  return { home, cwd: actualCwd };
}

function writeGrokSession(home: string, cwd: string, sessionId: string, mtimeSec: number): void {
  const dir = join(home, ".grok", "sessions", encodeURIComponent(canonicalProviderCwd(cwd)!), sessionId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "events.jsonl");
  writeFileSync(path, `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", type: "turn_started", session_id: sessionId })}\n`);
  utimesSync(path, mtimeSec, mtimeSec);
}

describe("provider-native identity discovery", () => {
  it("captures Claude's native session id from the newly-created transcript", async () => {
    const { home, cwd } = writeClaudeTranscript("claude-native-thread-1");
    expect(await discoverProviderThreadId("claude", cwd, Date.now() - 1000, home)).toBe("claude-native-thread-1");
  });

  it("finds Claude's transcript when the launch cwd uses a filesystem alias", async () => {
    const home = mkdtempSync(join(tmpdir(), "rooms-provider-id-alias-"));
    const realCwd = join(home, "real-project");
    const aliasCwd = join(home, "project-alias");
    mkdirSync(realCwd);
    symlinkSync(realCwd, aliasCwd);
    const canonicalCwd = canonicalProviderCwd(aliasCwd)!;
    const project = claudeProjectKey(canonicalCwd);
    mkdirSync(join(home, ".claude", "projects", project), { recursive: true });
    writeFileSync(join(home, ".claude", "projects", project, "claude-aliased-thread.jsonl"), JSON.stringify({ type: "mode", sessionId: "claude-aliased-thread" }) + "\n");

    expect(canonicalCwd).toBe(realpathSync.native(realCwd));
    expect(await discoverProviderThreadId("claude", aliasCwd, Date.now() - 1000, home)).toBe("claude-aliased-thread");
  });

  it("matches Claude 2.1.227 project keys for a dotted canonical cwd", async () => {
    const home = mkdtempSync(join(tmpdir(), "rooms-provider-id-dotted-"));
    const cwd = join(home, "rooms-proof.vPeuR6");
    mkdirSync(cwd);
    const canonicalCwd = canonicalProviderCwd(cwd)!;
    const project = claudeProjectKey(canonicalCwd);
    mkdirSync(join(home, ".claude", "projects", project), { recursive: true });
    writeFileSync(join(home, ".claude", "projects", project, "claude-dotted-thread.jsonl"), JSON.stringify({ type: "mode", sessionId: "claude-dotted-thread" }) + "\n");

    expect(project).toBe(canonicalCwd.replace(/[^A-Za-z0-9_-]/g, "-"));
    expect(project).not.toContain("-2e-");
    expect(await discoverProviderThreadId("claude", cwd, Date.now() - 1000, home)).toBe("claude-dotted-thread");
  });

  it("does not infer an identity for unsupported providers", async () => {
    expect(await discoverProviderThreadId("localPty", "/tmp/project", 0, "/tmp")).toBeNull();
  });

  it("captures Grok's native session id from the cwd-scoped events.jsonl binding", async () => {
    const home = mkdtempSync(join(tmpdir(), "rooms-provider-id-grok-"));
    const cwd = join(home, "project");
    mkdirSync(cwd);
    const sessionId = "019ff222-b397-7b22-a294-88a49c70f2ae";
    const dir = join(home, ".grok", "sessions", encodeURIComponent(canonicalProviderCwd(cwd)!), sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", type: "turn_started", session_id: sessionId })}\n`);
    expect(await discoverProviderThreadId("grok", cwd, Date.now() - 1000, home)).toBe(sessionId);
  });

  it("binds Grok ownership from chat history rather than its lifecycle log", async () => {
    const home = mkdtempSync(join(tmpdir(), "rooms-provider-id-grok-marker-"));
    const cwd = join(home, "project");
    const sessionId = "grok-owned-thread";
    mkdirSync(cwd);
    const dir = join(home, ".grok", "sessions", encodeURIComponent(canonicalProviderCwd(cwd)!), sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ type: "turn_started" })}\n`);
    writeFileSync(join(dir, "chat_history.jsonl"), `${JSON.stringify({ type: "user", content: [{ type: "text", text: "Rooms session grok-owner" }] })}\n`);
    expect(await discoverProviderThreadId("grok", cwd, Date.now() - 1_000, home, {
      ownershipMarker: "grok-owner",
    })).toBe(sessionId);
  });

  it("captures AGY's exact brain id from the transcript ownership marker", async () => {
    const home = mkdtempSync(join(tmpdir(), "rooms-provider-id-agy-"));
    const cwd = join(home, "project");
    const sessionId = "agy-native-thread-1";
    const logs = join(home, ".gemini", "antigravity-cli", "brain", sessionId, ".system_generated", "logs");
    mkdirSync(cwd);
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, "transcript.jsonl"), `${JSON.stringify({ type: "USER_INPUT", content: "Rooms session owner-agy" })}\n`);
    expect(await discoverProviderThreadId("agy", cwd, Date.now() - 1000, home, {
      ownershipMarker: "owner-agy",
    })).toBe(sessionId);
  });

  it("captures Google Gemini CLI's cwd-bound session id from its ownership marker", async () => {
    const home = mkdtempSync(join(tmpdir(), "rooms-provider-id-gemini-"));
    const cwd = join(home, "project");
    const chats = join(home, ".gemini", "tmp", "project", "chats");
    const sessionId = "gemini-native-thread-1";
    mkdirSync(cwd);
    mkdirSync(chats, { recursive: true });
    writeFileSync(join(chats, "session-proof.jsonl"), [
      JSON.stringify({ sessionId, projectHash: createHash("sha256").update(canonicalProviderCwd(cwd)!).digest("hex") }),
      JSON.stringify({ $push: { messages: { type: "user", content: [{ text: "Rooms session owner-gemini" }] } } }),
      "",
    ].join("\n"));
    expect(await discoverProviderThreadId("gemini", cwd, Date.now() - 1_000, home, {
      ownershipMarker: "owner-gemini",
    })).toBe(sessionId);
  });

  it("never binds a Grok session from a different cwd even if it is newer", async () => {
    const home = mkdtempSync(join(tmpdir(), "rooms-provider-id-grok-other-"));
    const cwd = join(home, "project-a");
    const other = join(home, "project-b");
    mkdirSync(cwd);
    mkdirSync(other);
    const dirOther = join(home, ".grok", "sessions", encodeURIComponent(canonicalProviderCwd(other)!), "other-sess");
    mkdirSync(dirOther, { recursive: true });
    writeFileSync(join(dirOther, "events.jsonl"), `${JSON.stringify({ type: "turn_started" })}\n`);
    expect(await discoverProviderThreadId("grok", cwd, Date.now() - 1000, home, { timeoutMs: 250 })).toBeNull();
  });

  it("never adopts a transcript another live runtime already claimed", async () => {
    const { home, cwd } = writeClaudeTranscript("claude-native-thread-2");
    const claimed: string[] = [];
    expect(await discoverProviderThreadId("claude", cwd, Date.now() - 1000, home, {
      timeoutMs: 250,
      isClaimed: (candidate) => { claimed.push(candidate); return true; },
    })).toBeNull();
    expect(claimed).toContain("claude-native-thread-2");
  });

  it("stops polling once the runtime it belongs to is no longer alive", async () => {
    const { home, cwd } = writeClaudeTranscript("claude-native-thread-3");
    expect(await discoverProviderThreadId("claude", cwd, Date.now() - 1000, home, {
      timeoutMs: 60_000,
      keepPolling: () => false,
    })).toBeNull();
  });

  it("concurrent same-cwd Claude discovery binds each transcript to its ownership marker, not the newest file", async () => {
    const home = mkdtempSync(join(tmpdir(), "rooms-provider-id-claude-race-"));
    const cwd = join(home, "same-cwd-project");
    mkdirSync(cwd);
    const canonicalCwd = canonicalProviderCwd(cwd)!;
    const project = claudeProjectKey(canonicalCwd);
    const projectDir = join(home, ".claude", "projects", project);
    mkdirSync(projectDir, { recursive: true });
    const olderId = "claude-sess-older-a";
    const newerId = "claude-sess-newer-b";
    const olderPath = join(projectDir, `${olderId}.jsonl`);
    const newerPath = join(projectDir, `${newerId}.jsonl`);
    // Newer file is written first in discovery sort without markers; each body
    // embeds only its Rooms session id so ownership cannot be swapped.
    writeFileSync(newerPath, `${JSON.stringify({ type: "mode", sessionId: newerId })}\nRooms session id: session-b\n`);
    writeFileSync(olderPath, `${JSON.stringify({ type: "mode", sessionId: olderId })}\nRooms session id: session-a\n`);
    const base = Math.floor(Date.now() / 1000) - 20;
    utimesSync(olderPath, base, base);
    utimesSync(newerPath, base + 5, base + 5);

    const database = new RoomsRepository(":memory:");
    try {
      database.insertSession({ id: "session-a", role: "worker" });
      database.insertSession({ id: "session-b", role: "worker" });
      const runtimes = new RuntimeRepository(database.db);
      const seed = { homeAuthorityId: "authority-a", generation: 1, protocolVersion: 1, transportKind: "localPty" as const, machineId: "machine-a", reconnectSecret: new Uint8Array(32), providerThreadId: null as string | null };
      runtimes.create({ ...seed, runtimeId: "runtime-a", sessionId: "session-a" });
      runtimes.markState("runtime-a", 1, "running");
      runtimes.create({ ...seed, runtimeId: "runtime-b", sessionId: "session-b" });
      runtimes.markState("runtime-b", 1, "running");

      const launchedAfter = Date.now() - 60_000;
      const [idA, idB] = await Promise.all([
        discoverProviderThreadId("claude", cwd, launchedAfter, home, {
          timeoutMs: 2_000,
          ownershipMarker: "session-a",
          isClaimed: (candidate) => runtimes.providerThreadHolder(candidate, "runtime-a") !== null,
          tryClaim: (candidate) => runtimes.tryClaimProviderThreadId("runtime-a", candidate).claimed,
          keepPolling: () => runtimes.get("runtime-a")?.providerThreadId == null,
        }),
        discoverProviderThreadId("claude", cwd, launchedAfter, home, {
          timeoutMs: 2_000,
          ownershipMarker: "session-b",
          isClaimed: (candidate) => runtimes.providerThreadHolder(candidate, "runtime-b") !== null,
          tryClaim: (candidate) => runtimes.tryClaimProviderThreadId("runtime-b", candidate).claimed,
          keepPolling: () => runtimes.get("runtime-b")?.providerThreadId == null,
        }),
      ]);

      expect(idA).toBe(olderId);
      expect(idB).toBe(newerId);
      expect(runtimes.get("runtime-a")?.providerThreadId).toBe(olderId);
      expect(runtimes.get("runtime-b")?.providerThreadId).toBe(newerId);
    } finally {
      database.close();
    }
  });

  it("does not claim a newer Claude transcript that lacks this launch's ownership marker", async () => {
    const home = mkdtempSync(join(tmpdir(), "rooms-provider-id-claude-marker-"));
    const cwd = join(home, "project");
    mkdirSync(cwd);
    const canonicalCwd = canonicalProviderCwd(cwd)!;
    const project = claudeProjectKey(canonicalCwd);
    mkdirSync(join(home, ".claude", "projects", project), { recursive: true });
    const wrong = join(home, ".claude", "projects", project, "wrong-session.jsonl");
    writeFileSync(wrong, `${JSON.stringify({ type: "mode", sessionId: "wrong-session" })}\nRooms session id: other-session\n`);
    expect(await discoverProviderThreadId("claude", cwd, Date.now() - 1000, home, {
      timeoutMs: 300,
      ownershipMarker: "my-session",
    })).toBeNull();
  });

  it("continues marker discovery beyond the first transcript chunk", () => {
    const home = mkdtempSync(join(tmpdir(), "rooms-provider-id-chunks-"));
    const path = join(home, "transcript.jsonl");
    const marker = "rooms-session-across-the-chunk-boundary";
    const markerOffset = (64 * 1024) - Math.floor(marker.length / 2);
    writeFileSync(path, `${"x".repeat(markerOffset)}${marker}\n`);
    const scan = { offset: 0, device: null, inode: null };

    expect(fileContainsMarker(path, marker, scan)).toBe(false);
    expect(scan.offset).toBe(64 * 1024);
    expect(fileContainsMarker(path, marker, scan)).toBe(true);
  });

  it("binds three concurrent same-cwd Codex launches whose markers follow large bootstrap context", async () => {
    const home = mkdtempSync(join(tmpdir(), "rooms-provider-id-codex-context-"));
    const cwd = join(home, "same-cwd-project");
    const sessionRoot = join(home, ".codex", "sessions", "2026", "08", "12");
    mkdirSync(cwd);
    mkdirSync(sessionRoot, { recursive: true });
    const sessions = ["rooms-session-a", "rooms-session-b", "rooms-session-c"];
    const threads = ["codex-thread-a", "codex-thread-b", "codex-thread-c"];
    const markerOffset = 122_251;
    for (let index = 0; index < sessions.length; index++) {
      const first = `${JSON.stringify({ type: "session_meta", payload: { id: threads[index], cwd: canonicalProviderCwd(cwd) } })}\n`;
      writeFileSync(join(sessionRoot, `rollout-${threads[index]}.jsonl`), `${first}${"x".repeat(markerOffset - Buffer.byteLength(first))}${sessions[index]}\n`);
    }

    const database = new RoomsRepository(":memory:");
    try {
      const runtimes = new RuntimeRepository(database.db);
      const seed = { homeAuthorityId: "authority-a", generation: 1, protocolVersion: 1, transportKind: "localPty" as const, machineId: "machine-a", reconnectSecret: new Uint8Array(32), providerThreadId: null as string | null };
      for (const sessionId of sessions) {
        database.insertSession({ id: sessionId, role: "worker" });
        runtimes.create({ ...seed, runtimeId: `runtime-${sessionId}`, sessionId });
        runtimes.markState(`runtime-${sessionId}`, 1, "running");
      }

      const discovered = await Promise.all(sessions.map((sessionId) => discoverProviderThreadId("codex", cwd, Date.now() - 1_000, home, {
        timeoutMs: 2_000,
        ownershipMarker: sessionId,
        isClaimed: (candidate) => runtimes.providerThreadHolder(candidate, `runtime-${sessionId}`) !== null,
        tryClaim: (candidate) => runtimes.tryClaimProviderThreadId(`runtime-${sessionId}`, candidate).claimed,
        keepPolling: () => runtimes.get(`runtime-${sessionId}`)?.providerThreadId == null,
      })));

      expect(discovered).toEqual(threads);
      expect(new Set(discovered).size).toBe(3);
      for (let index = 0; index < sessions.length; index++) {
        expect(runtimes.get(`runtime-${sessions[index]}`)?.providerThreadId).toBe(threads[index]);
      }
    } finally {
      database.close();
    }
  });

  it("concurrent same-cwd Grok discovery binds two different session ids under overlapping tryClaim", async () => {
    const home = mkdtempSync(join(tmpdir(), "rooms-provider-id-grok-race-"));
    const cwd = join(home, "same-cwd-project");
    mkdirSync(cwd);
    const olderId = "grok-sess-older";
    const newerId = "grok-sess-newer";
    const base = Math.floor(Date.now() / 1000) - 10;
    writeGrokSession(home, cwd, olderId, base);
    writeGrokSession(home, cwd, newerId, base + 5); // both pick newest first under mtime sort

    const database = new RoomsRepository(":memory:");
    try {
      database.insertSession({ id: "session-a", role: "worker" });
      database.insertSession({ id: "session-b", role: "worker" });
      const runtimes = new RuntimeRepository(database.db);
      const seed = { homeAuthorityId: "authority-a", generation: 1, protocolVersion: 1, transportKind: "localPty" as const, machineId: "machine-a", reconnectSecret: new Uint8Array(32), providerThreadId: null as string | null };
      runtimes.create({ ...seed, runtimeId: "runtime-a", sessionId: "session-a" });
      runtimes.markState("runtime-a", 1, "running");
      runtimes.create({ ...seed, runtimeId: "runtime-b", sessionId: "session-b" });
      runtimes.markState("runtime-b", 1, "running");

      const launchedAfter = Date.now() - 60_000;
      // Overlapping discovery: both see the same newest unclaimed candidate first;
      // atomic tryClaim lets only one win it; the loser continues to the older id.
      const [idA, idB] = await Promise.all([
        discoverProviderThreadId("grok", cwd, launchedAfter, home, {
          timeoutMs: 2_000,
          isClaimed: (candidate) => runtimes.providerThreadHolder(candidate, "runtime-a") !== null,
          tryClaim: (candidate) => runtimes.tryClaimProviderThreadId("runtime-a", candidate).claimed,
          keepPolling: () => runtimes.get("runtime-a")?.providerThreadId == null,
        }),
        discoverProviderThreadId("grok", cwd, launchedAfter, home, {
          timeoutMs: 2_000,
          isClaimed: (candidate) => runtimes.providerThreadHolder(candidate, "runtime-b") !== null,
          tryClaim: (candidate) => runtimes.tryClaimProviderThreadId("runtime-b", candidate).claimed,
          keepPolling: () => runtimes.get("runtime-b")?.providerThreadId == null,
        }),
      ]);

      expect(idA).toBeTruthy();
      expect(idB).toBeTruthy();
      expect(idA).not.toBe(idB);
      expect(new Set([idA, idB])).toEqual(new Set([newerId, olderId]));
      expect(runtimes.get("runtime-a")?.providerThreadId).toBe(idA);
      expect(runtimes.get("runtime-b")?.providerThreadId).toBe(idB);
      expect(runtimes.get("runtime-a")?.providerThreadId).not.toBe(runtimes.get("runtime-b")?.providerThreadId);
    } finally {
      database.close();
    }
  });
});

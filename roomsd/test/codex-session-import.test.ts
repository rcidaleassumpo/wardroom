import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importCodexThread, providerLaunchCommand } from "../src/cli/codex-session-import.js";

const THREAD = "019fc64b-3ba6-74f1-a951-bc099b4a259d";

describe("legacy Codex session import", () => {
  it("imports a legacy thread into the primary Codex home and launches without an alternate CODEX_HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "rooms-codex-import-"));
    const primary = join(home, ".codex");
    const legacy = join(home, ".codex-old");
    const legacyRollout = join(legacy, "sessions", "2026", "08", "03", `rollout-${THREAD}.jsonl`);
    mkdirSync(join(primary, "sessions"), { recursive: true });
    mkdirSync(join(legacyRollout, ".."), { recursive: true });
    writeFileSync(legacyRollout, "{\"type\":\"session_meta\"}\n");
    createThreadDatabase(join(primary, "state_5.sqlite"));
    const source = createThreadDatabase(join(legacy, "state_5.sqlite"));
    source.prepare("INSERT INTO threads(id, rollout_path, updated_at, updated_at_ms) VALUES (?, ?, 10, 10000)").run(THREAD, legacyRollout);
    source.close();

    expect(importCodexThread(THREAD, home)).toBe(true);
    expect(providerLaunchCommand("codex", ["--yolo", "resume", THREAD], THREAD, home)).toEqual(["codex", "--yolo", "resume", THREAD]);
    const target = new DatabaseSync(join(primary, "state_5.sqlite"), { readOnly: true });
    const row = target.prepare("SELECT rollout_path FROM threads WHERE id=?").get(THREAD) as { rollout_path: string };
    expect(row.rollout_path).toContain("/.codex/sessions/");
    expect(readFileSync(row.rollout_path, "utf8")).toContain("session_meta");
    target.close();
  });

  it("never routes resume through a legacy remote app-server", () => {
    const home = mkdtempSync(join(tmpdir(), "rooms-codex-native-resume-"));
    expect(providerLaunchCommand("codex", ["resume", THREAD, "--yolo"], THREAD, home)).toEqual([
      "codex", "resume", THREAD, "--yolo",
    ]);
  });
});

function createThreadDatabase(path: string): DatabaseSync {
  mkdirSync(join(path, ".."), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER)");
  return database;
}

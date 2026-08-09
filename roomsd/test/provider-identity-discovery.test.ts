import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProviderThreadId } from "../src/runtime/service.js";

describe("provider-native identity discovery", () => {
  it("captures Claude's native session id from the newly-created transcript", async () => {
    const home = mkdtempSync(join(tmpdir(), "rooms-provider-id-"));
    const cwd = "/Users/test/project";
    const project = cwd.replace(/[^A-Za-z0-9_-]/g, value => value === "/" ? "-" : `-${value.charCodeAt(0).toString(16)}-`);
    const transcript = join(home, ".claude", "projects", project, "native-thread.jsonl");
    mkdirSync(join(home, ".claude", "projects", project), { recursive: true });
    writeFileSync(transcript, JSON.stringify({ type: "mode", sessionId: "claude-native-thread-1" }) + "\n");
    expect(await discoverProviderThreadId("claude", cwd, Date.now() - 1000, home)).toBe("claude-native-thread-1");
  });

  it("does not infer an identity for unsupported providers", async () => {
    expect(await discoverProviderThreadId("grok", "/tmp/project", 0, "/tmp")).toBeNull();
  });
});

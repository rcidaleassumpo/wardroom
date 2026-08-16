import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RoomsApplication } from "../src/domain/application.js";
import { captureProviderReplyScanState } from "../src/runtime/provider-final-reply.js";
import { ProviderReplyBridge } from "../src/runtime/provider-reply-bridge.js";
import { canonicalProviderCwd, discoverProviderThreadId } from "../src/runtime/service.js";
import { RoomsRepository } from "../src/storage/repository.js";
import { RuntimeRepository } from "../src/storage/runtime-repository.js";

function setup(effectiveHome: string | null): Readonly<{
  database: RoomsRepository;
  application: RoomsApplication;
  runtimes: RuntimeRepository;
  runtime: { runtimeId: string; generation: number };
}> {
  const database = new RoomsRepository();
  database.insertSession({ id: "operator", role: "operator", deliveryMode: "log" });
  database.insertSession({ id: "provider", role: "worker", deliveryMode: "runtime" });
  database.insertChannel({ id: "proof", ownerOperatorSessionId: "operator" });
  database.insertMembership("proof", "operator", "operator");
  database.insertMembership("proof", "provider", "worker");
  const runtimes = new RuntimeRepository(database.db);
  const runtime = runtimes.create({
    runtimeId: "runtime-provider",
    homeAuthorityId: "authority",
    sessionId: "provider",
    generation: 1,
    protocolVersion: 1,
    transportKind: "localPty",
    machineId: "machine",
    providerThreadId: "codex-thread-1",
    effectiveHome,
    reconnectSecret: new Uint8Array(32),
  });
  runtimes.bind({
    bindingId: "binding-provider",
    runtimeId: runtime.runtimeId,
    homeAuthorityId: "authority",
    sessionId: "provider",
    generation: runtime.generation,
    channelId: "proof",
    adapterKind: "codex",
    handleRef: "local-test",
  });
  runtimes.markState(runtime.runtimeId, runtime.generation, "running");
  return { database, application: new RoomsApplication(database), runtimes, runtime };
}

function writeCodexTranscript(home: string, providerThreadId: string): string {
  const sessions = join(home, ".codex", "sessions");
  mkdirSync(sessions, { recursive: true });
  const path = join(sessions, "rollout.jsonl");
  writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: { id: providerThreadId, cwd: home } })}\n`);
  return path;
}

describe("runtime effective home", () => {
  it("persists the session generated home on the runtime row", () => {
    const home = mkdtempSync(join(tmpdir(), "rooms-effective-home-"));
    try {
      const { runtimes, runtime } = setup(home);
      expect(runtimes.get(runtime.runtimeId)?.effectiveHome).toBe(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("defaults the runtime home to null for ambient launches", () => {
    const { runtimes } = setup(null);
    const database = new RoomsRepository();
    database.insertSession({ id: "ambient", role: "worker", deliveryMode: "runtime" });
    const ambient = new RuntimeRepository(database.db).create({
      runtimeId: "runtime-ambient",
      homeAuthorityId: "authority",
      sessionId: "ambient",
      generation: 1,
      protocolVersion: 1,
      transportKind: "localPty",
      machineId: "machine",
      reconnectSecret: new Uint8Array(32),
    });
    expect(ambient.effectiveHome).toBeNull();
    expect(runtimes.get("runtime-provider")?.effectiveHome).toBeNull();
  });

  it("returns the home from the active runtime identity used by reply capture", () => {
    const home = mkdtempSync(join(tmpdir(), "rooms-effective-home-identity-"));
    try {
      const { database } = setup(home);
      const identity = database.activeRuntimeIdentityForSession("provider");
      expect(identity).toMatchObject({ provider: "codex", providerThreadId: "codex-thread-1", effectiveHome: home });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("discovers a provider thread id inside the session generated home", async () => {
    const home = mkdtempSync(join(tmpdir(), "rooms-effective-home-discovery-"));
    try {
      const sessions = join(home, ".codex", "sessions");
      mkdirSync(sessions, { recursive: true });
      const cwd = join(home, "project");
      mkdirSync(cwd, { recursive: true });
      writeFileSync(
        join(sessions, "rollout.jsonl"),
        `${JSON.stringify({ type: "session_meta", payload: { id: "codex-generated-home-thread", cwd: canonicalProviderCwd(cwd) } })}\n`,
      );
      expect(await discoverProviderThreadId("codex", cwd, Date.now() - 1000, home)).toBe("codex-generated-home-thread");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("scans final replies from the runtime's generated home, not the ambient one", async () => {
    const home = mkdtempSync(join(tmpdir(), "rooms-effective-home-scan-"));
    try {
      const { database, application } = setup(home);
      const transcript = writeCodexTranscript(home, "codex-thread-1");
      const scanState = captureProviderReplyScanState("codex", "codex-thread-1", home);
      const source = application.commitMessage({
        channelId: "proof",
        senderSessionId: "operator",
        body: "what is the status?",
        target: { kind: "direct", sessionId: "provider", sessionIds: ["provider"] },
        deliveryStatuses: { provider: "delivered" },
      });
      const bridge = new ProviderReplyBridge(database, application);
      bridge.enqueue({
        sourceEventId: (source.event as { id: string }).id,
        sourceCursor: String(source.cursor),
        sourceBody: "what is the status?",
        channelId: "proof",
        sourceSenderSessionId: "operator",
        providerSessionId: "provider",
        runtimeId: "runtime-provider",
        generation: 1,
        adapterKind: "codex",
        providerThreadId: "codex-thread-1",
        scanState,
      });
      appendFileSync(transcript, `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "what is the status?" }] } })}\n`);
      appendFileSync(transcript, `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "All checks passed" } })}\n`);
      await bridge.tick();
      bridge.stop();

      const replies = (database.snapshot("proof").events as Array<Record<string, unknown>>)
        .filter((event) => event.replyToEventId === (source.event as { id: string }).id);
      expect(replies).toMatchObject([{ body: "All checks passed", senderSessionId: "provider" }]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

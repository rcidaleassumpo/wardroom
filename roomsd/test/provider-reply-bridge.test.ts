import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RoomsApplication } from "../src/domain/application.js";
import { captureProviderReplyScanState } from "../src/runtime/provider-final-reply.js";
import { ProviderReplyBridge } from "../src/runtime/provider-reply-bridge.js";
import { RuntimeRepository } from "../src/storage/runtime-repository.js";
import { RoomsRepository } from "../src/storage/repository.js";
import { createNativeComposition } from "../src/runtime/native/composition.js";
import { setupMachineIdentity } from "../src/identity/machine-identity.js";

function setup(): Readonly<{
  database: RoomsRepository;
  application: RoomsApplication;
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
    reconnectSecret: new Uint8Array(32),
  });
  runtimes.markState(runtime.runtimeId, runtime.generation, "running");
  return { database, application: new RoomsApplication(database), runtime };
}

describe("provider reply bridge", () => {
  it("wires a log-client direct send through runtime delivery to one reply", async () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), "rooms-provider-bridge-native-"));
    try {
      setupMachineIdentity(stateDirectory);
      const composition = createNativeComposition(join(stateDirectory, "rooms.sqlite"), undefined, stateDirectory);
      composition.database.insertSession({ id: "operator", role: "operator", deliveryMode: "log" });
      composition.database.insertSession({ id: "provider", role: "worker", deliveryMode: "runtime" });
      composition.database.insertChannel({ id: "proof", ownerOperatorSessionId: "operator" });
      composition.database.insertMembership("proof", "operator", "operator");
      composition.database.insertMembership("proof", "provider", "worker");
      const transcript = join(stateDirectory, "codex.jsonl");
      writeFileSync(transcript, "");
      const runtimes = new RuntimeRepository(composition.database.db);
      const runtime = runtimes.create({
        runtimeId: "runtime-provider",
        homeAuthorityId: "authority",
        sessionId: "provider",
        generation: 1,
        protocolVersion: 1,
        transportKind: "localPty",
        machineId: "machine",
        providerThreadId: transcript,
        reconnectSecret: new Uint8Array(32),
      });
      runtimes.bind({
        bindingId: "binding-provider",
        runtimeId: runtime.runtimeId,
        homeAuthorityId: runtime.homeAuthorityId,
        sessionId: runtime.sessionId,
        generation: runtime.generation,
        channelId: "proof",
        adapterKind: "codex",
        handleRef: "local-test",
      });
      runtimes.markState(runtime.runtimeId, runtime.generation, "running");
      const runtimeService = composition.runtimeService as unknown as { deliverMessage: (...args: unknown[]) => Promise<unknown> };
      const originalDelivery = runtimeService.deliverMessage;
      runtimeService.deliverMessage = async () => ({ ok: true, outcome: "written", bytesWritten: 10 });
      const connection = { authenticatedSessionId: "operator", credentials: new Map([["credential", "operator"]]), onClose: new Set() };
      const sent = await composition.handler.send({
        senderSessionId: "operator",
        channelId: "proof",
        target: { kind: "direct", sessionId: "provider" },
        body: "native question",
        context: { credential: "credential" },
        __connection: connection,
      } as never) as { event: { id: string } };
      appendFileSync(transcript, `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "native question" }] } })}\n`);
      appendFileSync(transcript, `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "Native answer" } })}\n`);

      composition.providerReplyBridge.tick();

      const replies = (composition.database.snapshot("proof").events as Array<Record<string, unknown>>)
        .filter((event) => event.replyToEventId === sent.event.id);
      expect(replies).toMatchObject([{ body: "Native answer", senderSessionId: "provider" }]);

      await composition.handler.send({
        senderSessionId: "operator",
        channelId: "proof",
        target: { kind: "direct", sessionId: "provider" },
        body: "managed launch prompt",
        correlation: { purpose: "sessionLaunchPrompt" },
        context: { credential: "credential" },
        __connection: connection,
      } as never);
      await composition.handler.send({
        senderSessionId: "operator",
        channelId: "proof",
        target: { kind: "broadcast" },
        body: "broadcast",
        context: { credential: "credential" },
        __connection: connection,
      } as never);
      await composition.handler.send({
        senderSessionId: "operator",
        target: { kind: "direct", sessionId: "provider" },
        body: "channel-less direct",
        context: { credential: "credential" },
        __connection: connection,
      } as never);
      const providerConnection = { authenticatedSessionId: "provider", credentials: new Map([["provider-credential", "provider"]]), onClose: new Set() };
      await composition.handler.send({
        senderSessionId: "provider",
        channelId: "proof",
        target: { kind: "direct", sessionId: "operator" },
        body: "runtime sender",
        context: { credential: "provider-credential" },
        __connection: providerConnection,
      } as never);
      expect(composition.database.db.prepare("SELECT COUNT(*) AS count FROM provider_reply_jobs").get())
        .toEqual({ count: 1 });
      runtimeService.deliverMessage = originalDelivery;
      composition.providerReplyBridge.stop();
      composition.database.close();
    } finally {
      rmSync(stateDirectory, { recursive: true, force: true });
    }
  });

  it("publishes a provider final answer once with canonical reply metadata", () => {
    const { database, application, runtime } = setup();
    const directory = mkdtempSync(join(tmpdir(), "rooms-provider-bridge-"));
    const transcript = join(directory, "codex.jsonl");
    writeFileSync(transcript, "");
    const source = application.commitMessage({
      channelId: "proof",
      senderSessionId: "operator",
      body: "what is the status?",
      target: { kind: "direct", sessionId: "provider", sessionIds: ["provider"] },
      deliveryStatuses: { provider: "delivered" },
    });
    const sourceEvent = source.event as { id: string };
    const bridge = new ProviderReplyBridge(database, application);
    bridge.enqueue({
      sourceEventId: sourceEvent.id,
      sourceCursor: source.cursor,
      sourceBody: "what is the status?",
      channelId: "proof",
      sourceSenderSessionId: "operator",
      providerSessionId: "provider",
      runtimeId: runtime.runtimeId,
      generation: runtime.generation,
      adapterKind: "codex",
      providerThreadId: transcript,
      scanState: captureProviderReplyScanState("codex", transcript),
    });
    appendFileSync(transcript, `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "what is the status?" }] } })}\n`);
    appendFileSync(transcript, `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "All done" } })}\n`);

    bridge.tick();
    bridge.tick();

    const events = database.snapshot("proof").events as Array<Record<string, unknown>>;
    const replies = events.filter((event) => event.replyToEventId === sourceEvent.id);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      senderSessionId: "provider",
      body: "All done",
      target: { kind: "direct", sessionId: "operator" },
      correlation: { kind: "providerFinalReply", sourceEventId: sourceEvent.id },
    });
    bridge.stop();
    database.close();
  });

  it("does not duplicate a provider that already replied through Rooms", () => {
    const { database, application, runtime } = setup();
    const directory = mkdtempSync(join(tmpdir(), "rooms-provider-bridge-skip-"));
    const transcript = join(directory, "codex.jsonl");
    writeFileSync(transcript, "");
    const source = application.commitMessage({
      channelId: "proof",
      senderSessionId: "operator",
      body: "answer this",
      target: { kind: "direct", sessionId: "provider", sessionIds: ["provider"] },
    });
    const sourceEvent = source.event as { id: string };
    const bridge = new ProviderReplyBridge(database, application);
    bridge.enqueue({
      sourceEventId: sourceEvent.id,
      sourceCursor: source.cursor,
      sourceBody: "answer this",
      channelId: "proof",
      sourceSenderSessionId: "operator",
      providerSessionId: "provider",
      runtimeId: runtime.runtimeId,
      generation: runtime.generation,
      adapterKind: "codex",
      providerThreadId: transcript,
      scanState: captureProviderReplyScanState("codex", transcript),
    });
    application.commitMessage({
      channelId: "proof",
      senderSessionId: "provider",
      body: "Explicit reply",
      target: { kind: "direct", sessionId: "operator", sessionIds: ["operator"] },
      replyToEventId: sourceEvent.id,
    });
    appendFileSync(transcript, `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "answer this" }] } })}\n`);
    appendFileSync(transcript, `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "Terminal duplicate" } })}\n`);

    bridge.tick();

    const events = database.snapshot("proof").events as Array<Record<string, unknown>>;
    expect(events.filter((event) => event.replyToEventId === sourceEvent.id)).toHaveLength(1);
    expect(events.some((event) => event.body === "Terminal duplicate")).toBe(false);
    bridge.stop();
    database.close();
  });

  it("ends a job when the provider never records the delivered input", () => {
    const { database, application, runtime } = setup();
    const directory = mkdtempSync(join(tmpdir(), "rooms-provider-bridge-dropped-input-"));
    const transcript = join(directory, "codex.jsonl");
    writeFileSync(transcript, "");
    const source = application.commitMessage({
      channelId: "proof",
      senderSessionId: "operator",
      body: "dropped question",
      target: { kind: "direct", sessionId: "provider", sessionIds: ["provider"] },
    });
    const sourceEvent = source.event as { id: string };
    const bridge = new ProviderReplyBridge(database, application);
    bridge.enqueue({
      sourceEventId: sourceEvent.id,
      sourceCursor: source.cursor,
      sourceBody: "dropped question",
      channelId: "proof",
      sourceSenderSessionId: "operator",
      providerSessionId: "provider",
      runtimeId: runtime.runtimeId,
      generation: runtime.generation,
      adapterKind: "codex",
      providerThreadId: transcript,
      scanState: captureProviderReplyScanState("codex", transcript),
    });
    database.db.prepare("UPDATE provider_reply_jobs SET created_at=? WHERE source_event_id=?")
      .run("2026-01-01T00:00:00.000Z", sourceEvent.id);

    bridge.tick();

    expect(database.db.prepare("SELECT state, outcome_reason FROM provider_reply_jobs WHERE source_event_id=?").get(sourceEvent.id))
      .toEqual({ state: "failed", outcome_reason: "provider-input-not-observed" });
    bridge.stop();
    database.close();
  });
});

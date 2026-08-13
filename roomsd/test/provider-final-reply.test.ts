import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureProviderReplyScanState, scanProviderFinalReply } from "../src/runtime/provider-final-reply.js";

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe("provider final reply extraction", () => {
  it("uses Codex task_complete.last_agent_message and ignores tool output", () => {
    const directory = mkdtempSync(join(tmpdir(), "rooms-provider-reply-codex-"));
    const transcript = join(directory, "codex.jsonl");
    writeFileSync(transcript, line({ type: "session_meta", payload: { id: "thread" } }));
    const state = captureProviderReplyScanState("codex", transcript);
    appendFileSync(transcript, line({ type: "response_item", payload: { type: "function_call", arguments: "private tool data" } }));
    expect(scanProviderFinalReply({ adapterKind: "codex", providerThreadId: transcript, state })).toMatchObject({ status: "pending", text: null });
    appendFileSync(transcript, line({ type: "event_msg", timestamp: "2026-08-13T00:00:01Z", payload: { type: "task_complete", last_agent_message: "Codex final" } }));
    expect(scanProviderFinalReply({ adapterKind: "codex", providerThreadId: transcript, state })).toMatchObject({ status: "complete", text: "Codex final" });
  });

  it("waits for the exact delivered input before accepting a later final", () => {
    const directory = mkdtempSync(join(tmpdir(), "rooms-provider-reply-correlation-"));
    const transcript = join(directory, "codex.jsonl");
    writeFileSync(transcript, "");
    const state = captureProviderReplyScanState("codex", transcript);
    appendFileSync(transcript, line({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "Older answer" } }));
    expect(scanProviderFinalReply({ adapterKind: "codex", providerThreadId: transcript, state, expectedInput: "new question" })).toMatchObject({ status: "pending", text: null });
    appendFileSync(transcript, line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "new question" }] } }));
    appendFileSync(transcript, line({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "New answer" } }));
    expect(scanProviderFinalReply({ adapterKind: "codex", providerThreadId: transcript, state, expectedInput: "new question" })).toMatchObject({ status: "complete", text: "New answer" });
  });

  it("fails an explicit completion that has no final answer", () => {
    const directory = mkdtempSync(join(tmpdir(), "rooms-provider-reply-empty-"));
    const transcript = join(directory, "codex.jsonl");
    writeFileSync(transcript, "");
    const state = captureProviderReplyScanState("codex", transcript);
    appendFileSync(transcript, line({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "" } }));
    expect(scanProviderFinalReply({ adapterKind: "codex", providerThreadId: transcript, state }))
      .toMatchObject({ status: "failed", reason: "provider-final-empty" });
  });

  it("uses Claude's last text part only after turn_duration", () => {
    const directory = mkdtempSync(join(tmpdir(), "rooms-provider-reply-claude-"));
    const transcript = join(directory, "claude.jsonl");
    writeFileSync(transcript, "");
    const state = captureProviderReplyScanState("claude", transcript);
    appendFileSync(transcript, line({ type: "assistant", message: { content: [{ type: "thinking", thinking: "private" }, { type: "tool_use", name: "Read" }] } }));
    appendFileSync(transcript, line({ type: "assistant", message: { content: [{ type: "text", text: "Claude final" }], stop_reason: "end_turn" } }));
    expect(scanProviderFinalReply({ adapterKind: "claude", providerThreadId: transcript, state })).toMatchObject({ status: "pending", text: null });
    appendFileSync(transcript, line({ type: "system", subtype: "turn_duration", timestamp: "2026-08-13T00:00:02Z" }));
    expect(scanProviderFinalReply({ adapterKind: "claude", providerThreadId: transcript, state })).toMatchObject({ status: "complete", text: "Claude final" });
  });

  it("joins Grok chat history to its turn-ended lifecycle", () => {
    const directory = mkdtempSync(join(tmpdir(), "rooms-provider-reply-grok-"));
    const lifecycle = join(directory, "events.jsonl");
    const history = join(directory, "chat_history.jsonl");
    writeFileSync(lifecycle, "");
    writeFileSync(history, "");
    const state = captureProviderReplyScanState("grok", lifecycle);
    appendFileSync(history, line({ type: "assistant", content: "commentary", tool_calls: [{ name: "shell" }] }));
    appendFileSync(history, line({ type: "assistant", content: "Grok final" }));
    expect(scanProviderFinalReply({ adapterKind: "grok", providerThreadId: lifecycle, state })).toMatchObject({ status: "pending", text: null });
    appendFileSync(lifecycle, line({ type: "turn_ended", outcome: "completed", ts: "2026-08-13T00:00:03Z" }));
    expect(scanProviderFinalReply({ adapterKind: "grok", providerThreadId: lifecycle, state })).toMatchObject({ status: "complete", text: "Grok final" });
  });

  it("ends a Grok reply job when the provider turn errors", () => {
    const directory = mkdtempSync(join(tmpdir(), "rooms-provider-reply-grok-error-"));
    const lifecycle = join(directory, "events.jsonl");
    const history = join(directory, "chat_history.jsonl");
    writeFileSync(lifecycle, "");
    writeFileSync(history, "");
    const state = captureProviderReplyScanState("grok", lifecycle);
    appendFileSync(history, line({ type: "user", prompt_index: 1, content: [{ type: "text", text: "proof question" }] }));
    appendFileSync(lifecycle, line({ type: "turn_ended", outcome: "error", ts: "2026-08-13T00:00:03Z" }));
    expect(scanProviderFinalReply({ adapterKind: "grok", providerThreadId: lifecycle, state, expectedInput: "proof question" }))
      .toMatchObject({ status: "failed", reason: "provider-turn-error" });
  });

  it("uses AGY's completed model response and ignores planner tool calls", () => {
    const directory = mkdtempSync(join(tmpdir(), "rooms-provider-reply-agy-"));
    const transcript = join(directory, "transcript.jsonl");
    writeFileSync(transcript, "");
    const state = captureProviderReplyScanState("agy", transcript);
    appendFileSync(transcript, line({ type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", tool_calls: [{ name: "run_command" }] }));
    expect(scanProviderFinalReply({ adapterKind: "agy", providerThreadId: transcript, state })).toMatchObject({ status: "pending", text: null });
    appendFileSync(transcript, line({ type: "RUN_COMMAND", source: "MODEL", status: "DONE", content: "private command output" }));
    appendFileSync(transcript, line({ type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", content: "Gemini final", created_at: "2026-08-13T00:00:04Z" }));
    expect(scanProviderFinalReply({ adapterKind: "agy", providerThreadId: transcript, state })).toMatchObject({ status: "complete", text: "Gemini final" });
  });

  it("resolves an AGY conversation by its exact brain id", () => {
    const home = mkdtempSync(join(tmpdir(), "rooms-provider-reply-agy-home-"));
    const thread = "agy-thread";
    const logs = join(home, ".gemini", "antigravity-cli", "brain", thread, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    const transcript = join(logs, "transcript.jsonl");
    writeFileSync(transcript, "");
    const state = captureProviderReplyScanState("agy", thread, home);
    appendFileSync(transcript, line({ type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", content: "Bound Gemini final" }));
    expect(scanProviderFinalReply({ adapterKind: "agy", providerThreadId: thread, state, homeDirectory: home })).toMatchObject({ status: "complete", text: "Bound Gemini final" });
  });

  it("uses Google Gemini CLI's final response and ignores tool-call records", () => {
    const home = mkdtempSync(join(tmpdir(), "rooms-provider-reply-gemini-home-"));
    const thread = "gemini-thread";
    const chats = join(home, ".gemini", "tmp", "project", "chats");
    mkdirSync(chats, { recursive: true });
    const transcript = join(chats, "session-proof.jsonl");
    writeFileSync(transcript, line({ sessionId: thread, projectHash: "hash" }));
    const state = captureProviderReplyScanState("gemini", thread, home);
    appendFileSync(transcript, line({ $push: { messages: { type: "user", content: [{ text: "exact question" }] } } }));
    appendFileSync(transcript, line({ $push: { messages: { type: "gemini", content: "intermediate", toolCalls: [{ name: "read_file" }] } } }));
    expect(scanProviderFinalReply({ adapterKind: "gemini", providerThreadId: thread, state, expectedInput: "exact question", homeDirectory: home }))
      .toMatchObject({ status: "pending", text: null });
    appendFileSync(transcript, line({ $push: { messages: { type: "gemini", content: [{ text: "Google Gemini final" }], toolCalls: [] } } }));
    expect(scanProviderFinalReply({ adapterKind: "gemini", providerThreadId: thread, state, expectedInput: "exact question", homeDirectory: home }))
      .toMatchObject({ status: "complete", text: "Google Gemini final" });
  });

  it("ends a Google Gemini reply job when the provider records an error", () => {
    const directory = mkdtempSync(join(tmpdir(), "rooms-provider-reply-gemini-error-"));
    const transcript = join(directory, "gemini.jsonl");
    writeFileSync(transcript, "");
    const state = captureProviderReplyScanState("gemini", transcript);
    appendFileSync(transcript, line({ $push: { messages: { type: "user", content: [{ text: "exact question" }] } } }));
    appendFileSync(transcript, line({ $push: { messages: { type: "error", content: "API failed" } } }));
    expect(scanProviderFinalReply({ adapterKind: "gemini", providerThreadId: transcript, state, expectedInput: "exact question" }))
      .toMatchObject({ status: "failed", reason: "provider-turn-error" });
  });
});

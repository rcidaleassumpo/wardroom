// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { prepareManagedProviderLaunch } from "../src/runtime/provider-managed-launch.js";

describe("managed provider launch", () => {
  it("preloads Gemini's first prompt under a Rooms-owned native session id", () => {
    expect(prepareManagedProviderLaunch({
      adapterKind: "gemini",
      arguments: ["--approval-mode", "yolo"],
      prompt: "Rooms launch prompt",
      createThreadId: () => "gemini-thread-id",
    })).toEqual({
      arguments: ["--approval-mode", "yolo", "--session-id", "gemini-thread-id", "--prompt-interactive", "Rooms launch prompt"],
      providerThreadId: "gemini-thread-id",
      promptPreloaded: true,
    });
  });

  it("preloads Codex's first prompt through its positional prompt argument", () => {
    expect(prepareManagedProviderLaunch({ adapterKind: "codex", arguments: ["--yolo"], prompt: "prompt" }))
      .toEqual({ arguments: ["--yolo", "prompt"], providerThreadId: null, promptPreloaded: true });
  });

  it("keeps providers without a managed prompt argument on the PTY delivery path", () => {
    expect(prepareManagedProviderLaunch({ adapterKind: "claude", arguments: ["--dangerously-skip-permissions"], prompt: "prompt" }))
      .toEqual({ arguments: ["--dangerously-skip-permissions"], providerThreadId: null, promptPreloaded: false });
  });

  it("rejects caller-owned Gemini identity and initial-prompt flags", () => {
    expect(() => prepareManagedProviderLaunch({ adapterKind: "gemini", arguments: ["--session-id", "caller"], prompt: "prompt" }))
      .toThrow(/Rooms owns Gemini/);
    expect(() => prepareManagedProviderLaunch({ adapterKind: "gemini", arguments: ["-i", "caller"], prompt: "prompt" }))
      .toThrow(/Rooms owns Gemini/);
  });
});

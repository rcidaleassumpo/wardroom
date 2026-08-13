import { describe, expect, it } from "vitest";
import { ROOM_PROVIDERS } from "../src/cli/provider-registry.js";
import {
  formatProviderCapabilityMatrixMarkdown,
  providerCapabilityMatrix,
  providerCapabilityRow,
} from "../src/providers/capability-matrix.js";

describe("provider capability matrix", () => {
  it("covers every registered Rooms provider exactly once", () => {
    const rows = providerCapabilityMatrix();
    expect(rows.map((row) => row.provider).sort()).toEqual([...ROOM_PROVIDERS].sort());
    expect(new Set(rows.map((row) => row.provider)).size).toBe(ROOM_PROVIDERS.length);
  });

  it("publishes the normative runtime, driver, and MCP paths", () => {
    expect(providerCapabilityMatrix()).toEqual([
      {
        provider: "codex",
        runtime: true,
        providerDriver: true,
        mcpToolCall: true,
        details: {
          sessionLaunch: true,
          nativeThreadDiscovery: true,
          conversationResume: true,
          runtimeCommandResume: true,
          roomsSkillInstall: true,
        },
      },
      {
        provider: "claude",
        runtime: true,
        providerDriver: true,
        mcpToolCall: true,
        details: {
          sessionLaunch: true,
          nativeThreadDiscovery: true,
          conversationResume: true,
          runtimeCommandResume: true,
          roomsSkillInstall: true,
        },
      },
      {
        provider: "grok",
        runtime: true,
        providerDriver: true,
        mcpToolCall: true,
        details: {
          sessionLaunch: true,
          nativeThreadDiscovery: true,
          conversationResume: false,
          runtimeCommandResume: false,
          roomsSkillInstall: true,
        },
      },
      {
        provider: "gemini",
        runtime: true,
        providerDriver: true,
        mcpToolCall: true,
        details: {
          sessionLaunch: true,
          nativeThreadDiscovery: true,
          conversationResume: false,
          runtimeCommandResume: false,
          roomsSkillInstall: true,
        },
      },
    ]);
  });

  it("derives the three public paths from detail flags", () => {
    for (const row of providerCapabilityMatrix()) {
      expect(row.runtime).toBe(row.details.sessionLaunch);
      expect(row.providerDriver).toBe(row.details.sessionLaunch);
      expect(row.mcpToolCall).toBe(row.details.roomsSkillInstall);
    }
  });

  it("exposes a stable row lookup for documentation tooling", () => {
    expect(providerCapabilityRow("grok").details.conversationResume).toBe(false);
    expect(providerCapabilityRow("codex").details.conversationResume).toBe(true);
  });

  it("formats a markdown table for PROTOCOL publication", () => {
    const markdown = formatProviderCapabilityMatrixMarkdown();
    expect(markdown).toContain("| Provider | Runtime | Provider driver | MCP / tool skill |");
    expect(markdown).toContain("| codex | yes | yes | yes |");
    expect(markdown).toContain("| claude | yes | yes | yes |");
    expect(markdown).toContain("| grok | yes | yes | yes |");
    expect(markdown).toContain("| gemini | yes | yes | yes |");
  });
});

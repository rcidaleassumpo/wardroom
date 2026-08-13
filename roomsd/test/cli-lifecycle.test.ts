import { describe, expect, it } from "vitest";
import { executeLifecycleCLI, runLifecycleCLI } from "../src/cli/lifecycle.js";
import { nextResumeGeneration, resolveResumeGeneration } from "../src/cli/default-backend.js";

describe("lifecycle CLI", () => {
  it("resumes after the newest suspended runtime generation", () => {
    expect(nextResumeGeneration(0, 1)).toBe(2);
    expect(nextResumeGeneration(4, 2)).toBe(5);
  });

  it("reuses an incomplete resume generation instead of minting a new claim key", () => {
    expect(resolveResumeGeneration({ state: "resuming", generation: 3 }, 2)).toBe(3);
    expect(resolveResumeGeneration({ state: "suspended", generation: 3 }, 2)).toBe(4);
    expect(resolveResumeGeneration({ state: "active", generation: 0 }, 1)).toBe(2);
  });

  it("returns machine-readable resume status", async () => {
    const output = await runLifecycleCLI(["resume", "channel-id", "resume-1", "3"], {
      suspend: async () => ({}), resume: async () => [{ priorSessionId: "old", sessionId: "new", runtimeId: "runtime", generation: 3, outcome: "resumed" }], status: async () => ({ state: "active" }),
    });
    expect(JSON.parse(output)).toEqual({ channelId: "channel-id", command: "resume", result: [{ priorSessionId: "old", sessionId: "new", runtimeId: "runtime", generation: 3, outcome: "resumed" }] });
  });

  it("fails closed when resume identity or generation is omitted", async () => {
    const lifecycle = { suspend: async () => ({}), resume: async () => [], status: async () => ({ state: "active" }) };
    await expect(runLifecycleCLI(["resume", "channel-id"], lifecycle)).rejects.toThrow("idempotency-key and generation");
    await expect(runLifecycleCLI(["resume", "channel-id", "resume-1"], lifecycle)).rejects.toThrow("idempotency-key and generation");
  });

  it("composes an executable CLI call through a lifecycle factory", async () => {
    let created = 0;
    const output = await executeLifecycleCLI(["status", "channel-id"], () => { created++; return { suspend: async () => ({}), resume: async () => [], status: async () => ({ state: "active" }) }; });
    expect(created).toBe(1);
    expect(JSON.parse(output)).toEqual({ channelId: "channel-id", command: "status", result: { state: "active" } });
  });
});

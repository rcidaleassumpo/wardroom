import { describe, expect, it } from "vitest";
import { composeSessionLaunchPrompt } from "../src/runtime/native/composition.js";

describe("controlled Codex profile launch prompt", () => {
  it("keeps a low-reasoning worker task unchanged on the first turn", () => {
    const task = "Task 0e903a. Scope: fix Rooms profile delivery only.";

    expect(composeSessionLaunchPrompt("low-reasoning-worker", task, true)).toBe(task);
  });

  it("keeps the Rooms identity outside an ambient launch caller task", () => {
    expect(composeSessionLaunchPrompt("worker", "Do the task.", false))
      .toBe("You are a Rooms session worker.\n\nDo the task.");
  });
});

import { describe, expect, it } from "vitest";
import { runRoomsProvider } from "../src/cli/provider-run.js";

describe("Rooms provider runner", () => {
  it("requires a Rooms identity unless native mode is explicit", async () => {
    const previous = process.env.ROOMS_SESSION_ID;
    delete process.env.ROOMS_SESSION_ID;
    await expect(runRoomsProvider("codex", [])).rejects.toThrow("no Rooms session is active");
    if (previous === undefined) delete process.env.ROOMS_SESSION_ID;
    else process.env.ROOMS_SESSION_ID = previous;
  });
});

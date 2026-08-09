import { describe, expect, it } from "vitest";
import { roomsPaths, defaultStateDir } from "../src/provisioning/paths.js";

describe("Rooms test state isolation", () => {
  it("points the suite at a temporary state dir, never the live one", () => {
    expect(process.env.ROOMS_STATE_DIR).toBeTruthy();
    expect(roomsPaths().stateDir).not.toBe(defaultStateDir());
    expect(roomsPaths().storePath).not.toContain(defaultStateDir());
  });

  it("refuses the live default state dir when a test forgets isolation", () => {
    // Without this guard the suite silently read hundreds of real channels.
    const saved = process.env.ROOMS_STATE_DIR;
    delete process.env.ROOMS_STATE_DIR;
    try {
      expect(() => roomsPaths()).toThrow(/refusing to resolve the default Rooms state directory/);
    } finally {
      if (saved !== undefined) process.env.ROOMS_STATE_DIR = saved;
    }
  });

  it("still honors an explicit state dir argument while the guard is active", () => {
    expect(roomsPaths("/tmp/rooms-explicit").stateDir).toBe("/tmp/rooms-explicit");
  });
});

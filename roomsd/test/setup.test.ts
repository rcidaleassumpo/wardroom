import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRoomsSetup } from "../src/cli/setup.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Rooms setup", () => {
  it("bootstraps one stable local operator for first-run channel creation", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-setup-"));
    directories.push(stateDir);

    const created = runRoomsSetup("setup", stateDir);
    const repeated = runRoomsSetup("setup", stateDir);
    const status = runRoomsSetup("status", stateDir);

    expect(created.operatorSessionId).toBe("operator");
    expect(repeated.operatorSessionId).toBe("operator");
    expect(status.operatorSessionId).toBe("operator");
    expect(status.storePath).toBe(join(stateDir, "rooms.sqlite"));
  });
});

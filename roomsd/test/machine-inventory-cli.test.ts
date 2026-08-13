import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RoomsCLIBackend } from "../src/cli/backend.js";
import { runRoomsCLI } from "../src/cli/main.js";
import { discoverProviders } from "../src/cli/provider-registry.js";
import { setupMachineIdentity } from "../src/identity/machine-identity.js";

describe("Rooms machine inventory CLI", () => {
  it("lists and inspects the local authority without machine names in source", async () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-machine-inventory-"));
    const stateDir = join(root, "state");
    const bin = join(root, "bin");
    mkdirSync(bin);
    const claude = join(bin, "claude");
    writeFileSync(claude, "#!/bin/sh\n", { mode: 0o700 });
    chmodSync(claude, 0o700);
    const identity = setupMachineIdentity(stateDir);
    discoverProviders(stateDir, { PATH: bin });
    const backend = stubBackend({
      listChannels: async () => ({ channels: [{ id: "active", lifecycleState: "active" }, { id: "closed", lifecycleState: "closed" }] }),
      listSessions: async () => ({ sessions: [{ id: "session-1", endedAt: null }] }),
    });

    const listed = JSON.parse(await runRoomsCLI(["machine", "list", "--state-dir", stateDir], backend));
    expect(listed.machines).toMatchObject([{ authorityId: identity.authorityId, locality: "local", providers: [{ name: "claude" }] }]);
    const inspected = JSON.parse(await runRoomsCLI(["machine", "inspect", identity.authorityId, "--state-dir", stateDir], backend));
    expect(inspected).toMatchObject({ authorityId: identity.authorityId, locality: "local", providers: [{ name: "claude" }], channels: [{ id: "active" }], sessions: [{ id: "session-1" }] });

    const located = JSON.parse(await runRoomsCLI(["session", "locate", "session-1", "--state-dir", stateDir], backend));
    expect(located).toMatchObject({
      query: "session-1",
      matches: [{ authorityId: identity.authorityId, locality: "local", sessionId: "session-1", target: "session-1", session: { id: "session-1" } }],
      unreachableMachines: [],
    });
  });
});

function stubBackend(overrides: Partial<RoomsCLIBackend>): RoomsCLIBackend {
  return {
    createChannel: async () => ({}), listChannels: async () => ({ channels: [] }), channelStatus: async () => ({}),
    suspendChannel: async () => ({}), resumeChannel: async () => ({}), createSession: async () => ({}),
    commitMessage: async () => ({}), sendPrompt: async () => ({}), ...overrides,
  };
}

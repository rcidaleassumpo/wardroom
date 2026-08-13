import { describe, expect, it } from "vitest";
import { createConnection } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupMachineIdentity } from "../src/identity/machine-identity.js";
import { neutralRelayApplicationHandler } from "../src/federation/relay-connection.js";
import {
  bindLocalRelayServer,
  createRelayAdmission,
  MAX_AUTHENTICATED_SESSIONS_PER_PEER,
  MAX_HANDSHAKING_SESSIONS,
} from "../src/federation/relay-local-server.js";

function connect(path: string): Promise<{ closed: Promise<void>; destroy: () => void }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const closed = new Promise<void>((done) => socket.once("close", () => done()));
    socket.once("error", reject);
    socket.once("connect", () => resolve({ closed, destroy: () => socket.destroy() }));
  });
}

describe("relay admission accounting", () => {
  it("bounds sessions still in the handshake", () => {
    const admission = createRelayAdmission({ maxHandshaking: 2 });
    expect(admission.admitHandshake()).toBe(true);
    expect(admission.admitHandshake()).toBe(true);
    expect(admission.admitHandshake()).toBe(false);
    expect(admission.counts().handshaking).toBe(2);

    admission.releaseHandshake();
    expect(admission.admitHandshake()).toBe(true);
  });

  it("allows one authenticated session per peer and frees it on release", () => {
    const admission = createRelayAdmission();
    expect(admission.admitPeer("authority-a")).toBe(true);
    expect(admission.admitPeer("authority-a")).toBe(false);
    // A different peer is unaffected by the first peer's session.
    expect(admission.admitPeer("authority-b")).toBe(true);
    expect(admission.counts().authenticated).toEqual({ "authority-a": 1, "authority-b": 1 });

    admission.releasePeer("authority-a");
    expect(admission.counts().authenticated).toEqual({ "authority-b": 1 });
    expect(admission.admitPeer("authority-a")).toBe(true);
  });

  it("never lets a release drive a count negative", () => {
    const admission = createRelayAdmission();
    admission.releaseHandshake();
    admission.releasePeer("authority-unknown");
    expect(admission.counts()).toEqual({ handshaking: 0, authenticated: {} });
  });

  it("keeps the documented defaults that mirror the outbound one-per-peer policy", () => {
    expect(MAX_AUTHENTICATED_SESSIONS_PER_PEER).toBe(1);
    expect(MAX_HANDSHAKING_SESSIONS).toBeGreaterThan(1);
  });
});

describe("relay server handshake bound", () => {
  it("closes a connection accepted beyond the handshake bound", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rooms-relay-admission-"));
    setupMachineIdentity(stateDir);
    const endpoint = join(stateDir, "federation-relay.sock");
    const server = await bindLocalRelayServer(
      endpoint,
      stateDir,
      () => neutralRelayApplicationHandler,
      createRelayAdmission({ maxHandshaking: 1 }),
    );
    try {
      // Neither peer authenticates, so both stay in the handshake bucket and the
      // second connection must be refused rather than queued.
      const first = await connect(endpoint);
      const second = await connect(endpoint);
      await expect(second.closed).resolves.toBeUndefined();
      first.destroy();
      await first.closed;
    } finally {
      await server.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

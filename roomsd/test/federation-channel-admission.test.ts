import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRoomsFederationChannelCommand } from "../src/cli/federation.js";
import type { AuthorityId } from "../src/federation/contracts.js";
import { advancePeerTrustFromEnrollmentProof } from "../src/federation/peer-trust.js";
import { loadMachineSigningKeys, setupMachineIdentity } from "../src/identity/machine-identity.js";
import { RoomsRepository } from "../src/storage/repository.js";
import { SUPPORTED_SCHEMA_VERSION } from "../src/storage/migrations.js";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function identity(label: string) {
  const stateDir = mkdtempSync(join(tmpdir(), `rooms-channel-admission-${label}-`));
  temporary.push(stateDir);
  const status = setupMachineIdentity(stateDir);
  return { stateDir, authorityId: status.authorityId as AuthorityId, keys: loadMachineSigningKeys(stateDir) };
}

function flags(values: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(values));
}

describe("federated channel admission CLI", () => {
  it("rejects unverifiable structured replies on federated direct sends", async () => {
    await expect(runRoomsFederationChannelCommand("direct-send", flags({ "reply-to": "event_parent" })))
      .rejects.toThrow("parent event belongs to another Rooms authority");
  });

  it("upgrades a schema-13 store without losing channel ownership", () => {
    const home = identity("upgrade");
    const storePath = join(home.stateDir, "rooms.sqlite");
    const old = new RoomsRepository(storePath);
    old.insertSession({ id: "owner", role: "operator" });
    old.insertChannel({ id: "channel-a", ownerOperatorSessionId: "owner" });
    old.db.exec("DROP INDEX federation_channel_admissions_peer_active; DROP TABLE federation_channel_admissions; ALTER TABLE sessions DROP COLUMN delivery_mode; PRAGMA user_version=13;");
    old.close();

    const upgraded = new RoomsRepository(storePath);
    expect(upgraded.userVersion()).toBe(SUPPORTED_SCHEMA_VERSION);
    expect(upgraded.currentChannel("channel-a")).toMatchObject({ ownerOperatorSessionId: "owner" });
    expect(upgraded.grantFederatedChannelAdmission("channel-a", "authority-peer", "owner")).toMatchObject({ revokedAt: null });
    upgraded.close();
  });

  it("lets only the channel owner admit, inspect, and revoke an active enrolled peer", async () => {
    const home = identity("home");
    const peer = identity("peer");
    const repository = new RoomsRepository(join(home.stateDir, "rooms.sqlite"));
    repository.insertSession({ id: "owner", role: "operator" });
    repository.insertSession({ id: "other-operator", role: "operator" });
    repository.insertChannel({ id: "channel-a", ownerOperatorSessionId: "owner" });
    repository.close();
    advancePeerTrustFromEnrollmentProof({
      stateDir: home.stateDir,
      authorityId: peer.authorityId,
      publicKeyPem: peer.keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      transportPolicy: { kind: "loopbackSsh", peerAuthorityId: peer.authorityId, sshDestination: "peer-host", sshUser: "operator", localEndpoint: "127.0.0.1", localPort: 1 },
      toState: "active",
    });
    const ownerFlags = flags({ "state-dir": home.stateDir, credential: "owner", channel: "channel-a", "peer-authority-id": peer.authorityId });

    await expect(runRoomsFederationChannelCommand("admit", flags({ ...Object.fromEntries(ownerFlags), credential: "other-operator" })))
      .rejects.toThrow("does not own channel-a");
    await expect(runRoomsFederationChannelCommand("admit", ownerFlags)).resolves.toMatchObject({ admission: { channelId: "channel-a", peerAuthorityId: peer.authorityId, grantedBySessionId: "owner", revokedAt: null } });
    await expect(runRoomsFederationChannelCommand("admit", ownerFlags)).resolves.toMatchObject({ admission: { revokedAt: null } });
    await expect(runRoomsFederationChannelCommand("admissions", flags({ "state-dir": home.stateDir, credential: "owner", channel: "channel-a" }))).resolves.toMatchObject({
      channelId: "channel-a", admissions: [{ peerAuthorityId: peer.authorityId, revokedAt: null }],
    });
    await expect(runRoomsFederationChannelCommand("revoke-admission", ownerFlags)).resolves.toMatchObject({ admission: { revokedBySessionId: "owner", revokedAt: expect.any(String) } });

    const reopened = new RoomsRepository(join(home.stateDir, "rooms.sqlite"), { schemaPolicy: "require-current" });
    expect(reopened.isFederatedPeerAdmitted("channel-a", peer.authorityId)).toBe(false);
    reopened.close();
  });

  it("refuses to admit a peer that has not completed enrollment", async () => {
    const home = identity("home");
    const peer = identity("peer");
    const repository = new RoomsRepository(join(home.stateDir, "rooms.sqlite"));
    repository.insertSession({ id: "owner", role: "operator" });
    repository.insertChannel({ id: "channel-a", ownerOperatorSessionId: "owner" });
    repository.close();

    await expect(runRoomsFederationChannelCommand("admit", flags({ "state-dir": home.stateDir, credential: "owner", channel: "channel-a", "peer-authority-id": peer.authorityId })))
      .rejects.toThrow("requires an active enrolled peer");
  });
});

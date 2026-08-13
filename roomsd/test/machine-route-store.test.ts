import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readMachineRoute, removeMachineRoute, upsertMachineRoute } from "../src/federation/machine-route-store.js";
import { setupMachineIdentity } from "../src/identity/machine-identity.js";
import { advancePeerTrustFromEnrollmentProof } from "../src/federation/peer-trust.js";
import type { AuthorityId } from "../src/federation/contracts.js";

describe("per-machine federation routes", () => {
  it("stores local dialing configuration separately from signed peer trust", () => {
    const stateDir = join(mkdtempSync(join(tmpdir(), "rooms-machine-route-")), "state");
    setupMachineIdentity(stateDir);
    const keys = generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const fingerprint = createHash("sha256").update(keys.publicKey.export({ type: "spki", format: "der" })).digest("hex");
    const authorityId = `authority-${fingerprint}` as AuthorityId;
    advancePeerTrustFromEnrollmentProof({
      stateDir, authorityId, publicKeyPem, toState: "active",
      transportPolicy: { kind: "loopbackSsh", peerAuthorityId: authorityId, sshDestination: "bootstrap-host", sshUser: "operator", localEndpoint: "127.0.0.1", localPort: 1 },
    });

    const route = upsertMachineRoute({ stateDir, authorityId, sshHost: "host-a" });
    expect(route).toMatchObject({ authorityId, sshHost: "host-a", remoteStateDir: null });
    expect(readMachineRoute(authorityId, stateDir)).toEqual(route);
    expect(removeMachineRoute(authorityId, stateDir)).toEqual({ removed: true, authorityId });
    expect(readMachineRoute(authorityId, stateDir)).toBeUndefined();
  });
});

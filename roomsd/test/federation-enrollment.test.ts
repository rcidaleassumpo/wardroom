import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadMachineSigningKeys, setupMachineIdentity } from "../src/identity/machine-identity.js";
import {
  createEnrollmentAccept,
  createEnrollmentChallenge,
  createEnrollmentConfirm,
  createEnrollmentOffer,
  finalizeEnrollment,
} from "../src/federation/enrollment.js";
import { advancePeerTrustFromEnrollmentProof, listPeerTrust, readPeerTrust, revokePeerTrust } from "../src/federation/peer-trust.js";
import type { AuthorityId, FederationTransportPolicy } from "../src/federation/contracts.js";

const temporary: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function identity(label: string) {
  const stateDir = mkdtempSync(join(tmpdir(), `rooms-enrollment-${label}-`));
  temporary.push(stateDir);
  const status = setupMachineIdentity(stateDir);
  return { stateDir, authorityId: status.authorityId as AuthorityId, keys: loadMachineSigningKeys(stateDir) };
}

function policy(peerAuthorityId: AuthorityId, label: string): FederationTransportPolicy {
  return { kind: "loopbackSsh", peerAuthorityId, sshDestination: `${label}-host`, sshUser: "operator", localEndpoint: "127.0.0.1", localPort: 1 };
}

function enroll(origin = identity("origin"), destination = identity("destination")) {
  const offer = createEnrollmentOffer({ stateDir: origin.stateDir, peerAuthorityId: destination.authorityId, transportPolicy: policy(destination.authorityId, "destination") });
  const challenge = createEnrollmentChallenge({ stateDir: destination.stateDir, offerRaw: JSON.stringify(offer), transportPolicy: policy(origin.authorityId, "origin") });
  const accept = createEnrollmentAccept({ stateDir: origin.stateDir, challengeRaw: JSON.stringify(challenge.artifact) });
  const confirm = createEnrollmentConfirm({ stateDir: destination.stateDir, acceptRaw: JSON.stringify(accept.artifact) });
  const finalized = finalizeEnrollment({ stateDir: origin.stateDir, confirmRaw: JSON.stringify(confirm.artifact) });
  return { origin, destination, offer, challenge, accept, confirm, finalized };
}

describe("federation enrollment stage machine", () => {
  it("advances only signed matching stages and activates both peer pins", () => {
    const origin = identity("origin");
    const destination = identity("destination");
    const offer = createEnrollmentOffer({ stateDir: origin.stateDir, peerAuthorityId: destination.authorityId, transportPolicy: policy(destination.authorityId, "destination") });
    expect(listPeerTrust(origin.stateDir)).toEqual([]);

    const challenge = createEnrollmentChallenge({ stateDir: destination.stateDir, offerRaw: JSON.stringify(offer), transportPolicy: policy(origin.authorityId, "origin") });
    expect(challenge.peer.state).toBe("confirming");
    expect(() => createEnrollmentChallenge({ stateDir: destination.stateDir, offerRaw: JSON.stringify(offer), transportPolicy: policy(origin.authorityId, "origin") })).toThrow("replay");

    const accept = createEnrollmentAccept({ stateDir: origin.stateDir, challengeRaw: JSON.stringify(challenge.artifact) });
    expect(accept.peer.state).toBe("confirming");
    expect(() => createEnrollmentAccept({ stateDir: origin.stateDir, challengeRaw: JSON.stringify(challenge.artifact) })).toThrow("replay");

    const confirm = createEnrollmentConfirm({ stateDir: destination.stateDir, acceptRaw: JSON.stringify(accept.artifact) });
    expect(confirm.peer.state).toBe("active");
    expect(() => createEnrollmentConfirm({ stateDir: destination.stateDir, acceptRaw: JSON.stringify(accept.artifact) })).toThrow("replay");

    const finalized = finalizeEnrollment({ stateDir: origin.stateDir, confirmRaw: JSON.stringify(confirm.artifact) });
    expect(finalized.peer.state).toBe("active");
    expect(readPeerTrust(origin.authorityId, destination.stateDir)?.state).toBe("active");
    expect(readPeerTrust(destination.authorityId, origin.stateDir)?.state).toBe("active");
    expect(() => finalizeEnrollment({ stateDir: origin.stateDir, confirmRaw: JSON.stringify(confirm.artifact) })).toThrow("replay");
  });

  it("rejects a forged signature and a valid offer delivered to the wrong authority before trust changes", () => {
    const origin = identity("origin");
    const destination = identity("destination");
    const wrongDestination = identity("wrong-destination");
    const offer = createEnrollmentOffer({ stateDir: origin.stateDir, peerAuthorityId: destination.authorityId, transportPolicy: policy(destination.authorityId, "destination") });
    const forged = { ...offer, signature: `${offer.signature[0] === "A" ? "B" : "A"}${offer.signature.slice(1)}` };

    expect(() => createEnrollmentChallenge({ stateDir: destination.stateDir, offerRaw: JSON.stringify(forged), transportPolicy: policy(origin.authorityId, "origin") })).toThrow("signature is invalid");
    expect(listPeerTrust(destination.stateDir)).toEqual([]);
    expect(() => createEnrollmentChallenge({ stateDir: wrongDestination.stateDir, offerRaw: JSON.stringify(offer), transportPolicy: policy(origin.authorityId, "origin") })).toThrow("wrong destination");
    expect(listPeerTrust(wrongDestination.stateDir)).toEqual([]);
  });

  it("rejects an expired signed offer without creating responder trust", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T12:00:00.000Z"));
    const origin = identity("origin");
    const destination = identity("destination");
    const offer = createEnrollmentOffer({ stateDir: origin.stateDir, peerAuthorityId: destination.authorityId, transportPolicy: policy(destination.authorityId, "destination"), ttlSeconds: 30 });
    vi.setSystemTime(new Date("2026-08-04T12:00:31.000Z"));

    expect(() => createEnrollmentChallenge({ stateDir: destination.stateDir, offerRaw: JSON.stringify(offer), transportPolicy: policy(origin.authorityId, "origin") })).toThrow("expired");
    expect(listPeerTrust(destination.stateDir)).toEqual([]);
  });

  it("makes revocation terminal after a successful enrollment", () => {
    const { origin, destination } = enroll();
    const revoked = revokePeerTrust({ stateDir: origin.stateDir, authorityId: destination.authorityId, reason: "test revocation" });
    expect(revoked).toMatchObject({ state: "revoked", revokedReason: "test revocation" });
    expect(() => advancePeerTrustFromEnrollmentProof({
      stateDir: origin.stateDir,
      authorityId: destination.authorityId,
      publicKeyPem: destination.keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      transportPolicy: policy(destination.authorityId, "destination"),
      toState: "active",
    })).toThrow("durably revoked");
    expect(readPeerTrust(destination.authorityId, origin.stateDir)?.state).toBe("revoked");
  });
});

import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listFederatedChannelRoutes, upsertFederatedChannelRoute } from "../src/federation/channel-route-store.js";
import { setupMachineIdentity } from "../src/identity/machine-identity.js";
import { advancePeerTrustFromEnrollmentProof } from "../src/federation/peer-trust.js";
import type { AuthorityId } from "../src/federation/contracts.js";

describe("federated channel routes", () => {
  it("starts a new subscription at the home registration cursor and preserves later progress", () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-channel-route-"));
    const stateDir = join(root, "state");
    try {
      setupMachineIdentity(stateDir);
      const keys = generateKeyPairSync("ed25519");
      const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
      const fingerprint = createHash("sha256").update(keys.publicKey.export({ type: "spki", format: "der" })).digest("hex");
      const authorityId = `authority-${fingerprint}` as AuthorityId;
      advancePeerTrustFromEnrollmentProof({
        stateDir, authorityId, publicKeyPem, toState: "active",
        transportPolicy: { kind: "loopbackSsh", peerAuthorityId: authorityId, sshDestination: "bootstrap-host", sshUser: "operator", localEndpoint: "127.0.0.1", localPort: 1 },
      });

      const first = upsertFederatedChannelRoute({ stateDir, homeAuthorityId: authorityId, channelId: "channel-a", localSessionId: "session-a", sshHost: "host-a", cursor: "42" });
      expect(first.cursor).toBe("42");
      const repeated = upsertFederatedChannelRoute({ stateDir, homeAuthorityId: authorityId, channelId: "channel-a", localSessionId: "session-a", sshHost: "host-a", cursor: "99" });
      expect(repeated.cursor).toBe("42");
      expect(listFederatedChannelRoutes(stateDir)).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

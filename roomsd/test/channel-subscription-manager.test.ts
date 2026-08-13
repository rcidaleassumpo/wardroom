import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isRetryableChannelSubscriptionClose, startFederatedChannelSubscriptions } from "../src/federation/channel-subscription-manager.js";
import { setupMachineIdentity } from "../src/identity/machine-identity.js";
import { advancePeerTrustFromEnrollmentProof } from "../src/federation/peer-trust.js";
import { upsertFederatedChannelRoute } from "../src/federation/channel-route-store.js";
import type { AuthorityId } from "../src/federation/contracts.js";
import type { RelayApplicationHandler, RelayConnection } from "../src/federation/relay-connection.js";
import type { RelayChannelFrame } from "../src/federation/relay-protocol.js";
import type { RoomsRuntimeService } from "../src/runtime/service.js";

describe("federated channel subscription reconnect policy", () => {
  it("reconnects a durable route after the remote daemon drains or closes", () => {
    expect(isRetryableChannelSubscriptionClose("peerDrained")).toBe(true);
    expect(isRetryableChannelSubscriptionClose("peerClosed")).toBe(true);
  });

  it("does not reconnect an explicit local close or a trust failure", () => {
    expect(isRetryableChannelSubscriptionClose("gracefulClose")).toBe(false);
    expect(isRetryableChannelSubscriptionClose("peerTrustRevoked")).toBe(false);
    expect(isRetryableChannelSubscriptionClose(null)).toBe(false);
  });

  it("reassembles a remote page and injects an addressed message into the local runtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-channel-subscription-"));
    const stateDir = join(root, "state");
    const local = setupMachineIdentity(stateDir);
    const keys = generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const fingerprint = createHash("sha256").update(keys.publicKey.export({ type: "spki", format: "der" })).digest("hex");
    const peerAuthorityId = `authority-${fingerprint}` as AuthorityId;
    advancePeerTrustFromEnrollmentProof({
      stateDir, authorityId: peerAuthorityId, publicKeyPem, toState: "active",
      transportPolicy: { kind: "loopbackSsh", peerAuthorityId, sshDestination: "bootstrap-host", sshUser: "operator", localEndpoint: "127.0.0.1", localPort: 1 },
    });
    const route = upsertFederatedChannelRoute({ stateDir, homeAuthorityId: peerAuthorityId, channelId: "channel-a", localSessionId: "session-a", sshHost: "host-a" });
    const event = {
      id: "event-a", body: "hello", occurredAt: new Date(Date.parse(route.createdAt) + 1_000).toISOString(),
      deliveredRecipientSessionIds: [`federation:${local.authorityId}:session-a`],
    };
    let resolveDelivery!: (value: unknown) => void;
    const delivered = new Promise(resolve => { resolveDelivery = resolve; });
    const runtimeService = { deliverFederatedMessage: async (value: unknown) => { resolveDelivery(value); } } as unknown as RoomsRuntimeService;

    let manager: ReturnType<typeof startFederatedChannelSubscriptions> | undefined;
    try {
      manager = startFederatedChannelSubscriptions({
        stateDir, runtimeService, pollIntervalMs: 60_000,
        connectionFactory: (_route, handler, onStatusChange) => fakeConnectedRelay(handler, onStatusChange, { cursor: "10", messages: [event], hasMore: false }),
      });
      await expect(delivered).resolves.toMatchObject({ homeAuthorityId: peerAuthorityId, localSessionId: "session-a", messageId: "event-a", body: "hello" });
    } finally {
      await manager?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function fakeConnectedRelay(
  handler: RelayApplicationHandler,
  onStatusChange: (status: ReturnType<RelayConnection["status"]>) => void,
  result: unknown,
): RelayConnection {
  let state: "handshaking" | "connected" | "closed" = "handshaking";
  const status = () => ({ state, connectionId: "00000000-0000-0000-0000-000000000001", role: "initiator", authorityId: null, peerAuthorityId: null, connectedAt: null, lastHeartbeatSentAt: null, lastHeartbeatReceivedAt: null, outgoingSeq: 0, incomingSeq: 0, disconnectReason: null, disconnectMessage: null }) as ReturnType<RelayConnection["status"]>;
  const connection = {
    status,
    start() { state = "connected"; onStatusChange(status()); },
    drain() { state = "closed"; },
    sendChannel(frame: { kind: string; requestId: string }) {
      if (frame.kind !== "channelCommand") return;
      const bytes = Buffer.from(JSON.stringify(result), "utf8");
      const middle = Math.ceil(bytes.length / 2);
      const chunks = [bytes.subarray(0, middle), bytes.subarray(middle)];
      queueMicrotask(async () => {
        for (const [index, chunk] of chunks.entries()) {
          await handler.handleChannel?.({ kind: "channelResult", connectionId: "00000000-0000-0000-0000-000000000001", direction: "responderToInitiator", seq: index + 1, requestId: frame.requestId, ok: true, chunkIndex: index, final: index === chunks.length - 1, payload: chunk.toString("base64") } as RelayChannelFrame, connection as unknown as RelayConnection);
        }
      });
    },
  };
  return connection as unknown as RelayConnection;
}

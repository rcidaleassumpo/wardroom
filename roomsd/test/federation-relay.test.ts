import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMachineSigningKeys, setupMachineIdentity } from "../src/identity/machine-identity.js";
import { advancePeerTrustFromEnrollmentProof, preparePeerTrust, revokePeerTrust } from "../src/federation/peer-trust.js";
import { RelayConnection, type RelayByteDuplex, type RelayDisconnectReason, type RelayTransportCloseInfo } from "../src/federation/relay-connection.js";
import { encodeRelayFrame, parseRelayFrame, type RelayWireFrame } from "../src/federation/relay-protocol.js";
import type { AuthorityId, FederationTransportPolicy } from "../src/federation/contracts.js";

const temporary: string[] = [];
const connections: RelayConnection[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) connection.close("gracefulClose", "test cleanup");
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

class MemoryDuplex implements RelayByteDuplex {
  peer?: MemoryDuplex;
  transform: (line: string) => string = (line) => line;
  writes = 0;
  private onDataCallback: (chunk: Buffer) => void = () => undefined;
  private closeCallback: (info: RelayTransportCloseInfo) => void = () => undefined;

  write(data: string): boolean {
    this.writes += 1;
    const delivered = this.transform(data);
    queueMicrotask(() => this.peer?.onDataCallback(Buffer.from(delivered, "utf8")));
    return true;
  }
  onData(callback: (chunk: Buffer) => void): void { this.onDataCallback = callback; }
  onDrain(_callback: () => void): void { /* Writes never apply backpressure in this fixture. */ }
  onceClose(callback: (info: RelayTransportCloseInfo) => void): void { this.closeCallback = callback; }
  destroy(): void { /* RelayConnection already records the authoritative close reason. */ }
  externalClose(reason: RelayDisconnectReason = "transportError", message = "test transport closed"): void { this.closeCallback({ reason, message }); }
}

function duplexPair(): [MemoryDuplex, MemoryDuplex] {
  const left = new MemoryDuplex();
  const right = new MemoryDuplex();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

function identity(label: string) {
  const stateDir = mkdtempSync(join(tmpdir(), `rooms-relay-${label}-`));
  temporary.push(stateDir);
  const status = setupMachineIdentity(stateDir);
  return { stateDir, authorityId: status.authorityId as AuthorityId, keys: loadMachineSigningKeys(stateDir) };
}

function policy(peerAuthorityId: AuthorityId, label: string): FederationTransportPolicy {
  return { kind: "loopbackSsh", peerAuthorityId, sshDestination: `${label}-host`, sshUser: "operator", localEndpoint: "127.0.0.1", localPort: 1 };
}

function activate(local: ReturnType<typeof identity>, peer: ReturnType<typeof identity>, label: string): void {
  advancePeerTrustFromEnrollmentProof({
    stateDir: local.stateDir,
    authorityId: peer.authorityId,
    publicKeyPem: peer.keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    transportPolicy: policy(peer.authorityId, label),
    toState: "active",
  });
}

function connectedPair(input: Readonly<{ leftTransform?: (line: string) => string; rightTransform?: (line: string) => string; onEchoReply?: (payload: string, seq: number) => void }> = {}) {
  const left = identity("left");
  const right = identity("right");
  activate(left, right, "right");
  activate(right, left, "left");
  const [leftDuplex, rightDuplex] = duplexPair();
  if (input.leftTransform) leftDuplex.transform = input.leftTransform;
  if (input.rightTransform) rightDuplex.transform = input.rightTransform;
  const responder = new RelayConnection({ role: "responder", duplex: rightDuplex, localStateDir: right.stateDir, heartbeatIntervalMs: 60_000, handshakeTimeoutMs: 1_000 });
  const initiator = new RelayConnection({ role: "initiator", duplex: leftDuplex, localStateDir: left.stateDir, remoteStateDirForPeer: right.stateDir, peerAuthorityId: right.authorityId, heartbeatIntervalMs: 60_000, handshakeTimeoutMs: 1_000, onEchoReply: input.onEchoReply });
  connections.push(initiator, responder);
  responder.start();
  initiator.start();
  return { left, right, leftDuplex, rightDuplex, initiator, responder };
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function mutateFrame(line: string, mutate: (frame: Record<string, unknown>) => void): string {
  const frame = JSON.parse(line) as Record<string, unknown>;
  mutate(frame);
  return `${JSON.stringify(frame)}\n`;
}

describe("authenticated federation relay", () => {
  it("completes mutual authentication and sequences both directions", async () => {
    const replies: Array<{ payload: string; seq: number }> = [];
    const pair = connectedPair({ onEchoReply: (payload, seq) => replies.push({ payload, seq }) });
    await waitFor(() => pair.initiator.status().state === "connected" && pair.responder.status().state === "connected", "relay handshake");

    pair.initiator.sendEcho("proof");
    await waitFor(() => replies.length === 1, "echo response");
    expect(replies).toEqual([{ payload: "proof", seq: 1 }]);
    expect(pair.initiator.status()).toMatchObject({ outgoingSeq: 1, incomingSeq: 1, peerAuthorityId: pair.right.authorityId });
    expect(pair.responder.status()).toMatchObject({ outgoingSeq: 1, incomingSeq: 1, peerAuthorityId: pair.left.authorityId });
  });

  it("rejects a forged handshake signature", async () => {
    let tampered = false;
    const pair = connectedPair({ leftTransform: (line) => {
      if (tampered || !line.includes('"kind":"relayHandshakeInit"')) return line;
      tampered = true;
      return mutateFrame(line, (frame) => {
        const signature = String(frame.signature);
        frame.signature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
      });
    } });
    await waitFor(() => pair.responder.status().state === "closed", "forged handshake rejection");
    expect(pair.responder.status()).toMatchObject({ disconnectReason: "invalidSignature" });
    await waitFor(() => pair.initiator.status().state === "closed", "handshake reject delivery");
    expect(pair.initiator.status()).toMatchObject({ disconnectReason: "handshakeRejected" });
  });

  it.each([
    ["relative", "relative/state", "absolute path"],
    ["traversal", "/tmp/rooms/../secret", "must not contain '..'"],
    ["metacharacter", "/tmp/rooms state", "using only letters"],
    ["non-ASCII", "/tmp/röoms", "using only letters"],
    ["overlong", `/${"a".repeat(1_024)}`, "at most 1024 characters"],
  ])("rejects a %s peer-supplied stateDir before loading responder identity", async (_label, stateDir, expected) => {
    const pair = connectedPair({ leftTransform: (line) => line.includes('"kind":"relayHandshakeInit"')
      ? mutateFrame(line, (frame) => { frame.stateDir = stateDir; })
      : line });
    await waitFor(() => pair.responder.status().state === "closed", "unsafe stateDir rejection");
    expect(pair.responder.status()).toMatchObject({ authorityId: null, disconnectReason: "malformedHandshake" });
    expect(pair.responder.status().disconnectMessage).toContain(expected);
    await waitFor(() => pair.initiator.status().state === "closed", "unsafe stateDir reject delivery");
    expect(pair.initiator.status()).toMatchObject({ disconnectReason: "handshakeRejected" });
  });

  it("rejects a validated but unusable stateDir without leaking local detail to the peer", async () => {
    // Passes assertSafeRemoteAbsolutePath, so it reaches loadMachineSigningKeys
    // and fails there. The peer is still unauthenticated at that point, so the
    // reply must not carry the path or the signing-key error.
    const absent = "/tmp/rooms-absent-state-dir-for-preauth-test";
    const pair = connectedPair({ leftTransform: (line) => line.includes('"kind":"relayHandshakeInit"')
      ? mutateFrame(line, (frame) => { frame.stateDir = absent; })
      : line });
    await waitFor(() => pair.responder.status().state === "closed", "unusable stateDir rejection");
    expect(pair.responder.status()).toMatchObject({ authorityId: null, disconnectReason: "malformedHandshake" });
    await waitFor(() => pair.initiator.status().state === "closed", "reject delivery");
    const delivered = pair.initiator.status().disconnectMessage ?? "";
    expect(delivered).toContain("handshake rejected");
    expect(delivered).not.toContain(absent);
    expect(delivered).not.toMatch(/machine|signing|key|ENOENT|no such file/i);
  });

  it("refuses a merely pending peer before sending a handshake", () => {
    const left = identity("pending-left");
    const right = identity("pending-right");
    preparePeerTrust({ stateDir: left.stateDir, authorityId: right.authorityId, publicKeyPem: right.keys.publicKey.export({ type: "spki", format: "pem" }).toString(), transportPolicy: policy(right.authorityId, "right") });
    const [leftDuplex] = duplexPair();
    const initiator = new RelayConnection({ role: "initiator", duplex: leftDuplex, localStateDir: left.stateDir, peerAuthorityId: right.authorityId, handshakeTimeoutMs: 1_000 });
    connections.push(initiator);
    initiator.start();
    expect(initiator.status()).toMatchObject({ state: "closed", disconnectReason: "peerNotActive" });
    expect(leftDuplex.writes).toBe(0);
  });

  it("closes on a per-direction sequence gap", async () => {
    const pair = connectedPair();
    await waitFor(() => pair.initiator.status().state === "connected" && pair.responder.status().state === "connected", "relay handshake");
    pair.leftDuplex.transform = (line) => line.includes('"kind":"echoRequest"') ? mutateFrame(line, (frame) => { frame.seq = Number(frame.seq) + 1; }) : line;
    pair.initiator.sendEcho("gap");
    await waitFor(() => pair.responder.status().state === "closed", "sequence violation");
    expect(pair.responder.status()).toMatchObject({ disconnectReason: "sequenceViolation", incomingSeq: 0 });
  });

  it("closes on a frame sent in the wrong direction", async () => {
    const pair = connectedPair();
    await waitFor(() => pair.initiator.status().state === "connected" && pair.responder.status().state === "connected", "relay handshake");
    pair.leftDuplex.transform = (line) => line.includes('"kind":"echoRequest"') ? mutateFrame(line, (frame) => { frame.direction = "responderToInitiator"; }) : line;
    pair.initiator.sendEcho("wrong-direction");
    await waitFor(() => pair.responder.status().state === "closed", "direction violation");
    expect(pair.responder.status()).toMatchObject({ disconnectReason: "wrongDirection", incomingSeq: 0 });
  });

  it("revalidates trust and closes a live connection after revocation", async () => {
    const pair = connectedPair();
    await waitFor(() => pair.initiator.status().state === "connected" && pair.responder.status().state === "connected", "relay handshake");
    revokePeerTrust({ stateDir: pair.right.stateDir, authorityId: pair.left.authorityId, reason: "live revocation test" });
    pair.responder.sendHeartbeat();
    expect(pair.responder.status()).toMatchObject({ state: "closed", disconnectReason: "peerTrustRevoked" });
  });
});

describe("relay frame parser bounds", () => {
  const connectionId = "00000000-0000-0000-0000-000000000001";
  const frame: RelayWireFrame = { kind: "echoRequest", connectionId, direction: "initiatorToResponder", seq: 1, payload: "ok" };

  it("round-trips a bounded exact frame", () => {
    expect(parseRelayFrame(encodeRelayFrame(frame).trim())).toEqual(frame);
  });

  it("rejects unknown fields, duplicate keys, and oversized frames", () => {
    expect(() => parseRelayFrame(JSON.stringify({ ...frame, unexpected: true }))).toThrow("unknown field unexpected");
    expect(() => parseRelayFrame(`{"kind":"echoRequest","connectionId":"${connectionId}","direction":"initiatorToResponder","seq":1,"seq":2,"payload":"ok"}`)).toThrow(/duplicate/i);
    expect(() => encodeRelayFrame({ ...frame, payload: "x".repeat(20_000) })).toThrow("maximum size");
    expect(() => parseRelayFrame(JSON.stringify({ ...frame, payload: "x".repeat(20_000) }))).toThrow("maximum size");
  });
});

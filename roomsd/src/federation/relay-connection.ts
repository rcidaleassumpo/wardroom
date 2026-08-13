// SPDX-License-Identifier: Apache-2.0
/**
 * Transport-neutral, authenticated Rooms relay connection state machine. Given any
 * `RelayByteDuplex` (a bounded byte stream with backpressure signalling), this module runs
 * the full connection lifecycle — mutual handshake, sequenced echo/status application
 * frames, heartbeat-driven peer-trust revalidation, graceful drain/close, and bounded-queue
 * overflow disconnect — without knowing anything about SSH. `ssh-relay-transport.ts` is the
 * only duplex implementation today; a later Tailscale/direct transport supplies its own
 * duplex to this same engine and needs its own confidential authenticated channel (SSH
 * supplies confidentiality/integrity for this one).
 *
 * Connection is allowed only when the local peer trust record for the other party is
 * `active` (non-revoked) and its pinned fingerprint/public key/transport policy match
 * exactly what the other side presents in the handshake — this is re-checked independently
 * by whichever side is validating, never inferred from the other side's self-assertion
 * alone, and SSH identity is never treated as a substitute for this Ed25519 proof.
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
  canonicalPublicKeyDerFromSpkiBase64,
  fingerprintForDer,
  publicKeyFromCanonicalDer,
  signEnrollmentTranscript,
  spkiBase64FromPublicKey,
  verifyEnrollmentTranscript,
} from "./enrollment-crypto.js";
import { loadMachineSigningKeys, resolveRoomsStateDir } from "../identity/machine-identity.js";
import { readActivePeerTrust, type PeerTrustRecord } from "./peer-trust.js";
import type { AuthorityId, FederationTransportPolicy } from "./contracts.js";
import {
  canonicalRelayAcceptTranscript,
  canonicalRelayInitTranscript,
  encodeRelayFrame,
  parseRelayFrame,
  RelayFrameReader,
  RelayProtocolError,
  RELAY_CHANNEL_KIND,
  RELAY_CLOCK_SKEW_TOLERANCE_MS,
  RELAY_DEFAULT_TTL_SECONDS,
  RELAY_HANDSHAKE_NONCE_BYTES,
  RELAY_MAX_TTL_SECONDS,
  RELAY_MIN_TTL_SECONDS,
  RELAY_PROTOCOL_VERSION,
  type RelayApplicationFrame,
  type RelayChannelFrame,
  type RelayInventoryFrame,
  type RelayTerminalFrame,
  type RelayDirection,
  type RelayHandshakeAccept,
  type RelayHandshakeInit,
  type RelayPeerStatus,
  type RelayWireFrame,
} from "./relay-protocol.js";

type RelayTerminalSendFrame = RelayTerminalFrame extends infer Frame
  ? Frame extends RelayTerminalFrame ? Omit<Frame, "connectionId" | "direction" | "seq"> : never
  : never;
type RelayChannelSendFrame = RelayChannelFrame extends infer Frame
  ? Frame extends RelayChannelFrame ? Omit<Frame, "connectionId" | "direction" | "seq"> : never
  : never;
type RelayInventorySendFrame = RelayInventoryFrame extends infer Frame
  ? Frame extends RelayInventoryFrame ? Omit<Frame, "connectionId" | "direction" | "seq"> : never
  : never;

/** Encode first, then expose the next sequence so a rejected frame cannot consume it. */
export function encodeNextSequencedRelayFrame(
  currentSeq: number,
  factory: (seq: number) => RelayApplicationFrame | RelayTerminalFrame | RelayChannelFrame | RelayInventoryFrame,
): Readonly<{ seq: number; line: string }> {
  const seq = currentSeq + 1;
  return { seq, line: encodeRelayFrame(factory(seq)) };
}

const UNKNOWN_CONNECTION_ID = "00000000-0000-0000-0000-000000000000";
/** Which pinned peer-trust transport policy kind is compatible with each relay channel; `sshStdio` is the only channel this unit implements. */
const EXPECTED_TRUST_POLICY_KIND_FOR_CHANNEL: Readonly<Record<typeof RELAY_CHANNEL_KIND, FederationTransportPolicy["kind"]>> = {
  sshStdio: "loopbackSsh",
};
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MULTIPLE = 3;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_QUEUED_FRAMES = 256;
const DEFAULT_MAX_QUEUED_BYTES = 1_048_576; // 1 MiB

export type RelayTransportCloseInfo = Readonly<{ reason: RelayDisconnectReason; message: string }>;

/** A bounded byte duplex a RelayConnection drives; ssh-relay-transport.ts is the only implementation. */
export interface RelayByteDuplex {
  /** Mirrors Node stream.write()'s backpressure signal: false means the caller should stop writing until onDrain fires. */
  write(data: string): boolean;
  onData(callback: (chunk: Buffer) => void): void;
  onDrain(callback: () => void): void;
  onceClose(callback: (info: RelayTransportCloseInfo) => void): void;
  destroy(): void;
}

export type RelayConnectionState = "handshaking" | "connected" | "draining" | "closed";

export type RelayDisconnectReason =
  | "gracefulClose"
  | "peerClosed"
  | "peerDrained"
  | "childExited"
  | "childSignaled"
  | "childSpawnFailed"
  | "transportError"
  | "handshakeTimeout"
  | "handshakeRejected"
  | "handshakeExpired"
  | "malformedHandshake"
  | "wrongDestination"
  | "wrongPeer"
  | "wrongConnection"
  | "wrongDirection"
  | "keyMismatch"
  | "peerNotActive"
  | "peerTrustMismatch"
  | "peerTrustRevoked"
  | "invalidSignature"
  | "protocolDowngrade"
  | "sequenceViolation"
  | "unknownField"
  | "oversizeFrame"
  | "queueOverflow"
  | "idleTimeout"
  | "protocolError";

export type RelayConnectionStatus = Readonly<{
  state: RelayConnectionState;
  connectionId: string | null;
  role: "initiator" | "responder";
  /** Null only for a responder that has not yet parsed a handshake Init frame (its own state dir, and therefore its own identity, is not known before that). */
  authorityId: AuthorityId | null;
  peerAuthorityId: AuthorityId | null;
  connectedAt: string | null;
  lastHeartbeatSentAt: string | null;
  lastHeartbeatReceivedAt: string | null;
  outgoingSeq: number;
  incomingSeq: number;
  disconnectReason: RelayDisconnectReason | null;
  disconnectMessage: string | null;
}>;

export interface RelayApplicationHandler {
  handleEcho(payload: string): string;
  handleStatus(base: RelayPeerStatus): RelayPeerStatus;
  /** Handles one terminal frame after connection/sequence validation. Replies are scheduled on the bounded relay queue. */
  handleTerminal?(frame: RelayTerminalFrame, connection: RelayConnection): void | Promise<void>;
  /** Handles durable home-authority channel operations after machine authentication. */
  handleChannel?(frame: RelayChannelFrame, connection: RelayConnection): void | Promise<void>;
  /** Handles bounded machine inventory after mutual machine authentication. */
  handleInventory?(frame: RelayInventoryFrame, connection: RelayConnection): void | Promise<void>;
  /** Releases per-connection application state after any graceful or failed close. */
  connectionClosed?(status: RelayConnectionStatus): void | Promise<void>;
}

/** Pure echo/status proof handler with no side effects and no storage access — never opens SQLite, never becomes a second writer. */
export const neutralRelayApplicationHandler: RelayApplicationHandler = {
  handleEcho: (payload) => payload,
  handleStatus: (base) => base,
};

export type RelayConnectionInput = Readonly<{
  role: "initiator" | "responder";
  duplex: RelayByteDuplex;
  localStateDir?: string;
  /** Required when role is "initiator": the peer this side is dialing. */
  peerAuthorityId?: AuthorityId;
  /** Initiator-only: the responder's own state dir, carried in-band since the fixed serve-stdio remote command takes no dynamic argv. */
  remoteStateDirForPeer?: string;
  ttlSeconds?: number;
  heartbeatIntervalMs?: number;
  idleTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  maxQueuedFrames?: number;
  maxQueuedBytes?: number;
  /** Responder-side neutral echo/status handler; defaults to a pure identity echo with no storage access. */
  handler?: RelayApplicationHandler;
  onStatusChange?: (status: RelayConnectionStatus) => void;
  /** Initiator-only: invoked when an echoResponse/statusResponse arrives. */
  onEchoReply?: (payload: string, seq: number) => void;
  onStatusReply?: (status: RelayPeerStatus, seq: number) => void;
}>;

export class RelayConnectionError extends Error {
  readonly reason: RelayDisconnectReason;
  constructor(reason: RelayDisconnectReason, message: string) {
    super(`Rooms relay connection: ${message}`);
    this.name = "RelayConnectionError";
    this.reason = reason;
  }
}

type PendingInit = Readonly<{
  connectionId: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  initiatorAuthorityId: AuthorityId;
  initiatorFingerprint: string;
  initiatorPublicKeySpkiB64: string;
  initiatorTransportPolicy: FederationTransportPolicy;
  responderAuthorityId: AuthorityId;
}>;

export class RelayConnection {
  private readonly input: RelayConnectionInput;
  private readonly duplex: RelayByteDuplex;
  private readonly reader = new RelayFrameReader();
  private readonly handler: RelayApplicationHandler;
  private readonly localStateDir: string;
  /**
   * The initiator's own identity is known immediately (it dials with a fixed, already
   * chosen local state dir). The responder's is not: which local state dir it should use
   * only arrives inside the handshake Init frame (`init.stateDir`), since the fixed
   * `serve-stdio` remote command takes no dynamic argv — so a responder must not load its
   * own signing keys until that frame is parsed, not eagerly in the constructor.
   */
  private ownAuthorityId: AuthorityId | null = null;

  private state: RelayConnectionState = "handshaking";
  private connectionId: string | null = null;
  private peerAuthorityId: AuthorityId | null = null;
  private resolvedRemoteStateDir: string | undefined;
  /** Responder-only: the heartbeat interval the initiator proposed in its Init frame, carried in-band since `serve-stdio` takes no dynamic argv (see relay-protocol.ts). */
  private negotiatedHeartbeatIntervalMs: number | null = null;
  private connectedAt: string | null = null;
  private outgoingSeq = 0;
  private incomingSeq = 0;
  private lastHeartbeatSentAt: string | null = null;
  private lastHeartbeatReceivedAt: string | null = null;
  private lastAnyReceivedAtMs = 0;
  private disconnectReason: RelayDisconnectReason | null = null;
  private disconnectMessage: string | null = null;
  private pendingInit: PendingInit | null = null;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly outgoingQueue: string[] = [];
  private queuedBytes = 0;
  private destroyed = false;

  constructor(input: RelayConnectionInput) {
    if (input.role === "initiator" && !input.peerAuthorityId) {
      throw new RelayConnectionError("wrongPeer", "initiator role requires peerAuthorityId");
    }
    this.input = input;
    this.duplex = input.duplex;
    this.handler = input.handler ?? neutralRelayApplicationHandler;
    this.localStateDir = resolveRoomsStateDir(input.localStateDir);
    if (input.role === "initiator") {
      this.ownAuthorityId = loadMachineSigningKeys(this.localStateDir).authorityId as AuthorityId;
    }

    this.duplex.onData((chunk) => this.onData(chunk));
    this.duplex.onDrain(() => this.flushQueue());
    this.duplex.onceClose((info) => this.onTransportClose(info));
  }

  status(): RelayConnectionStatus {
    return {
      state: this.state,
      connectionId: this.connectionId,
      role: this.input.role,
      authorityId: this.ownAuthorityId,
      peerAuthorityId: this.peerAuthorityId,
      connectedAt: this.connectedAt,
      lastHeartbeatSentAt: this.lastHeartbeatSentAt,
      lastHeartbeatReceivedAt: this.lastHeartbeatReceivedAt,
      outgoingSeq: this.outgoingSeq,
      incomingSeq: this.incomingSeq,
      disconnectReason: this.disconnectReason,
      disconnectMessage: this.disconnectMessage,
    };
  }

  /** Begins the handshake. Initiator sends the signed Init frame immediately; responder only starts its handshake timeout and waits for one. */
  start(): void {
    this.handshakeTimer = setTimeout(() => {
      if (this.state === "handshaking") this.fail("handshakeTimeout", "handshake did not complete within the configured timeout");
    }, this.input.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);

    if (this.input.role === "responder") return;

    const ownAuthorityId = this.ownAuthorityId as AuthorityId; // set eagerly in the constructor for the initiator role
    const peerAuthorityId = this.input.peerAuthorityId as AuthorityId;
    const trust = readActivePeerTrust(peerAuthorityId, this.localStateDir);
    if (!trust) {
      this.fail("peerNotActive", `no active local peer trust for ${peerAuthorityId}; connection refused before dialing`);
      return;
    }

    const keys = loadMachineSigningKeys(this.localStateDir);
    const ttlSeconds = boundedTtl(this.input.ttlSeconds);
    const now = Date.now();
    const issuedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + ttlSeconds * 1000).toISOString();
    const connectionId = randomUUID();
    const nonce = randomBytes(RELAY_HANDSHAKE_NONCE_BYTES).toString("hex");
    const initiatorPublicKeySpkiB64 = spkiBase64FromPublicKey(keys.publicKey);
    const initiatorFingerprint = fingerprintForDer(canonicalPublicKeyDerFromSpkiBase64(initiatorPublicKeySpkiB64));
    const initiatorTransportPolicy = trust.transportPolicy;

    const transcript = canonicalRelayInitTranscript({
      connectionId, initiatorAuthorityId: ownAuthorityId, initiatorFingerprint, initiatorPublicKeySpkiB64,
      initiatorTransportPolicy, responderAuthorityId: peerAuthorityId, nonce, issuedAt, expiresAt,
    });
    const signature = signEnrollmentTranscript(keys.privateKey, transcript);

    const init: RelayHandshakeInit = {
      kind: "relayHandshakeInit", version: RELAY_PROTOCOL_VERSION, channel: RELAY_CHANNEL_KIND, connectionId,
      initiatorAuthorityId: ownAuthorityId, initiatorFingerprint, initiatorPublicKeySpkiB64, initiatorTransportPolicy,
      responderAuthorityId: peerAuthorityId, stateDir: this.input.remoteStateDirForPeer ?? null,
      heartbeatIntervalMs: this.input.heartbeatIntervalMs ?? null,
      nonce, issuedAt, expiresAt, signature,
    };

    this.connectionId = connectionId;
    this.peerAuthorityId = peerAuthorityId;
    this.pendingInit = {
      connectionId, nonce, issuedAt, expiresAt, initiatorAuthorityId: ownAuthorityId, initiatorFingerprint,
      initiatorPublicKeySpkiB64, initiatorTransportPolicy, responderAuthorityId: peerAuthorityId,
    };
    this.writeFrame(encodeRelayFrame(init));
    this.emitStatus();
  }

  /** Initiator-only: sends a bounded echo request; responder replies with echoResponse. */
  sendEcho(payload: string): void {
    this.assertCanSendApplicationRequest();
    this.sendSequencedFrame((seq) => ({ kind: "echoRequest", connectionId: this.connectionId!, direction: this.ownDirection(), seq, payload }));
  }

  /** Initiator-only: sends a bounded status request; responder replies with statusResponse. */
  requestStatus(): void {
    this.assertCanSendApplicationRequest();
    this.sendSequencedFrame((seq) => ({ kind: "statusRequest", connectionId: this.connectionId!, direction: this.ownDirection(), seq }));
  }

  /** Sends one heartbeat frame; safe to call from an external timer on either role. */
  sendHeartbeat(): void {
    if (this.state !== "connected" && this.state !== "draining") return;
    this.sendSequencedFrame((seq) => ({ kind: "heartbeat", connectionId: this.connectionId!, direction: this.ownDirection(), seq }));
    this.lastHeartbeatSentAt = new Date().toISOString();
    this.revalidatePeerTrustOrClose();
    this.emitStatus();
  }

  /** Begins graceful shutdown: announces drain, then closes once the peer acknowledges or a bounded grace period elapses. */
  drain(graceMs = 2_000): void {
    if (this.state !== "connected") return;
    this.state = "draining";
    this.sendSequencedFrame((seq) => ({ kind: "drain", connectionId: this.connectionId!, direction: this.ownDirection(), seq }));
    this.emitStatus();
    setTimeout(() => {
      if (this.state === "draining") this.close("gracefulClose", "drain grace period elapsed");
    }, graceMs);
  }

  /** Sends a close frame (best effort) and tears down the duplex immediately. */
  close(reason: RelayDisconnectReason = "gracefulClose", message = "connection closed"): void {
    if (this.state === "closed") return;
    if (this.connectionId) {
      try {
        this.sendSequencedFrame((seq) => ({ kind: "close", connectionId: this.connectionId!, direction: this.ownDirection(), seq, reason: message }));
      } catch {
        // best effort only; falling through to destroy regardless
      }
    }
    this.fail(reason, message);
  }

  private ownDirection(): RelayDirection {
    return this.input.role === "initiator" ? "initiatorToResponder" : "responderToInitiator";
  }

  private peerDirection(): RelayDirection {
    return this.input.role === "initiator" ? "responderToInitiator" : "initiatorToResponder";
  }

  private assertCanSendApplicationRequest(): void {
    if (this.input.role !== "initiator") throw new RelayConnectionError("protocolError", "only the initiator sends echo/status requests");
    if (this.state !== "connected") throw new RelayConnectionError("protocolError", "connection is not in the connected state");
  }

  /** Commit the sequence only after strict encoding succeeds. */
  private sendSequencedFrame(factory: (seq: number) => RelayApplicationFrame | RelayTerminalFrame | RelayChannelFrame | RelayInventoryFrame): void {
    const encoded = encodeNextSequencedRelayFrame(this.outgoingSeq, factory);
    this.outgoingSeq = encoded.seq;
    this.writeFrame(encoded.line);
  }

  private writeFrame(line: string): void {
    if (this.destroyed) return;
    if (this.outgoingQueue.length > 0) {
      this.enqueue(line);
      return;
    }
    const ok = this.duplex.write(line);
    if (!ok) this.enqueue(line);
  }

  private enqueue(line: string): void {
    const maxFrames = this.input.maxQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES;
    const maxBytes = this.input.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
    if (this.outgoingQueue.length + 1 > maxFrames || this.queuedBytes + line.length > maxBytes) {
      this.fail("queueOverflow", `outgoing queue exceeded bounds (${maxFrames} frames / ${maxBytes} bytes); slow peer disconnected`);
      return;
    }
    this.outgoingQueue.push(line);
    this.queuedBytes += line.length;
  }

  private flushQueue(): void {
    while (this.outgoingQueue.length > 0) {
      const next = this.outgoingQueue[0]!;
      const ok = this.duplex.write(next);
      this.outgoingQueue.shift();
      this.queuedBytes -= next.length;
      if (!ok) return;
    }
  }

  private onData(chunk: Buffer): void {
    if (this.destroyed) return;
    let lines: readonly string[];
    try {
      lines = this.reader.push(chunk);
    } catch (error) {
      this.fail("oversizeFrame", error instanceof Error ? error.message : String(error));
      return;
    }
    for (const line of lines) {
      if (this.destroyed) return;
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let frame: RelayWireFrame;
    try {
      frame = parseRelayFrame(line);
    } catch (error) {
      this.handleMalformed(error instanceof Error ? error.message : String(error));
      return;
    }
    this.lastAnyReceivedAtMs = Date.now();

    if (this.state === "handshaking") {
      this.onHandshakeFrame(frame);
      return;
    }
    if (frame.kind === "relayHandshakeInit" || frame.kind === "relayHandshakeAccept" || frame.kind === "relayHandshakeReject") {
      this.fail("protocolDowngrade", `received handshake frame ${frame.kind} after handshake already completed`);
      return;
    }
    this.onApplicationFrame(frame);
  }

  private handleMalformed(message: string): void {
    if (this.input.role === "responder" && this.state === "handshaking") {
      this.rejectHandshake(this.connectionId ?? UNKNOWN_CONNECTION_ID, "malformedHandshake", message);
      return;
    }
    this.fail("protocolError", message);
  }

  private onHandshakeFrame(frame: RelayWireFrame): void {
    if (this.input.role === "responder") {
      if (frame.kind !== "relayHandshakeInit") {
        this.rejectHandshake(this.connectionId ?? UNKNOWN_CONNECTION_ID, "protocolDowngrade", `expected relayHandshakeInit, received ${frame.kind}`);
        return;
      }
      this.onHandshakeInit(frame);
      return;
    }
    if (frame.kind === "relayHandshakeReject") {
      this.fail("handshakeRejected", `${frame.code}: ${frame.message}`);
      return;
    }
    if (frame.kind !== "relayHandshakeAccept") {
      this.fail("protocolDowngrade", `expected relayHandshakeAccept, received ${frame.kind}`);
      return;
    }
    this.onHandshakeAccept(frame);
  }

  private onHandshakeInit(init: RelayHandshakeInit): void {
    this.connectionId = init.connectionId;
    let responderStateDir: string;
    try {
      responderStateDir = resolveRoomsStateDir(init.stateDir ?? this.input.localStateDir);
    } catch (error) {
      // The peer is not authenticated yet, so it learns only that the frame was
      // rejected. Local filesystem and identity detail stays local.
      this.rejectHandshakeWithoutDetail(init.connectionId, "state directory rejected", error);
      return;
    }
    this.resolvedRemoteStateDir = responderStateDir;
    this.negotiatedHeartbeatIntervalMs = init.heartbeatIntervalMs;

    let keys: ReturnType<typeof loadMachineSigningKeys>;
    try {
      keys = loadMachineSigningKeys(responderStateDir);
    } catch (error) {
      this.rejectHandshakeWithoutDetail(init.connectionId, "responder identity unavailable", error);
      return;
    }
    const ownAuthorityId = keys.authorityId as AuthorityId;
    this.ownAuthorityId = ownAuthorityId;

    if (init.responderAuthorityId !== ownAuthorityId) {
      this.rejectHandshake(init.connectionId, "wrongDestination", "handshake is not addressed to this Rooms identity");
      return;
    }
    if (init.initiatorAuthorityId === ownAuthorityId) {
      this.rejectHandshake(init.connectionId, "wrongDestination", "reflection: initiator cannot be this Rooms identity");
      return;
    }

    let initiatorDer: Buffer;
    try {
      initiatorDer = canonicalPublicKeyDerFromSpkiBase64(init.initiatorPublicKeySpkiB64);
    } catch (error) {
      this.rejectHandshake(init.connectionId, "keyMismatch", error instanceof Error ? error.message : String(error));
      return;
    }
    const recomputedFingerprint = fingerprintForDer(initiatorDer);
    if (recomputedFingerprint !== init.initiatorFingerprint || `authority-${recomputedFingerprint}` !== init.initiatorAuthorityId) {
      this.rejectHandshake(init.connectionId, "keyMismatch", "initiator fingerprint/authority id does not match its presented public key");
      return;
    }

    const trust = readActivePeerTrust(init.initiatorAuthorityId, responderStateDir);
    if (!trust) {
      this.rejectHandshake(init.connectionId, "peerNotActive", `no active local peer trust for ${init.initiatorAuthorityId}`);
      return;
    }
    if (!this.trustMatchesPresented(trust, recomputedFingerprint)) {
      this.rejectHandshake(init.connectionId, "peerTrustMismatch", "presented key/transport policy does not match the locally pinned peer trust record");
      return;
    }

    const now = Date.now();
    if (Date.parse(init.expiresAt) <= now) {
      this.rejectHandshake(init.connectionId, "handshakeExpired", "handshake init has expired");
      return;
    }
    if (Date.parse(init.issuedAt) - now > RELAY_CLOCK_SKEW_TOLERANCE_MS) {
      this.rejectHandshake(init.connectionId, "handshakeExpired", "handshake init issuedAt is too far in the future");
      return;
    }

    const initTranscript = canonicalRelayInitTranscript({
      connectionId: init.connectionId, initiatorAuthorityId: init.initiatorAuthorityId, initiatorFingerprint: init.initiatorFingerprint,
      initiatorPublicKeySpkiB64: init.initiatorPublicKeySpkiB64, initiatorTransportPolicy: init.initiatorTransportPolicy,
      responderAuthorityId: init.responderAuthorityId, nonce: init.nonce, issuedAt: init.issuedAt, expiresAt: init.expiresAt,
    });
    if (!verifyEnrollmentTranscript(publicKeyFromCanonicalDer(initiatorDer), initTranscript, init.signature)) {
      this.rejectHandshake(init.connectionId, "invalidSignature", "handshake init signature is invalid");
      return;
    }

    const responderPublicKeySpkiB64 = spkiBase64FromPublicKey(keys.publicKey);
    const responderFingerprint = fingerprintForDer(canonicalPublicKeyDerFromSpkiBase64(responderPublicKeySpkiB64));
    const responderNonce = randomBytes(RELAY_HANDSHAKE_NONCE_BYTES).toString("hex");

    // `trust` is already this responder's own active trust record for the initiator.
    const responderTransportPolicy = trust.transportPolicy;

    const acceptTranscript = canonicalRelayAcceptTranscript({
      connectionId: init.connectionId, initiatorAuthorityId: init.initiatorAuthorityId, initiatorFingerprint: init.initiatorFingerprint,
      initiatorPublicKeySpkiB64: init.initiatorPublicKeySpkiB64, initiatorTransportPolicy: init.initiatorTransportPolicy,
      responderAuthorityId: ownAuthorityId, responderFingerprint, responderPublicKeySpkiB64, responderTransportPolicy,
      initiatorNonce: init.nonce, responderNonce, issuedAt: init.issuedAt, expiresAt: init.expiresAt,
    });
    const signature = signEnrollmentTranscript(keys.privateKey, acceptTranscript);

    const accept: RelayHandshakeAccept = {
      kind: "relayHandshakeAccept", version: RELAY_PROTOCOL_VERSION, channel: RELAY_CHANNEL_KIND, connectionId: init.connectionId,
      initiatorAuthorityId: init.initiatorAuthorityId, initiatorFingerprint: init.initiatorFingerprint,
      initiatorPublicKeySpkiB64: init.initiatorPublicKeySpkiB64, initiatorTransportPolicy: init.initiatorTransportPolicy,
      responderAuthorityId: ownAuthorityId, responderFingerprint, responderPublicKeySpkiB64, responderTransportPolicy,
      initiatorNonce: init.nonce, responderNonce, issuedAt: init.issuedAt, expiresAt: init.expiresAt, signature,
    };

    this.peerAuthorityId = init.initiatorAuthorityId;
    this.writeFrame(encodeRelayFrame(accept));
    this.becomeConnected();
  }

  private onHandshakeAccept(accept: RelayHandshakeAccept): void {
    const pending = this.pendingInit;
    if (!pending || accept.connectionId !== pending.connectionId) {
      this.fail("wrongConnection", "handshake accept connectionId does not match the pending init");
      return;
    }
    if (
      accept.initiatorAuthorityId !== pending.initiatorAuthorityId ||
      accept.initiatorFingerprint !== pending.initiatorFingerprint ||
      accept.initiatorPublicKeySpkiB64 !== pending.initiatorPublicKeySpkiB64 ||
      !sameTransportPolicy(accept.initiatorTransportPolicy, pending.initiatorTransportPolicy) ||
      accept.initiatorNonce !== pending.nonce ||
      accept.issuedAt !== pending.issuedAt ||
      accept.expiresAt !== pending.expiresAt
    ) {
      this.fail("protocolError", "handshake accept does not echo this side's offered init fields exactly (mutation)");
      return;
    }
    if (accept.responderAuthorityId !== pending.responderAuthorityId) {
      this.fail("wrongPeer", "handshake accept responder authority id does not match the dialed peer");
      return;
    }

    const now = Date.now();
    if (Date.parse(accept.expiresAt) <= now) {
      this.fail("handshakeExpired", "handshake accept has expired");
      return;
    }

    const trust = readActivePeerTrust(accept.responderAuthorityId, this.localStateDir);
    if (!trust) {
      this.fail("peerNotActive", `no active local peer trust for ${accept.responderAuthorityId}`);
      return;
    }
    let responderDer: Buffer;
    try {
      responderDer = canonicalPublicKeyDerFromSpkiBase64(accept.responderPublicKeySpkiB64);
    } catch (error) {
      this.fail("keyMismatch", error instanceof Error ? error.message : String(error));
      return;
    }
    const recomputedFingerprint = fingerprintForDer(responderDer);
    if (recomputedFingerprint !== accept.responderFingerprint || `authority-${recomputedFingerprint}` !== accept.responderAuthorityId) {
      this.fail("keyMismatch", "responder fingerprint/authority id does not match its presented public key");
      return;
    }
    if (!this.trustMatchesPresented(trust, recomputedFingerprint)) {
      this.fail("peerTrustMismatch", "presented responder key/transport policy does not match the locally pinned peer trust record");
      return;
    }

    const acceptTranscript = canonicalRelayAcceptTranscript({
      connectionId: accept.connectionId, initiatorAuthorityId: accept.initiatorAuthorityId, initiatorFingerprint: accept.initiatorFingerprint,
      initiatorPublicKeySpkiB64: accept.initiatorPublicKeySpkiB64, initiatorTransportPolicy: accept.initiatorTransportPolicy,
      responderAuthorityId: accept.responderAuthorityId, responderFingerprint: accept.responderFingerprint,
      responderPublicKeySpkiB64: accept.responderPublicKeySpkiB64, responderTransportPolicy: accept.responderTransportPolicy,
      initiatorNonce: accept.initiatorNonce, responderNonce: accept.responderNonce, issuedAt: accept.issuedAt, expiresAt: accept.expiresAt,
    });
    if (!verifyEnrollmentTranscript(publicKeyFromCanonicalDer(responderDer), acceptTranscript, accept.signature)) {
      this.fail("invalidSignature", "handshake accept signature is invalid");
      return;
    }

    this.becomeConnected();
  }

  /**
   * A `PeerTrustRecord`'s `transportPolicy` is each side's own local configuration for
   * reaching the other party (e.g. B's record for A holds B's own asserted policy, tagged
   * `peerAuthorityId: A` — see peer-trust.ts/enrollment.ts), not a copy of what the other
   * side presents about itself; the two sides' policies for the same pair are never
   * expected to be byte-identical, so this deliberately does not compare them. What must
   * match exactly is the key pin (the essential authentication fact) and that the *kind* of
   * transport this side already has on file for the peer is the one this connection is
   * actually running over — rejecting a peer pinned only for `tailscalePeer` (or
   * `localUnix`, which has no remote peer at all) from being satisfied by an SSH-stdio
   * connection is the transport-substitution defense this check exists for.
   */
  private trustMatchesPresented(trust: PeerTrustRecord, presentedFingerprint: string): boolean {
    return trust.fingerprint === presentedFingerprint && trust.transportPolicy.kind === EXPECTED_TRUST_POLICY_KIND_FOR_CHANNEL[RELAY_CHANNEL_KIND];
  }

  /**
   * Reject before the peer is authenticated without handing it the underlying
   * error. A raw local path or signing-key message would let an unauthenticated
   * peer probe this machine, and would become a real oracle on any transport
   * that does not already require shell access.
   */
  private rejectHandshakeWithoutDetail(connectionId: string, summary: string, error: unknown): void {
    process.stderr.write(`roomsd: federation relay handshake rejected (${summary}): ${error instanceof Error ? error.message : String(error)}\n`);
    this.rejectHandshake(connectionId, "malformedHandshake", "handshake rejected");
  }

  private rejectHandshake(connectionId: string, code: string, message: string): void {
    this.writeFrame(encodeRelayFrame({ kind: "relayHandshakeReject", connectionId, code, message }));
    this.fail(reasonFromRejectCode(code), message);
  }

  private becomeConnected(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.state = "connected";
    this.connectedAt = new Date().toISOString();
    this.lastAnyReceivedAtMs = Date.now();
    const heartbeatIntervalMs = this.input.heartbeatIntervalMs ?? this.negotiatedHeartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), heartbeatIntervalMs);
    const idleTimeoutMs = this.input.idleTimeoutMs ?? heartbeatIntervalMs * DEFAULT_IDLE_TIMEOUT_MULTIPLE;
    this.idleTimer = setInterval(() => {
      if (Date.now() - this.lastAnyReceivedAtMs > idleTimeoutMs) this.fail("idleTimeout", `no frames received from peer within ${idleTimeoutMs}ms`);
    }, Math.max(250, Math.floor(idleTimeoutMs / 4)));
    this.emitStatus();
  }

  private onApplicationFrame(frame: RelayWireFrame): void {
    if (frame.kind === "relayHandshakeInit" || frame.kind === "relayHandshakeAccept" || frame.kind === "relayHandshakeReject") return;

    if (frame.connectionId !== this.connectionId) {
      this.fail("wrongConnection", `frame connectionId ${frame.connectionId} does not match this connection`);
      return;
    }
    if (frame.direction !== this.peerDirection()) {
      this.fail("wrongDirection", `frame direction ${frame.direction} is not valid for a peer-originated frame on this connection`);
      return;
    }
    if (frame.seq !== this.incomingSeq + 1) {
      this.fail("sequenceViolation", `expected seq ${this.incomingSeq + 1}, received ${frame.seq} (gap, duplicate, or replay)`);
      return;
    }
    this.incomingSeq = frame.seq;

    switch (frame.kind) {
      case "echoRequest": {
        if (this.input.role !== "responder") return this.fail("protocolError", "only a responder accepts echoRequest");
        const payload = this.handler.handleEcho(frame.payload);
        this.sendSequencedFrame((seq) => ({ kind: "echoResponse", connectionId: this.connectionId!, direction: this.ownDirection(), seq, payload }));
        return;
      }
      case "echoResponse": {
        this.input.onEchoReply?.(frame.payload, frame.seq);
        return;
      }
      case "statusRequest": {
        if (this.input.role !== "responder") return this.fail("protocolError", "only a responder accepts statusRequest");
        const base: RelayPeerStatus = {
          connectionId: this.connectionId!, authorityId: this.ownAuthorityId as AuthorityId, peerAuthorityId: this.peerAuthorityId!,
          role: "responder", connectedAt: this.connectedAt!, uptimeMs: Date.now() - Date.parse(this.connectedAt!),
        };
        const status = this.handler.handleStatus(base);
        this.sendSequencedFrame((seq) => ({ kind: "statusResponse", connectionId: this.connectionId!, direction: this.ownDirection(), seq, status }));
        return;
      }
      case "statusResponse": {
        this.input.onStatusReply?.(frame.status, frame.seq);
        return;
      }
      case "heartbeat": {
        this.lastHeartbeatReceivedAt = new Date().toISOString();
        this.revalidatePeerTrustOrClose();
        this.emitStatus();
        return;
      }
      case "drain": {
        this.close("peerDrained", "peer initiated graceful drain");
        return;
      }
      case "close": {
        this.fail("peerClosed", frame.reason);
        return;
      }
      case "terminalOpen": case "terminalOpenAck": case "terminalOutput": case "terminalGap": case "terminalInput": case "terminalInputAck": case "terminalResize": case "terminalResizeAck": case "terminalDetach": case "terminalClose": {
        const terminal = frame as RelayTerminalFrame;
        try {
          const handled = this.handler.handleTerminal?.(terminal, this);
          if (handled) void handled.catch((error) => this.fail("protocolError", error instanceof Error ? error.message : String(error)));
        } catch (error) { this.fail("protocolError", error instanceof Error ? error.message : String(error)); }
        return;
      }
      case "channelCommand": case "channelResult": {
        try {
          const handled = this.handler.handleChannel?.(frame as RelayChannelFrame, this);
          if (!this.handler.handleChannel) return this.fail("protocolError", "channel federation is unavailable");
          if (handled) void handled.catch((error) => this.fail("protocolError", error instanceof Error ? error.message : String(error)));
        } catch (error) { this.fail("protocolError", error instanceof Error ? error.message : String(error)); }
        return;
      }
      case "inventoryCommand": case "inventoryResult": {
        try {
          const handled = this.handler.handleInventory?.(frame as RelayInventoryFrame, this);
          if (!this.handler.handleInventory) return this.fail("protocolError", "machine inventory is unavailable");
          if (handled) void handled.catch((error) => this.fail("protocolError", error instanceof Error ? error.message : String(error)));
        } catch (error) { this.fail("protocolError", error instanceof Error ? error.message : String(error)); }
        return;
      }
      case "protocolError": {
        this.fail("protocolError", `${frame.code}: ${frame.message}`);
        return;
      }
    }
  }

  /** Sends a validated terminal frame through the same sequenced, bounded SSH relay connection. */
  sendTerminal(frame: RelayTerminalSendFrame): void {
    if (this.state !== "connected" && this.state !== "draining") throw new RelayConnectionError("protocolError", "connection is not available");
    this.sendSequencedFrame((seq) => ({ ...frame, connectionId: this.connectionId!, direction: this.ownDirection(), seq } as RelayTerminalFrame));
  }

  sendChannel(frame: RelayChannelSendFrame): void {
    if (this.state !== "connected" && this.state !== "draining") throw new RelayConnectionError("protocolError", "connection is not available");
    this.sendSequencedFrame((seq) => ({ ...frame, connectionId: this.connectionId!, direction: this.ownDirection(), seq } as RelayChannelFrame));
  }

  sendInventory(frame: RelayInventorySendFrame): void {
    if (this.state !== "connected" && this.state !== "draining") throw new RelayConnectionError("protocolError", "connection is not available");
    this.sendSequencedFrame((seq) => ({ ...frame, connectionId: this.connectionId!, direction: this.ownDirection(), seq } as RelayInventoryFrame));
  }

  private revalidatePeerTrustOrClose(): void {
    if (!this.peerAuthorityId) return;
    const stateDir = this.input.role === "initiator" ? this.localStateDir : (this.resolvedRemoteStateDir ?? this.localStateDir);
    const trust = readActivePeerTrust(this.peerAuthorityId, stateDir);
    if (!trust) {
      this.close("peerTrustRevoked", "peer trust is no longer active (revoked or not yet re-established)");
    }
  }

  private onTransportClose(info: RelayTransportCloseInfo): void {
    this.fail(info.reason, info.message);
  }

  private fail(reason: RelayDisconnectReason, message: string): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.disconnectReason = reason;
    this.disconnectMessage = message;
    this.destroyed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.emitStatus();
    try {
      const closed = this.handler.connectionClosed?.(this.status());
      if (closed) void closed.catch(() => {});
    } catch { /* transport shutdown must remain deterministic */ }
    this.duplex.destroy();
  }

  private emitStatus(): void {
    this.input.onStatusChange?.(this.status());
  }
}

function boundedTtl(value: number | undefined): number {
  if (value === undefined) return RELAY_DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(value) || value < RELAY_MIN_TTL_SECONDS || value > RELAY_MAX_TTL_SECONDS) {
    throw new RelayConnectionError("protocolError", `ttlSeconds must be an integer between ${RELAY_MIN_TTL_SECONDS} and ${RELAY_MAX_TTL_SECONDS}`);
  }
  return value;
}

function sameTransportPolicy(left: FederationTransportPolicy, right: FederationTransportPolicy): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function reasonFromRejectCode(code: string): RelayDisconnectReason {
  switch (code) {
    case "wrongDestination": return "wrongDestination";
    case "keyMismatch": return "keyMismatch";
    case "peerNotActive": return "peerNotActive";
    case "peerTrustMismatch": return "peerTrustMismatch";
    case "handshakeExpired": return "handshakeExpired";
    case "invalidSignature": return "invalidSignature";
    case "protocolDowngrade": return "protocolDowngrade";
    case "malformedHandshake": return "malformedHandshake";
    default: return "handshakeRejected";
  }
}

// SPDX-License-Identifier: Apache-2.0
/** Provider-neutral contracts for the first Rooms federation protocol. */

import type { Cursor } from "../domain/contracts.js";
import type { AuthorityId } from "../identity/authority.js";

export type { Cursor } from "../domain/contracts.js";
export type { AuthorityId } from "../identity/authority.js";

export const FEDERATION_PROTOCOL_VERSION = 1 as const;

declare const homeRefBrand: unique symbol;

export type HomeRef = Readonly<{ authorityId: AuthorityId }> & { readonly [homeRefBrand]: "HomeRef" };

export type FederationTransportPolicy =
  | Readonly<{ kind: "localUnix"; path: string }>
  | Readonly<{ kind: "loopbackSsh"; peerAuthorityId: AuthorityId; sshDestination: string; sshUser: string; localEndpoint: "127.0.0.1" | "::1" | "localhost"; localPort: number }>
  | Readonly<{ kind: "tailscalePeer"; peerAuthorityId: AuthorityId; address: string; nodeIdentity: string; verifiedAt: string }>;

export type MachineSetupState = "uninitialized" | "identityCreated" | "ready";
export type SecureMachineState = Readonly<{
  state: MachineSetupState;
  statePath: string;
  identityPath: string;
  permissions: "owner-only";
  privateMaterial: "local-only-never-in-envelope";
}>;

/**
 * Mutual peer enrollment is a self-contained, pre-transport trust bootstrap: every
 * artifact below carries its own signed origin/destination AuthorityId pair rather than
 * inheriting one from a PeerEnvelope, because no Rooms-authenticated peer transport exists
 * until enrollment itself has produced trust. These are therefore public, bounded,
 * machine-readable CLI artifacts and are not members of `PeerPayload`/`PeerEnvelope`.
 * Operators may exchange the files out of band; the SSH connect path instead carries the
 * exact raw artifacts through its bounded fixed-command `remote-step` exchange. A future
 * transport that wraps them in an authenticated envelope must cross-check the envelope's
 * origin/destination against these signed fields rather than replacing them.
 *
 * Every artifact binds: protocol version, enrollment id, both AuthorityIds, both Ed25519
 * SPKI public keys (base64 DER) and SHA-256 fingerprints, both closed transport policies,
 * a >=256-bit origin nonce (and, from the challenge onward, a >=256-bit destination
 * nonce), a shared issuedAt/expiresAt window set once by the offer and echoed unchanged
 * thereafter, and a domain-separated Ed25519 signature over a canonical re-serialization
 * of those fields (see enrollment-crypto.ts). AuthorityId must equal
 * `authority-<sha256-hex-fingerprint>` of the accompanying public key.
 */
export type EnrollmentOffer = Readonly<{
  kind: "enrollmentOffer";
  version: typeof FEDERATION_PROTOCOL_VERSION;
  enrollmentId: string;
  origin: AuthorityId;
  destination: AuthorityId;
  originPublicKeySpkiB64: string;
  originFingerprint: string;
  originTransportPolicy: FederationTransportPolicy;
  originNonce: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
}>;

export type EnrollmentChallenge = Readonly<{
  kind: "enrollmentChallenge";
  version: typeof FEDERATION_PROTOCOL_VERSION;
  enrollmentId: string;
  origin: AuthorityId;
  destination: AuthorityId;
  originPublicKeySpkiB64: string;
  originFingerprint: string;
  originTransportPolicy: FederationTransportPolicy;
  destinationPublicKeySpkiB64: string;
  destinationFingerprint: string;
  destinationTransportPolicy: FederationTransportPolicy;
  originNonce: string;
  destinationNonce: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
}>;

export type EnrollmentAccept = Readonly<{
  kind: "enrollmentAccept";
  version: typeof FEDERATION_PROTOCOL_VERSION;
  enrollmentId: string;
  origin: AuthorityId;
  destination: AuthorityId;
  originPublicKeySpkiB64: string;
  originFingerprint: string;
  originTransportPolicy: FederationTransportPolicy;
  destinationPublicKeySpkiB64: string;
  destinationFingerprint: string;
  destinationTransportPolicy: FederationTransportPolicy;
  originNonce: string;
  destinationNonce: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
}>;

export type EnrollmentConfirm = Readonly<{
  kind: "enrollmentConfirm";
  version: typeof FEDERATION_PROTOCOL_VERSION;
  enrollmentId: string;
  origin: AuthorityId;
  destination: AuthorityId;
  originPublicKeySpkiB64: string;
  originFingerprint: string;
  originTransportPolicy: FederationTransportPolicy;
  destinationPublicKeySpkiB64: string;
  destinationFingerprint: string;
  destinationTransportPolicy: FederationTransportPolicy;
  originNonce: string;
  destinationNonce: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
}>;

export type EnrollmentArtifact = EnrollmentOffer | EnrollmentChallenge | EnrollmentAccept | EnrollmentConfirm;

export type EnrollmentRevoke = Readonly<{
  kind: "enrollmentRevoke";
  revokedAuthorityId: AuthorityId;
  reason: string;
}>;

export type ForwardCommand = Readonly<{
  kind: "forwardCommand";
  command: "channel.join" | "channel.leave" | "message.send" | "session.lookup";
  channelId: string;
  sessionId: string;
  body?: string;
  cursor?: Cursor;
}>;

export type DeliveryItem = Readonly<{
  cursor: Cursor;
  kind: "message" | "membership" | "lifecycle";
  channelId: string;
  sessionId: string;
  body?: string;
}>;

export type DeliveryBatch = Readonly<{
  kind: "deliveryBatch";
  channelId: string;
  recipientSessionId: string;
  cursorStart: Cursor;
  cursorEnd: Cursor;
  items: readonly DeliveryItem[];
}>;

export type DeliveryAck = Readonly<{
  kind: "deliveryAck";
  channelId: string;
  recipientSessionId: string;
  cursor: Cursor;
}>;

export type FederationError = Readonly<{
  kind: "error";
  code: "unauthorized" | "unknownAuthority" | "invalidRequest" | "expired" | "duplicate" | "unavailable";
  message: string;
}>;

export type PeerPayload =
  | EnrollmentRevoke
  | ForwardCommand
  | DeliveryBatch
  | DeliveryAck
  | FederationError;

export type PeerEnvelope = Readonly<{
  version: typeof FEDERATION_PROTOCOL_VERSION;
  envelopeId: string;
  requestId: string;
  deduplicationId: string;
  createdAt: string;
  expiresAt: string;
  origin: HomeRef;
  destination: HomeRef;
  payload: PeerPayload;
}>;

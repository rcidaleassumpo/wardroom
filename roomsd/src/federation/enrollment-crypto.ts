// SPDX-License-Identifier: Apache-2.0
/**
 * Pure Ed25519 signing/verification and canonical-transcript helpers for mutual peer
 * enrollment. No filesystem access lives here; see enrollment.ts for the stage machine
 * and durable ledger that use these primitives.
 */

import { createHash, createPublicKey, randomBytes, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { authorityId as toAuthorityId } from "./codec.js";
import type { AuthorityId, FederationTransportPolicy } from "./contracts.js";

export const ENROLLMENT_TRANSCRIPT_DOMAIN = "rooms-federation-enrollment-v1";
export const ENROLLMENT_NONCE_BYTES = 32; // 256 bits

export class EnrollmentCryptoError extends Error {
  constructor(message: string) {
    super(`Rooms peer enrollment: ${message}`);
    this.name = "EnrollmentCryptoError";
  }
}

/** Re-derives the canonical SPKI DER of a presented key rather than trusting caller bytes verbatim, so no alternate-but-equivalent DER encoding can produce ambiguous fingerprints. */
export function canonicalPublicKeyDerFromSpkiBase64(spkiBase64: string): Buffer {
  let der: Buffer;
  try {
    der = Buffer.from(spkiBase64, "base64");
  } catch {
    throw new EnrollmentCryptoError("public key is not valid base64");
  }
  let key: KeyObject;
  try {
    key = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new EnrollmentCryptoError("public key is not a valid SPKI-encoded key");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new EnrollmentCryptoError("public key must be Ed25519");
  return key.export({ type: "spki", format: "der" }) as Buffer;
}

export function publicKeyFromCanonicalDer(der: Buffer): KeyObject {
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

export function spkiBase64FromPublicKey(publicKey: KeyObject): string {
  return (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
}

export function fingerprintForDer(der: Buffer): string {
  return createHash("sha256").update(der).digest("hex");
}

export function authorityIdForDer(der: Buffer): AuthorityId {
  return toAuthorityId(`authority-${fingerprintForDer(der)}`);
}

export function generateEnrollmentNonce(): string {
  return randomBytes(ENROLLMENT_NONCE_BYTES).toString("hex");
}

export type EnrollmentTranscriptFields = Readonly<{
  domainKind: "offer" | "challenge" | "accept" | "confirm";
  version: number;
  enrollmentId: string;
  origin: AuthorityId;
  destination: AuthorityId;
  originPublicKeySpkiB64: string;
  originFingerprint: string;
  originTransportPolicy: FederationTransportPolicy;
  destinationPublicKeySpkiB64: string | null;
  destinationFingerprint: string | null;
  destinationTransportPolicy: FederationTransportPolicy | null;
  originNonce: string;
  destinationNonce: string | null;
  issuedAt: string;
  expiresAt: string;
}>;

/** Deterministic, domain-separated re-serialization: signatures cover this fixed field order, never the raw wire JSON, so field reordering in transit cannot create ambiguity. */
export function canonicalEnrollmentTranscript(fields: EnrollmentTranscriptFields): Buffer {
  const ordered = {
    version: fields.version,
    enrollmentId: fields.enrollmentId,
    origin: fields.origin,
    destination: fields.destination,
    originPublicKeySpkiB64: fields.originPublicKeySpkiB64,
    originFingerprint: fields.originFingerprint,
    originTransportPolicy: fields.originTransportPolicy,
    destinationPublicKeySpkiB64: fields.destinationPublicKeySpkiB64,
    destinationFingerprint: fields.destinationFingerprint,
    destinationTransportPolicy: fields.destinationTransportPolicy,
    originNonce: fields.originNonce,
    destinationNonce: fields.destinationNonce,
    issuedAt: fields.issuedAt,
    expiresAt: fields.expiresAt,
  };
  return Buffer.from(`${ENROLLMENT_TRANSCRIPT_DOMAIN}:${fields.domainKind}\n${JSON.stringify(ordered)}`, "utf8");
}

export function signEnrollmentTranscript(privateKey: KeyObject, transcript: Buffer): string {
  return edSign(null, transcript, privateKey).toString("base64");
}

export function verifyEnrollmentTranscript(publicKey: KeyObject, transcript: Buffer, signatureB64: string): boolean {
  let signature: Buffer;
  try {
    signature = Buffer.from(signatureB64, "base64");
  } catch {
    return false;
  }
  if (signature.length !== 64) return false;
  try {
    return edVerify(null, transcript, publicKey, signature);
  } catch {
    return false;
  }
}

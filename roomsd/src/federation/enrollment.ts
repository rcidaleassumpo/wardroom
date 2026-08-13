// SPDX-License-Identifier: Apache-2.0
/**
 * Mutual peer enrollment stage machine: cryptographically authenticated, replay-resistant
 * offer -> challenge -> accept -> confirm -> finalize. Every stage is a pure local
 * transform over a CLI-supplied artifact file plus this Rooms identity's own signing key;
 * none of it contacts a peer or opens a listener. See roomsd/docs/federation-architecture.md
 * for the full protocol writeup.
 */

import { randomUUID } from "node:crypto";
import { closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assertBoundedEnrollmentArtifact,
  parseEnrollmentArtifactJson,
  validateEnrollmentOffer,
  validateEnrollmentChallenge,
  validateEnrollmentAccept,
  validateEnrollmentConfirm,
  validateTransportPolicy,
} from "./codec.js";
import {
  canonicalEnrollmentTranscript,
  canonicalPublicKeyDerFromSpkiBase64,
  fingerprintForDer,
  generateEnrollmentNonce,
  publicKeyFromCanonicalDer,
  signEnrollmentTranscript,
  spkiBase64FromPublicKey,
  verifyEnrollmentTranscript,
} from "./enrollment-crypto.js";
import { loadMachineSigningKeys, resolveRoomsStateDir } from "../identity/machine-identity.js";
import { advancePeerTrustFromEnrollmentProof, assertWellFormedAuthorityId, type PeerTrustRecord } from "./peer-trust.js";
import { FEDERATION_PROTOCOL_VERSION, type AuthorityId, type EnrollmentAccept, type EnrollmentChallenge, type EnrollmentConfirm, type EnrollmentOffer, type FederationTransportPolicy } from "./contracts.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_TTL_SECONDS = 300;
const MIN_TTL_SECONDS = 30;
const MAX_TTL_SECONDS = 3600;
const CLOCK_SKEW_TOLERANCE_MS = 30_000;

export class EnrollmentError extends Error {
  constructor(message: string) {
    super(`Rooms peer enrollment: ${message}`);
    this.name = "EnrollmentError";
  }
}

type EnrollmentRole = "initiator" | "responder";
type EnrollmentLedgerStage = "offered" | "challenged" | "accepted" | "confirmed";

type EnrollmentLedgerEntry = Readonly<{
  version: 1;
  enrollmentId: string;
  role: EnrollmentRole;
  stage: EnrollmentLedgerStage;
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
  createdAt: string;
  updatedAt: string;
}>;

export function createEnrollmentOffer(input: Readonly<{
  stateDir?: string;
  peerAuthorityId: string;
  transportPolicy: unknown;
  ttlSeconds?: number;
}>): EnrollmentOffer {
  const stateDir = resolveRoomsStateDir(input.stateDir);
  const keys = loadMachineSigningKeys(stateDir);
  const origin = keys.authorityId as AuthorityId;
  const destination = assertWellFormedAuthorityId(input.peerAuthorityId);
  if (origin === destination) throw new EnrollmentError("cannot enroll with this Rooms identity's own authority id (self-pair)");

  validateTransportPolicy(input.transportPolicy);
  const originTransportPolicy = input.transportPolicy as FederationTransportPolicy;
  assertTransportPeerMatches(originTransportPolicy, destination, "transport policy");

  const ttlSeconds = boundedTtlSeconds(input.ttlSeconds);
  const now = Date.now();
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlSeconds * 1000).toISOString();

  const originPublicKeySpkiB64 = spkiBase64FromPublicKey(keys.publicKey);
  const originDer = canonicalPublicKeyDerFromSpkiBase64(originPublicKeySpkiB64);
  const originFingerprint = fingerprintForDer(originDer);
  const originNonce = generateEnrollmentNonce();
  const enrollmentId = randomUUID();

  const transcript = canonicalEnrollmentTranscript({
    domainKind: "offer", version: FEDERATION_PROTOCOL_VERSION, enrollmentId, origin, destination,
    originPublicKeySpkiB64, originFingerprint, originTransportPolicy,
    destinationPublicKeySpkiB64: null, destinationFingerprint: null, destinationTransportPolicy: null,
    originNonce, destinationNonce: null, issuedAt, expiresAt,
  });
  const signature = signEnrollmentTranscript(keys.privateKey, transcript);

  const artifact: EnrollmentOffer = {
    kind: "enrollmentOffer", version: FEDERATION_PROTOCOL_VERSION, enrollmentId, origin, destination,
    originPublicKeySpkiB64, originFingerprint, originTransportPolicy, originNonce, issuedAt, expiresAt, signature,
  };
  validateEnrollmentOffer(artifact);

  createLedgerEntry(stateDir, {
    version: 1, enrollmentId, role: "initiator", stage: "offered", origin, destination,
    originPublicKeySpkiB64, originFingerprint, originTransportPolicy,
    destinationPublicKeySpkiB64: null, destinationFingerprint: null, destinationTransportPolicy: null,
    originNonce, destinationNonce: null, issuedAt, expiresAt,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });

  return artifact;
}

export function createEnrollmentChallenge(input: Readonly<{ stateDir?: string; offerRaw: string; transportPolicy: unknown }>): Readonly<{ artifact: EnrollmentChallenge; peer: PeerTrustRecord }> {
  assertBoundedEnrollmentArtifact(input.offerRaw, "enrollment offer");
  const offer = parseArtifact(input.offerRaw, "enrollment offer");
  validateEnrollmentOffer(offer);

  const stateDir = resolveRoomsStateDir(input.stateDir);
  const keys = loadMachineSigningKeys(stateDir);
  const destination = keys.authorityId as AuthorityId;
  if (offer.destination !== destination) throw new EnrollmentError("wrong destination: enrollment offer is not addressed to this Rooms identity");
  if (offer.origin === destination) throw new EnrollmentError("reflection: enrollment offer origin cannot be this Rooms identity");

  assertNotExpired(offer.issuedAt, offer.expiresAt);
  const originDer = canonicalPublicKeyDerFromSpkiBase64(offer.originPublicKeySpkiB64);
  assertKeyMatchesArtifact(originDer, offer.origin, offer.originFingerprint, "origin");
  const offerTranscript = canonicalEnrollmentTranscript({
    domainKind: "offer", version: offer.version, enrollmentId: offer.enrollmentId, origin: offer.origin, destination: offer.destination,
    originPublicKeySpkiB64: offer.originPublicKeySpkiB64, originFingerprint: offer.originFingerprint, originTransportPolicy: offer.originTransportPolicy,
    destinationPublicKeySpkiB64: null, destinationFingerprint: null, destinationTransportPolicy: null,
    originNonce: offer.originNonce, destinationNonce: null, issuedAt: offer.issuedAt, expiresAt: offer.expiresAt,
  });
  if (!verifyEnrollmentTranscript(publicKeyFromCanonicalDer(originDer), offerTranscript, offer.signature)) {
    throw new EnrollmentError("enrollment offer signature is invalid");
  }

  if (readLedgerEntry(stateDir, offer.enrollmentId)) throw new EnrollmentError("replay: this enrollment id has already been processed");

  validateTransportPolicy(input.transportPolicy);
  const destinationTransportPolicy = input.transportPolicy as FederationTransportPolicy;
  assertTransportPeerMatches(destinationTransportPolicy, offer.origin, "transport policy");

  const originPem = pemFromDer(originDer);
  const peer = advancePeerTrustFromEnrollmentProof({
    stateDir, authorityId: offer.origin, publicKeyPem: originPem, transportPolicy: destinationTransportPolicy, toState: "confirming",
  });

  const destinationPublicKeySpkiB64 = spkiBase64FromPublicKey(keys.publicKey);
  const destinationDer = canonicalPublicKeyDerFromSpkiBase64(destinationPublicKeySpkiB64);
  const destinationFingerprint = fingerprintForDer(destinationDer);
  const destinationNonce = generateEnrollmentNonce();

  const transcript = canonicalEnrollmentTranscript({
    domainKind: "challenge", version: offer.version, enrollmentId: offer.enrollmentId, origin: offer.origin, destination: offer.destination,
    originPublicKeySpkiB64: offer.originPublicKeySpkiB64, originFingerprint: offer.originFingerprint, originTransportPolicy: offer.originTransportPolicy,
    destinationPublicKeySpkiB64, destinationFingerprint, destinationTransportPolicy,
    originNonce: offer.originNonce, destinationNonce, issuedAt: offer.issuedAt, expiresAt: offer.expiresAt,
  });
  const signature = signEnrollmentTranscript(keys.privateKey, transcript);

  const artifact: EnrollmentChallenge = {
    kind: "enrollmentChallenge", version: offer.version, enrollmentId: offer.enrollmentId, origin: offer.origin, destination: offer.destination,
    originPublicKeySpkiB64: offer.originPublicKeySpkiB64, originFingerprint: offer.originFingerprint, originTransportPolicy: offer.originTransportPolicy,
    destinationPublicKeySpkiB64, destinationFingerprint, destinationTransportPolicy,
    originNonce: offer.originNonce, destinationNonce, issuedAt: offer.issuedAt, expiresAt: offer.expiresAt, signature,
  };
  validateEnrollmentChallenge(artifact);

  const now = new Date().toISOString();
  createLedgerEntry(stateDir, {
    version: 1, enrollmentId: offer.enrollmentId, role: "responder", stage: "challenged", origin: offer.origin, destination: offer.destination,
    originPublicKeySpkiB64: offer.originPublicKeySpkiB64, originFingerprint: offer.originFingerprint, originTransportPolicy: offer.originTransportPolicy,
    destinationPublicKeySpkiB64, destinationFingerprint, destinationTransportPolicy,
    originNonce: offer.originNonce, destinationNonce, issuedAt: offer.issuedAt, expiresAt: offer.expiresAt,
    createdAt: now, updatedAt: now,
  });

  return { artifact, peer };
}

export function createEnrollmentAccept(input: Readonly<{ stateDir?: string; challengeRaw: string }>): Readonly<{ artifact: EnrollmentAccept; peer: PeerTrustRecord }> {
  assertBoundedEnrollmentArtifact(input.challengeRaw, "enrollment challenge");
  const challenge = parseArtifact(input.challengeRaw, "enrollment challenge");
  validateEnrollmentChallenge(challenge);

  const stateDir = resolveRoomsStateDir(input.stateDir);
  const keys = loadMachineSigningKeys(stateDir);
  const origin = keys.authorityId as AuthorityId;
  if (challenge.origin !== origin) throw new EnrollmentError("wrong destination: enrollment challenge is not addressed back to this Rooms identity");
  if (challenge.destination === origin) throw new EnrollmentError("reflection: enrollment challenge destination cannot be this Rooms identity");

  const ledger = readLedgerEntry(stateDir, challenge.enrollmentId);
  if (!ledger || ledger.role !== "initiator") throw new EnrollmentError("no matching local enrollment offer found for this enrollment id");
  if (ledger.stage !== "offered") throw new EnrollmentError("replay: this enrollment has already advanced past its offer stage");
  assertEchoesLedgerOrigin(challenge, ledger);

  assertNotExpired(challenge.issuedAt, challenge.expiresAt);
  const destinationDer = canonicalPublicKeyDerFromSpkiBase64(challenge.destinationPublicKeySpkiB64);
  assertKeyMatchesArtifact(destinationDer, challenge.destination, challenge.destinationFingerprint, "destination");
  const transcript = canonicalEnrollmentTranscript({
    domainKind: "challenge", version: challenge.version, enrollmentId: challenge.enrollmentId, origin: challenge.origin, destination: challenge.destination,
    originPublicKeySpkiB64: challenge.originPublicKeySpkiB64, originFingerprint: challenge.originFingerprint, originTransportPolicy: challenge.originTransportPolicy,
    destinationPublicKeySpkiB64: challenge.destinationPublicKeySpkiB64, destinationFingerprint: challenge.destinationFingerprint, destinationTransportPolicy: challenge.destinationTransportPolicy,
    originNonce: challenge.originNonce, destinationNonce: challenge.destinationNonce, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt,
  });
  if (!verifyEnrollmentTranscript(publicKeyFromCanonicalDer(destinationDer), transcript, challenge.signature)) {
    throw new EnrollmentError("enrollment challenge signature is invalid");
  }

  const destinationPem = pemFromDer(destinationDer);
  const peer = advancePeerTrustFromEnrollmentProof({
    stateDir, authorityId: challenge.destination, publicKeyPem: destinationPem, transportPolicy: ledger.originTransportPolicy, toState: "confirming",
  });

  const acceptTranscript = canonicalEnrollmentTranscript({
    domainKind: "accept", version: challenge.version, enrollmentId: challenge.enrollmentId, origin: challenge.origin, destination: challenge.destination,
    originPublicKeySpkiB64: challenge.originPublicKeySpkiB64, originFingerprint: challenge.originFingerprint, originTransportPolicy: challenge.originTransportPolicy,
    destinationPublicKeySpkiB64: challenge.destinationPublicKeySpkiB64, destinationFingerprint: challenge.destinationFingerprint, destinationTransportPolicy: challenge.destinationTransportPolicy,
    originNonce: challenge.originNonce, destinationNonce: challenge.destinationNonce, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt,
  });
  const signature = signEnrollmentTranscript(keys.privateKey, acceptTranscript);

  const artifact: EnrollmentAccept = {
    kind: "enrollmentAccept", version: challenge.version, enrollmentId: challenge.enrollmentId, origin: challenge.origin, destination: challenge.destination,
    originPublicKeySpkiB64: challenge.originPublicKeySpkiB64, originFingerprint: challenge.originFingerprint, originTransportPolicy: challenge.originTransportPolicy,
    destinationPublicKeySpkiB64: challenge.destinationPublicKeySpkiB64, destinationFingerprint: challenge.destinationFingerprint, destinationTransportPolicy: challenge.destinationTransportPolicy,
    originNonce: challenge.originNonce, destinationNonce: challenge.destinationNonce, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt, signature,
  };
  validateEnrollmentAccept(artifact);

  updateLedgerEntry(stateDir, { ...ledger,
    stage: "accepted",
    destinationPublicKeySpkiB64: challenge.destinationPublicKeySpkiB64, destinationFingerprint: challenge.destinationFingerprint, destinationTransportPolicy: challenge.destinationTransportPolicy,
    destinationNonce: challenge.destinationNonce, updatedAt: new Date().toISOString(),
  });

  return { artifact, peer };
}

export function createEnrollmentConfirm(input: Readonly<{ stateDir?: string; acceptRaw: string }>): Readonly<{ artifact: EnrollmentConfirm; peer: PeerTrustRecord }> {
  assertBoundedEnrollmentArtifact(input.acceptRaw, "enrollment accept");
  const accept = parseArtifact(input.acceptRaw, "enrollment accept");
  validateEnrollmentAccept(accept);

  const stateDir = resolveRoomsStateDir(input.stateDir);
  const keys = loadMachineSigningKeys(stateDir);
  const destination = keys.authorityId as AuthorityId;
  if (accept.destination !== destination) throw new EnrollmentError("wrong destination: enrollment accept is not addressed to this Rooms identity");

  const ledger = readLedgerEntry(stateDir, accept.enrollmentId);
  if (!ledger || ledger.role !== "responder") throw new EnrollmentError("no matching local enrollment challenge found for this enrollment id");
  if (ledger.stage !== "challenged") throw new EnrollmentError("replay: this enrollment has already advanced past its challenge stage");
  assertEchoesLedgerFull(accept, ledger);

  assertNotExpired(accept.issuedAt, accept.expiresAt);
  const originDer = canonicalPublicKeyDerFromSpkiBase64(accept.originPublicKeySpkiB64);
  assertKeyMatchesArtifact(originDer, accept.origin, accept.originFingerprint, "origin");
  const transcript = canonicalEnrollmentTranscript({
    domainKind: "accept", version: accept.version, enrollmentId: accept.enrollmentId, origin: accept.origin, destination: accept.destination,
    originPublicKeySpkiB64: accept.originPublicKeySpkiB64, originFingerprint: accept.originFingerprint, originTransportPolicy: accept.originTransportPolicy,
    destinationPublicKeySpkiB64: accept.destinationPublicKeySpkiB64, destinationFingerprint: accept.destinationFingerprint, destinationTransportPolicy: accept.destinationTransportPolicy,
    originNonce: accept.originNonce, destinationNonce: accept.destinationNonce, issuedAt: accept.issuedAt, expiresAt: accept.expiresAt,
  });
  if (!verifyEnrollmentTranscript(publicKeyFromCanonicalDer(originDer), transcript, accept.signature)) {
    throw new EnrollmentError("enrollment accept signature is invalid");
  }

  const originPem = pemFromDer(originDer);
  const peer = advancePeerTrustFromEnrollmentProof({
    stateDir, authorityId: accept.origin, publicKeyPem: originPem, transportPolicy: ledger.destinationTransportPolicy!, toState: "active",
  });

  const confirmTranscript = canonicalEnrollmentTranscript({
    domainKind: "confirm", version: accept.version, enrollmentId: accept.enrollmentId, origin: accept.origin, destination: accept.destination,
    originPublicKeySpkiB64: accept.originPublicKeySpkiB64, originFingerprint: accept.originFingerprint, originTransportPolicy: accept.originTransportPolicy,
    destinationPublicKeySpkiB64: accept.destinationPublicKeySpkiB64, destinationFingerprint: accept.destinationFingerprint, destinationTransportPolicy: accept.destinationTransportPolicy,
    originNonce: accept.originNonce, destinationNonce: accept.destinationNonce, issuedAt: accept.issuedAt, expiresAt: accept.expiresAt,
  });
  const signature = signEnrollmentTranscript(keys.privateKey, confirmTranscript);

  const artifact: EnrollmentConfirm = {
    kind: "enrollmentConfirm", version: accept.version, enrollmentId: accept.enrollmentId, origin: accept.origin, destination: accept.destination,
    originPublicKeySpkiB64: accept.originPublicKeySpkiB64, originFingerprint: accept.originFingerprint, originTransportPolicy: accept.originTransportPolicy,
    destinationPublicKeySpkiB64: accept.destinationPublicKeySpkiB64, destinationFingerprint: accept.destinationFingerprint, destinationTransportPolicy: accept.destinationTransportPolicy,
    originNonce: accept.originNonce, destinationNonce: accept.destinationNonce, issuedAt: accept.issuedAt, expiresAt: accept.expiresAt, signature,
  };
  validateEnrollmentConfirm(artifact);

  updateLedgerEntry(stateDir, { ...ledger, stage: "confirmed", updatedAt: new Date().toISOString() });

  return { artifact, peer };
}

export function finalizeEnrollment(input: Readonly<{ stateDir?: string; confirmRaw: string }>): Readonly<{ peer: PeerTrustRecord }> {
  assertBoundedEnrollmentArtifact(input.confirmRaw, "enrollment confirm");
  const confirm = parseArtifact(input.confirmRaw, "enrollment confirm");
  validateEnrollmentConfirm(confirm);

  const stateDir = resolveRoomsStateDir(input.stateDir);
  const keys = loadMachineSigningKeys(stateDir);
  const origin = keys.authorityId as AuthorityId;
  if (confirm.origin !== origin) throw new EnrollmentError("wrong destination: enrollment confirm is not addressed to this Rooms identity");

  const ledger = readLedgerEntry(stateDir, confirm.enrollmentId);
  if (!ledger || ledger.role !== "initiator") throw new EnrollmentError("no matching local enrollment accept found for this enrollment id");
  if (ledger.stage !== "accepted") throw new EnrollmentError("replay: this enrollment has already advanced past its accept stage");
  assertEchoesLedgerFull(confirm, ledger);

  assertNotExpired(confirm.issuedAt, confirm.expiresAt);
  const destinationDer = canonicalPublicKeyDerFromSpkiBase64(confirm.destinationPublicKeySpkiB64);
  assertKeyMatchesArtifact(destinationDer, confirm.destination, confirm.destinationFingerprint, "destination");
  const transcript = canonicalEnrollmentTranscript({
    domainKind: "confirm", version: confirm.version, enrollmentId: confirm.enrollmentId, origin: confirm.origin, destination: confirm.destination,
    originPublicKeySpkiB64: confirm.originPublicKeySpkiB64, originFingerprint: confirm.originFingerprint, originTransportPolicy: confirm.originTransportPolicy,
    destinationPublicKeySpkiB64: confirm.destinationPublicKeySpkiB64, destinationFingerprint: confirm.destinationFingerprint, destinationTransportPolicy: confirm.destinationTransportPolicy,
    originNonce: confirm.originNonce, destinationNonce: confirm.destinationNonce, issuedAt: confirm.issuedAt, expiresAt: confirm.expiresAt,
  });
  if (!verifyEnrollmentTranscript(publicKeyFromCanonicalDer(destinationDer), transcript, confirm.signature)) {
    throw new EnrollmentError("enrollment confirm signature is invalid");
  }

  const destinationPem = pemFromDer(destinationDer);
  const peer = advancePeerTrustFromEnrollmentProof({
    stateDir, authorityId: confirm.destination, publicKeyPem: destinationPem, transportPolicy: ledger.originTransportPolicy, toState: "active",
  });

  updateLedgerEntry(stateDir, { ...ledger, stage: "confirmed", updatedAt: new Date().toISOString() });

  return { peer };
}

function boundedTtlSeconds(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(value) || value < MIN_TTL_SECONDS || value > MAX_TTL_SECONDS) {
    throw new EnrollmentError(`ttlSeconds must be an integer between ${MIN_TTL_SECONDS} and ${MAX_TTL_SECONDS}`);
  }
  return value;
}

function assertTransportPeerMatches(policy: FederationTransportPolicy, expectedPeer: AuthorityId, field: string): void {
  if ((policy.kind === "loopbackSsh" || policy.kind === "tailscalePeer") && policy.peerAuthorityId !== expectedPeer) {
    throw new EnrollmentError(`${field}.peerAuthorityId does not match the enrollment peer; transport substitution`);
  }
}

function assertNotExpired(issuedAt: string, expiresAt: string): void {
  const now = Date.now();
  const issuedAtMs = Date.parse(issuedAt);
  const expiresAtMs = Date.parse(expiresAt);
  if (expiresAtMs <= now) throw new EnrollmentError("expired: enrollment artifact has passed its expiresAt");
  if (issuedAtMs - now > CLOCK_SKEW_TOLERANCE_MS) throw new EnrollmentError("expiry/clock-skew violation: enrollment artifact issuedAt is too far in the future");
}

function assertKeyMatchesArtifact(der: Buffer, authorityId: AuthorityId, fingerprint: string, label: "origin" | "destination"): void {
  const computedFingerprint = fingerprintForDer(der);
  if (computedFingerprint !== fingerprint) throw new EnrollmentError(`${label} fingerprint does not match ${label} public key`);
  const computedAuthorityId = `authority-${computedFingerprint}`;
  if (computedAuthorityId !== authorityId) throw new EnrollmentError(`${label} AuthorityId does not match ${label} public key; authority mismatch`);
}

function assertEchoesLedgerOrigin(artifact: EnrollmentChallenge, ledger: EnrollmentLedgerEntry): void {
  if (
    artifact.origin !== ledger.origin || artifact.destination !== ledger.destination ||
    artifact.originPublicKeySpkiB64 !== ledger.originPublicKeySpkiB64 || artifact.originFingerprint !== ledger.originFingerprint ||
    !sameTransportPolicy(artifact.originTransportPolicy, ledger.originTransportPolicy) ||
    artifact.originNonce !== ledger.originNonce || artifact.issuedAt !== ledger.issuedAt || artifact.expiresAt !== ledger.expiresAt
  ) {
    throw new EnrollmentError("mutation: enrollment challenge does not echo the original offer fields");
  }
}

function assertEchoesLedgerFull(artifact: EnrollmentAccept | EnrollmentConfirm, ledger: EnrollmentLedgerEntry): void {
  if (
    artifact.origin !== ledger.origin || artifact.destination !== ledger.destination ||
    artifact.originPublicKeySpkiB64 !== ledger.originPublicKeySpkiB64 || artifact.originFingerprint !== ledger.originFingerprint ||
    !sameTransportPolicy(artifact.originTransportPolicy, ledger.originTransportPolicy) ||
    artifact.destinationPublicKeySpkiB64 !== ledger.destinationPublicKeySpkiB64 || artifact.destinationFingerprint !== ledger.destinationFingerprint ||
    !sameTransportPolicy(artifact.destinationTransportPolicy, ledger.destinationTransportPolicy) ||
    artifact.originNonce !== ledger.originNonce || artifact.destinationNonce !== ledger.destinationNonce ||
    artifact.issuedAt !== ledger.issuedAt || artifact.expiresAt !== ledger.expiresAt
  ) {
    throw new EnrollmentError("mutation: enrollment artifact does not echo its predecessor's fields");
  }
}

function sameTransportPolicy(left: FederationTransportPolicy | null, right: FederationTransportPolicy | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pemFromDer(der: Buffer): string {
  return publicKeyFromCanonicalDer(der).export({ type: "spki", format: "pem" }).toString();
}

function parseArtifact(raw: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = parseEnrollmentArtifactJson(raw);
  } catch (error) {
    throw new EnrollmentError(`${label} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EnrollmentError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function enrollmentsDir(stateDir: string): string {
  const federationDir = join(stateDir, "federation");
  const dir = join(federationDir, "enrollments");
  assertSafePath(dir);
  if (!existsAsAny(dir)) mkdirSync(dir, { mode: DIRECTORY_MODE });
  assertRegularDirectory(dir, "federation enrollments directory");
  assertMode(dir, DIRECTORY_MODE, "federation enrollments directory");
  return dir;
}

function ledgerPath(stateDir: string, enrollmentId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(enrollmentId)) {
    throw new EnrollmentError("enrollmentId must be a UUID");
  }
  const path = join(enrollmentsDir(stateDir), `${enrollmentId}.json`);
  assertSafePath(path);
  return path;
}

function readLedgerEntry(stateDir: string, enrollmentId: string): EnrollmentLedgerEntry | null {
  const path = ledgerPath(stateDir, enrollmentId);
  if (!existsAsAny(path)) return null;
  assertRegularNonSymlink(path, "enrollment ledger entry");
  assertMode(path, FILE_MODE, "enrollment ledger entry");
  return parseLedgerEntry(readFileSync(path, "utf8"), enrollmentId);
}

function createLedgerEntry(stateDir: string, entry: EnrollmentLedgerEntry): void {
  const path = ledgerPath(stateDir, entry.enrollmentId);
  const fd = openSync(path, "wx", FILE_MODE);
  try {
    fchmodSync(fd, FILE_MODE);
    writeFileSync(fd, `${JSON.stringify(entry, null, 2)}\n`, { encoding: "utf8" });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  assertMode(path, FILE_MODE, "enrollment ledger entry");
}

function updateLedgerEntry(stateDir: string, entry: EnrollmentLedgerEntry): void {
  const path = ledgerPath(stateDir, entry.enrollmentId);
  const temporary = join(enrollmentsDir(stateDir), `.${entry.enrollmentId}.json.tmp-${randomUUID()}`);
  const fd = openSync(temporary, "wx", FILE_MODE);
  try {
    fchmodSync(fd, FILE_MODE);
    writeFileSync(fd, `${JSON.stringify(entry, null, 2)}\n`, { encoding: "utf8" });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  assertMode(path, FILE_MODE, "enrollment ledger entry");
}

function parseLedgerEntry(serialized: string, expectedEnrollmentId: string): EnrollmentLedgerEntry {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new EnrollmentError("enrollment ledger entry is malformed JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EnrollmentError("enrollment ledger entry must be an object");
  const record = value as Record<string, unknown>;
  if (record.enrollmentId !== expectedEnrollmentId) throw new EnrollmentError("enrollment ledger entry id does not match its storage location");
  return record as unknown as EnrollmentLedgerEntry;
}

function assertSafePath(path: string): void {
  const absolute = resolve(path);
  let current = "/";
  for (const component of absolute.split("/").filter(Boolean)) {
    current = join(current, component);
    if (!existsAsAny(current)) break;
    if (lstatSync(current).isSymbolicLink()) throw new EnrollmentError(`path contains a symlink: ${current}`);
  }
}

function existsAsAny(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertRegularNonSymlink(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new EnrollmentError(`${label} must not be a symlink`);
  if (!stat.isFile()) throw new EnrollmentError(`${label} must be a regular file`);
}

function assertRegularDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new EnrollmentError(`${label} must not be a symlink`);
  if (!stat.isDirectory()) throw new EnrollmentError(`${label} must be a directory`);
}

function assertMode(path: string, mode: number, label: string): void {
  const actual = statSync(path).mode & 0o777;
  if (actual !== mode) throw new EnrollmentError(`${label} permissions must be ${mode.toString(8)}, found ${actual.toString(8)}`);
}

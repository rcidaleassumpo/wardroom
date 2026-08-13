// SPDX-License-Identifier: Apache-2.0
import {
  FEDERATION_PROTOCOL_VERSION,
  type AuthorityId,
  type Cursor,
  type HomeRef,
  type PeerEnvelope,
  type PeerPayload,
  type FederationTransportPolicy,
  type EnrollmentOffer,
  type EnrollmentChallenge,
  type EnrollmentAccept,
  type EnrollmentConfirm,
} from "./contracts.js";
import { isIP } from "node:net";

const KINDS = new Set([
  "enrollmentRevoke",
  "forwardCommand", "deliveryBatch", "deliveryAck", "error",
]);
const COMMANDS = new Set(["channel.join", "channel.leave", "message.send", "session.lookup"]);
const DELIVERY_KINDS = new Set(["message", "membership", "lifecycle"]);
const ERROR_CODES = new Set(["unauthorized", "unknownAuthority", "invalidRequest", "expired", "duplicate", "unavailable"]);
const AUTHORITY_KEYS = new Set(["origin", "destination", "home", "sourceAuthorityId", "targetAuthorityId"]);
const IPV4_TAILSCALE = /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.(?:[0-9]{1,3})\.(?:[0-9]{1,3})$/;

type UnknownRecord = Record<string, unknown>;

export class FederationCodecError extends Error {
  constructor(message: string) {
    super(`invalid Rooms federation envelope: ${message}`);
    this.name = "FederationCodecError";
  }
}

export function authorityId(value: string): AuthorityId {
  if (!nonBlank(value)) throw new FederationCodecError("authority id must be non-blank");
  return value as AuthorityId;
}

export function homeRef(value: { authorityId: string }): HomeRef {
  return { authorityId: authorityId(value.authorityId) } as HomeRef;
}

export function cursor(value: string): Cursor {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new FederationCodecError("cursor must be a non-negative decimal string");
  return value as Cursor;
}

export function validateTransportPolicy(value: unknown, now = Date.now()): asserts value is FederationTransportPolicy {
  const policy = record(value, "transport policy");
  if (typeof policy.kind !== "string" || !["localUnix", "loopbackSsh", "tailscalePeer"].includes(policy.kind)) {
    throw new FederationCodecError("transport policy kind is not supported");
  }
  switch (policy.kind) {
    case "localUnix":
      exactKeys(policy, ["kind", "path"], policy.kind);
      absolutePath(policy.path, "local Unix path");
      return;
    case "loopbackSsh":
      exactKeys(policy, ["kind", "peerAuthorityId", "sshDestination", "sshUser", "localEndpoint", "localPort"], policy.kind);
      authorityField(policy.peerAuthorityId, "peerAuthorityId");
      nonBlankField(policy.sshDestination, "SSH destination");
      nonBlankField(policy.sshUser, "SSH user");
      if (policy.localEndpoint !== "127.0.0.1" && policy.localEndpoint !== "::1" && policy.localEndpoint !== "localhost") {
        throw new FederationCodecError("loopback SSH Rooms endpoint must be 127.0.0.1, ::1, or localhost");
      }
      port(policy.localPort, "loopback SSH local port");
      return;
    case "tailscalePeer":
      exactKeys(policy, ["kind", "peerAuthorityId", "address", "nodeIdentity", "verifiedAt"], policy.kind);
      if (!isTailscaleAddress(policy.address)) throw new FederationCodecError("tailscale peer requires a verified Tailscale address");
      authorityField(policy.peerAuthorityId, "peerAuthorityId");
      nonBlankField(policy.nodeIdentity, "Tailscale node identity");
      const verifiedAt = timestamp(policy.verifiedAt, "verifiedAt");
      if (verifiedAt > now) throw new FederationCodecError("verifiedAt cannot be in the future");
      return;
  }
}

export const ENROLLMENT_MAX_ARTIFACT_BYTES = 8192;
const ENROLLMENT_MIN_NONCE_HEX_LENGTH = 64; // 256 bits
const ENROLLMENT_MAX_TTL_MS = 60 * 60 * 1000;
const ENROLLMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Restricted to a UUID shape: enrollmentId is used to build a durable ledger filename, so it must never admit path separators or traversal sequences. */
function enrollmentIdField(value: unknown, field: string): string {
  const id = nonBlankField(value, field);
  if (!ENROLLMENT_ID_PATTERN.test(id)) throw new FederationCodecError(`${field} must be a UUID`);
  return id;
}

/** Rejects an oversized enrollment artifact before it is ever JSON.parse'd. */
export function assertBoundedEnrollmentArtifact(serialized: string, label: string): void {
  if (Buffer.byteLength(serialized, "utf8") > ENROLLMENT_MAX_ARTIFACT_BYTES) {
    throw new FederationCodecError(`${label} exceeds the maximum artifact size of ${ENROLLMENT_MAX_ARTIFACT_BYTES} bytes`);
  }
}

export function validateEnrollmentOffer(value: unknown, now = Date.now()): asserts value is EnrollmentOffer {
  const offer = record(value, "enrollment offer");
  exactKeys(offer, [
    "kind", "version", "enrollmentId", "origin", "destination",
    "originPublicKeySpkiB64", "originFingerprint", "originTransportPolicy",
    "originNonce", "issuedAt", "expiresAt", "signature",
  ], "enrollment offer");
  if (offer.kind !== "enrollmentOffer") throw new FederationCodecError("enrollment offer kind mismatch");
  versionField(offer.version);
  enrollmentIdField(offer.enrollmentId, "enrollmentId");
  const origin = authorityField(offer.origin, "origin");
  const destination = authorityField(offer.destination, "destination");
  if (origin === destination) throw new FederationCodecError("origin and destination must differ");
  base64Field(offer.originPublicKeySpkiB64, "originPublicKeySpkiB64");
  fingerprintField(offer.originFingerprint, "originFingerprint");
  validateTransportPolicy(offer.originTransportPolicy, now);
  transportPeerMatches(offer.originTransportPolicy, destination, "originTransportPolicy");
  nonceField(offer.originNonce, "originNonce");
  enrollmentWindow(offer.issuedAt, offer.expiresAt);
  base64Field(offer.signature, "signature");
}

function validateEnrollmentTranscript(value: unknown, expectedKind: "enrollmentChallenge" | "enrollmentAccept" | "enrollmentConfirm", now: number): UnknownRecord {
  const artifact = record(value, expectedKind);
  exactKeys(artifact, [
    "kind", "version", "enrollmentId", "origin", "destination",
    "originPublicKeySpkiB64", "originFingerprint", "originTransportPolicy",
    "destinationPublicKeySpkiB64", "destinationFingerprint", "destinationTransportPolicy",
    "originNonce", "destinationNonce", "issuedAt", "expiresAt", "signature",
  ], expectedKind);
  if (artifact.kind !== expectedKind) throw new FederationCodecError(`${expectedKind} kind mismatch`);
  versionField(artifact.version);
  enrollmentIdField(artifact.enrollmentId, "enrollmentId");
  const origin = authorityField(artifact.origin, "origin");
  const destination = authorityField(artifact.destination, "destination");
  if (origin === destination) throw new FederationCodecError("origin and destination must differ");
  base64Field(artifact.originPublicKeySpkiB64, "originPublicKeySpkiB64");
  fingerprintField(artifact.originFingerprint, "originFingerprint");
  validateTransportPolicy(artifact.originTransportPolicy, now);
  transportPeerMatches(artifact.originTransportPolicy, destination, "originTransportPolicy");
  base64Field(artifact.destinationPublicKeySpkiB64, "destinationPublicKeySpkiB64");
  fingerprintField(artifact.destinationFingerprint, "destinationFingerprint");
  validateTransportPolicy(artifact.destinationTransportPolicy, now);
  transportPeerMatches(artifact.destinationTransportPolicy, origin, "destinationTransportPolicy");
  nonceField(artifact.originNonce, "originNonce");
  nonceField(artifact.destinationNonce, "destinationNonce");
  enrollmentWindow(artifact.issuedAt, artifact.expiresAt);
  base64Field(artifact.signature, "signature");
  return artifact;
}

export function validateEnrollmentChallenge(value: unknown, now = Date.now()): asserts value is EnrollmentChallenge {
  validateEnrollmentTranscript(value, "enrollmentChallenge", now);
}

export function validateEnrollmentAccept(value: unknown, now = Date.now()): asserts value is EnrollmentAccept {
  validateEnrollmentTranscript(value, "enrollmentAccept", now);
}

export function validateEnrollmentConfirm(value: unknown, now = Date.now()): asserts value is EnrollmentConfirm {
  validateEnrollmentTranscript(value, "enrollmentConfirm", now);
}

function transportPeerMatches(policy: FederationTransportPolicy, expectedPeer: AuthorityId, field: string): void {
  if ((policy.kind === "loopbackSsh" || policy.kind === "tailscalePeer") && policy.peerAuthorityId !== expectedPeer) {
    throw new FederationCodecError(`${field}.peerAuthorityId does not match the other enrollment party; transport substitution`);
  }
}

function nonceField(value: unknown, field: string): string {
  const nonce = nonBlankField(value, field);
  if (!/^[0-9a-f]+$/.test(nonce) || nonce.length < ENROLLMENT_MIN_NONCE_HEX_LENGTH) {
    throw new FederationCodecError(`${field} must be a lowercase hex string of at least 256 bits`);
  }
  return nonce;
}

function fingerprintField(value: unknown, field: string): string {
  const fingerprint = nonBlankField(value, field);
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new FederationCodecError(`${field} must be a SHA-256 hex fingerprint`);
  return fingerprint;
}

function base64Field(value: unknown, field: string): string {
  const encoded = nonBlankField(value, field);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new FederationCodecError(`${field} must be base64-encoded`);
  }
  return encoded;
}

function enrollmentWindow(issuedAtInput: unknown, expiresAtInput: unknown): void {
  const issuedAt = timestamp(issuedAtInput, "issuedAt");
  const expiresAt = timestamp(expiresAtInput, "expiresAt");
  if (expiresAt <= issuedAt) throw new FederationCodecError("expiresAt must be after issuedAt");
  if (expiresAt - issuedAt > ENROLLMENT_MAX_TTL_MS) {
    throw new FederationCodecError("enrollment validity window exceeds the maximum allowed TTL");
  }
}

function versionField(value: unknown): void {
  if (value !== FEDERATION_PROTOCOL_VERSION) throw new FederationCodecError(`unsupported version ${String(value)}`);
}

export function encodeEnvelope(envelope: PeerEnvelope, now = Date.now()): string {
  validateEnvelope(envelope, now);
  return `${JSON.stringify(envelope)}\n`;
}

export function decodeEnvelope(serialized: string, now = Date.now()): PeerEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new FederationCodecError("payload is not valid JSON");
  }
  validateEnvelope(value, now);
  return value;
}

export function validateEnvelope(value: unknown, now = Date.now()): asserts value is PeerEnvelope {
  const envelope = record(value, "envelope");
  exactKeys(envelope, ["version", "envelopeId", "requestId", "deduplicationId", "createdAt", "expiresAt", "origin", "destination", "payload"], "envelope");
  if (envelope.version !== FEDERATION_PROTOCOL_VERSION) throw new FederationCodecError(`unsupported version ${String(envelope.version)}`);
  nonBlankField(envelope.envelopeId, "envelopeId");
  nonBlankField(envelope.requestId, "requestId");
  nonBlankField(envelope.deduplicationId, "deduplicationId");
  const createdAt = timestamp(envelope.createdAt, "createdAt");
  const expiresAt = timestamp(envelope.expiresAt, "expiresAt");
  if (expiresAt <= createdAt) throw new FederationCodecError("expiresAt must be after createdAt");
  if (expiresAt <= now) throw new FederationCodecError("envelope is expired");
  const origin = validateHome(envelope.origin, "origin");
  const destination = validateHome(envelope.destination, "destination");
  if (origin.authorityId === destination.authorityId) throw new FederationCodecError("origin and destination must differ");
  validatePayload(envelope.payload);
}

function validatePayload(value: unknown): asserts value is PeerPayload {
  const payload = record(value, "payload");
  const kind = payload.kind;
  if (typeof kind !== "string" || !KINDS.has(kind)) throw new FederationCodecError(`unsupported payload kind ${String(kind)}`);
  for (const key of Object.keys(payload)) if (AUTHORITY_KEYS.has(key)) throw new FederationCodecError(`payload cannot override envelope authority with ${key}`);
  switch (kind) {
    case "enrollmentRevoke":
      exactKeys(payload, ["kind", "revokedAuthorityId", "reason"], kind);
      authorityField(payload.revokedAuthorityId, "revokedAuthorityId");
      nonBlankField(payload.reason, "reason");
      return;
    case "forwardCommand":
      exactKeys(payload, ["kind", "command", "channelId", "sessionId"], kind, ["body", "cursor"]);
      if (typeof payload.command !== "string" || !COMMANDS.has(payload.command)) throw new FederationCodecError("invalid forward command");
      nonBlankField(payload.channelId, "channelId");
      nonBlankField(payload.sessionId, "sessionId");
      optionalString(payload.body, "body");
      optionalCursor(payload.cursor, "cursor");
      return;
    case "deliveryBatch":
      exactKeys(payload, ["kind", "channelId", "recipientSessionId", "cursorStart", "cursorEnd", "items"], kind);
      nonBlankField(payload.channelId, "channelId");
      nonBlankField(payload.recipientSessionId, "recipientSessionId");
      cursorField(payload.cursorStart, "cursorStart");
      cursorField(payload.cursorEnd, "cursorEnd");
      if (!Array.isArray(payload.items)) throw new FederationCodecError("items must be an array");
      for (const item of payload.items) validateDeliveryItem(item);
      return;
    case "deliveryAck":
      exactKeys(payload, ["kind", "channelId", "recipientSessionId", "cursor"], kind);
      nonBlankField(payload.channelId, "channelId");
      nonBlankField(payload.recipientSessionId, "recipientSessionId");
      cursorField(payload.cursor, "cursor");
      return;
    case "error":
      exactKeys(payload, ["kind", "code", "message"], kind);
      if (typeof payload.code !== "string" || !ERROR_CODES.has(payload.code)) throw new FederationCodecError("invalid error code");
      nonBlankField(payload.message, "message");
      return;
  }
}

function validateDeliveryItem(value: unknown): void {
  const item = record(value, "delivery item");
  exactKeys(item, ["cursor", "kind", "channelId", "sessionId"], "delivery item", ["body"]);
  cursorField(item.cursor, "delivery cursor");
  if (typeof item.kind !== "string" || !DELIVERY_KINDS.has(item.kind)) throw new FederationCodecError("invalid delivery kind");
  nonBlankField(item.channelId, "delivery channelId");
  nonBlankField(item.sessionId, "delivery sessionId");
  optionalString(item.body, "delivery body");
}

function validateHome(value: unknown, field: string): HomeRef {
  const home = record(value, field);
  exactKeys(home, ["authorityId"], field);
  return homeRef({ authorityId: authorityField(home.authorityId, `${field}.authorityId`) });
}

function record(value: unknown, field: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FederationCodecError(`${field} must be an object`);
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, required: readonly string[], field: string, optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new FederationCodecError(`${field} has unknown field ${key}`);
  for (const key of required) if (!(key in value)) throw new FederationCodecError(`${field} is missing ${key}`);
}

function nonBlank(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function nonBlankField(value: unknown, field: string): string { if (!nonBlank(value)) throw new FederationCodecError(`${field} must be non-blank`); return value; }
function authorityField(value: unknown, field: string): AuthorityId { return authorityId(nonBlankField(value, field)); }
function optionalString(value: unknown, field: string): void { if (value !== undefined && typeof value !== "string") throw new FederationCodecError(`${field} must be a string`); }
function absolutePath(value: unknown, field: string): string { const path = nonBlankField(value, field); if (!path.startsWith("/")) throw new FederationCodecError(`${field} must be absolute`); return path; }
function port(value: unknown, field: string): number { if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65535) throw new FederationCodecError(`${field} must be a valid local port`); return Number(value); }
function isTailscaleAddress(value: unknown): boolean {
  if (typeof value !== "string" || value.includes("://") || value.trim() !== value) return false;
  if (isIP(value) === 4) return IPV4_TAILSCALE.test(value) && value.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);
  return isIP(value) === 6 && value.toLowerCase().startsWith("fd7a:115c:a1e0:");
}
function optionalCursor(value: unknown, field: string): void { if (value !== undefined) cursorField(value, field); }
function cursorField(value: unknown, field: string): Cursor { if (typeof value !== "string") throw new FederationCodecError(`${field} must be a cursor`); return cursor(value); }
function timestamp(value: unknown, field: string): number { const parsed = Date.parse(nonBlankField(value, field)); if (!Number.isFinite(parsed)) throw new FederationCodecError(`${field} must be an ISO timestamp`); return parsed; }

/**
 * A strict JSON parser used for enrollment artifacts instead of `JSON.parse`: it rejects a
 * duplicate key in any object at any nesting depth (including inside a nested transport
 * policy) rather than silently keeping the last occurrence, so a crafted artifact with
 * repeated keys cannot introduce non-canonical ambiguity between what a human reviewing the
 * raw text sees and what this process acts on.
 */
export function parseEnrollmentArtifactJson(text: string): unknown {
  let i = 0;
  const n = text.length;

  function fail(message: string): never {
    throw new FederationCodecError(`${message} at position ${i}`);
  }

  function skipWhitespace(): void {
    while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i += 1;
  }

  function parseValue(): unknown {
    skipWhitespace();
    if (i >= n) fail("unexpected end of JSON input");
    const c = text[i];
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === "\"") return parseString();
    if (c === "-" || (c >= "0" && c <= "9")) return parseNumber();
    if (text.startsWith("true", i)) { i += 4; return true; }
    if (text.startsWith("false", i)) { i += 5; return false; }
    if (text.startsWith("null", i)) { i += 4; return null; }
    fail("unexpected token");
  }

  function parseObject(): UnknownRecord {
    i += 1;
    const result: UnknownRecord = {};
    skipWhitespace();
    if (text[i] === "}") { i += 1; return result; }
    for (;;) {
      skipWhitespace();
      if (text[i] !== "\"") fail("expected an object key");
      const key = parseString();
      skipWhitespace();
      if (text[i] !== ":") fail("expected ':' after object key");
      i += 1;
      const value = parseValue();
      if (Object.prototype.hasOwnProperty.call(result, key)) fail(`duplicate object key "${key}"`);
      result[key] = value;
      skipWhitespace();
      if (text[i] === ",") { i += 1; continue; }
      if (text[i] === "}") { i += 1; break; }
      fail("expected ',' or '}' in object");
    }
    return result;
  }

  function parseArray(): unknown[] {
    i += 1;
    const result: unknown[] = [];
    skipWhitespace();
    if (text[i] === "]") { i += 1; return result; }
    for (;;) {
      result.push(parseValue());
      skipWhitespace();
      if (text[i] === ",") { i += 1; continue; }
      if (text[i] === "]") { i += 1; break; }
      fail("expected ',' or ']' in array");
    }
    return result;
  }

  function parseString(): string {
    i += 1;
    let result = "";
    while (i < n) {
      const c = text[i]!;
      if (c === "\"") { i += 1; return result; }
      if (c === "\\") {
        i += 1;
        const escape = text[i];
        switch (escape) {
          case "\"": result += "\""; break;
          case "\\": result += "\\"; break;
          case "/": result += "/"; break;
          case "b": result += "\b"; break;
          case "f": result += "\f"; break;
          case "n": result += "\n"; break;
          case "r": result += "\r"; break;
          case "t": result += "\t"; break;
          case "u": {
            const hex = text.slice(i + 1, i + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("invalid unicode escape");
            result += String.fromCharCode(parseInt(hex, 16));
            i += 4;
            break;
          }
          default:
            fail("invalid escape sequence");
        }
        i += 1;
        continue;
      }
      if (c.charCodeAt(0) < 0x20) fail("unescaped control character in string");
      result += c;
      i += 1;
    }
    fail("unterminated string");
  }

  function parseNumber(): number {
    const start = i;
    if (text[i] === "-") i += 1;
    if (text[i] === "0") { i += 1; } else { while (i < n && text[i]! >= "0" && text[i]! <= "9") i += 1; }
    if (text[i] === ".") { i += 1; while (i < n && text[i]! >= "0" && text[i]! <= "9") i += 1; }
    if (text[i] === "e" || text[i] === "E") {
      i += 1;
      if (text[i] === "+" || text[i] === "-") i += 1;
      while (i < n && text[i]! >= "0" && text[i]! <= "9") i += 1;
    }
    const numberText = text.slice(start, i);
    if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(numberText)) fail("invalid number");
    return Number(numberText);
  }

  const value = parseValue();
  skipWhitespace();
  if (i !== n) fail("unexpected trailing content after JSON value");
  return value;
}

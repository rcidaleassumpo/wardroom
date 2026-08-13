// SPDX-License-Identifier: Apache-2.0
/**
 * Wire contract for an authenticated Rooms relay connection carried over a bounded byte
 * duplex (SSH stdio today, see ssh-relay-transport.ts; a future Tailscale/direct transport
 * must supply its own duplex to the same RelayConnection state machine in
 * relay-connection.ts and needs its own confidential authenticated channel — SSH supplies
 * confidentiality/integrity for this one). Every frame is one newline-delimited,
 * size-bounded JSON object, parsed with the same duplicate-key-rejecting strict parser used
 * for enrollment artifacts (`parseEnrollmentArtifactJson` in codec.ts), and every frame
 * rejects unknown top-level fields the same way enrollment artifacts do.
 */

import { authorityId as toAuthorityId, parseEnrollmentArtifactJson, validateTransportPolicy } from "./codec.js";
import type { AuthorityId, FederationTransportPolicy } from "./contracts.js";
import { assertSafeRemoteAbsolutePath } from "./remote-command-port.js";

export const RELAY_PROTOCOL_VERSION = 3 as const;
export const RELAY_HANDSHAKE_DOMAIN = "rooms-federation-relay-v1";
export const RELAY_CHANNEL_KIND = "sshStdio" as const;

export const RELAY_MAX_FRAME_BYTES = 16_384;
export const RELAY_MAX_ECHO_PAYLOAD_BYTES = 4_096;
export const RELAY_MAX_TERMINAL_BYTES = 8_192;
export const RELAY_MAX_REASON_BYTES = 512;
export const RELAY_HANDSHAKE_NONCE_BYTES = 32; // 256 bits
export const RELAY_DEFAULT_TTL_SECONDS = 60;
export const RELAY_MIN_TTL_SECONDS = 10;
export const RELAY_MAX_TTL_SECONDS = 300;
export const RELAY_CLOCK_SKEW_TOLERANCE_MS = 30_000;

const CONNECTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const NONCE_PATTERN = /^[0-9a-f]{64,}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const AUTHORITY_ID_PATTERN = /^authority-[0-9a-f]{64}$/;

export class RelayProtocolError extends Error {
  constructor(message: string) {
    super(`Rooms relay protocol: ${message}`);
    this.name = "RelayProtocolError";
  }
}

export type RelayDirection = "initiatorToResponder" | "responderToInitiator";

export type RelayHandshakeInit = Readonly<{
  kind: "relayHandshakeInit";
  version: typeof RELAY_PROTOCOL_VERSION;
  channel: typeof RELAY_CHANNEL_KIND;
  connectionId: string;
  initiatorAuthorityId: AuthorityId;
  initiatorFingerprint: string;
  initiatorPublicKeySpkiB64: string;
  initiatorTransportPolicy: FederationTransportPolicy;
  responderAuthorityId: AuthorityId;
  /** The remote (responder) machine's own Rooms state dir, when non-default; carried in-band because the fixed `serve-stdio` remote command takes no dynamic argv. Null means "use the responder's default state dir". */
  stateDir: string | null;
  /**
   * The heartbeat cadence the initiator wants for this connection, carried in-band for the
   * same reason as `stateDir`: `serve-stdio` takes no dynamic argv, so a responder that
   * defaulted to its own hardcoded interval instead could pick a slower cadence than the
   * initiator's idle-timeout tolerance expects, and misread a healthy but slower peer as
   * idle. Not part of the signed transcript below: it is a liveness tuning knob, not a
   * trust-relevant fact, so tampering with it (impossible over the authenticated SSH
   * channel anyway) could only ever affect timing, never authentication. Null means "use
   * the built-in default".
   */
  heartbeatIntervalMs: number | null;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
}>;

export type RelayHandshakeAccept = Readonly<{
  kind: "relayHandshakeAccept";
  version: typeof RELAY_PROTOCOL_VERSION;
  channel: typeof RELAY_CHANNEL_KIND;
  connectionId: string;
  initiatorAuthorityId: AuthorityId;
  initiatorFingerprint: string;
  initiatorPublicKeySpkiB64: string;
  initiatorTransportPolicy: FederationTransportPolicy;
  responderAuthorityId: AuthorityId;
  responderFingerprint: string;
  responderPublicKeySpkiB64: string;
  responderTransportPolicy: FederationTransportPolicy;
  initiatorNonce: string;
  responderNonce: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
}>;

export type RelayHandshakeReject = Readonly<{
  kind: "relayHandshakeReject";
  connectionId: string;
  code: string;
  message: string;
}>;

export type RelayPeerStatus = Readonly<{
  connectionId: string;
  authorityId: AuthorityId;
  peerAuthorityId: AuthorityId;
  role: "initiator" | "responder";
  connectedAt: string;
  uptimeMs: number;
}>;

export type RelayApplicationFrame =
  | Readonly<{ kind: "echoRequest"; connectionId: string; direction: RelayDirection; seq: number; payload: string }>
  | Readonly<{ kind: "echoResponse"; connectionId: string; direction: RelayDirection; seq: number; payload: string }>
  | Readonly<{ kind: "statusRequest"; connectionId: string; direction: RelayDirection; seq: number }>
  | Readonly<{ kind: "statusResponse"; connectionId: string; direction: RelayDirection; seq: number; status: RelayPeerStatus }>
  | Readonly<{ kind: "heartbeat"; connectionId: string; direction: RelayDirection; seq: number }>
  | Readonly<{ kind: "drain"; connectionId: string; direction: RelayDirection; seq: number }>
  | Readonly<{ kind: "close"; connectionId: string; direction: RelayDirection; seq: number; reason: string }>
  | Readonly<{ kind: "protocolError"; connectionId: string; direction: RelayDirection; seq: number; code: string; message: string }>;

/** Durable channel operations routed to the one authority that owns the channel store. */
export type RelayChannelFrame =
  | Readonly<{ kind: "channelCommand"; connectionId: string; direction: RelayDirection; seq: number; requestId: string; homeAuthorityId: AuthorityId; operation: "register" | "leave" | "send" | "directSend" | "snapshot" | "messages"; actorSessionId: string; payload: string }>
  | Readonly<{ kind: "channelResult"; connectionId: string; direction: RelayDirection; seq: number; requestId: string; ok: boolean; chunkIndex: number; final: boolean; payload: string }>;

/** Bounded, paginated inventory for an authenticated enrolled machine. */
export type RelayInventoryFrame =
  | Readonly<{ kind: "inventoryCommand"; connectionId: string; direction: RelayDirection; seq: number; requestId: string; authorityId: AuthorityId; resource: "channels" | "sessions" | "providers"; cursor: number; limit: number; includeEnded: boolean }>
  | Readonly<{ kind: "inventoryResult"; connectionId: string; direction: RelayDirection; seq: number; requestId: string; ok: boolean; payload: string }>;

/** Terminal traffic is intentionally opaque to the relay codec and is never a durable Rooms event. */
export type RelayTerminalFrame =
  | Readonly<{ kind: "terminalOpen"; connectionId: string; direction: RelayDirection; seq: number; streamId: string; homeAuthorityId: AuthorityId; sessionId: string; capability: string; mode: "observe" | "controller"; outputCursor: string }>
  | Readonly<{ kind: "terminalOpenAck"; connectionId: string; direction: RelayDirection; seq: number; streamId: string; homeAuthorityId: AuthorityId; sessionId: string; runtimeId: string; generation: number; outputCursor: string }>
  | Readonly<{ kind: "terminalOutput"; connectionId: string; direction: RelayDirection; seq: number; streamId: string; homeAuthorityId: AuthorityId; sessionId: string; runtimeId: string; generation: number; outputCursor: string; bytes: string }>
  | Readonly<{ kind: "terminalGap"; connectionId: string; direction: RelayDirection; seq: number; streamId: string; homeAuthorityId: AuthorityId; sessionId: string; runtimeId: string; generation: number; replayFrom: string; head: string }>
  | Readonly<{ kind: "terminalInput"; connectionId: string; direction: RelayDirection; seq: number; streamId: string; homeAuthorityId: AuthorityId; sessionId: string; runtimeId: string; generation: number; capabilityId: string; inputSeq: string; bytes: string }>
  | Readonly<{ kind: "terminalInputAck"; connectionId: string; direction: RelayDirection; seq: number; streamId: string; inputSeq: string; outcome: "written" | "duplicate" | "uncertain" }>
  | Readonly<{ kind: "terminalResize"; connectionId: string; direction: RelayDirection; seq: number; streamId: string; homeAuthorityId: AuthorityId; sessionId: string; runtimeId: string; generation: number; capabilityId: string; columns: number; rows: number }>
  | Readonly<{ kind: "terminalResizeAck"; connectionId: string; direction: RelayDirection; seq: number; streamId: string }>
  | Readonly<{ kind: "terminalDetach"; connectionId: string; direction: RelayDirection; seq: number; streamId: string; homeAuthorityId: AuthorityId; sessionId: string; runtimeId: string; generation: number }>
  | Readonly<{ kind: "terminalClose"; connectionId: string; direction: RelayDirection; seq: number; streamId: string; reason: string }>;

export type RelayWireFrame = RelayHandshakeInit | RelayHandshakeAccept | RelayHandshakeReject | RelayApplicationFrame | RelayTerminalFrame | RelayChannelFrame | RelayInventoryFrame;

/** Canonical, domain-separated field order signed for the handshake init (initiator's own signature only). */
export type RelayInitTranscriptFields = Readonly<{
  connectionId: string;
  initiatorAuthorityId: AuthorityId;
  initiatorFingerprint: string;
  initiatorPublicKeySpkiB64: string;
  initiatorTransportPolicy: FederationTransportPolicy;
  responderAuthorityId: AuthorityId;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}>;

export function canonicalRelayInitTranscript(fields: RelayInitTranscriptFields): Buffer {
  const ordered = {
    version: RELAY_PROTOCOL_VERSION,
    channel: RELAY_CHANNEL_KIND,
    connectionId: fields.connectionId,
    initiatorAuthorityId: fields.initiatorAuthorityId,
    initiatorFingerprint: fields.initiatorFingerprint,
    initiatorPublicKeySpkiB64: fields.initiatorPublicKeySpkiB64,
    initiatorTransportPolicy: fields.initiatorTransportPolicy,
    responderAuthorityId: fields.responderAuthorityId,
    nonce: fields.nonce,
    issuedAt: fields.issuedAt,
    expiresAt: fields.expiresAt,
  };
  return Buffer.from(`${RELAY_HANDSHAKE_DOMAIN}:init\n${JSON.stringify(ordered)}`, "utf8");
}

/** Canonical, domain-separated field order signed for the handshake accept (responder's own signature, over both parties' fields). */
export type RelayAcceptTranscriptFields = Readonly<{
  connectionId: string;
  initiatorAuthorityId: AuthorityId;
  initiatorFingerprint: string;
  initiatorPublicKeySpkiB64: string;
  initiatorTransportPolicy: FederationTransportPolicy;
  responderAuthorityId: AuthorityId;
  responderFingerprint: string;
  responderPublicKeySpkiB64: string;
  responderTransportPolicy: FederationTransportPolicy;
  initiatorNonce: string;
  responderNonce: string;
  issuedAt: string;
  expiresAt: string;
}>;

export function canonicalRelayAcceptTranscript(fields: RelayAcceptTranscriptFields): Buffer {
  const ordered = {
    version: RELAY_PROTOCOL_VERSION,
    channel: RELAY_CHANNEL_KIND,
    connectionId: fields.connectionId,
    initiatorAuthorityId: fields.initiatorAuthorityId,
    initiatorFingerprint: fields.initiatorFingerprint,
    initiatorPublicKeySpkiB64: fields.initiatorPublicKeySpkiB64,
    initiatorTransportPolicy: fields.initiatorTransportPolicy,
    responderAuthorityId: fields.responderAuthorityId,
    responderFingerprint: fields.responderFingerprint,
    responderPublicKeySpkiB64: fields.responderPublicKeySpkiB64,
    responderTransportPolicy: fields.responderTransportPolicy,
    initiatorNonce: fields.initiatorNonce,
    responderNonce: fields.responderNonce,
    issuedAt: fields.issuedAt,
    expiresAt: fields.expiresAt,
  };
  return Buffer.from(`${RELAY_HANDSHAKE_DOMAIN}:accept\n${JSON.stringify(ordered)}`, "utf8");
}

export function encodeRelayFrame(frame: RelayWireFrame): string {
  const line = JSON.stringify(frame);
  if (Buffer.byteLength(line, "utf8") > RELAY_MAX_FRAME_BYTES) {
    throw new RelayProtocolError(`outgoing frame exceeds the maximum size of ${RELAY_MAX_FRAME_BYTES} bytes`);
  }
  return `${line}\n`;
}

/** Strictly parses one bounded frame line (no trailing newline) into a validated, exact-keys-checked RelayWireFrame. */
export function parseRelayFrame(raw: string): RelayWireFrame {
  if (Buffer.byteLength(raw, "utf8") > RELAY_MAX_FRAME_BYTES) {
    throw new RelayProtocolError(`incoming frame exceeds the maximum size of ${RELAY_MAX_FRAME_BYTES} bytes`);
  }
  let value: unknown;
  try {
    value = parseEnrollmentArtifactJson(raw);
  } catch (error) {
    throw new RelayProtocolError(`frame is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RelayProtocolError("frame must be an object");
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case "relayHandshakeInit":
      return validateHandshakeInit(record);
    case "relayHandshakeAccept":
      return validateHandshakeAccept(record);
    case "relayHandshakeReject":
      return validateHandshakeReject(record);
    case "echoRequest":
    case "echoResponse":
      return validateEchoFrame(record);
    case "statusRequest":
      return validateStatusRequest(record);
    case "statusResponse":
      return validateStatusResponse(record);
    case "heartbeat":
      return validateSeqOnlyFrame(record, "heartbeat");
    case "drain":
      return validateSeqOnlyFrame(record, "drain");
    case "close":
      return validateCloseFrame(record);
    case "protocolError":
      return validateProtocolErrorFrame(record);
    case "terminalOpen": case "terminalOpenAck": case "terminalOutput": case "terminalGap": case "terminalInput": case "terminalInputAck": case "terminalResize": case "terminalResizeAck": case "terminalDetach": case "terminalClose":
      return validateTerminalFrame(record);
    case "channelCommand": case "channelResult":
      return validateChannelFrame(record);
    case "inventoryCommand": case "inventoryResult":
      return validateInventoryFrame(record);
    default:
      throw new RelayProtocolError(`unknown frame kind ${JSON.stringify(record.kind)}`);
  }
}

function validateInventoryFrame(record: Record<string, unknown>): RelayInventoryFrame {
  const kind = str(record.kind, "kind");
  if (kind === "inventoryCommand") {
    assertExactKeys(record, ["kind", "connectionId", "direction", "seq", "requestId", "authorityId", "resource", "cursor", "limit", "includeEnded"], kind);
    if (!["channels", "sessions", "providers"].includes(String(record.resource))) throw new RelayProtocolError("invalid inventory resource");
    if (!Number.isSafeInteger(record.cursor) || (record.cursor as number) < 0) throw new RelayProtocolError("inventory cursor must be a non-negative integer");
    if (!Number.isSafeInteger(record.limit) || (record.limit as number) < 1 || (record.limit as number) > 20) throw new RelayProtocolError("inventory limit must be between 1 and 20");
    if (typeof record.includeEnded !== "boolean") throw new RelayProtocolError("includeEnded must be boolean");
    return {
      kind, connectionId: connectionIdField(record.connectionId), direction: directionField(record.direction), seq: seqField(record.seq),
      requestId: boundedStr(record.requestId, "requestId", 128), authorityId: authorityField(record.authorityId, "authorityId"),
      resource: record.resource as "channels" | "sessions" | "providers", cursor: record.cursor as number, limit: record.limit as number, includeEnded: record.includeEnded,
    };
  }
  assertExactKeys(record, ["kind", "connectionId", "direction", "seq", "requestId", "ok", "payload"], kind);
  if (typeof record.ok !== "boolean") throw new RelayProtocolError("ok must be boolean");
  return { kind: "inventoryResult", connectionId: connectionIdField(record.connectionId), direction: directionField(record.direction), seq: seqField(record.seq), requestId: boundedStr(record.requestId, "requestId", 128), ok: record.ok, payload: boundedBase64(record.payload, "payload", RELAY_MAX_TERMINAL_BYTES) };
}

function validateChannelFrame(record: Record<string, unknown>): RelayChannelFrame {
  const kind = str(record.kind, "kind");
  if (kind === "channelCommand") {
    assertExactKeys(record, ["kind", "connectionId", "direction", "seq", "requestId", "homeAuthorityId", "operation", "actorSessionId", "payload"], kind);
    if (!["register", "leave", "send", "directSend", "snapshot", "messages"].includes(String(record.operation))) throw new RelayProtocolError("invalid channel operation");
    return {
      kind, connectionId: connectionIdField(record.connectionId), direction: directionField(record.direction), seq: seqField(record.seq),
      requestId: boundedStr(record.requestId, "requestId", 128), homeAuthorityId: authorityField(record.homeAuthorityId, "homeAuthorityId"),
      operation: record.operation as "register" | "leave" | "send" | "directSend" | "snapshot" | "messages",
      actorSessionId: boundedStr(record.actorSessionId, "actorSessionId", 512), payload: boundedBase64(record.payload, "payload", RELAY_MAX_TERMINAL_BYTES),
    };
  }
  assertExactKeys(record, ["kind", "connectionId", "direction", "seq", "requestId", "ok", "chunkIndex", "final", "payload"], kind);
  if (typeof record.ok !== "boolean") throw new RelayProtocolError("ok must be boolean");
  if (!Number.isSafeInteger(record.chunkIndex) || (record.chunkIndex as number) < 0) throw new RelayProtocolError("channel result chunkIndex must be a non-negative integer");
  if (typeof record.final !== "boolean") throw new RelayProtocolError("channel result final must be boolean");
  return { kind: "channelResult", connectionId: connectionIdField(record.connectionId), direction: directionField(record.direction), seq: seqField(record.seq), requestId: boundedStr(record.requestId, "requestId", 128), ok: record.ok, chunkIndex: record.chunkIndex as number, final: record.final, payload: boundedBase64(record.payload, "payload", RELAY_MAX_TERMINAL_BYTES) };
}

function boundedBase64(value: unknown, field: string, maxBytes: number): string {
  const encoded = boundedStr(value, field, maxBytes);
  if (!BASE64_PATTERN.test(encoded) || encoded.length % 4 !== 0) throw new RelayProtocolError(`${field} must be base64-encoded`);
  return encoded;
}

function validateTerminalFrame(record: Record<string, unknown>): RelayTerminalFrame {
  const kind = str(record.kind, "kind");
  const common = ["kind", "connectionId", "direction", "seq", "streamId"];
  const fields = new Set(common);
  const add = (...names: string[]) => names.forEach((name) => fields.add(name));
  if (["terminalOpen", "terminalOpenAck", "terminalInput", "terminalResize", "terminalDetach", "terminalOutput", "terminalGap"].includes(kind)) add("homeAuthorityId", "sessionId");
  if (["terminalOpenAck", "terminalInput", "terminalResize", "terminalDetach", "terminalOutput", "terminalGap"].includes(kind)) add("runtimeId", "generation");
  if (kind === "terminalOpen") add("capability", "mode", "outputCursor");
  if (kind === "terminalInput") add("capabilityId", "inputSeq", "bytes");
  if (kind === "terminalResize") add("capabilityId", "columns", "rows");
  if (kind === "terminalOutput") add("outputCursor", "bytes");
  if (kind === "terminalOpenAck") add("outputCursor");
  if (kind === "terminalGap") add("replayFrom", "head");
  if (kind === "terminalInputAck") add("inputSeq", "outcome");
  if (kind === "terminalClose") add("reason");
  assertExactKeys(record, [...fields], kind);
  const result = { ...record, kind, connectionId: connectionIdField(record.connectionId), direction: directionField(record.direction), seq: seqField(record.seq), streamId: boundedStr(record.streamId, "streamId", 128) } as Record<string, unknown>;
  for (const name of ["homeAuthorityId"]) if (name in result) result[name] = authorityField(result[name], name);
  for (const name of ["sessionId", "runtimeId", "capabilityId"]) if (name in result) result[name] = boundedStr(result[name], name, 256);
  for (const name of ["outputCursor", "replayFrom", "head", "inputSeq"]) {
    if (!(name in result)) continue;
    const value = boundedStr(result[name], name, 32);
    if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new RelayProtocolError(`${name} must be an unsigned decimal integer`);
    result[name] = value;
  }
  if ("generation" in result && (!Number.isInteger(result.generation) || (result.generation as number) < 1)) throw new RelayProtocolError("generation must be a positive integer");
  if ("bytes" in result) { const bytes = boundedStr(result.bytes, "bytes", RELAY_MAX_TERMINAL_BYTES); if (!BASE64_PATTERN.test(bytes) || bytes.length % 4 !== 0) throw new RelayProtocolError("bytes must be base64-encoded"); result.bytes = bytes; }
  if ("capability" in result) result.capability = boundedBase64(result.capability, "capability", 8 * 1_024);
  if ("columns" in result && (!Number.isInteger(result.columns) || (result.columns as number) < 1 || (result.columns as number) > 1000)) throw new RelayProtocolError("columns out of bounds");
  if ("rows" in result && (!Number.isInteger(result.rows) || (result.rows as number) < 1 || (result.rows as number) > 1000)) throw new RelayProtocolError("rows out of bounds");
  if (kind === "terminalOpen" && result.mode !== "observe" && result.mode !== "controller") throw new RelayProtocolError("invalid terminal mode");
  if (kind === "terminalInputAck" && !["written", "duplicate", "uncertain"].includes(String(result.outcome))) throw new RelayProtocolError("invalid input outcome");
  return result as RelayTerminalFrame;
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new RelayProtocolError(`${label} has unknown field ${key}`);
  for (const key of allowed) if (!(key in record)) throw new RelayProtocolError(`${label} is missing ${key}`);
}

function str(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new RelayProtocolError(`${field} must be a non-blank string`);
  return value;
}

function boundedStr(value: unknown, field: string, maxBytes: number): string {
  const text = str(value, field);
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new RelayProtocolError(`${field} exceeds ${maxBytes} bytes`);
  return text;
}

function authorityField(value: unknown, field: string): AuthorityId {
  const text = str(value, field);
  if (!AUTHORITY_ID_PATTERN.test(text)) throw new RelayProtocolError(`${field} is not a well-formed authority id`);
  return toAuthorityId(text);
}

function fingerprintField(value: unknown, field: string): string {
  const text = str(value, field);
  if (!FINGERPRINT_PATTERN.test(text)) throw new RelayProtocolError(`${field} must be a SHA-256 hex fingerprint`);
  return text;
}

function base64Field(value: unknown, field: string): string {
  const text = str(value, field);
  if (!BASE64_PATTERN.test(text) || text.length % 4 !== 0) throw new RelayProtocolError(`${field} must be base64-encoded`);
  return text;
}

function nonceField(value: unknown, field: string): string {
  const text = str(value, field);
  if (!NONCE_PATTERN.test(text)) throw new RelayProtocolError(`${field} must be a lowercase hex string of at least 256 bits`);
  return text;
}

function connectionIdField(value: unknown): string {
  const text = str(value, "connectionId");
  if (!CONNECTION_ID_PATTERN.test(text)) throw new RelayProtocolError("connectionId must be a UUID");
  return text;
}

function timestampField(value: unknown, field: string): string {
  const text = str(value, field);
  if (!Number.isFinite(Date.parse(text))) throw new RelayProtocolError(`${field} must be an ISO timestamp`);
  return text;
}

function transportPolicyField(value: unknown, field: string): FederationTransportPolicy {
  try {
    validateTransportPolicy(value);
  } catch (error) {
    throw new RelayProtocolError(`${field}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return value as FederationTransportPolicy;
}

function directionField(value: unknown): RelayDirection {
  if (value !== "initiatorToResponder" && value !== "responderToInitiator") throw new RelayProtocolError("direction must be initiatorToResponder or responderToInitiator");
  return value;
}

function seqField(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new RelayProtocolError("seq must be a positive integer");
  return value as number;
}

function stateDirField(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new RelayProtocolError("stateDir must be null or a string");
  try {
    return assertSafeRemoteAbsolutePath(value, "stateDir");
  } catch (error) {
    throw new RelayProtocolError(error instanceof Error ? error.message : String(error));
  }
}

const MIN_NEGOTIATED_HEARTBEAT_INTERVAL_MS = 100;
const MAX_NEGOTIATED_HEARTBEAT_INTERVAL_MS = 300_000;

function heartbeatIntervalMsField(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || (value as number) < MIN_NEGOTIATED_HEARTBEAT_INTERVAL_MS || (value as number) > MAX_NEGOTIATED_HEARTBEAT_INTERVAL_MS) {
    throw new RelayProtocolError(`heartbeatIntervalMs must be null or an integer between ${MIN_NEGOTIATED_HEARTBEAT_INTERVAL_MS} and ${MAX_NEGOTIATED_HEARTBEAT_INTERVAL_MS}`);
  }
  return value as number;
}

function versionField(value: unknown): void {
  if (value !== RELAY_PROTOCOL_VERSION) throw new RelayProtocolError(`unsupported relay protocol version ${String(value)}`);
}

function channelField(value: unknown): void {
  if (value !== RELAY_CHANNEL_KIND) throw new RelayProtocolError(`unsupported relay channel ${String(value)}`);
}

function windowField(issuedAtInput: unknown, expiresAtInput: unknown): void {
  const issuedAt = Date.parse(timestampField(issuedAtInput, "issuedAt"));
  const expiresAt = Date.parse(timestampField(expiresAtInput, "expiresAt"));
  if (expiresAt <= issuedAt) throw new RelayProtocolError("expiresAt must be after issuedAt");
  if (expiresAt - issuedAt > RELAY_MAX_TTL_SECONDS * 1000) throw new RelayProtocolError("handshake validity window exceeds the maximum allowed TTL");
}

function validateHandshakeInit(record: Record<string, unknown>): RelayHandshakeInit {
  assertExactKeys(record, [
    "kind", "version", "channel", "connectionId", "initiatorAuthorityId", "initiatorFingerprint",
    "initiatorPublicKeySpkiB64", "initiatorTransportPolicy", "responderAuthorityId", "stateDir",
    "heartbeatIntervalMs", "nonce", "issuedAt", "expiresAt", "signature",
  ], "relayHandshakeInit");
  versionField(record.version);
  channelField(record.channel);
  const connectionId = connectionIdField(record.connectionId);
  const initiatorAuthorityId = authorityField(record.initiatorAuthorityId, "initiatorAuthorityId");
  const responderAuthorityId = authorityField(record.responderAuthorityId, "responderAuthorityId");
  if (initiatorAuthorityId === responderAuthorityId) throw new RelayProtocolError("initiatorAuthorityId and responderAuthorityId must differ");
  const initiatorFingerprint = fingerprintField(record.initiatorFingerprint, "initiatorFingerprint");
  const initiatorPublicKeySpkiB64 = base64Field(record.initiatorPublicKeySpkiB64, "initiatorPublicKeySpkiB64");
  const initiatorTransportPolicy = transportPolicyField(record.initiatorTransportPolicy, "initiatorTransportPolicy");
  const stateDir = stateDirField(record.stateDir);
  const heartbeatIntervalMs = heartbeatIntervalMsField(record.heartbeatIntervalMs);
  const nonce = nonceField(record.nonce, "nonce");
  const issuedAt = timestampField(record.issuedAt, "issuedAt");
  const expiresAt = timestampField(record.expiresAt, "expiresAt");
  windowField(issuedAt, expiresAt);
  const signature = base64Field(record.signature, "signature");
  return {
    kind: "relayHandshakeInit", version: RELAY_PROTOCOL_VERSION, channel: RELAY_CHANNEL_KIND, connectionId,
    initiatorAuthorityId, initiatorFingerprint, initiatorPublicKeySpkiB64, initiatorTransportPolicy,
    responderAuthorityId, stateDir, heartbeatIntervalMs, nonce, issuedAt, expiresAt, signature,
  };
}

function validateHandshakeAccept(record: Record<string, unknown>): RelayHandshakeAccept {
  assertExactKeys(record, [
    "kind", "version", "channel", "connectionId", "initiatorAuthorityId", "initiatorFingerprint",
    "initiatorPublicKeySpkiB64", "initiatorTransportPolicy", "responderAuthorityId", "responderFingerprint",
    "responderPublicKeySpkiB64", "responderTransportPolicy", "initiatorNonce", "responderNonce",
    "issuedAt", "expiresAt", "signature",
  ], "relayHandshakeAccept");
  versionField(record.version);
  channelField(record.channel);
  const connectionId = connectionIdField(record.connectionId);
  const initiatorAuthorityId = authorityField(record.initiatorAuthorityId, "initiatorAuthorityId");
  const responderAuthorityId = authorityField(record.responderAuthorityId, "responderAuthorityId");
  if (initiatorAuthorityId === responderAuthorityId) throw new RelayProtocolError("initiatorAuthorityId and responderAuthorityId must differ");
  const initiatorFingerprint = fingerprintField(record.initiatorFingerprint, "initiatorFingerprint");
  const initiatorPublicKeySpkiB64 = base64Field(record.initiatorPublicKeySpkiB64, "initiatorPublicKeySpkiB64");
  const initiatorTransportPolicy = transportPolicyField(record.initiatorTransportPolicy, "initiatorTransportPolicy");
  const responderFingerprint = fingerprintField(record.responderFingerprint, "responderFingerprint");
  const responderPublicKeySpkiB64 = base64Field(record.responderPublicKeySpkiB64, "responderPublicKeySpkiB64");
  const responderTransportPolicy = transportPolicyField(record.responderTransportPolicy, "responderTransportPolicy");
  const initiatorNonce = nonceField(record.initiatorNonce, "initiatorNonce");
  const responderNonce = nonceField(record.responderNonce, "responderNonce");
  const issuedAt = timestampField(record.issuedAt, "issuedAt");
  const expiresAt = timestampField(record.expiresAt, "expiresAt");
  windowField(issuedAt, expiresAt);
  const signature = base64Field(record.signature, "signature");
  return {
    kind: "relayHandshakeAccept", version: RELAY_PROTOCOL_VERSION, channel: RELAY_CHANNEL_KIND, connectionId,
    initiatorAuthorityId, initiatorFingerprint, initiatorPublicKeySpkiB64, initiatorTransportPolicy,
    responderAuthorityId, responderFingerprint, responderPublicKeySpkiB64, responderTransportPolicy,
    initiatorNonce, responderNonce, issuedAt, expiresAt, signature,
  };
}

function validateHandshakeReject(record: Record<string, unknown>): RelayHandshakeReject {
  assertExactKeys(record, ["kind", "connectionId", "code", "message"], "relayHandshakeReject");
  const connectionId = connectionIdField(record.connectionId);
  const code = boundedStr(record.code, "code", 128);
  const message = boundedStr(record.message, "message", RELAY_MAX_REASON_BYTES);
  return { kind: "relayHandshakeReject", connectionId, code, message };
}

function validateEchoFrame(record: Record<string, unknown>): RelayApplicationFrame {
  assertExactKeys(record, ["kind", "connectionId", "direction", "seq", "payload"], String(record.kind));
  const connectionId = connectionIdField(record.connectionId);
  const direction = directionField(record.direction);
  const seq = seqField(record.seq);
  const payload = boundedStr(record.payload, "payload", RELAY_MAX_ECHO_PAYLOAD_BYTES);
  return { kind: record.kind as "echoRequest" | "echoResponse", connectionId, direction, seq, payload };
}

function validateStatusRequest(record: Record<string, unknown>): RelayApplicationFrame {
  assertExactKeys(record, ["kind", "connectionId", "direction", "seq"], "statusRequest");
  return { kind: "statusRequest", connectionId: connectionIdField(record.connectionId), direction: directionField(record.direction), seq: seqField(record.seq) };
}

function validateStatusResponse(record: Record<string, unknown>): RelayApplicationFrame {
  assertExactKeys(record, ["kind", "connectionId", "direction", "seq", "status"], "statusResponse");
  const connectionId = connectionIdField(record.connectionId);
  const direction = directionField(record.direction);
  const seq = seqField(record.seq);
  const status = validatePeerStatus(record.status);
  return { kind: "statusResponse", connectionId, direction, seq, status };
}

function validatePeerStatus(value: unknown): RelayPeerStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RelayProtocolError("status must be an object");
  const record = value as Record<string, unknown>;
  assertExactKeys(record, ["connectionId", "authorityId", "peerAuthorityId", "role", "connectedAt", "uptimeMs"], "status");
  const connectionId = connectionIdField(record.connectionId);
  const authorityId = authorityField(record.authorityId, "status.authorityId");
  const peerAuthorityId = authorityField(record.peerAuthorityId, "status.peerAuthorityId");
  if (record.role !== "initiator" && record.role !== "responder") throw new RelayProtocolError("status.role must be initiator or responder");
  const connectedAt = timestampField(record.connectedAt, "status.connectedAt");
  if (!Number.isInteger(record.uptimeMs) || (record.uptimeMs as number) < 0) throw new RelayProtocolError("status.uptimeMs must be a non-negative integer");
  return { connectionId, authorityId, peerAuthorityId, role: record.role, connectedAt, uptimeMs: record.uptimeMs as number };
}

function validateSeqOnlyFrame(record: Record<string, unknown>, kind: "heartbeat" | "drain"): RelayApplicationFrame {
  assertExactKeys(record, ["kind", "connectionId", "direction", "seq"], kind);
  return { kind, connectionId: connectionIdField(record.connectionId), direction: directionField(record.direction), seq: seqField(record.seq) };
}

function validateCloseFrame(record: Record<string, unknown>): RelayApplicationFrame {
  assertExactKeys(record, ["kind", "connectionId", "direction", "seq", "reason"], "close");
  const connectionId = connectionIdField(record.connectionId);
  const direction = directionField(record.direction);
  const seq = seqField(record.seq);
  const reason = boundedStr(record.reason, "reason", RELAY_MAX_REASON_BYTES);
  return { kind: "close", connectionId, direction, seq, reason };
}

function validateProtocolErrorFrame(record: Record<string, unknown>): RelayApplicationFrame {
  assertExactKeys(record, ["kind", "connectionId", "direction", "seq", "code", "message"], "protocolError");
  const connectionId = connectionIdField(record.connectionId);
  const direction = directionField(record.direction);
  const seq = seqField(record.seq);
  const code = boundedStr(record.code, "code", 128);
  const message = boundedStr(record.message, "message", RELAY_MAX_REASON_BYTES);
  return { kind: "protocolError", connectionId, direction, seq, code, message };
}

/**
 * Incremental newline-delimited frame reader bounded by RELAY_MAX_FRAME_BYTES: a line that
 * grows past the bound without a newline is rejected as oversize before it is ever handed to
 * the JSON parser, so an unbounded remote write cannot grow memory without limit.
 */
export class RelayFrameReader {
  private buffer = "";

  /** Feeds one chunk of bytes and returns zero or more complete, still-raw (unparsed) frame lines. Throws RelayProtocolError if the unterminated buffer exceeds the bound. */
  push(chunk: Buffer | string): readonly string[] {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const lines: string[] = [];
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index === -1) break;
      lines.push(this.buffer.slice(0, index));
      this.buffer = this.buffer.slice(index + 1);
    }
    if (Buffer.byteLength(this.buffer, "utf8") > RELAY_MAX_FRAME_BYTES) {
      throw new RelayProtocolError(`incoming frame exceeds the maximum size of ${RELAY_MAX_FRAME_BYTES} bytes before a newline was found`);
    }
    return lines;
  }
}

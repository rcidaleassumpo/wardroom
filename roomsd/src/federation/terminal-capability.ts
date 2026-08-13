// SPDX-License-Identifier: Apache-2.0
import { Buffer } from "node:buffer";
import { randomBytes, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import type { AuthorityId } from "./contracts.js";

export const TERMINAL_CAPABILITY_VERSION = 1 as const;
export const TERMINAL_CAPABILITY_MAX_TTL_SECONDS = 3_600;
const TERMINAL_CAPABILITY_DOMAIN = "rooms-federation-terminal-capability-v1";
const ACTIONS = ["observe", "controller", "input", "resize"] as const;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type TerminalCapabilityAction = typeof ACTIONS[number];

/** A one-use bearer capability issued and signed by the authority that owns the runtime. */
export type TerminalCapability = Readonly<{
  version: typeof TERMINAL_CAPABILITY_VERSION;
  capabilityId: string;
  nonce: string;
  issuer: AuthorityId;
  audience: AuthorityId;
  sessionId: string;
  channelId: string | null;
  runtimeId: string;
  generation: number;
  actions: readonly TerminalCapabilityAction[];
  issuedAt: string;
  expiresAt: string;
  signature: string;
}>;

export function terminalActionsForMode(mode: "observe" | "controller"): readonly TerminalCapabilityAction[] {
  return mode === "observe" ? ["observe"] : ["observe", "controller", "input", "resize"];
}

export function issueTerminalCapability(input: Readonly<{
  issuer: AuthorityId;
  audience: AuthorityId;
  sessionId: string;
  channelId?: string | null;
  runtimeId: string;
  generation: number;
  mode: "observe" | "controller";
  privateKey: KeyObject;
  ttlSeconds?: number;
  now?: Date;
}>): TerminalCapability {
  const ttlSeconds = input.ttlSeconds ?? 300;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > TERMINAL_CAPABILITY_MAX_TTL_SECONDS) {
    throw new Error(`terminal capability TTL must be between 1 and ${TERMINAL_CAPABILITY_MAX_TTL_SECONDS} seconds`);
  }
  if (!input.sessionId.trim() || !input.runtimeId.trim() || !Number.isInteger(input.generation) || input.generation < 1) {
    throw new Error("terminal capability runtime binding is invalid");
  }
  const issuedAt = (input.now ?? new Date()).toISOString();
  const unsigned = {
    version: TERMINAL_CAPABILITY_VERSION,
    capabilityId: `terminal-capability-${randomUUID()}`,
    nonce: randomBytes(32).toString("hex"),
    issuer: input.issuer,
    audience: input.audience,
    sessionId: input.sessionId,
    channelId: input.channelId ?? null,
    runtimeId: input.runtimeId,
    generation: input.generation,
    actions: terminalActionsForMode(input.mode),
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + ttlSeconds * 1_000).toISOString(),
  } as const;
  return { ...unsigned, signature: sign(null, terminalCapabilityTranscript(unsigned), input.privateKey).toString("base64") };
}

export function verifyTerminalCapability(input: Readonly<{
  capability: TerminalCapability;
  publicKey: KeyObject;
  issuer: AuthorityId;
  audience: AuthorityId;
  sessionId: string;
  mode: "observe" | "controller";
  now?: Date;
}>): void {
  const capability = input.capability;
  if (capability.issuer !== input.issuer) throw new Error("terminal capability issuer mismatch");
  if (capability.audience !== input.audience) throw new Error("terminal capability audience mismatch");
  if (capability.sessionId !== input.sessionId) throw new Error("terminal capability session mismatch");
  const required = terminalActionsForMode(input.mode);
  if (required.some((action) => !capability.actions.includes(action))) throw new Error("terminal capability action mismatch");
  const now = (input.now ?? new Date()).getTime();
  const issuedAt = Date.parse(capability.issuedAt);
  const expiresAt = Date.parse(capability.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt || expiresAt - issuedAt > TERMINAL_CAPABILITY_MAX_TTL_SECONDS * 1_000) {
    throw new Error("terminal capability time window is invalid");
  }
  if (issuedAt > now + 30_000) throw new Error("terminal capability is not yet valid");
  if (expiresAt <= now) throw new Error("terminal capability expired");
  const signature = Buffer.from(capability.signature, "base64");
  if (!BASE64.test(capability.signature) || signature.length !== 64 || !verify(null, terminalCapabilityTranscript(capability), input.publicKey, signature)) {
    throw new Error("terminal capability signature is invalid");
  }
}

export function parseTerminalCapability(raw: string): TerminalCapability {
  if (Buffer.byteLength(raw, "utf8") > 8 * 1_024) throw new Error("terminal capability exceeds 8 KiB");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("terminal capability is malformed JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("terminal capability must be an object");
  const record = value as Record<string, unknown>;
  const expected = ["version", "capabilityId", "nonce", "issuer", "audience", "sessionId", "channelId", "runtimeId", "generation", "actions", "issuedAt", "expiresAt", "signature"];
  if (Object.keys(record).some((key) => !expected.includes(key)) || expected.some((key) => !(key in record))) throw new Error("terminal capability fields are invalid");
  if (record.version !== TERMINAL_CAPABILITY_VERSION) throw new Error("terminal capability version is unsupported");
  for (const field of ["capabilityId", "issuer", "audience", "sessionId", "runtimeId", "issuedAt", "expiresAt", "signature"]) {
    if (typeof record[field] !== "string" || !(record[field] as string).trim() || Buffer.byteLength(record[field] as string, "utf8") > 512) throw new Error(`terminal capability ${field} is invalid`);
  }
  if (!/^terminal-capability-[0-9a-f-]{36}$/.test(record.capabilityId as string)) throw new Error("terminal capability id is invalid");
  if (typeof record.nonce !== "string" || !/^[0-9a-f]{64}$/.test(record.nonce)) throw new Error("terminal capability nonce is invalid");
  if (record.channelId !== null && (typeof record.channelId !== "string" || !record.channelId.trim() || Buffer.byteLength(record.channelId, "utf8") > 256)) throw new Error("terminal capability channelId is invalid");
  if (!Number.isInteger(record.generation) || (record.generation as number) < 1) throw new Error("terminal capability generation is invalid");
  if (!Array.isArray(record.actions) || record.actions.length < 1 || record.actions.some((action) => !ACTIONS.includes(action as TerminalCapabilityAction)) || new Set(record.actions).size !== record.actions.length) {
    throw new Error("terminal capability actions are invalid");
  }
  return record as unknown as TerminalCapability;
}

export function encodeTerminalCapability(capability: TerminalCapability): string {
  return Buffer.from(JSON.stringify(capability), "utf8").toString("base64");
}

export function decodeTerminalCapability(encoded: string): TerminalCapability {
  if (!BASE64.test(encoded) || encoded.length % 4 !== 0) throw new Error("terminal capability must be base64-encoded");
  return parseTerminalCapability(Buffer.from(encoded, "base64").toString("utf8"));
}

function terminalCapabilityTranscript(capability: Omit<TerminalCapability, "signature"> | TerminalCapability): Buffer {
  const ordered = {
    version: capability.version,
    capabilityId: capability.capabilityId,
    nonce: capability.nonce,
    issuer: capability.issuer,
    audience: capability.audience,
    sessionId: capability.sessionId,
    channelId: capability.channelId,
    runtimeId: capability.runtimeId,
    generation: capability.generation,
    actions: capability.actions,
    issuedAt: capability.issuedAt,
    expiresAt: capability.expiresAt,
  };
  return Buffer.from(`${TERMINAL_CAPABILITY_DOMAIN}\n${JSON.stringify(ordered)}`, "utf8");
}

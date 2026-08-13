// SPDX-License-Identifier: Apache-2.0
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

export const HOST_PROTOCOL_VERSION = 1;
export const HOST_FRAME_LIMIT = 1 << 20;
export const HOST_TYPES = {
  hello: 0x01, helloAck: 0x02, output: 0x03, input: 0x04, resize: 0x05,
  exit: 0x06, error: 0x07, ping: 0x08, pong: 0x09, wipe: 0x0a,
  wipeAck: 0x0b, deliverMessage: 0x0c, deliverAck: 0x0d, signal: 0x0e,
  terminate: 0x0f, terminateAck: 0x10, enroll: 0x20, ready: 0x23,
} as const;

export interface HostFrame { type: number; payload: Buffer }
export interface HostReady { generation: number; hostPid: number; childPid: number }
export interface HostHelloAck { version: number; generation: number; replayFrom: bigint; head: bigint; gap: boolean }
export interface HostOutput { cursor: bigint; bytes: Buffer }
export interface HostExit { code: number }
export interface HostError { code: number; message: string }
export interface HostDeliveryAck { id: string; generation: number; outcome: "written" | "duplicate" | "uncertain"; bytesWritten: number }

export function frame(type: number, payload: Uint8Array = Buffer.alloc(0)): Buffer {
  if (!Number.isInteger(type) || type < 0 || type > 255) throw new Error("invalid host frame type");
  const length = payload.byteLength + 1;
  if (length > HOST_FRAME_LIMIT) throw new Error("host frame exceeds limit");
  const result = Buffer.allocUnsafe(length + 4);
  result.writeUInt32BE(length, 0);
  result[4] = type;
  Buffer.from(payload).copy(result, 5);
  return result;
}

export class HostFrameDecoder {
  private buffer = Buffer.alloc(0);
  push(chunk: Uint8Array): HostFrame[] {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const frames: HostFrame[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length < 1 || length > HOST_FRAME_LIMIT) throw new Error("invalid host frame length");
      if (this.buffer.length < length + 4) break;
      const type = this.buffer[4]!;
      frames.push({ type, payload: Buffer.from(this.buffer.subarray(5, length + 4)) });
      this.buffer = this.buffer.subarray(length + 4);
    }
    return frames;
  }
  finish(): void { if (this.buffer.length !== 0) throw new Error("truncated host frame"); }
}

export function encodeEnrollment(input: {
  sessionId: string; channelId?: string | null; runtimeId: string; homeAuthorityId: string; generation: number;
  protocolVersion: number; expiresAt: number; reconnectSecret: Uint8Array;
  statePath: string; socketPath: string; ringBytes: number;
  command?: readonly string[]; cwd?: string;
}): Buffer {
  return frame(HOST_TYPES.enroll, Buffer.from(JSON.stringify({
    version: 1, sessionId: input.sessionId, ...(input.channelId ? { channelId: input.channelId } : {}), runtimeId: input.runtimeId,
    homeAuthorityId: input.homeAuthorityId, generation: input.generation,
    protocolVersion: input.protocolVersion, expiresAt: input.expiresAt,
    reconnectSecret: Buffer.from(input.reconnectSecret).toString("base64").replace(/=+$/g, ""),
    statePath: input.statePath, socketPath: input.socketPath, ringBytes: input.ringBytes,
    ...(input.command ? { command: input.command } : {}), ...(input.cwd ? { cwd: input.cwd } : {}),
  }), "utf8"));
}

export function encodeHello(input: {
  sessionId: string; runtimeId: string; homeAuthorityId: string; generation: number;
  expiresAt: number; secret: Uint8Array; actions: readonly string[]; cursor: bigint;
  mode: "observe" | "controller";
}): Buffer {
  return Buffer.from(JSON.stringify({
    version: HOST_PROTOCOL_VERSION, issuer: "roomsd", audience: input.runtimeId,
    sessionId: input.sessionId, runtimeId: input.runtimeId, homeAuthorityId: input.homeAuthorityId,
    generation: input.generation, actions: input.actions, expiry: input.expiresAt,
    nonce: randomBytes(16).toString("hex"), id: randomBytes(16).toString("hex"), cursor: Number(input.cursor),
    secret: Buffer.from(input.secret).toString("base64"),
  }), "utf8");
}

export function decodeReady(payload: Uint8Array): HostReady {
  const value = Buffer.from(payload);
  if (value.length !== 12) throw new Error("invalid host READY");
  return { generation: value.readUInt32BE(0), hostPid: value.readUInt32BE(4), childPid: value.readUInt32BE(8) };
}
export function decodeHelloAck(payload: Uint8Array): HostHelloAck {
  const value = Buffer.from(payload);
  if (value.length !== 23) throw new Error("invalid host HELLO_ACK");
  return { version: value.readUInt16BE(0), generation: value.readUInt32BE(2), replayFrom: value.readBigUInt64BE(6), head: value.readBigUInt64BE(14), gap: value[22] === 1 };
}
export function decodeOutput(payload: Uint8Array): HostOutput {
  const value = Buffer.from(payload);
  if (value.length < 8) throw new Error("invalid host output");
  return { cursor: value.readBigUInt64BE(0), bytes: Buffer.from(value.subarray(8)) };
}
export function decodeExit(payload: Uint8Array): HostExit {
  const value = Buffer.from(payload);
  if (value.length !== 4) throw new Error("invalid host exit");
  return { code: value.readInt32BE(0) };
}
export function decodeError(payload: Uint8Array): HostError {
  const value = Buffer.from(payload);
  if (value.length < 2) throw new Error("invalid host error");
  return { code: value.readUInt16BE(0), message: value.subarray(2).toString("utf8") };
}
export function decodeDeliveryAck(payload: Uint8Array): HostDeliveryAck {
  const value = JSON.parse(Buffer.from(payload).toString("utf8")) as Record<string, unknown>;
  if (typeof value.id !== "string" || typeof value.generation !== "number" || typeof value.outcome !== "string" || typeof value.bytesWritten !== "number") throw new Error("invalid delivery acknowledgement");
  if (value.outcome !== "written" && value.outcome !== "duplicate" && value.outcome !== "uncertain") throw new Error("invalid delivery outcome");
  return { id: value.id, generation: value.generation, outcome: value.outcome, bytesWritten: value.bytesWritten };
}

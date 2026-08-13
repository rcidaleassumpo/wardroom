// SPDX-License-Identifier: Apache-2.0
import { Buffer } from "node:buffer";
import { createConnection, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import {
  decodeDeliveryAck, decodeError, decodeExit, decodeHelloAck, decodeOutput, encodeHello,
  HostFrameDecoder, HOST_TYPES, type HostDeliveryAck, type HostError, type HostExit, type HostHelloAck, type HostOutput,
} from "./codec.js";

export interface HostClientIdentity { sessionId: string; runtimeId: string; homeAuthorityId: string; generation: number; secret: Uint8Array }
export interface DeliverMessageInput { id: string; frames: readonly Uint8Array[]; delaysMs: readonly number[] }
export type HostClientEvents = { output: (value: HostOutput) => void; exit: (value: HostExit) => void; error: (value: HostError) => void; close: () => void };
export const HOST_CAPABILITY_TTL_SECONDS = 300;
export const HOST_CAPABILITY_RENEWAL_SECONDS = 240;
export interface RuntimeHostClientOptions { renewCapabilities?: boolean }

export class RuntimeHostClient extends EventEmitter {
  private socket?: Socket;
  private decoder = new HostFrameDecoder();
  private pending = new Map<number, (frame: { type: number; payload: Buffer }) => void>();
  private nextRequest = 1;
  private closed = false;
  private mode?: "observe" | "controller";
  private actions: readonly string[] = [];
  private cursor = 0n;
  private renewalTimer?: NodeJS.Timeout;
  constructor(private readonly socketPath: string, private readonly identity: HostClientIdentity, private readonly options: RuntimeHostClientOptions = {}) { super(); }

  async connect(mode: "observe" | "controller", actions: readonly string[], cursor = 0n, expiresAt = Math.floor(Date.now() / 1000) + HOST_CAPABILITY_TTL_SECONDS): Promise<HostHelloAck> {
    if (this.socket) throw new Error("host client already connected");
    const socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = createConnection(this.socketPath);
      candidate.once("connect", () => { candidate.removeListener("error", reject); resolve(candidate); });
      candidate.once("error", reject);
    });
    this.socket = socket;
    this.mode = mode;
    this.actions = [...actions];
    this.cursor = cursor;
    socket.unref();
    socket.on("data", (chunk) => { for (const frame of this.decoder.push(chunk)) this.dispatch(frame); });
    socket.once("close", () => { this.closed = true; this.emit("close"); });
    socket.once("error", (error) => this.emit("error", { code: 0, message: error.message } satisfies HostError));
    const ack = await this.request(HOST_TYPES.hello, encodeHello({ ...this.identity, actions, cursor, mode, expiresAt }), HOST_TYPES.helloAck);
    const hello = decodeHelloAck(ack.payload);
    this.cursor = hello.head;
    if (this.options.renewCapabilities) this.scheduleRenewal();
    return hello;
  }

  input(bytes: Uint8Array): void { this.send(HOST_TYPES.input, Buffer.from(bytes)); }
  resize(columns: number, rows: number): void { if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || columns > 1000 || rows < 1 || rows > 1000) throw new Error("invalid terminal size"); const payload = Buffer.alloc(4); payload.writeUInt16BE(columns, 0); payload.writeUInt16BE(rows, 2); this.send(HOST_TYPES.resize, payload); }
  signal(signal: "SIGHUP" | "SIGINT" | "SIGTERM" | "SIGWINCH"): void { const value = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGWINCH: 28 }[signal]; this.send(HOST_TYPES.signal, Buffer.from([value])); }
  terminate(): Promise<void> { return this.request(HOST_TYPES.terminate, Buffer.alloc(0), HOST_TYPES.terminateAck).then(() => undefined); }
  ping(): Promise<void> { return this.request(HOST_TYPES.ping, Buffer.alloc(0), HOST_TYPES.pong).then(() => undefined); }
  deliverMessage(input: DeliverMessageInput): Promise<HostDeliveryAck> {
    if (!input.id || input.frames.length === 0 || input.frames.length > 64 || input.frames.length !== input.delaysMs.length) throw new Error("invalid delivery transaction");
    const totalBytes = input.frames.reduce((sum, frame) => sum + frame.byteLength, 0);
    const totalDelay = input.delaysMs.reduce((sum, delay) => sum + delay, 0);
    if (totalBytes > 1 << 20 || totalDelay > 5000 || input.frames.some((frame) => frame.byteLength > 65536) || input.delaysMs.some((delay) => !Number.isInteger(delay) || delay < 0 || delay > 5000)) throw new Error("delivery transaction exceeds bounds");
    const payload = Buffer.from(JSON.stringify({ id: input.id, frames: input.frames.map((value) => Buffer.from(value).toString("base64")), delaysMs: input.delaysMs }));
    return this.request(HOST_TYPES.deliverMessage, payload, HOST_TYPES.deliverAck).then((response) => decodeDeliveryAck(response.payload));
  }
  close(): void { this.closed = true; if (this.renewalTimer) clearTimeout(this.renewalTimer); this.renewalTimer = undefined; this.socket?.destroy(); this.socket = undefined; }

  private scheduleRenewal(): void {
    if (this.renewalTimer) clearTimeout(this.renewalTimer);
    this.renewalTimer = setTimeout(() => { void this.renewCapability(); }, HOST_CAPABILITY_RENEWAL_SECONDS * 1_000);
    this.renewalTimer.unref();
  }

  private async renewCapability(): Promise<void> {
    if (this.closed || !this.mode) return;
    try {
      const response = await this.request(HOST_TYPES.hello, encodeHello({
        ...this.identity,
        actions: this.actions,
        cursor: this.cursor,
        mode: this.mode,
        expiresAt: Math.floor(Date.now() / 1000) + HOST_CAPABILITY_TTL_SECONDS,
      }), HOST_TYPES.helloAck);
      const hello = decodeHelloAck(response.payload);
      this.cursor = hello.head;
      this.scheduleRenewal();
    } catch (error) {
      this.emit("error", { code: Number((error as { code?: unknown }).code) || 1, message: error instanceof Error ? error.message : String(error) } satisfies HostError);
      this.close();
    }
  }

  private send(type: number, payload: Uint8Array): void { if (!this.socket || this.closed) throw new Error("host client is not connected"); this.socket.write(frameFor(type, payload)); }
  private request(type: number, payload: Uint8Array, responseType: number): Promise<{ type: number; payload: Buffer }> {
    const requestId = this.nextRequest++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("runtime host request timed out")); }, 10_000);
      this.pending.set(requestId, (value) => { clearTimeout(timer); if (value.type === HOST_TYPES.error) reject(hostError(value.payload)); else if (value.type !== responseType) reject(new Error(`unexpected host response ${value.type}`)); else resolve(value); });
      try { this.send(type, payload); } catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
  private dispatch(value: { type: number; payload: Buffer }): void {
    if (value.type === HOST_TYPES.output) { const output = decodeOutput(value.payload); this.cursor = output.cursor + BigInt(output.bytes.byteLength); this.emit("output", output); return; }
    if (value.type === HOST_TYPES.exit) { this.emit("exit", decodeExit(value.payload)); return; }
    const first = this.pending.entries().next().value as [number, (frame: { type: number; payload: Buffer }) => void] | undefined;
    if (first) { this.pending.delete(first[0]); first[1](value); return; }
    if (value.type === HOST_TYPES.error) this.emit("error", decodeError(value.payload));
  }
}

function frameFor(type: number, payload: Uint8Array): Buffer { const length = payload.byteLength + 1; const result = Buffer.allocUnsafe(length + 4); result.writeUInt32BE(length, 0); result[4] = type; Buffer.from(payload).copy(result, 5); return result; }
function hostError(payload: Uint8Array): Error { const error = decodeError(payload); return Object.assign(new Error(error.message), { code: error.code }); }

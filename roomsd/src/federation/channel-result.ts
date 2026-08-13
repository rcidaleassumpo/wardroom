// SPDX-License-Identifier: Apache-2.0
import { Buffer } from "node:buffer";
import type { RelayConnection } from "./relay-connection.js";
import type { RelayChannelFrame } from "./relay-protocol.js";

const RESULT_CHUNK_BYTES = 4_096;
const MAX_RESULT_BYTES = 128 * 1024;

export type AssembledChannelResult = Readonly<{ ok: boolean; value: unknown }>;

/** Sends a bounded result as ordered relay frames without requiring a large wire frame. */
export function sendChannelResult(connection: RelayConnection, requestId: string, ok: boolean, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  if (bytes.length > MAX_RESULT_BYTES) throw new Error(`channel result exceeds ${MAX_RESULT_BYTES} bytes`);
  const chunks = Math.max(1, Math.ceil(bytes.length / RESULT_CHUNK_BYTES));
  for (let chunkIndex = 0; chunkIndex < chunks; chunkIndex += 1) {
    const chunk = bytes.subarray(chunkIndex * RESULT_CHUNK_BYTES, (chunkIndex + 1) * RESULT_CHUNK_BYTES);
    connection.sendChannel({
      kind: "channelResult",
      requestId,
      ok,
      chunkIndex,
      final: chunkIndex === chunks - 1,
      payload: chunk.toString("base64"),
    });
  }
}

/** Reassembles one logical channel result while enforcing order and memory bounds. */
export class ChannelResultAssembler {
  private readonly pending = new Map<string, { ok: boolean; nextChunk: number; bytes: number; chunks: Buffer[] }>();

  accept(frame: RelayChannelFrame): AssembledChannelResult | undefined {
    if (frame.kind !== "channelResult") return undefined;
    const state = this.pending.get(frame.requestId) ?? { ok: frame.ok, nextChunk: 0, bytes: 0, chunks: [] };
    if (state.ok !== frame.ok || frame.chunkIndex !== state.nextChunk) {
      this.pending.delete(frame.requestId);
      throw new Error("invalid channel result chunk sequence");
    }
    const chunk = Buffer.from(frame.payload, "base64");
    state.bytes += chunk.length;
    if (state.bytes > MAX_RESULT_BYTES) {
      this.pending.delete(frame.requestId);
      throw new Error("channel result exceeds reassembly bound");
    }
    state.chunks.push(chunk);
    state.nextChunk += 1;
    if (!frame.final) {
      this.pending.set(frame.requestId, state);
      return undefined;
    }
    this.pending.delete(frame.requestId);
    return { ok: state.ok, value: JSON.parse(Buffer.concat(state.chunks).toString("utf8")) };
  }

  clear(requestId?: string): void {
    if (requestId) this.pending.delete(requestId);
    else this.pending.clear();
  }
}

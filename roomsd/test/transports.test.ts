import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindRoomsService, connectRoomsService } from "../src/transports/unix/index.js";
import type { RoomsServiceHandler } from "../src/api/service/handler.js";
import { ROOMS_PROTOCOL_MAX_VERSION, ROOMS_PROTOCOL_MIN_VERSION } from "../src/api/protocol-compatibility.js";

const context = { protocolVersion: ROOMS_PROTOCOL_MAX_VERSION };

// The transport injects connection state as __connection for handlers to
// consume; a real handler never echoes it, so this echo handler strips it.
const sanitize = (request: unknown) => { const { __connection: _, ...rest } = request as Record<string, unknown>; return rest; };
const handler = {
  status: async (request: unknown) => ({ accepted: sanitize(request) }),
  channelStateSnapshots: async (request: unknown) => ({ snapshots: { build: { channelId: "build", revision: "1:1", lifecycleState: "active", members: [] } }, errors: {}, accepted: sanitize(request) }),
  channelControlPages: async (request: unknown) => ({ controls: { build: { events: [], cursor: "7", hasMore: false } }, errors: {}, accepted: sanitize(request) }),
  watch: async function* (request: unknown) { yield { accepted: sanitize(request), ordinal: 1 }; yield { accepted: sanitize(request), ordinal: 2 }; },
  showChannel: async () => { throw Object.assign(new Error("channel missing"), { code: "channelNotFound" }); },
} as unknown as RoomsServiceHandler;

describe("portable local transport adapters", () => {
  it.each([
    ["unix", (dir: string) => ({ kind: "unix" as const, path: join(dir, "rooms.sock") })],
    ["named pipe", (dir: string) => ({ kind: "namedPipe" as const, name: join(dir, "rooms.pipe") })],
  ])("binds the generated handler over %s", async (_name, endpointFor) => {
    const dir = mkdtempSync(join(tmpdir(), "rooms-transport-"));
    const endpoint = endpointFor(dir);
    const server = await bindRoomsService(handler, endpoint);
    const socket = await connectRoomsService(endpoint);
    socket.setEncoding("utf8");
    try {
      const response = await new Promise<string>((resolve) => { socket.once("data", resolve); socket.write(JSON.stringify({ method: "status", request: { channelId: "build", context } }) + "\n"); });
      expect(JSON.parse(response)).toEqual({ response: { accepted: { channelId: "build", context } } });
    } finally { socket.destroy(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("binds the same handler on loopback TCP and reports the selected port", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rooms-transport-"));
    const server = await bindRoomsService(handler, { kind: "tcp", host: "127.0.0.1", port: 0 });
    expect(server.endpoint).toMatchObject({ kind: "tcp", host: "127.0.0.1" });
    expect((server.endpoint as { port: number }).port).toBeGreaterThan(0);
    await server.close(); rmSync(dir, { recursive: true, force: true });
  });

  it("serves a multi-channel state snapshot in one typed request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rooms-transport-state-"));
    const endpoint = { kind: "unix" as const, path: join(dir, "rooms.sock") };
    const server = await bindRoomsService(handler, endpoint);
    const socket = await connectRoomsService(endpoint); socket.setEncoding("utf8");
    try {
      const response = await new Promise<string>((resolve) => { socket.once("data", resolve); socket.write(JSON.stringify({ method: "channelStateSnapshots", request: { channelIds: ["build"], context } }) + "\n"); });
      expect(JSON.parse(response)).toEqual({ response: { snapshots: { build: { channelId: "build", revision: "1:1", lifecycleState: "active", members: [] } }, errors: {}, accepted: { channelIds: ["build"], context } } });
    } finally { socket.destroy(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("serves multi-channel control cursors in one typed request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rooms-transport-controls-"));
    const endpoint = { kind: "unix" as const, path: join(dir, "rooms.sock") };
    const server = await bindRoomsService(handler, endpoint);
    const socket = await connectRoomsService(endpoint); socket.setEncoding("utf8");
    try {
      const request = { channels: [{ channelId: "build", afterCursor: "7" }], sessionId: "operator", limit: 100, context };
      const response = await new Promise<string>((resolve) => { socket.once("data", resolve); socket.write(JSON.stringify({ method: "channelControlPages", request }) + "\n"); });
      expect(JSON.parse(response)).toEqual({ response: { controls: { build: { events: [], cursor: "7", hasMore: false } }, errors: {}, accepted: request } });
    } finally { socket.destroy(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps watch items ordered and marks stream completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rooms-transport-"));
    const endpoint = { kind: "unix" as const, path: join(dir, "rooms.sock") };
    const server = await bindRoomsService(handler, endpoint);
    const socket = await connectRoomsService(endpoint); socket.setEncoding("utf8");
    try {
      const lines = await new Promise<string[]>((resolve) => {
        const got: string[] = []; socket.on("data", (chunk: string) => { got.push(...chunk.trim().split("\n")); if (got.length === 3) resolve(got); });
        socket.write(JSON.stringify({ method: "watch", request: { afterCursor: "0", context } }) + "\n");
      });
      expect(lines.map((line) => JSON.parse(line))).toEqual([
        { stream: { accepted: { afterCursor: "0", context }, ordinal: 1 } },
        { stream: { accepted: { afterCursor: "0", context }, ordinal: 2 } },
        { streamEnd: true },
      ]);
    } finally { socket.destroy(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("maps domain errors to the typed Rooms error contract", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rooms-transport-error-"));
    const endpoint = { kind: "unix" as const, path: join(dir, "rooms.sock") };
    const server = await bindRoomsService(handler, endpoint);
    const socket = await connectRoomsService(endpoint); socket.setEncoding("utf8");
    try {
      const response = await new Promise<string>((resolve) => { socket.once("data", resolve); socket.write(JSON.stringify({ method: "showChannel", request: { channelId: "missing", context } }) + "\n"); });
      expect(JSON.parse(response)).toEqual({ error: { code: "not_found", message: "channel missing", domainCode: "channelNotFound" } });
    } finally { socket.destroy(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([
    ["missing", undefined],
    ["older", ROOMS_PROTOCOL_MIN_VERSION - 1],
    ["newer", ROOMS_PROTOCOL_MAX_VERSION + 1],
  ])("rejects a %s typed request protocol version before handler dispatch", async (_name, protocolVersion) => {
    const dir = mkdtempSync(join(tmpdir(), "rooms-transport-version-"));
    const endpoint = { kind: "unix" as const, path: join(dir, "rooms.sock") };
    const server = await bindRoomsService(handler, endpoint);
    const socket = await connectRoomsService(endpoint); socket.setEncoding("utf8");
    try {
      const requestContext = protocolVersion === undefined ? {} : { protocolVersion };
      const response = await new Promise<string>((resolve) => { socket.once("data", resolve); socket.write(JSON.stringify({ method: "status", request: { context: requestContext } }) + "\n"); });
      expect(JSON.parse(response)).toEqual({ error: { code: "failed_precondition", message: expect.stringContaining("supported version: 4"), domainCode: "protocolVersionMismatch" } });
    } finally { socket.destroy(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects an older legacy envelope with the same typed mismatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rooms-transport-version-"));
    const endpoint = { kind: "unix" as const, path: join(dir, "rooms.sock") };
    const server = await bindRoomsService(handler, endpoint);
    const socket = await connectRoomsService(endpoint); socket.setEncoding("utf8");
    try {
      const response = await new Promise<string>((resolve) => { socket.once("data", resolve); socket.write(JSON.stringify({ protocolVersion: ROOMS_PROTOCOL_MIN_VERSION - 1, kind: "status" }) + "\n"); });
      expect(JSON.parse(response)).toEqual({ error: { code: "failed_precondition", message: expect.stringContaining("supported version: 4"), domainCode: "protocolVersionMismatch" } });
    } finally { socket.destroy(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

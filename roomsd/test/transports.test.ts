import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindRoomsService, connectRoomsService } from "../src/transports/unix/index.js";
import type { RoomsServiceHandler } from "../src/api/service/handler.js";

// The transport injects connection state as __connection for handlers to
// consume; a real handler never echoes it, so this echo handler strips it.
const sanitize = (request: unknown) => { const { __connection: _, ...rest } = request as Record<string, unknown>; return rest; };
const handler = {
  status: async (request: unknown) => ({ accepted: sanitize(request) }),
  watch: async function* (request: unknown) { yield { accepted: sanitize(request), ordinal: 1 }; yield { accepted: sanitize(request), ordinal: 2 }; },
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
      const response = await new Promise<string>((resolve) => { socket.once("data", resolve); socket.write(JSON.stringify({ method: "status", request: { channelId: "build" } }) + "\n"); });
      expect(JSON.parse(response)).toEqual({ response: { accepted: { channelId: "build" } } });
    } finally { socket.destroy(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("binds the same handler on loopback TCP and reports the selected port", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rooms-transport-"));
    const server = await bindRoomsService(handler, { kind: "tcp", host: "127.0.0.1", port: 0 });
    expect(server.endpoint).toMatchObject({ kind: "tcp", host: "127.0.0.1" });
    expect((server.endpoint as { port: number }).port).toBeGreaterThan(0);
    await server.close(); rmSync(dir, { recursive: true, force: true });
  });

  it("keeps watch items ordered and marks stream completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rooms-transport-"));
    const endpoint = { kind: "unix" as const, path: join(dir, "rooms.sock") };
    const server = await bindRoomsService(handler, endpoint);
    const socket = await connectRoomsService(endpoint); socket.setEncoding("utf8");
    try {
      const lines = await new Promise<string[]>((resolve) => {
        const got: string[] = []; socket.on("data", (chunk: string) => { got.push(...chunk.trim().split("\n")); if (got.length === 3) resolve(got); });
        socket.write(JSON.stringify({ method: "watch", request: { afterCursor: "0" } }) + "\n");
      });
      expect(lines.map((line) => JSON.parse(line))).toEqual([
        { stream: { accepted: { afterCursor: "0" }, ordinal: 1 } },
        { stream: { accepted: { afterCursor: "0" }, ordinal: 2 } },
        { streamEnd: true },
      ]);
    } finally { socket.destroy(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

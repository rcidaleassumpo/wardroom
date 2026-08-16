import { describe, expect, it, vi } from "vitest";
import type { RoomsService } from "../src/generated/rooms/v1/rooms.js";
import { createRoomsServiceHandler } from "../src/api/service/handler.js";

describe("Rooms API handler", () => {
  it("delegates transport-neutral calls to the generated service implementation", async () => {
    const createChannel = vi.fn(async () => ({ channel: { id: "build", lifecycleState: "active" as const } }));
    const service = { createChannel } as unknown as RoomsService;
    const handler = createRoomsServiceHandler({ service });

    await expect(handler.createChannel({ channelName: "build", ownerOperatorSessionId: "operator" })).resolves.toEqual({
      channel: { id: "build", lifecycleState: "active" },
    });
    expect(createChannel).toHaveBeenCalledWith({ channelName: "build", ownerOperatorSessionId: "operator" });
  });

  it("keeps watch as an async iterable owned by the service implementation", async () => {
    const watch = vi.fn(() => (async function* () { yield { status: { state: "running" as const } }; })());
    const service = { watch } as unknown as RoomsService;
    const handler = createRoomsServiceHandler({ service });

    expect(await handler.watch({ channelId: "build" })[Symbol.asyncIterator]().next()).toEqual({
      value: { status: { state: "running" } }, done: false,
    });
  });

  it("exposes the private lead broadcast extension through the transport-neutral handler", async () => {
    const leadBroadcast = vi.fn(async () => ({ idempotencyKey: "key", results: [{ channelId: "alpha", status: "sent" as const }] }));
    const handler = createRoomsServiceHandler({ service: { leadBroadcast } as unknown as RoomsService });
    const request = { idempotencyKey: "key", body: "hello", channelIds: ["alpha"], attachmentReferences: ["attachment:a"] };

    await expect(handler.leadBroadcast!(request)).resolves.toEqual({ idempotencyKey: "key", results: [{ channelId: "alpha", status: "sent" }] });
    expect(leadBroadcast).toHaveBeenCalledWith(request);
  });
});

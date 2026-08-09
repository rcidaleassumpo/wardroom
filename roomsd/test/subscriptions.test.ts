import { describe, expect, it } from "vitest";
import { RoomsSubscriptionService, type SubscriptionSource } from "../src/api/subscriptions/subscription.js";
import type { Change, Cursor, Snapshot } from "../src/domain/contracts.js";

const cursor = (value: number) => String(value) as Cursor;
const change = (value: number): Change => ({ cursor: cursor(value), kind: "message.sent", payload: { value }, channelId: "build", occurredAt: new Date(value).toISOString() });
const snapshot = (): Snapshot => ({ cursor: cursor(1), channel: { id: "build", registeredAt: "now", ownerOperatorSessionId: null, lifecycleState: "active", closedAt: null }, sessions: [], memberships: [], events: [] });

class FakeSource implements SubscriptionSource {
  listeners = new Set<(changes: Change[]) => void>(); changes: Change[] = [];
  snapshot() { return snapshot(); }
  replay(after: Cursor) { return this.changes.filter((item) => BigInt(item.cursor) > BigInt(after)); }
  onCommit(listener: (changes: Change[]) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  commit(...changes: Change[]) { this.changes.push(...changes); for (const listener of this.listeners) listener(changes); }
}

describe("Rooms subscriptions", () => {
  it("sends one snapshot then ordered committed deltas without duplicates", async () => {
    const source = new FakeSource(); const service = new RoomsSubscriptionService(source); const stream = service.subscribe({ channelId: "build" });
    expect((await stream.next()).value?.type).toBe("snapshot");
    source.commit(change(2), change(3));
    expect((await stream.next()).value).toMatchObject({ type: "delta", cursor: "3" });
    source.commit(change(3), change(4));
    expect((await stream.next()).value).toMatchObject({ type: "delta", cursor: "4" });
    service.acknowledge(stream.id, cursor(4));
  });

  it("resumes exclusively after the supplied cursor", async () => {
    const source = new FakeSource(); source.commit(change(2), change(3), change(4));
    const stream = new RoomsSubscriptionService(source).subscribe({ channelId: "build", afterCursor: cursor(2) });
    expect((await stream.next()).value).toEqual({ type: "delta", changes: [change(3), change(4)], cursor: cursor(4) });
  });

  it("closes when the bounded queue overflows", async () => {
    const source = new FakeSource(); const service = new RoomsSubscriptionService(source, 1); const stream = service.subscribe({ channelId: "build" });
    await stream.next(); source.commit(change(2)); source.commit(change(3));
    expect((await stream.next()).done).toBe(true);
  });
});

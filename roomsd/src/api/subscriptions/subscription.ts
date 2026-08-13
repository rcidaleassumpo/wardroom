// SPDX-License-Identifier: Apache-2.0
import type { Change, Cursor, Snapshot } from "../../domain/contracts.js";

export type SnapshotOrDelta =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "delta"; changes: Change[]; cursor: Cursor };

export interface SubscriptionSource {
  snapshot(channelId: string): Snapshot;
  replay(afterCursor: Cursor, channelId?: string): Change[];
  onCommit(listener: (changes: Change[]) => void): () => void;
}

export interface SubscriptionInput {
  channelId: string;
  afterCursor?: Cursor;
  filter?: (change: Change) => boolean;
  cancellation?: AbortSignal;
}

export interface SubscriptionStream extends AsyncIterable<SnapshotOrDelta> {
  readonly id: string;
  close(): void;
}

export class SubscriptionError extends Error {
  constructor(public readonly code: "backpressure" | "sourceLost" | "closed" | "unknownSubscription", message = code) {
    super(message);
    this.name = "SubscriptionError";
  }
}

/** Maximum queued delta batches before a slow watcher is closed. */
export const DEFAULT_MAX_BUFFERED_DELTA_BATCHES = 128;

export class RoomsSubscriptionService {
  private nextId = 1;
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly source: SubscriptionSource, private readonly maxBuffered = DEFAULT_MAX_BUFFERED_DELTA_BATCHES) {
    if (!Number.isSafeInteger(maxBuffered) || maxBuffered < 1) throw new RangeError("maxBuffered must be positive");
  }

  subscribe(input: SubscriptionInput): SubscriptionStream {
    const id = `subscription-${this.nextId++}`;
    const session = new Session(id, this.source, input, this.maxBuffered, () => this.sessions.delete(id));
    this.sessions.set(id, session);
    session.start();
    return session;
  }

  acknowledge(subscriptionId: string, cursor: Cursor): void {
    const session = this.sessions.get(subscriptionId);
    if (!session) throw new SubscriptionError("unknownSubscription");
    session.acknowledge(cursor);
  }
}

class Session implements SubscriptionStream {
  private queue: SnapshotOrDelta[] = [];
  private waiter: ((result: IteratorResult<SnapshotOrDelta>) => void) | undefined;
  private unsubscribe = () => {};
  private closed = false;
  private delivered: Cursor | undefined;
  private acknowledged: Cursor | undefined;

  constructor(
    readonly id: string,
    private readonly source: SubscriptionSource,
    private readonly input: SubscriptionInput,
    private readonly maxBuffered: number,
    private readonly onClose: () => void,
  ) {}

  start() {
    try {
      if (this.input.afterCursor) {
        this.enqueueChanges(this.source.replay(this.input.afterCursor, this.input.channelId));
      } else {
        const snapshot = this.source.snapshot(this.input.channelId);
        this.delivered = snapshot.cursor;
        this.queue.push({ type: "snapshot", snapshot });
      }
      this.unsubscribe = this.source.onCommit((changes) => this.enqueueChanges(changes));
      this.input.cancellation?.addEventListener("abort", () => this.close(), { once: true });
    } catch {
      this.close();
    }
  }

  acknowledge(cursor: Cursor) {
    if (this.closed) throw new SubscriptionError("closed");
    if (this.delivered && BigInt(cursor) > BigInt(this.delivered)) throw new SubscriptionError("closed");
    if (!this.acknowledged || BigInt(cursor) > BigInt(this.acknowledged)) this.acknowledged = cursor;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.queue.length = 0;
    this.waiter?.({ value: undefined, done: true });
    this.waiter = undefined;
    this.onClose();
  }

  [Symbol.asyncIterator](): AsyncIterator<SnapshotOrDelta> { return this; }

  next(): Promise<IteratorResult<SnapshotOrDelta>> {
    if (this.queue.length > 0) {
      const value = this.queue.shift()!;
      if (value.type === "delta") this.delivered = value.cursor;
      return Promise.resolve({ value, done: false });
    }
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  private enqueueChanges(changes: Change[]) {
    if (this.closed) return;
    const filtered = changes.filter((change) => (change.channelId === this.input.channelId || change.channelId === null) && (!this.input.filter || this.input.filter(change)));
    const after = this.input.afterCursor ?? this.delivered;
    const unique = filtered.filter((change, index) => BigInt(change.cursor) > BigInt(after ?? "0") && filtered.findIndex((item) => item.cursor === change.cursor) === index);
    if (unique.length === 0) return;
    unique.sort((left, right) => Number(BigInt(left.cursor) - BigInt(right.cursor)));
    const last = unique.at(-1)!.cursor;
    this.queue.push({ type: "delta", changes: unique, cursor: last });
    if (this.queue.length > this.maxBuffered) { this.close(); return; }
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      void this.next().then(waiter);
    }
  }
}

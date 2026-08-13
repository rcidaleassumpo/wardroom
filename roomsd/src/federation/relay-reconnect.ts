// SPDX-License-Identifier: Apache-2.0
/**
 * Capped exponential backoff with jitter and a small reconnect loop for the initiator side
 * of a Rooms relay connection. Never busy-loops: the delay before each redial attempt grows
 * exponentially up to a fixed cap and is jittered, and the loop gives up outright (no more
 * redials) on a disconnect reason that reflects a durable local decision — an inactive,
 * mismatched, or revoked peer trust record, a rejected/invalid handshake, or a graceful
 * close either side initiated on purpose — rather than retrying a connection that cannot
 * succeed until an operator re-enrolls the peer.
 */

import type { RelayConnection, RelayConnectionStatus, RelayDisconnectReason } from "./relay-connection.js";
import type { RelayPeerStatus } from "./relay-protocol.js";

export type RelayBackoffConfig = Readonly<{ baseMs: number; maxMs: number; random?: () => number }>;

export const DEFAULT_RELAY_BACKOFF_CONFIG: RelayBackoffConfig = { baseMs: 250, maxMs: 30_000 };

/** Equal-jitter exponential backoff: raw = min(maxMs, baseMs * 2^attempt); returns a value in [raw/2, raw], so the loop never sleeps less than half the unjittered value and never exceeds the cap. */
export function nextBackoffDelayMs(attempt: number, config: RelayBackoffConfig = DEFAULT_RELAY_BACKOFF_CONFIG): number {
  if (!Number.isInteger(attempt) || attempt < 0) throw new Error("attempt must be a non-negative integer");
  const random = config.random ?? Math.random;
  const raw = Math.min(config.maxMs, config.baseMs * 2 ** attempt);
  return Math.round(raw / 2 + random() * (raw / 2));
}

const NON_RETRYABLE_REASONS: ReadonlySet<RelayDisconnectReason> = new Set([
  "gracefulClose", "peerDrained", "peerClosed",
  "handshakeRejected", "wrongDestination", "wrongPeer", "wrongConnection", "wrongDirection",
  "keyMismatch", "peerNotActive", "peerTrustMismatch", "peerTrustRevoked", "invalidSignature",
  "protocolDowngrade", "malformedHandshake", "sequenceViolation", "unknownField", "oversizeFrame",
]);

/** True for a disconnect reason worth redialing (a transient transport/timing fault); false for a durable local/trust/protocol decision that will not resolve itself by retrying. */
export function isRetryableDisconnectReason(reason: RelayDisconnectReason | null): boolean {
  if (!reason) return true;
  return !NON_RETRYABLE_REASONS.has(reason);
}

export type RelayReconnectHooks = Readonly<{
  onStatusChange?: (status: RelayConnectionStatus) => void;
  onEchoReply?: (payload: string, seq: number) => void;
  onStatusReply?: (status: RelayPeerStatus, seq: number) => void;
}>;

export type RelayReconnectInput = Readonly<{
  /** Builds a fresh, unstarted RelayConnection for one dial attempt; must forward `hooks` into the connection's own callbacks. */
  connect: (hooks: RelayReconnectHooks) => RelayConnection;
  backoff?: RelayBackoffConfig;
  onAttempt?: (attempt: number, delayMs: number) => void;
  onStatusChange?: (status: RelayConnectionStatus, attempt: number) => void;
  onEchoReply?: (payload: string, seq: number) => void;
  onStatusReply?: (status: RelayPeerStatus, seq: number) => void;
  /** Called exactly once when the loop gives up after a non-retryable disconnect. */
  onGiveUp?: (status: RelayConnectionStatus) => void;
}>;

/** Drives repeated dial attempts against `connect()` with capped exponential backoff, stopping outright on a non-retryable disconnect or an explicit `stop()`. */
export class RelayReconnectLoop {
  private readonly input: RelayReconnectInput;
  private stopped = false;
  private attempt = 0;
  private current: RelayConnection | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Set the instant `stop()` is called, before the resulting close necessarily reaches
   * `onClosed()` — deliberately distinct from `stopped` (which means "finalized, no more
   * redials will ever happen"). `onClosed()` must still run its normal finalize path when a
   * deliberate stop is in flight; gating it on `stopped` here would make `stop()`'s own
   * close silently swallowed and `onGiveUp` (which callers use to release resources and end
   * their own process) would never fire.
   */
  private stopRequested = false;

  constructor(input: RelayReconnectInput) {
    this.input = input;
  }

  start(): void {
    this.dial();
  }

  /** Stops the loop and gracefully closes any in-flight connection; no further redials occur after this. Always eventually calls `onGiveUp` exactly once, even if no connection is currently live (e.g. called during a backoff wait). */
  stop(): void {
    if (this.stopRequested) return;
    this.stopRequested = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const current = this.current;
    if (current && current.status().state !== "closed") {
      current.close("gracefulClose", "reconnect loop stopped");
      return; // onClosed() runs synchronously off of that close() and finalizes.
    }
    this.finalize(current ? current.status() : null);
  }

  currentConnection(): RelayConnection | null {
    return this.current;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  private dial(): void {
    if (this.stopped || this.stopRequested) return;
    const connection = this.input.connect({
      onStatusChange: (status) => {
        this.input.onStatusChange?.(status, this.attempt);
        if (status.state === "connected") this.attempt = 0;
        if (status.state === "closed") this.onClosed(status);
      },
      onEchoReply: this.input.onEchoReply,
      onStatusReply: this.input.onStatusReply,
    });
    this.current = connection;
    connection.start();
  }

  private onClosed(status: RelayConnectionStatus): void {
    if (this.stopped) return;
    if (this.stopRequested || !isRetryableDisconnectReason(status.disconnectReason)) {
      this.finalize(status);
      return;
    }
    const delayMs = nextBackoffDelayMs(this.attempt, this.input.backoff);
    this.attempt += 1;
    this.input.onAttempt?.(this.attempt, delayMs);
    this.timer = setTimeout(() => this.dial(), delayMs);
  }

  private finalize(status: RelayConnectionStatus | null): void {
    if (this.stopped) return;
    this.stopped = true;
    if (status) this.input.onGiveUp?.(status);
  }
}

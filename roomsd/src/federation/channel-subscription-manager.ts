// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import type { RoomsRuntimeService } from "../runtime/service.js";
import type { AuthorityId } from "./contracts.js";
import { advanceFederatedChannelRouteCursor, listFederatedChannelRoutes, type FederatedChannelRoute } from "./channel-route-store.js";
import { readMachineIdentityStatus } from "../identity/machine-identity.js";
import { neutralRelayApplicationHandler, type RelayApplicationHandler, type RelayConnection } from "./relay-connection.js";
import type { RelayChannelFrame } from "./relay-protocol.js";
import { createSshRelayConnection } from "./ssh-relay-transport.js";
import { ChannelResultAssembler } from "./channel-result.js";

type CanonicalMessage = Readonly<{ id: string; body: string; occurredAt?: string; deliveredRecipientSessionIds?: readonly string[] }>;
export interface FederatedChannelSubscriptionManager { close(): Promise<void>; }

type Worker = {
  authority: AuthorityId;
  connection: RelayConnection;
  current?: { requestId: string; route: FederatedChannelRoute };
  routeIndex: number;
  timer?: NodeJS.Timeout;
  assembler: ChannelResultAssembler;
  closed: boolean;
};

const RETRYABLE_SUBSCRIPTION_CLOSE_REASONS = new Set([
  "childExited", "childSignaled", "childSpawnFailed", "transportError",
  "handshakeTimeout", "idleTimeout", "queueOverflow", "protocolError",
  // A durable channel route outlives either daemon process. The remote side
  // uses these graceful reasons during service restart, so suppressing them
  // strands the route until an operator rewrites its file.
  "peerDrained", "peerClosed",
]);

export function isRetryableChannelSubscriptionClose(reason: string | null): boolean {
  return reason !== null && RETRYABLE_SUBSCRIPTION_CLOSE_REASONS.has(reason);
}

/**
 * Maintain one authenticated SSH-stdio relay per channel-home authority and pull only
 * canonical events after each local route's durable cursor. Remote events are injected
 * into local runtimes without becoming a second local message record.
 */
export function startFederatedChannelSubscriptions(input: Readonly<{
  stateDir: string;
  runtimeService: RoomsRuntimeService;
  pollIntervalMs?: number;
  connectionFactory?: (route: FederatedChannelRoute, handler: RelayApplicationHandler, onStatusChange: (status: ReturnType<RelayConnection["status"]>) => void) => RelayConnection;
}>): FederatedChannelSubscriptionManager {
  const localAuthorityId = readMachineIdentityStatus(input.stateDir).authorityId;
  const pollIntervalMs = Math.max(250, input.pollIntervalMs ?? 1_000);
  const workers = new Map<string, Worker>();
  const retries = new Map<string, { failures: number; nextAttemptAt: number }>();
  const suppressed = new Map<string, string>();
  let discoveryTimer: NodeJS.Timeout | undefined;
  let closed = false;

  const routesFor = (authority: string): FederatedChannelRoute[] => listFederatedChannelRoutes(input.stateDir).filter((route) => route.homeAuthorityId === authority);

  const schedule = (worker: Worker, delay = pollIntervalMs): void => {
    if (worker.timer) clearTimeout(worker.timer);
    worker.timer = setTimeout(() => pollNext(worker), delay);
  };

  const requestRoute = (worker: Worker, route: FederatedChannelRoute): void => {
    if (closed || worker.closed || worker.current || worker.connection.status().state !== "connected") return;
    const requestId = randomUUID();
    worker.current = { requestId, route };
    worker.connection.sendChannel({
      kind: "channelCommand",
      requestId,
      homeAuthorityId: worker.authority,
      operation: "messages",
      actorSessionId: route.localSessionId,
      payload: Buffer.from(JSON.stringify({ channelId: route.channelId, afterCursor: route.cursor }), "utf8").toString("base64"),
    });
  };

  const scheduleRoute = (worker: Worker, route: FederatedChannelRoute): void => {
    if (worker.timer) clearTimeout(worker.timer);
    worker.timer = setTimeout(() => requestRoute(worker, route), 0);
  };

  const pollNext = (worker: Worker): void => {
    if (closed || worker.closed || worker.current || worker.connection.status().state !== "connected") return;
    let routes: FederatedChannelRoute[];
    try { routes = routesFor(worker.authority); }
    catch (error) { process.stderr.write(`roomsd: federated channel route scan failed: ${safeMessage(error)}\n`); schedule(worker); return; }
    if (routes.length === 0) { worker.connection.drain(); return; }
    worker.routeIndex %= routes.length;
    const route = routes[worker.routeIndex++]!;
    requestRoute(worker, route);
  };

  const startWorker = (authority: AuthorityId, seed: FederatedChannelRoute): void => {
    process.stderr.write(`roomsd: federated channel subscription connecting: authority=${authority} host=${seed.sshHost}\n`);
    let worker!: Worker;
    const handler = {
      ...neutralRelayApplicationHandler,
      async handleChannel(frame: RelayChannelFrame): Promise<void> {
        if (frame.kind !== "channelResult" || !worker.current || frame.requestId !== worker.current.requestId) throw new Error("unexpected channel subscription result");
        const assembled = worker.assembler.accept(frame);
        if (!assembled) return;
        const route = worker.current.route;
        worker.current = undefined;
        const value = assembled.value as { cursor?: string; messages?: CanonicalMessage[]; hasMore?: boolean; message?: string };
        if (!assembled.ok) throw new Error(value.message ?? "channel subscription failed");
        // A relay handshake is not proof that the subscription is healthy: the
        // first channel command can still fail immediately (for example when a
        // stale route is no longer admitted by its home). Reset reconnect
        // backoff only after the home has accepted and answered a route poll.
        retries.delete(authority);
        const messages = Array.isArray(value.messages) ? value.messages : [];
        for (const event of messages) {
          if (!event || typeof event.id !== "string" || typeof event.body !== "string" || !Array.isArray(event.deliveredRecipientSessionIds)) throw new Error("invalid canonical channel event from home authority");
          // Routes created before the registration cursor was persisted start at zero.
          // Drain their cursor without injecting messages from before the route existed.
          if (typeof event.occurredAt !== "string") throw new Error("canonical channel event is missing occurredAt");
          if (event.occurredAt < route.createdAt) continue;
          const recipient = `federation:${localAuthorityId}:${route.localSessionId}`;
          if (!event.deliveredRecipientSessionIds.includes(recipient)) continue;
          try {
            await input.runtimeService.deliverFederatedMessage({ homeAuthorityId: authority, localSessionId: route.localSessionId, messageId: event.id, body: event.body, deliveredRecipientSessionIds: event.deliveredRecipientSessionIds });
          } catch (error) {
            if ((error as { code?: string }).code === "runtimeNotFound") { schedule(worker); return; }
            throw error;
          }
        }
        const advanced = advanceFederatedChannelRouteCursor(route, typeof value.cursor === "string" ? value.cursor : route.cursor, input.stateDir);
        // Drain bounded pages immediately. Once caught up, cycle routes and pause
        // only after a complete pass.
        if (value.hasMore) scheduleRoute(worker, advanced);
        else schedule(worker, worker.routeIndex % Math.max(routesFor(authority).length, 1) === 0 ? pollIntervalMs : 0);
      },
    };
    const onStatusChange = (status: ReturnType<RelayConnection["status"]>): void => {
        if (status.state === "connected") {
          process.stderr.write(`roomsd: federated channel subscription connected: authority=${authority}\n`);
          pollNext(worker);
        }
        if (status.state === "closed") {
          process.stderr.write(`roomsd: federated channel subscription closed: authority=${authority} reason=${status.disconnectReason ?? "unknown"} detail=${safeMessage(status.disconnectMessage ?? "")}\n`);
          worker.closed = true;
          worker.assembler.clear();
          if (worker.timer) clearTimeout(worker.timer);
          workers.delete(authority);
          let hasRoutes = false;
          try { hasRoutes = routesFor(authority).length > 0; } catch {}
          if (!closed && hasRoutes && isRetryableChannelSubscriptionClose(status.disconnectReason)) {
            const prior = retries.get(authority)?.failures ?? 0;
            const failures = Math.min(prior + 1, 8);
            const base = Math.min(30_000, 500 * (2 ** (failures - 1)));
            const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(base / 2)));
            retries.set(authority, { failures, nextAttemptAt: Date.now() + base + jitter });
          } else if (!closed && hasRoutes) {
            const newest = routesFor(authority).map((route) => route.updatedAt).sort().at(-1) ?? "";
            suppressed.set(authority, newest);
          }
        }
    };
    const connection = input.connectionFactory
      ? input.connectionFactory(seed, handler, onStatusChange)
      : createSshRelayConnection({ sshHost: seed.sshHost, peerAuthorityId: authority, localStateDir: input.stateDir, remoteStateDir: seed.remoteStateDir ?? undefined, handler, onStatusChange });
    worker = { authority, connection, routeIndex: 0, assembler: new ChannelResultAssembler(), closed: false };
    workers.set(authority, worker);
    connection.start();
  };

  const discover = (): void => {
    if (closed) return;
    try {
      const routes = listFederatedChannelRoutes(input.stateDir);
      for (const authority of new Set(routes.map((route) => route.homeAuthorityId))) {
        if (workers.has(authority)) continue;
        const grouped = routes.filter((route) => route.homeAuthorityId === authority);
        const suppressedAt = suppressed.get(authority);
        const newestRoute = grouped.map((route) => route.updatedAt).sort().at(-1) ?? "";
        if (suppressedAt && newestRoute <= suppressedAt) continue;
        if (suppressedAt) suppressed.delete(authority);
        const retry = retries.get(authority);
        if (retry && retry.nextAttemptAt > Date.now()) continue;
        const endpoints = new Set(grouped.map((route) => `${route.sshHost}\0${route.remoteStateDir ?? ""}`));
        if (endpoints.size !== 1) { process.stderr.write(`roomsd: conflicting SSH routes for channel home ${authority}\n`); continue; }
        startWorker(authority, grouped[0]!);
      }
    } catch (error) { process.stderr.write(`roomsd: federated channel discovery failed: ${safeMessage(error)}\n`); }
    discoveryTimer = setTimeout(discover, 2_000);
  };

  discover();
  return {
    async close(): Promise<void> {
      closed = true;
      if (discoveryTimer) clearTimeout(discoveryTimer);
      for (const worker of workers.values()) {
        worker.closed = true;
        worker.assembler.clear();
        if (worker.timer) clearTimeout(worker.timer);
        worker.connection.drain();
      }
      workers.clear();
    },
  };
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ").slice(0, 512);
}

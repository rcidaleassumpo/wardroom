// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import type { RoomsCLIBackend } from "./backend.js";
import { listRegisteredProviders } from "./provider-registry.js";
import { readMachineIdentityStatus } from "../identity/machine-identity.js";
import { listPeerTrust, readPeerTrust } from "../federation/peer-trust.js";
import { createSshRelayConnection } from "../federation/ssh-relay-transport.js";
import { neutralRelayApplicationHandler } from "../federation/relay-connection.js";
import type { RelayInventoryFrame } from "../federation/relay-protocol.js";
import type { AuthorityId } from "../federation/contracts.js";
import { readMachineRoute, removeMachineRoute, upsertMachineRoute } from "../federation/machine-route-store.js";

type InventoryResource = Extract<RelayInventoryFrame, { kind: "inventoryCommand" }>["resource"];

export interface SessionLocation {
  authorityId: AuthorityId;
  locality: "local" | "peer";
  sessionId: string;
  target: string;
  session: Record<string, unknown>;
}

export function listMachines(stateDir?: string): unknown {
  const local = readMachineIdentityStatus(stateDir);
  return {
    machines: [
      { authorityId: local.authorityId, locality: "local", state: local.lifecycleState, providers: listRegisteredProviders(stateDir) },
      ...listPeerTrust(stateDir).map(peer => ({ authorityId: peer.authorityId, locality: "peer", state: peer.state, transport: publicTransport(peer.transportPolicy), route: readMachineRoute(peer.authorityId, stateDir) ?? null })),
    ],
  };
}

export async function inspectMachine(authorityIdInput: string | undefined, backend: RoomsCLIBackend, options?: Readonly<{ stateDir?: string; includeEnded?: boolean; sshHost?: string; remoteStateDir?: string }>): Promise<unknown> {
  const local = readMachineIdentityStatus(options?.stateDir);
  const authorityId = authorityIdInput ?? local.authorityId;
  if (authorityId === local.authorityId) {
    const [channelResult, sessionResult] = await Promise.all([
      backend.listChannels(),
      backend.listSessions?.({ includeEnded: options?.includeEnded ?? false }) ?? Promise.resolve({ sessions: [] }),
    ]);
    const channels = objectItems(channelResult, "channels").filter(item => options?.includeEnded || (item as any).lifecycleState === "active");
    const sessions = objectItems(sessionResult, "sessions");
    const inspections = await Promise.all(sessions.flatMap(session => {
      const id = recordString(session, "id");
      return id && backend.inspectSession ? [backend.inspectSession(id)] : [];
    }));
    const quotaResult = await (backend.runtimeQuotaGet?.() ?? Promise.resolve({ quotas: [] })) as { quotas?: unknown[] };
    return { authorityId, locality: "local", providers: listRegisteredProviders(options?.stateDir), channels, sessions, inspections, runtimeQuotas: quotaResult.quotas ?? [] };
  }
  const peer = readPeerTrust(authorityId, options?.stateDir);
  if (peer.state !== "active") throw new Error(`Rooms machine ${authorityId} is not an active enrolled peer`);
  if (peer.transportPolicy.kind !== "loopbackSsh") throw new Error(`Rooms machine inventory does not yet support ${peer.transportPolicy.kind} transport`);
  const route = readMachineRoute(peer.authorityId, options?.stateDir);
  const sshHost = options?.sshHost ?? route?.sshHost ?? peer.transportPolicy.sshDestination;
  const remoteStateDir = options?.remoteStateDir ?? route?.remoteStateDir ?? undefined;
  const inventory = await inspectRemoteMachine({ authorityId: peer.authorityId, sshHost, localStateDir: options?.stateDir, remoteStateDir, includeEnded: options?.includeEnded ?? false });
  return { authorityId, locality: "peer", transport: publicTransport(peer.transportPolicy), route: route ?? null, ...inventory };
}

/**
 * Finds an exact session across the local authority and enrolled peers and
 * returns the precise target accepted by `rooms session send`. Remote targets
 * are qualified here so agents never have to construct federation addresses.
 */
export async function locateSession(sessionIdInput: string, backend: RoomsCLIBackend, options?: Readonly<{ stateDir?: string; includeEnded?: boolean }>): Promise<Readonly<{ query: string; matches: SessionLocation[]; unreachableMachines: ReadonlyArray<{ authorityId: AuthorityId; message: string }> }>> {
  const local = readMachineIdentityStatus(options?.stateDir);
  const localAuthorityId = local.authorityId as AuthorityId;
  const parsed = parseFederatedSessionTarget(sessionIdInput);
  const sessionId = parsed?.sessionId ?? sessionIdInput;
  const includeEnded = options?.includeEnded ?? false;
  const authorities = parsed
    ? [parsed.authorityId]
    : [localAuthorityId, ...listPeerTrust(options?.stateDir).filter(peer => peer.state === "active").map(peer => peer.authorityId as AuthorityId)];
  const attempts = await Promise.all(authorities.map(async authorityId => {
    try {
      const locality = authorityId === localAuthorityId ? "local" as const : "peer" as const;
      const sessions = locality === "local"
        ? objectItems(await (backend.listSessions?.({ includeEnded }) ?? Promise.resolve({ sessions: [] })), "sessions")
        : (await inspectRemoteMachine({
            authorityId,
            ...remoteRoute(authorityId, options?.stateDir),
            localStateDir: options?.stateDir,
            includeEnded,
            resources: ["sessions"],
          })).sessions ?? [];
      const found = sessions.find(item => recordString(item, "id") === sessionId);
      if (!found) return { authorityId, location: null, error: null };
      const session = found as Record<string, unknown>;
      return {
        authorityId,
        location: {
          authorityId,
          locality,
          sessionId,
          target: locality === "local" ? sessionId : `federation:${authorityId}:${sessionId}`,
          session,
        } satisfies SessionLocation,
        error: null,
      };
    } catch (error) {
      return { authorityId, location: null, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  return {
    query: sessionIdInput,
    matches: attempts.flatMap(attempt => attempt.location ? [attempt.location] : []),
    unreachableMachines: attempts.flatMap(attempt => attempt.error ? [{ authorityId: attempt.authorityId, message: attempt.error }] : []),
  };
}

export function configureMachineRoute(authorityId: AuthorityId, flags: ReadonlyMap<string, string>): unknown {
  if (flags.has("remove")) return removeMachineRoute(authorityId, flags.get("state-dir"));
  const sshHost = flags.get("ssh-host");
  if (!sshHost) throw new Error("Rooms machine route requires --ssh-host or --remove");
  return upsertMachineRoute({ authorityId, sshHost, remoteStateDir: flags.get("remote-state-dir"), stateDir: flags.get("state-dir") });
}

async function inspectRemoteMachine(input: Readonly<{ authorityId: AuthorityId; sshHost: string; localStateDir?: string; remoteStateDir?: string; includeEnded: boolean; resources?: readonly InventoryResource[] }>): Promise<Record<string, unknown[]>> {
  const resources: readonly InventoryResource[] = input.resources ?? ["providers", "channels", "sessions"];
  const result: Record<string, unknown[]> = Object.fromEntries(resources.map(resource => [resource, []]));
  let resourceIndex = 0;
  let cursor = 0;
  let requestId = randomUUID();
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.drain();
      if (error) reject(error); else resolve(result);
    };
    const send = (): void => connection.sendInventory({ kind: "inventoryCommand", requestId, authorityId: input.authorityId, resource: resources[resourceIndex]!, cursor, limit: 20, includeEnded: input.includeEnded });
    const handler = {
      ...neutralRelayApplicationHandler,
      handleInventory(frame: RelayInventoryFrame): void {
        if (frame.kind !== "inventoryResult" || frame.requestId !== requestId) throw new Error("unexpected inventory result");
        const value = JSON.parse(Buffer.from(frame.payload, "base64").toString("utf8"));
        if (!frame.ok) { finish(new Error(value?.message ?? "remote machine inventory failed")); return; }
        const resource = resources[resourceIndex]!;
        if (!Array.isArray(value?.items) || value.resource !== resource) { finish(new Error("invalid remote machine inventory result")); return; }
        result[resource]!.push(...value.items);
        if (value.nextCursor !== null) {
          if (!Number.isSafeInteger(value.nextCursor) || value.nextCursor <= cursor) { finish(new Error("invalid remote machine inventory cursor")); return; }
          cursor = value.nextCursor;
          requestId = randomUUID();
          send();
          return;
        }
        resourceIndex += 1;
        if (resourceIndex >= resources.length) { finish(); return; }
        cursor = 0;
        requestId = randomUUID();
        send();
      },
    };
    const connection = createSshRelayConnection({
      sshHost: input.sshHost, peerAuthorityId: input.authorityId, localStateDir: input.localStateDir, remoteStateDir: input.remoteStateDir, handler,
      onStatusChange(status) {
        if (status.state === "connected") send();
        if (status.state === "closed" && !settled) finish(new Error(`machine inventory relay closed: ${status.disconnectReason}: ${status.disconnectMessage ?? ""}`));
      },
    });
    const timer = setTimeout(() => finish(new Error("machine inventory timed out")), 20_000);
    connection.start();
  });
}

function remoteRoute(authorityId: AuthorityId, stateDir?: string): Readonly<{ sshHost: string; remoteStateDir?: string }> {
  const peer = readPeerTrust(authorityId, stateDir);
  if (peer.state !== "active") throw new Error(`Rooms machine ${authorityId} is not an active enrolled peer`);
  if (peer.transportPolicy.kind !== "loopbackSsh") throw new Error(`Rooms machine inventory does not yet support ${peer.transportPolicy.kind} transport`);
  const route = readMachineRoute(authorityId, stateDir);
  return {
    sshHost: route?.sshHost ?? peer.transportPolicy.sshDestination,
    ...(route?.remoteStateDir ? { remoteStateDir: route.remoteStateDir } : {}),
  };
}

function parseFederatedSessionTarget(value: string): Readonly<{ authorityId: AuthorityId; sessionId: string }> | undefined {
  const match = /^federation:(authority-[0-9a-f]{64}):(.+)$/.exec(value);
  if (!match) return undefined;
  return { authorityId: match[1] as AuthorityId, sessionId: match[2]! };
}

function recordString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = (value as Record<string, unknown>)[key];
  return typeof item === "string" ? item : undefined;
}

function objectItems(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as Record<string, unknown>)[key])) return [];
  return (value as Record<string, unknown[]>)[key]!;
}

function publicTransport(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const transport = value as Record<string, unknown>;
  if (transport.kind === "loopbackSsh") return { kind: transport.kind, destination: transport.sshDestination };
  if (transport.kind === "tailscalePeer") return { kind: transport.kind, address: transport.address, nodeIdentity: transport.nodeIdentity };
  return { kind: transport.kind };
}

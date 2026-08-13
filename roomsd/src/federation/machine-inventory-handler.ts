// SPDX-License-Identifier: Apache-2.0
import type { RoomsRepository } from "../storage/repository.js";
import type { RelayApplicationHandler, RelayConnection } from "./relay-connection.js";
import type { RelayInventoryFrame } from "./relay-protocol.js";
import { listRegisteredProviders } from "../cli/provider-registry.js";

export function withMachineInventory(input: Readonly<{
  base: RelayApplicationHandler;
  database: RoomsRepository;
  authorityId: string;
  stateDir: string;
}>): RelayApplicationHandler {
  const reply = (connection: RelayConnection, requestId: string, ok: boolean, value: unknown): void => {
    connection.sendInventory({ kind: "inventoryResult", requestId, ok, payload: Buffer.from(JSON.stringify(value), "utf8").toString("base64") });
  };
  return {
    ...input.base,
    async handleInventory(frame: RelayInventoryFrame, connection: RelayConnection): Promise<void> {
      if (frame.kind === "inventoryResult") {
        await input.base.handleInventory?.(frame, connection);
        return;
      }
      const status = connection.status();
      if (status.state !== "connected" || !status.peerAuthorityId) throw new Error("inventory peer is not authenticated");
      if (frame.authorityId !== input.authorityId) throw new Error("inventory requested from the wrong authority");
      try {
        const all = resourceItems(frame.resource, frame.includeEnded, input.database, input.stateDir);
        const items = all.slice(frame.cursor, frame.cursor + frame.limit);
        const nextCursor = frame.cursor + items.length < all.length ? frame.cursor + items.length : null;
        reply(connection, frame.requestId, true, { authorityId: input.authorityId, resource: frame.resource, items, nextCursor });
      } catch (error) {
        reply(connection, frame.requestId, false, { code: "inventoryFailed", message: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}

function resourceItems(resource: "channels" | "sessions" | "providers", includeEnded: boolean, database: RoomsRepository, stateDir: string): readonly unknown[] {
  if (resource === "channels") return database.listChannels().filter(item => includeEnded || item.lifecycleState === "active");
  if (resource === "sessions") return database.listSessions().filter(item => includeEnded || item.endedAt === null);
  return listRegisteredProviders(stateDir);
}

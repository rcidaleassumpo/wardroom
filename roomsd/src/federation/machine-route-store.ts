// SPDX-License-Identifier: Apache-2.0
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readMachineIdentityStatus, resolveRoomsStateDir } from "../identity/machine-identity.js";
import { readActivePeerTrust } from "./peer-trust.js";
import { parseSshTarget } from "./ssh-command-adapter.js";
import { assertSafeRemoteStateDir } from "./ssh-connect.js";
import type { AuthorityId } from "./contracts.js";

export type MachineRoute = Readonly<{
  version: 1;
  authorityId: AuthorityId;
  transport: "ssh";
  sshHost: string;
  remoteStateDir: string | null;
  updatedAt: string;
}>;

export function upsertMachineRoute(input: Readonly<{ authorityId: AuthorityId; sshHost: string; remoteStateDir?: string; stateDir?: string }>): MachineRoute {
  const stateDir = initializedStateDir(input.stateDir);
  if (!readActivePeerTrust(input.authorityId, stateDir)) throw new Error(`Rooms machine route requires an active enrolled peer: ${input.authorityId}`);
  const sshHost = parseSshTarget(input.sshHost).target;
  const route: MachineRoute = { version: 1, authorityId: input.authorityId, transport: "ssh", sshHost, remoteStateDir: input.remoteStateDir ? assertSafeRemoteStateDir(input.remoteStateDir) : null, updatedAt: new Date().toISOString() };
  const directory = routeDirectory(stateDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = routePath(directory, input.authorityId);
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(route, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return route;
}

export function readMachineRoute(authorityId: AuthorityId, stateDirInput?: string): MachineRoute | undefined {
  const stateDir = initializedStateDir(stateDirInput);
  try {
    const value = JSON.parse(readFileSync(routePath(routeDirectory(stateDir), authorityId), "utf8")) as Record<string, unknown>;
    if (value.version !== 1 || value.authorityId !== authorityId || value.transport !== "ssh" || typeof value.sshHost !== "string" || (value.remoteStateDir !== null && typeof value.remoteStateDir !== "string") || typeof value.updatedAt !== "string") throw new Error("invalid route fields");
    parseSshTarget(value.sshHost);
    if (value.remoteStateDir) assertSafeRemoteStateDir(value.remoteStateDir as string);
    return value as MachineRoute;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Rooms machine route is unreadable for ${authorityId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function removeMachineRoute(authorityId: AuthorityId, stateDirInput?: string): { removed: boolean; authorityId: AuthorityId } {
  const stateDir = initializedStateDir(stateDirInput);
  try { rmSync(routePath(routeDirectory(stateDir), authorityId)); return { removed: true, authorityId }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed: false, authorityId };
    throw error;
  }
}

function initializedStateDir(input?: string): string {
  const stateDir = resolveRoomsStateDir(input ?? process.env.ROOMS_STATE_DIR);
  readMachineIdentityStatus(stateDir);
  return stateDir;
}
function routeDirectory(stateDir: string): string { return join(stateDir, "federation", "machine-routes"); }
function routePath(directory: string, authorityId: AuthorityId): string { return join(directory, `${authorityId}.json`); }

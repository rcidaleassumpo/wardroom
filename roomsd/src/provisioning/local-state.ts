import { chmodSync, existsSync, lstatSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { RoomsRepository } from "../storage/repository.js";
import { prepareCanonicalStorePath } from "../storage/store-migration.js";
import { readMachineIdentityStatus, setupMachineIdentity, type MachineIdentityStatus } from "../identity/machine-identity.js";
import { roomsPaths, type RoomsPaths } from "./paths.js";

export type LocalRoomsStatus = MachineIdentityStatus & Readonly<{
  storePath: string;
  endpoint: string;
  operatorSessionId: string | null;
  runtimeDirectory: string;
  runtimeSocketDirectory: string;
  stateMode: "0700";
  credentialMode: "0600";
}>;

export function provisionLocalState(stateDirInput?: string): LocalRoomsStatus {
  const paths = roomsPaths(stateDirInput);
  ensureStateDirectories(paths);
  const storePath = prepareCanonicalStorePath(paths.storePath);
  const repository = new RoomsRepository(storePath);
  const operatorSessionId = activeOperator(repository) ?? "operator";
  if (!repository.currentSession(operatorSessionId)) repository.insertSession({ id: operatorSessionId, role: "operator" });
  repository.close();
  secureFile(storePath, "canonical Rooms store");
  for (const sidecar of [`${storePath}-wal`, `${storePath}-shm`]) if (existsAsAny(sidecar)) secureFile(sidecar, "SQLite sidecar");
  const identity = setupMachineIdentity(paths.stateDir);
  return status(identity, paths, storePath, operatorSessionId);
}

export function readLocalStateStatus(stateDirInput?: string): LocalRoomsStatus {
  const paths = roomsPaths(stateDirInput);
  const identity = readMachineIdentityStatus(paths.stateDir);
  assertStateDirectories(paths);
  const storePath = canonicalStoreForReadOnlyStatus(paths);
  secureFile(storePath, "canonical Rooms store");
  const repository = new RoomsRepository(storePath);
  const operatorSessionId = activeOperator(repository);
  repository.close();
  return status(identity, paths, storePath, operatorSessionId);
}

export function ensureStateDirectories(paths: RoomsPaths, createStoreParent = true): void {
  ensureDirectory(paths.stateDir, 0o700, "Rooms state directory");
  if (createStoreParent) ensureDirectory(dirname(paths.storePath), 0o700, "Rooms store parent");
  for (const [path, label] of [[paths.runtimeDir, "runtime directory"], [paths.runtimeSocketDir, "runtime socket directory"], [paths.logsDir, "log directory"], [paths.serviceDir, "service directory"]] as const) ensureDirectory(path, 0o700, label);
}

export function assertLocalStateModes(paths: RoomsPaths): void {
  assertDirectory(paths.stateDir, 0o700, "Rooms state directory");
  for (const path of [paths.runtimeDir, paths.runtimeSocketDir, paths.logsDir, paths.serviceDir]) assertDirectory(path, 0o700, "Rooms state directory");
  if (existsAsAny(paths.storePath)) assertFileMode(paths.storePath, "canonical Rooms store");
  if (existsAsAny(paths.endpoint)) assertSocketMode(paths.endpoint);
}

function status(identity: MachineIdentityStatus, paths: RoomsPaths, storePath: string, operatorSessionId: string | null): LocalRoomsStatus {
  return { ...identity, storePath, endpoint: paths.endpoint, operatorSessionId, runtimeDirectory: paths.runtimeDir, runtimeSocketDirectory: paths.runtimeSocketDir, stateMode: "0700", credentialMode: "0600" };
}

function activeOperator(repository: RoomsRepository): string | null {
  return repository.listSessions().find((session) => session.role === "operator" && session.endedAt === null)?.id ?? null;
}

function assertStateDirectories(paths: RoomsPaths): void {
  assertDirectory(paths.stateDir, 0o700, "Rooms state directory");
  for (const [path, label] of [[paths.runtimeDir, "runtime directory"], [paths.runtimeSocketDir, "runtime socket directory"], [paths.logsDir, "log directory"], [paths.serviceDir, "service directory"]] as const) assertDirectory(path, 0o700, label);
}

function canonicalStoreForReadOnlyStatus(paths: RoomsPaths): string {
  const canonical = existsAsAny(paths.storePath);
  const legacy = existsAsAny(join(paths.stateDir, "roomsd-ts.sqlite"));
  if (canonical && legacy) throw new Error("Rooms store collision: canonical and legacy stores both exist");
  if (!canonical && legacy) throw new Error("Rooms legacy store requires the Rooms-owned setup migration");
  if (!canonical) throw new Error(`Rooms canonical store is missing: ${paths.storePath}`);
  return paths.storePath;
}

function ensureDirectory(path: string, mode: number, label: string): void {
  if (!existsAsAny(path)) mkdirSync(path, { recursive: true, mode });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Rooms ${label} must be a non-symlink directory: ${path}`);
  if ((stat.mode & 0o777) !== mode) chmodSync(path, mode);
  if ((statSync(path).mode & 0o777) !== mode) throw new Error(`Rooms ${label} permissions must be ${mode.toString(8)}`);
}

function secureFile(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Rooms ${label} must be a regular non-symlink file`);
  chmodSync(path, 0o600);
  if ((statSync(path).mode & 0o777) !== 0o600) throw new Error(`Rooms ${label} permissions must be 600`);
}

function assertFileMode(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Rooms ${label} must be a regular non-symlink file`);
  if ((stat.mode & 0o777) !== 0o600) throw new Error(`Rooms ${label} permissions must be 600, found ${(stat.mode & 0o777).toString(8)}`);
}

function assertSocketMode(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.isSymbolicLink()) throw new Error(`Rooms Unix endpoint must be a non-symlink socket: ${path}`);
  if ((stat.mode & 0o777) !== 0o600) throw new Error(`Rooms Unix socket permissions must be 600, found ${(stat.mode & 0o777).toString(8)}`);
}

function assertDirectory(path: string, mode: number, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Rooms ${label} must be a non-symlink directory: ${path}`);
  if ((stat.mode & 0o777) !== mode) throw new Error(`Rooms ${label} permissions must be ${mode.toString(8)}, found ${(stat.mode & 0o777).toString(8)}`);
}

function existsAsAny(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

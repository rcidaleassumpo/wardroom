// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { existsSync, lstatSync, realpathSync } from "node:fs";

export type RoomsPaths = Readonly<{
  stateDir: string;
  storePath: string;
  endpoint: string;
  federationRelayEndpoint: string;
  runtimeDir: string;
  runtimeSocketDir: string;
  logsDir: string;
  serviceDir: string;
  drainMarker: string;
  installRoot: string;
  releaseRoot: string;
  currentLink: string;
  binDir: string;
  roomsLink: string;
  serviceLabel: string;
  launchAgentDir: string;
  launchAgentPlist: string;
}>;

export const DEFAULT_ROOMS_SERVICE_LABEL = "local.rooms.roomsd";

export function defaultStateDir(): string { return join(homedir(), ".rooms"); }

/**
 * A test run sets ROOMS_FORBID_DEFAULT_STATE_DIR so that reaching the real
 * ~/.rooms store is a loud failure rather than a silent read of live state.
 */
function resolveStateDir(stateDirInput?: string): string {
  const requested = stateDirInput ?? process.env.ROOMS_STATE_DIR;
  if (requested) return requested;
  if (process.env.ROOMS_FORBID_DEFAULT_STATE_DIR) {
    throw new Error("refusing to resolve the default Rooms state directory: ROOMS_FORBID_DEFAULT_STATE_DIR is set; pass an explicit state directory");
  }
  return defaultStateDir();
}
export function defaultInstallRoot(): string { return join(homedir(), ".local"); }

export function roomsPaths(stateDirInput?: string, installRootInput?: string): RoomsPaths {
  const stateDir = absolute(resolveStateDir(stateDirInput), "state directory");
  const installRoot = absolute(installRootInput ?? process.env.ROOMS_INSTALL_ROOT ?? defaultInstallRoot(), "install root");
  const serviceDir = join(stateDir, "service");
  const serviceLabel = roomsServiceLabel(stateDir);
  const launchAgentDir = join(homedir(), "Library", "LaunchAgents");
  return {
    stateDir,
    storePath: join(stateDir, "rooms.sqlite"),
    endpoint: join(stateDir, "roomsd.sock"),
    federationRelayEndpoint: join(stateDir, "federation-relay.sock"),
    runtimeDir: join(stateDir, "runtimes"),
    runtimeSocketDir: join(stateDir, "s"),
    logsDir: join(stateDir, "logs"),
    serviceDir,
    drainMarker: join(serviceDir, "drain.json"),
    installRoot,
    releaseRoot: join(installRoot, "lib", "rooms", "releases"),
    currentLink: join(installRoot, "lib", "rooms", "current"),
    binDir: join(installRoot, "bin"),
    roomsLink: join(installRoot, "bin", "rooms"),
    serviceLabel,
    launchAgentDir,
    launchAgentPlist: join(launchAgentDir, `${serviceLabel}.plist`),
  };
}

export function roomsServiceLabel(stateDirInput: string): string {
  const stateDir = absolute(stateDirInput, "state directory");
  const identityPath = canonicalIdentityPath(stateDir);
  const defaultIdentityPath = canonicalIdentityPath(absolute(defaultStateDir(), "default state directory"));
  if (identityPath === defaultIdentityPath) return DEFAULT_ROOMS_SERVICE_LABEL;
  const stateKey = createHash("sha256").update(identityPath).digest("hex").slice(0, 16);
  return `${DEFAULT_ROOMS_SERVICE_LABEL}.state-${stateKey}`;
}

function canonicalIdentityPath(path: string): string {
  const missingTail: string[] = [];
  let existingAncestor = path;
  while (true) {
    try {
      return resolve(realpathSync(existingAncestor), ...missingTail);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      missingTail.unshift(basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

export function assertAbsolutePath(value: string, label: string): string {
  return absolute(value, label);
}

export function assertSafeVersion(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value)) throw new Error(`invalid Rooms release version: ${value}`);
  return value;
}

export function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function isPresent(path: string): boolean { return existsSync(path) || isSymlink(path); }

function absolute(value: string, label: string): string {
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return resolve(value);
}

export function parentPath(path: string): string { return dirname(path); }

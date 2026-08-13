// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installService, runRoomsService, serviceStatus } from "./launchd.js";
import { installRelease, pruneOldReleases, releasePaths, switchToRelease, verifyCurrentRelease, verifyRelease } from "./release.js";
import { assertSafeVersion, type RoomsPaths } from "./paths.js";

export function runRoomsInstall(releaseDirectory: string, options: { stateDir?: string; installRoot?: string; allowIdentityChange?: boolean } = {}): unknown {
  return installRelease(releaseDirectory, options);
}

export function runRoomsUpgrade(releaseDirectory: string, options: { stateDir?: string; installRoot?: string; allowIdentityChange?: boolean } = {}): unknown {
  const paths = releasePaths(options);
  const prior = safeCurrent(paths);
  const drained = runRoomsDrain(options);
  let installed;
  try {
    installed = installRelease(releaseDirectory, options);
    if (existsSync(paths.launchAgentPlist)) installService(paths);
  } catch (error) {
    if (prior && existsSync(paths.launchAgentPlist)) { switchToRelease(prior.manifest.version, options); installService(paths); }
    throw error;
  }
  const prune = pruneOldReleases(options);
  return { upgraded: true, from: prior?.manifest.version ?? null, to: installed.manifest.version, drain: drained, prune };
}

export function runRoomsRollback(versionInput: string | undefined, options: { stateDir?: string; installRoot?: string } = {}): unknown {
  const paths = releasePaths(options);
  const current = safeCurrent(paths);
  const version = versionInput ? assertSafeVersion(versionInput) : previousVersion(paths, current?.manifest.version);
  if (!version) throw new Error("Rooms rollback requires --version or a second verified release");
  const drained = runRoomsDrain(options);
  const selected = switchToRelease(version, options);
  if (existsSync(paths.launchAgentPlist)) installService(paths);
  return { rolledBack: true, from: current?.manifest.version ?? null, to: selected.manifest.version, drain: drained };
}

export function runRoomsDrain(options: { stateDir?: string; installRoot?: string } = {}): unknown {
  const paths = releasePaths(options);
  mkdirSync(paths.serviceDir, { recursive: true, mode: 0o700 });
  const marker = JSON.stringify({ schemaVersion: 1, state: "draining", requestedAt: new Date().toISOString() }, null, 2) + "\n";
  const temporary = `${paths.drainMarker}.tmp-${process.pid}`;
  writeFileSync(temporary, marker, { mode: 0o600 }); chmodSync(temporary, 0o600); renameSync(temporary, paths.drainMarker);
  const status = serviceStatus(paths);
  if (status.loaded) runRoomsService("stop", options);
  return { draining: true, label: status.label, wasLoaded: status.loaded, marker: paths.drainMarker };
}

function safeCurrent(paths: RoomsPaths) { try { return verifyCurrentRelease(paths); } catch { return undefined; } }
function previousVersion(paths: RoomsPaths, current?: string): string | undefined {
  if (!existsSync(paths.releaseRoot)) return undefined;
  return readdirSync(paths.releaseRoot).filter(item => item !== current && !item.startsWith(".")).sort().reverse().find((item) => { try { verifyRelease(join(paths.releaseRoot, item)); return true; } catch { return false; } });
}

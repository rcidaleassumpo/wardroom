import { basename, dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { readInstalledReleaseContract, readReleaseManifest } from "./release.js";
import { roomsPaths } from "./paths.js";

export type RoomsVersionIdentity = Readonly<{
  release: string;
  origin: "installed" | "bundled" | "source" | "unknown";
}>;

export function roomsVersionIdentity(options: {
  executablePath?: string;
  installRoot?: string;
  stateDir?: string;
} = {}): RoomsVersionIdentity {
  const executablePath = options.executablePath ?? process.execPath;
  const paths = roomsPaths(options.stateDir, options.installRoot);
  let resolvedExecutable = executablePath;
  try { resolvedExecutable = realpathSync(executablePath); } catch { /* classify below */ }
  try {
    if (resolvedExecutable === realpathSync(join(paths.currentLink, "rooms"))) {
      return {
        release: readInstalledReleaseContract(paths).version,
        origin: "installed",
      };
    }
  } catch {
    // A missing or invalid install is classified below; --version must remain
    // useful when doctor is needed to explain the broken install.
  }

  try {
    return { release: readReleaseManifest(dirname(resolvedExecutable)).version, origin: "bundled" };
  } catch {
    // Source and copied binaries have no adjacent verified release manifest.
  }

  if (/^node(?:\.exe)?$/i.test(basename(resolvedExecutable))) {
    return { release: "source", origin: "source" };
  }
  return { release: "unknown", origin: "unknown" };
}

export function formatRoomsVersion(productVersion: string, identity = roomsVersionIdentity()): string {
  const displayVersion = identity.origin === "installed" || identity.origin === "bundled" ? identity.release : productVersion;
  return `rooms ${displayVersion}\nrelease=${identity.release}\norigin=${identity.origin}\n`;
}

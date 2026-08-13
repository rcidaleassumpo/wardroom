// SPDX-License-Identifier: Apache-2.0
import { basename, join } from "node:path";
import { realpathSync } from "node:fs";
import { readInstalledReleaseContract } from "./release.js";
import { roomsPaths } from "./paths.js";

export type RoomsVersionIdentity = Readonly<{
  release: string;
  origin: "installed" | "source" | "unknown";
}>;

export function roomsVersionIdentity(options: {
  executablePath?: string;
  installRoot?: string;
  stateDir?: string;
} = {}): RoomsVersionIdentity {
  const executablePath = options.executablePath ?? process.execPath;
  const paths = roomsPaths(options.stateDir, options.installRoot);
  try {
    if (realpathSync(executablePath) === realpathSync(join(paths.currentLink, "rooms"))) {
      return {
        release: readInstalledReleaseContract(paths).version,
        origin: "installed",
      };
    }
  } catch {
    // A missing or invalid install is classified below; --version must remain
    // useful when doctor is needed to explain the broken install.
  }

  if (/^node(?:\.exe)?$/i.test(basename(executablePath))) {
    return { release: "source", origin: "source" };
  }
  return { release: "unknown", origin: "unknown" };
}

export function formatRoomsVersion(productVersion: string, identity = roomsVersionIdentity()): string {
  return `rooms ${productVersion}\nrelease=${identity.release}\norigin=${identity.origin}\n`;
}

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runRoomsCLI } from "../src/cli/main.js";
import { formatRoomsVersion, roomsVersionIdentity } from "../src/provisioning/version.js";

describe("Rooms version reporting", () => {
  it("reports the release manifest for the resolved installed binary", () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-version-installed-"));
    const release = join(root, "lib", "rooms", "releases", "0.2.1-proof.4");
    const current = join(root, "lib", "rooms", "current");
    mkdirSync(release, { recursive: true });
    writeFileSync(join(release, "rooms"), "binary");
    writeFileSync(join(release, "manifest.json"), JSON.stringify({
      product: "rooms",
      version: "0.2.1-proof.4",
      storeSchemaVersion: 17,
    }));
    symlinkSync(release, current, "dir");

    const identity = roomsVersionIdentity({
      executablePath: join(current, "rooms"),
      installRoot: root,
      stateDir: join(root, "state"),
    });

    expect(identity).toEqual({ release: "0.2.1-proof.4", origin: "installed" });
    expect(formatRoomsVersion("0.1.0", identity)).toBe(
      "rooms 0.2.1-proof.4\nrelease=0.2.1-proof.4\norigin=installed\n",
    );
  });

  it("reports the manifest beside an extracted or package-manager binary", () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-version-bundled-"));
    writeFileSync(join(root, "rooms"), "binary");
    writeFileSync(join(root, "roomsd"), "binary");
    writeFileSync(join(root, "rooms-runtime-host"), "binary");
    writeFileSync(join(root, "manifest.json"), JSON.stringify(releaseManifest("0.2.1")));

    const identity = roomsVersionIdentity({
      executablePath: join(root, "rooms"),
      installRoot: join(root, "absent-install"),
      stateDir: join(root, "absent-state"),
    });

    expect(identity).toEqual({ release: "0.2.1", origin: "bundled" });
    expect(formatRoomsVersion("0.1.0", identity)).toBe(
      "rooms 0.2.1\nrelease=0.2.1\norigin=bundled\n",
    );
  });

  it("reports a source run plainly", () => {
    expect(roomsVersionIdentity({
      executablePath: "/opt/homebrew/bin/node",
      installRoot: "/tmp/no-rooms-install",
      stateDir: "/tmp/no-rooms-state",
    })).toEqual({ release: "source", origin: "source" });
  });

  it.each(["--version", "version"])("reports source truth through rooms %s", async (command) => {
    expect(await runRoomsCLI([command])).toBe(
      "rooms 0.1.0\nrelease=source\norigin=source\n",
    );
  });

  it("reports unknown instead of guessing for an unrecognized binary", () => {
    expect(roomsVersionIdentity({
      executablePath: "/tmp/copied-rooms",
      installRoot: "/tmp/no-rooms-install",
      stateDir: "/tmp/no-rooms-state",
    })).toEqual({ release: "unknown", origin: "unknown" });
  });
});

function releaseManifest(version: string) {
  const checksum = "0".repeat(64);
  return {
    schemaVersion: 1,
    product: "rooms",
    version,
    architecture: "darwin-arm64",
    minimumMacOS: "13.0",
    protocolVersion: 4,
    storeSchemaVersion: 21,
    features: { federation: false },
    signing: {
      mode: "LOCAL_PROOF_ONLY",
      identity: null,
      teamIdentifier: null,
      designatedRequirement: null,
      notarized: false,
    },
    files: {
      rooms: { sha256: checksum, mode: "0755" },
      roomsd: { sha256: checksum, mode: "0755" },
      "rooms-runtime-host": { sha256: checksum, mode: "0755" },
    },
  };
}

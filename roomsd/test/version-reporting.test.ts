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
      "rooms 0.1.0\nrelease=0.2.1-proof.4\norigin=installed\n",
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

import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RoomsDaemonRuntimeClient } from "../src/cli/daemon-runtime-client.js";
import { daemonUnavailableReason } from "../src/cli/default-backend.js";
import { runRoomsCLI } from "../src/cli/main.js";
import { setupMachineIdentity } from "../src/identity/machine-identity.js";
import { roomsPaths } from "../src/provisioning/paths.js";
import { readInstalledReleaseContract } from "../src/provisioning/release.js";
import { inspectStoreSchema, storeSchemaCompatibility } from "../src/provisioning/doctor.js";
import { daemonFailureExitCode } from "../src/runtime/native/main.js";
import { RoomsSchemaVersionError, SUPPORTED_SCHEMA_VERSION } from "../src/storage/migrations.js";
import { RoomsRepository } from "../src/storage/repository.js";

describe("Rooms schema safety", () => {
  it("migrates channel labels and reopens the upgraded store", () => {
    const directory = mkdtempSync(join(tmpdir(), "rooms-schema-label-"));
    const path = join(directory, "rooms.sqlite");
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE channels (
        id TEXT PRIMARY KEY,
        registered_at TEXT NOT NULL,
        owner_operator_session_id TEXT,
        lifecycle_state TEXT NOT NULL DEFAULT 'active',
        closed_at TEXT
      );
      CREATE TABLE changes (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        channel_id TEXT,
        payload TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        source_ordinal INTEGER
      );
      INSERT INTO channels(id, registered_at) VALUES ('proof', '2026-08-09T00:00:00.000Z');
      PRAGMA user_version=14;
    `);
    database.close();

    const migrated = new RoomsRepository(path);
    expect(migrated.currentChannel("proof")?.label).toBeNull();
    migrated.updateChannelLabel("proof", "Migration proof");
    migrated.close();

    const reopened = new RoomsRepository(path, { schemaPolicy: "require-current", schemaActor: "reopen proof" });
    expect(reopened.currentChannel("proof")?.label).toBe("Migration proof");
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("refuses to migrate an older shared store from a CLI repository", () => {
    const directory = mkdtempSync(join(tmpdir(), "rooms-schema-cli-"));
    const path = join(directory, "rooms.sqlite");
    const database = new DatabaseSync(path);
    database.exec(`PRAGMA user_version=${SUPPORTED_SCHEMA_VERSION - 1}`);
    database.close();

    expect(() => new RoomsRepository(path, { schemaPolicy: "require-current", schemaActor: "Rooms CLI" }))
      .toThrow(/refusing to migrate shared state/);

    const unchanged = new DatabaseSync(path, { readOnly: true });
    expect(Number((unchanged.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version))
      .toBe(SUPPORTED_SCHEMA_VERSION - 1);
    unchanged.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("does not create a missing store as a CLI side effect", () => {
    const directory = mkdtempSync(join(tmpdir(), "rooms-schema-missing-"));
    const path = join(directory, "rooms.sqlite");
    expect(() => new RoomsRepository(path, { schemaPolicy: "require-current" })).toThrow(/run `rooms setup`/);
    expect(existsSync(path)).toBe(false);
    rmSync(directory, { recursive: true, force: true });
  });

  it("refuses through the real default CLI backend without changing the store", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rooms-schema-real-cli-"));
    const stateDir = join(directory, "state");
    const path = join(stateDir, "rooms.sqlite");
    const previousStateDir = process.env.ROOMS_STATE_DIR;
    setupMachineIdentity(stateDir);
    const database = new DatabaseSync(path);
    database.exec(`PRAGMA user_version=${SUPPORTED_SCHEMA_VERSION - 1}`);
    database.close();
    process.env.ROOMS_STATE_DIR = stateDir;
    try {
      await expect(runRoomsCLI(["channel", "list"])).rejects.toThrow(/refusing to migrate shared state/);
      const unchanged = new DatabaseSync(path, { readOnly: true });
      expect(Number((unchanged.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version))
        .toBe(SUPPORTED_SCHEMA_VERSION - 1);
      unchanged.close();
    } finally {
      if (previousStateDir === undefined) delete process.env.ROOMS_STATE_DIR;
      else process.env.ROOMS_STATE_DIR = previousStateDir;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("names both schema versions in doctor output", () => {
    expect(() => storeSchemaCompatibility(14, 11)).toThrow(/store schema 14.*daemon schema 11/);
    expect(storeSchemaCompatibility(14, 14)).toBe("store=14 installed_daemon=14");
  });

  it("distinguishes a schema mismatch from an ordinary stopped daemon", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rooms-schema-client-"));
    const endpoint = join(directory, "roomsd.sock");
    const incompatible = new RoomsDaemonRuntimeClient(endpoint, () => "roomsd is incompatible with the Rooms store: installed daemon supports schema 11, store is at schema 14");
    const stopped = new RoomsDaemonRuntimeClient(endpoint);
    await expect(incompatible.call("status", {})).rejects.toThrow(/incompatible.*schema 11.*schema 14/);
    await expect(stopped.call("status", {})).rejects.toThrow(/roomsd is not running/);
    rmSync(directory, { recursive: true, force: true });
  });

  it("reads an older installed daemon schema for client diagnostics", () => {
    const directory = mkdtempSync(join(tmpdir(), "rooms-schema-installed-"));
    const stateDir = join(directory, "state");
    const installRoot = join(directory, "local");
    const releaseDirectory = join(installRoot, "lib", "rooms", "releases", "older");
    const currentLink = join(installRoot, "lib", "rooms", "current");
    const storePath = join(stateDir, "rooms.sqlite");
    mkdirSync(releaseDirectory, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(releaseDirectory, "manifest.json"), JSON.stringify({ product: "rooms", version: "older", storeSchemaVersion: 11 }));
    symlinkSync(releaseDirectory, currentLink, "dir");
    const database = new DatabaseSync(storePath);
    database.exec("PRAGMA user_version=14");
    database.close();

    const paths = roomsPaths(stateDir, installRoot);
    expect(readInstalledReleaseContract(paths)).toEqual({ version: "older", storeSchemaVersion: 11 });
    expect(() => inspectStoreSchema(paths)).toThrow(/store schema 14.*daemon schema 11/);
    expect(daemonUnavailableReason(paths, storePath))
      .toMatch(/installed daemon supports schema 11, store is at schema 14/);
    rmSync(directory, { recursive: true, force: true });
  });

  it("makes a future-store startup error non-retryable for launchd", () => {
    expect(daemonFailureExitCode(new RoomsSchemaVersionError(15, 14, "installed daemon"))).toBe(0);
    expect(daemonFailureExitCode(new Error("transient bind failure"))).toBe(1);
  });
});

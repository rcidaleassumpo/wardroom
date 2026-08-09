import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertReleaseUpgradeCompatible, readReleaseManifest, RELEASE_STORE_SCHEMA_VERSION, type ReleaseManifest } from "../src/provisioning/release.js";

function manifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    schemaVersion: 1,
    product: "rooms",
    version: "0.1.0-test",
    architecture: "darwin-arm64",
    minimumMacOS: "13.0",
    protocolVersion: 4,
    storeSchemaVersion: RELEASE_STORE_SCHEMA_VERSION,
    signing: { mode: "LOCAL_PROOF_ONLY", identity: null, teamIdentifier: "not set", designatedRequirement: null, notarized: false },
    files: {},
    ...overrides,
  } as ReleaseManifest;
}

function storeAtSchema(version: number): { storePath: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "rooms-release-upgrade-"));
  const storePath = join(directory, "rooms.sqlite");
  const database = new DatabaseSync(storePath);
  database.exec(`PRAGMA user_version=${version}`);
  database.close();
  return { storePath, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

describe("release store schema compatibility", () => {
  it("accepts a release that advances the store schema past the current store", () => {
    // The defect: this was rejected outright, so no schema bump could ever be
    // installed by the binary it was replacing.
    const { storePath, cleanup } = storeAtSchema(14);
    try {
      expect(() => assertReleaseUpgradeCompatible(manifest({ storeSchemaVersion: 15 }), storePath)).not.toThrow();
      expect(() => assertReleaseUpgradeCompatible(manifest({ storeSchemaVersion: 99 }), storePath)).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it("accepts a release matching the current store schema", () => {
    const { storePath, cleanup } = storeAtSchema(14);
    try {
      expect(() => assertReleaseUpgradeCompatible(manifest({ storeSchemaVersion: 14 }), storePath)).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it("refuses a release older than the store and names both versions and the remedy", () => {
    const { storePath, cleanup } = storeAtSchema(14);
    try {
      expect(() => assertReleaseUpgradeCompatible(manifest({ storeSchemaVersion: 13 }), storePath))
        .toThrow(/supports store schema 13, but this machine's store is already at schema 14/);
      expect(() => assertReleaseUpgradeCompatible(manifest({ storeSchemaVersion: 13 }), storePath))
        .toThrow(/restore a store backup/);
    } finally {
      cleanup();
    }
  });

  it("allows any release on a machine with no store yet", () => {
    const directory = mkdtempSync(join(tmpdir(), "rooms-release-nostore-"));
    try {
      const missing = join(directory, "rooms.sqlite");
      expect(() => assertReleaseUpgradeCompatible(manifest({ storeSchemaVersion: 1 }), missing)).not.toThrow();
      expect(() => assertReleaseUpgradeCompatible(manifest({ storeSchemaVersion: 99 }), missing)).not.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("release manifest version fields", () => {
  function writeManifest(body: Record<string, unknown>): { directory: string; cleanup: () => void } {
    const directory = mkdtempSync(join(tmpdir(), "rooms-manifest-"));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "manifest.json"), JSON.stringify(body));
    return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  }

  const base = {
    schemaVersion: 1,
    product: "rooms",
    version: "0.1.0-test",
    architecture: "darwin-arm64",
    minimumMacOS: "13.0",
    signing: { mode: "LOCAL_PROOF_ONLY", identity: null, teamIdentifier: "not set", designatedRequirement: null, notarized: false },
    files: {},
  };

  it("no longer requires the manifest to match this binary's own contract", () => {
    // Reading must succeed for a newer schema/protocol; only the file-checksum
    // stage below it cares about contents, so a missing files entry is the failure.
    const { directory, cleanup } = writeManifest({ ...base, protocolVersion: 99, storeSchemaVersion: 99 });
    try {
      expect(() => readReleaseManifest(directory)).toThrow(/checksum entry is invalid/);
    } finally {
      cleanup();
    }
  });

  it("still rejects a nonsensical schema or protocol version", () => {
    for (const bad of [0, -1, 1.5, "4", null]) {
      const store = writeManifest({ ...base, protocolVersion: 4, storeSchemaVersion: bad });
      try {
        expect(() => readReleaseManifest(store.directory)).toThrow(/store schema version is invalid/);
      } finally {
        store.cleanup();
      }
      const protocol = writeManifest({ ...base, protocolVersion: bad, storeSchemaVersion: 14 });
      try {
        expect(() => readReleaseManifest(protocol.directory)).toThrow(/protocol version is invalid/);
      } finally {
        protocol.cleanup();
      }
    }
  });
});

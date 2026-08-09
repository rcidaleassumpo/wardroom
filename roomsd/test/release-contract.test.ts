import { describe, expect, it } from "vitest";
import releaseContract from "../release-contract.json" with { type: "json" };
import { RELEASE_PROTOCOL_VERSION, RELEASE_STORE_SCHEMA_VERSION } from "../src/provisioning/release.js";
import { SUPPORTED_SCHEMA_VERSION } from "../src/storage/migrations.js";

describe("Rooms release contract", () => {
  it("uses the daemon's supported store schema in packaged release metadata", () => {
    expect(RELEASE_STORE_SCHEMA_VERSION).toBe(SUPPORTED_SCHEMA_VERSION);
    expect(RELEASE_STORE_SCHEMA_VERSION).toBe(releaseContract.storeSchemaVersion);
    expect(RELEASE_PROTOCOL_VERSION).toBe(releaseContract.protocolVersion);
  });
});

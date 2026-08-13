import { describe, expect, it } from "vitest";
import {
  planReleasePruning,
  RELEASE_CODE_IDENTIFIERS,
  RELEASE_FILES,
  RELEASE_STORE_SCHEMA_VERSION,
  type ReleaseManifest,
} from "../src/provisioning/release.js";

const requirement = (name: string, signer = "Rooms") =>
  `identifier "${RELEASE_CODE_IDENTIFIERS[name]}" and certificate leaf[subject.CN] = "${signer}"`;

function manifest(version: string, signer = "Rooms", stableIdentity = true): ReleaseManifest {
  return {
    schemaVersion: 1,
    product: "rooms",
    version,
    architecture: "darwin-arm64",
    minimumMacOS: "13.0",
    protocolVersion: 4,
    storeSchemaVersion: RELEASE_STORE_SCHEMA_VERSION,
    signing: {
      mode: "LOCAL_PROOF_ONLY",
      identity: signer,
      teamIdentifier: null,
      designatedRequirement: null,
      notarized: false,
      identifiers: Object.fromEntries(RELEASE_FILES.map(name => [name, RELEASE_CODE_IDENTIFIERS[name]])),
      designatedRequirements: Object.fromEntries(RELEASE_FILES.map(name => [name, stableIdentity ? requirement(name, signer) : `cdhash H"${version}"`])),
      stableIdentity,
    },
    files: {},
  } as ReleaseManifest;
}

describe("release pruning", () => {
  it("keeps the newest rollback release with the current stable macOS identity", () => {
    const current = manifest("current");
    const plan = planReleasePruning(current, [
      { name: "oldest", manifest: manifest("oldest"), modified: 1 },
      { name: "rollback", manifest: manifest("rollback"), modified: 3 },
      { name: "middle", manifest: manifest("middle"), modified: 2 },
    ]);
    expect(plan).toEqual({ retained: ["rollback"], removed: ["middle", "oldest"] });
  });

  it("removes verified releases with a different identity instead of retaining an invalid rollback", () => {
    const current = manifest("current");
    const plan = planReleasePruning(current, [
      { name: "different", manifest: manifest("different", "Other signer"), modified: 4 },
      { name: "rollback", manifest: manifest("rollback"), modified: 3 },
    ]);
    expect(plan).toEqual({ retained: ["rollback"], removed: ["different"] });
  });

  it("does not prune when the current release has no stable identity", () => {
    const plan = planReleasePruning(manifest("current", "ad-hoc", false), [
      { name: "old-a", manifest: manifest("old-a"), modified: 2 },
      { name: "old-b", manifest: manifest("old-b"), modified: 1 },
    ]);
    expect(plan).toEqual({ retained: ["old-a", "old-b"], removed: [] });
  });
});

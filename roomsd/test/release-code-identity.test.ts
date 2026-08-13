import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertReleaseIdentityUnchanged,
  isStableCodeIdentity,
  readReleaseManifest,
  RELEASE_CODE_IDENTIFIERS,
  RELEASE_FILES,
  RELEASE_STORE_SCHEMA_VERSION,
  requirementIdentifier,
  type ReleaseManifest,
} from "../src/provisioning/release.js";

const ANCHORED = (identifier: string) =>
  `identifier "${identifier}" and anchor apple generic and certificate leaf[subject.CN] = "Developer ID Application: Rooms" and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */`;
const AD_HOC = 'cdhash H"1ffe25b978e4461fbe0822bff2046c8f72d7fce0"';

function signedManifest(overrides: Partial<ReleaseManifest["signing"]> = {}, version = "0.1.0"): ReleaseManifest {
  const identifiers = Object.fromEntries(RELEASE_FILES.map(name => [name, RELEASE_CODE_IDENTIFIERS[name]]));
  const designatedRequirements = Object.fromEntries(RELEASE_FILES.map(name => [name, ANCHORED(RELEASE_CODE_IDENTIFIERS[name])]));
  return {
    schemaVersion: 1,
    product: "rooms",
    version,
    architecture: "darwin-arm64",
    minimumMacOS: "13.0",
    protocolVersion: 4,
    storeSchemaVersion: RELEASE_STORE_SCHEMA_VERSION,
    signing: { mode: "LOCAL_PROOF_ONLY", identity: "Rooms Local Signing", teamIdentifier: null, designatedRequirement: null, notarized: false, identifiers, designatedRequirements, stableIdentity: true, ...overrides },
    files: Object.fromEntries(RELEASE_FILES.map(name => [name, { sha256: "a".repeat(64), mode: "0755" }])),
  } as ReleaseManifest;
}

function manifestDirectory(manifest: ReleaseManifest): { directory: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "rooms-code-identity-"));
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

describe("release code identity", () => {
  it("reads an identifier only from a requirement that survives a rebuild", () => {
    // The defect: an ad-hoc build has no requirement of its own, so codesign
    // reports this build's cdhash and every release becomes a new program.
    expect(requirementIdentifier(AD_HOC)).toBeNull();
    expect(requirementIdentifier(ANCHORED("io.rooms.roomsd"))).toBe("io.rooms.roomsd");
    expect(requirementIdentifier('identifier "io.rooms.rooms" and certificate leaf H"abc"')).toBe("io.rooms.rooms");
    expect(isStableCodeIdentity(AD_HOC, "io.rooms.roomsd")).toBe(false);
    expect(isStableCodeIdentity(ANCHORED("io.rooms.rooms"), "io.rooms.roomsd")).toBe(false);
    expect(isStableCodeIdentity(ANCHORED("io.rooms.roomsd"), "io.rooms.roomsd")).toBe(true);
  });

  it("gives every packaged binary its own fixed identifier", () => {
    for (const name of RELEASE_FILES) expect(RELEASE_CODE_IDENTIFIERS[name]).toMatch(/^io\.rooms\./);
    expect(new Set(RELEASE_FILES.map(name => RELEASE_CODE_IDENTIFIERS[name])).size).toBe(RELEASE_FILES.length);
  });

  it("accepts a manifest that claims this product's identity", () => {
    const { directory, cleanup } = manifestDirectory(signedManifest());
    try { expect(readReleaseManifest(directory).signing.stableIdentity).toBe(true); } finally { cleanup(); }
  });

  it("still reads a release built before per-binary identity", () => {
    const legacy = signedManifest();
    const signing = { ...legacy.signing } as Record<string, unknown>;
    delete signing.identifiers; delete signing.designatedRequirements; delete signing.stableIdentity;
    const { directory, cleanup } = manifestDirectory({ ...legacy, signing } as ReleaseManifest);
    try { expect(readReleaseManifest(directory).version).toBe("0.1.0"); } finally { cleanup(); }
  });

  it("refuses a manifest claiming an identity that is not this product's", () => {
    const identifiers = Object.fromEntries(RELEASE_FILES.map(name => [name, RELEASE_CODE_IDENTIFIERS[name]]));
    identifiers.roomsd = "io.example.roomsd";
    const { directory, cleanup } = manifestDirectory(signedManifest({ identifiers }));
    try { expect(() => readReleaseManifest(directory)).toThrow(/code identifier for roomsd must be io\.rooms\.roomsd/); } finally { cleanup(); }
  });

  it("refuses a manifest whose stable-identity claim its own requirements do not support", () => {
    const designatedRequirements = Object.fromEntries(RELEASE_FILES.map(name => [name, ANCHORED(RELEASE_CODE_IDENTIFIERS[name])]));
    designatedRequirements.rooms = AD_HOC;
    const { directory, cleanup } = manifestDirectory(signedManifest({ designatedRequirements, stableIdentity: true }));
    try { expect(() => readReleaseManifest(directory)).toThrow(/stable identity claim does not match/); } finally { cleanup(); }
  });

  it("installs a successor that keeps the same identity", () => {
    expect(() => assertReleaseIdentityUnchanged(signedManifest({}, "0.1.0"), signedManifest({}, "0.2.0"))).not.toThrow();
  });

  it("refuses a successor that would strand the operator's App Management grant", () => {
    const rotated = Object.fromEntries(RELEASE_FILES.map(name => [name, ANCHORED(RELEASE_CODE_IDENTIFIERS[name]).replace("Rooms", "Someone Else")]));
    const incoming = signedManifest({ designatedRequirements: rotated }, "0.2.0");
    expect(() => assertReleaseIdentityUnchanged(signedManifest({}, "0.1.0"), incoming)).toThrow(/App Management/);
    expect(() => assertReleaseIdentityUnchanged(signedManifest({}, "0.1.0"), incoming)).toThrow(/--allow-identity-change/);
  });

  it("names ad-hoc signing as the cause when a build carries its own identity", () => {
    const adHoc = signedManifest({ designatedRequirements: Object.fromEntries(RELEASE_FILES.map(name => [name, AD_HOC])), stableIdentity: false }, "0.2.0");
    expect(() => assertReleaseIdentityUnchanged(signedManifest({}, "0.1.0"), adHoc)).toThrow(/ad-hoc signed/);
    expect(() => assertReleaseIdentityUnchanged(signedManifest({}, "0.1.0"), adHoc)).toThrow(/ROOMS_SIGNING_IDENTITY/);
  });

  it("says nothing about identity for two releases that never recorded one", () => {
    const legacy = signedManifest();
    const signing = { ...legacy.signing } as Record<string, unknown>;
    delete signing.identifiers; delete signing.designatedRequirements; delete signing.stableIdentity;
    const before = { ...legacy, signing } as ReleaseManifest;
    expect(() => assertReleaseIdentityUnchanged(before, before)).not.toThrow();
  });
});

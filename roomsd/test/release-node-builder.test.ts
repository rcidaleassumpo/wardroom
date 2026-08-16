import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isReleaseNode, releaseNode, sha256 } from "../scripts/run-release-builder.mjs";

describe("release Node builder", () => {
  it("pins the official Apple Silicon Node archive and checksum", () => {
    expect(releaseNode).toEqual({
      version: "v22.23.2",
      archive: "node-v22.23.2-darwin-arm64.tar.gz",
      sha256: "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
    });
  });

  it("accepts only the pinned version with the SEA fuse", () => {
    const directory = mkdtempSync(join(tmpdir(), "rooms-release-node-test-"));
    const executable = join(directory, "node");
    writeFileSync(executable, "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:0");
    expect(isReleaseNode("v22.23.2", executable)).toBe(true);
    expect(isReleaseNode("v26.0.0", executable)).toBe(false);
  });

  it("rejects a binary without the SEA fuse", () => {
    const directory = mkdtempSync(join(tmpdir(), "rooms-release-node-test-"));
    const executable = join(directory, "node");
    writeFileSync(executable, "homebrew node");
    expect(isReleaseNode("v22.23.2", executable)).toBe(false);
  });

  it("computes the archive checksum", () => {
    const directory = mkdtempSync(join(tmpdir(), "rooms-release-node-test-"));
    const archive = join(directory, "archive");
    writeFileSync(archive, "rooms\n");
    expect(sha256(archive)).toBe("174af82024b3d6f0b6d1ee6e06cebf92b368dcf187bff7d84e2f694cac6a9f72");
  });
});

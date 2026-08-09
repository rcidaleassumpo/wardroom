import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundledReleaseDirectory } from "../src/cli/main.js";

describe("Rooms packaged self-install", () => {
  it("resolves an npm or Homebrew bin link to the bundled release directory", () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-self-install-"));
    const release = join(root, "release");
    const bin = join(root, "bin");
    try {
      const executable = join(release, "rooms");
      mkdirSync(release);
      writeFileSync(executable, "release");
      symlinkSync(executable, bin);
      expect(bundledReleaseDirectory(bin)).toBe(realpathSync(release));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

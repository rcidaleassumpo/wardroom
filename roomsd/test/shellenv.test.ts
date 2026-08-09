import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { roomsShellenv } from "../src/cli/shellenv.js";
import { setupMachineIdentity } from "../src/identity/machine-identity.js";

describe("Rooms shellenv lifecycle", () => {
  it("keeps status explicit while print remains the eval-safe output", () => {
    const dir = mkdtempSync(join(tmpdir(), "rooms-shellenv-print-"));
    process.env.ROOMS_STATE_DIR = join(dir, "state");
    process.env.ROOMS_SHELL_CONFIG = join(dir, ".zshrc");
    process.env.ROOMS_SHELLENV_FILE = join(dir, "shellenv.zsh");
    setupMachineIdentity(process.env.ROOMS_STATE_DIR);
    try {
      expect(roomsShellenv(undefined)).toContain("# >>> rooms shellenv >>>");
      expect(roomsShellenv("status")).toMatchObject({ installed: false });
    } finally { delete process.env.ROOMS_STATE_DIR; delete process.env.ROOMS_SHELL_CONFIG; delete process.env.ROOMS_SHELLENV_FILE; }
  });

  it("installs and removes only its managed zsh block", () => {
    const dir = mkdtempSync(join(tmpdir(), "rooms-shellenv-"));
    process.env.ROOMS_SHELL_CONFIG = join(dir, ".zshrc");
    process.env.ROOMS_SHELLENV_FILE = join(dir, "shellenv.zsh");
    process.env.ROOMS_STATE_DIR = join(dir, "state");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), "#!/bin/sh\n", { mode: 0o700 });
    chmodSync(join(bin, "claude"), 0o700);
    const previousPath = process.env.PATH;
    process.env.PATH = bin;
    setupMachineIdentity(process.env.ROOMS_STATE_DIR);
    try {
      roomsShellenv("install");
      expect(roomsShellenv("status")).toMatchObject({ installed: true, providers: [{ name: "claude" }] });
      expect(readFileSync(process.env.ROOMS_SHELL_CONFIG, "utf8")).toContain("rooms shellenv");
      expect(readFileSync(process.env.ROOMS_SHELLENV_FILE, "utf8")).toContain("claude() {");
      expect(readFileSync(process.env.ROOMS_SHELLENV_FILE, "utf8")).not.toContain("codex() {");
      roomsShellenv("uninstall");
      expect(roomsShellenv("status")).toMatchObject({ installed: false });
    } finally {
      delete process.env.ROOMS_SHELL_CONFIG;
      delete process.env.ROOMS_SHELLENV_FILE;
      delete process.env.ROOMS_STATE_DIR;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

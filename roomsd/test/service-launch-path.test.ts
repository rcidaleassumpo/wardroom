import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { launchAgentPlist, serviceLaunchPath } from "../src/provisioning/launchd.js";
import { providerInterpreterCommand, resolveOnPath } from "../src/cli/provider-registry.js";
import { roomsPaths } from "../src/provisioning/paths.js";

describe("Rooms service launch PATH", () => {
  it("records the installing operator's directories and always keeps the launchd defaults", () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-service-path-"));
    const prefix = join(root, "prefix", "bin");
    mkdirSync(prefix, { recursive: true });

    const value = serviceLaunchPath({ PATH: [prefix, "relative/bin", join(root, "absent"), prefix, "/usr/bin"].join(delimiter) });

    expect(value.split(delimiter)).toEqual([prefix, "/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
  });

  it("falls back to the launchd defaults when the installing shell has no PATH", () => {
    expect(serviceLaunchPath({}).split(delimiter)).toEqual(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
  });

  it("publishes the PATH in the launch agent so an interpreted provider can exec", () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-service-plist-"));
    const paths = roomsPaths(join(root, "state"), join(root, "install"));
    mkdirSync(paths.releaseRoot, { recursive: true });
    const prefix = join(root, "prefix", "bin");
    mkdirSync(prefix, { recursive: true });

    const plist = launchAgentPlist(paths, paths.releaseRoot, { PATH: prefix });

    expect(plist).toContain(`<key>PATH</key><string>${prefix}${delimiter}/usr/bin${delimiter}/bin${delimiter}/usr/sbin${delimiter}/sbin</string>`);
  });
});

describe("Rooms provider interpreter requirements", () => {
  it("reports the interpreter an interpreted provider resolves through PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-interpreter-"));
    const script = join(root, "codex.js");
    writeFileSync(script, "#!/usr/bin/env node\nconsole.log(1)\n");
    chmodSync(script, 0o755);

    expect(providerInterpreterCommand(script)).toBe("node");
  });

  it("ignores env switches and inline assignments before the interpreter", () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-interpreter-"));
    const script = join(root, "provider");
    writeFileSync(script, "#!/usr/bin/env -S FOO=1 python3 -u\n");
    chmodSync(script, 0o755);

    expect(providerInterpreterCommand(script)).toBe("python3");
  });

  it("requires nothing from a native provider or an absolute interpreter", () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-interpreter-"));
    const native = join(root, "grok");
    writeFileSync(native, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00]));
    const absolute = join(root, "wrapper");
    writeFileSync(absolute, "#!/bin/sh\nexec true\n");

    expect(providerInterpreterCommand(native)).toBeUndefined();
    expect(providerInterpreterCommand(absolute)).toBeUndefined();
    expect(providerInterpreterCommand(join(root, "absent"))).toBeUndefined();
  });

  it("resolves an interpreter only against executable entries of the given PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-interpreter-path-"));
    const bin = join(root, "bin");
    const empty = join(root, "empty");
    mkdirSync(bin);
    mkdirSync(empty);
    const node = join(bin, "node");
    writeFileSync(node, "#!/bin/sh\nexit 0\n");
    chmodSync(node, 0o755);

    expect(resolveOnPath("node", [empty, bin].join(delimiter))).toBe(node);
    expect(resolveOnPath("node", empty)).toBeUndefined();
    expect(resolveOnPath("node", "relative/bin")).toBeUndefined();
  });
});

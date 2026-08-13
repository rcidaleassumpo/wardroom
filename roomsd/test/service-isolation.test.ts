import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { launchAgentPlist, retireLegacyLaunchAgents, serviceTarget, waitForServiceReady } from "../src/provisioning/launchd.js";
import { DEFAULT_ROOMS_SERVICE_LABEL, defaultStateDir, roomsPaths } from "../src/provisioning/paths.js";

describe("Rooms per-state LaunchAgent identity", () => {
  it("preserves the existing label and plist for the default state", () => {
    const paths = roomsPaths(defaultStateDir(), join(tmpdir(), "rooms-default-install"));

    expect(paths.serviceLabel).toBe(DEFAULT_ROOMS_SERVICE_LABEL);
    expect(paths.launchAgentPlist).toBe(join(homedir(), "Library", "LaunchAgents", "local.rooms.roomsd.plist"));
  });

  it("derives a stable opaque label and plist from a non-default state", () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-service-isolation-"));
    const stateDir = join(root, "state");
    const expectedIdentity = join(realpathSync(root), "state");
    const expectedKey = createHash("sha256").update(expectedIdentity).digest("hex").slice(0, 16);
    const direct = roomsPaths(stateDir, join(root, "install-a"));
    const normalized = roomsPaths(join(root, "nested", "..", "state"), join(root, "install-b"));

    expect(direct.serviceLabel).toBe(`local.rooms.roomsd.state-${expectedKey}`);
    expect(direct.serviceLabel).toBe(normalized.serviceLabel);
    expect(direct.serviceLabel).not.toContain(root);
    expect(direct.launchAgentPlist).toBe(join(homedir(), "Library", "LaunchAgents", `${direct.serviceLabel}.plist`));
  });

  it("uses one stable label through a symlink before and after state creation", () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-service-isolation-"));
    const realParent = join(root, "real-parent");
    const linkedParent = join(root, "linked-parent");
    mkdirSync(realParent);
    symlinkSync(realParent, linkedParent);
    const directState = join(realParent, "not-created", "state");
    const linkedState = join(linkedParent, "not-created", "state");

    const beforeCreation = roomsPaths(linkedState, join(root, "install-a")).serviceLabel;
    expect(beforeCreation).toBe(roomsPaths(directState, join(root, "install-b")).serviceLabel);

    mkdirSync(directState, { recursive: true });
    expect(roomsPaths(linkedState, join(root, "install-c")).serviceLabel).toBe(beforeCreation);
    expect(roomsPaths(directState, join(root, "install-d")).serviceLabel).toBe(beforeCreation);
  });

  it("keeps an aliased path to the default state on the default label", () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-service-isolation-"));
    const linkedHome = join(root, "linked-home");
    symlinkSync(homedir(), linkedHome);

    expect(roomsPaths(join(linkedHome, ".rooms"), join(root, "install")).serviceLabel)
      .toBe(DEFAULT_ROOMS_SERVICE_LABEL);
  });

  it("keeps separate state directories on separate launchd targets", () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-service-isolation-"));
    const first = roomsPaths(join(root, "first"), join(root, "install"));
    const second = roomsPaths(join(root, "second"), join(root, "install"));

    expect(first.serviceLabel).not.toBe(second.serviceLabel);
    expect(first.launchAgentPlist).not.toBe(second.launchAgentPlist);
    expect(serviceTarget(first, "gui/501")).toBe(`gui/501/${first.serviceLabel}`);
    expect(serviceTarget(second, "gui/501")).toBe(`gui/501/${second.serviceLabel}`);
  });

  it("writes the isolated label and state into the generated plist", () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-service-isolation-"));
    const prefix = join(root, "bin");
    mkdirSync(prefix);
    const paths = roomsPaths(join(root, "state"), join(root, "install"));
    mkdirSync(paths.releaseRoot, { recursive: true });
    const plist = launchAgentPlist(paths, paths.releaseRoot, { PATH: prefix });

    expect(plist).toContain(`<key>Label</key><string>${paths.serviceLabel}</string>`);
    expect(plist).toContain(`<key>ROOMS_STATE_DIR</key><string>${paths.stateDir}</string>`);
    expect(plist).not.toContain(`<key>Label</key><string>${DEFAULT_ROOMS_SERVICE_LABEL}</string>`);
  });

  it("accepts a verified release reached through a symlinked install root", () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-service-isolation-"));
    const realInstall = join(root, "real-install");
    const linkedInstall = join(root, "linked-install");
    const release = join(realInstall, "lib", "rooms", "releases", "v1");
    mkdirSync(release, { recursive: true });
    symlinkSync(realInstall, linkedInstall);
    const paths = roomsPaths(join(root, "state"), linkedInstall);

    expect(() => launchAgentPlist(paths, realpathSync(release), { PATH: "/usr/bin" })).not.toThrow();
    expect(() => launchAgentPlist(paths, root, { PATH: "/usr/bin" })).toThrow("inside the verified release root");
  });

  it("waits a bounded number of times for the daemon endpoint", () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-service-isolation-"));
    const paths = roomsPaths(join(root, "state"), join(root, "install"));
    let checks = 0;
    let pauses = 0;

    waitForServiceReady(paths, {
      attempts: 3,
      isReady: () => ++checks === 3,
      pause: () => { pauses += 1; },
    });
    expect(checks).toBe(3);
    expect(pauses).toBe(2);

    expect(() => waitForServiceReady(paths, { attempts: 2, isReady: () => false, pause: () => undefined }))
      .toThrow(`did not become ready at ${paths.endpoint}`);
  });
});

describe("service install readiness wiring", () => {
  // waitForServiceReady is covered behaviourally above, but nothing pinned that
  // installService actually calls it: removing the call leaves the whole suite
  // green while restoring the internal work item race, where install returns before the
  // socket exists and the next command fails. launchd cannot be driven in a unit
  // test, so the wiring is guarded at the source like the CI and README guards.
  const source = readFileSync(resolve(import.meta.dirname, "../src/provisioning/launchd.ts"), "utf8");

  it("calls the readiness wait after bootstrapping the service", () => {
    const install = source.slice(source.indexOf("export function installService"));
    const body = install.slice(0, install.indexOf("\nexport function "));
    expect(body).toContain("bootstrapService(");
    expect(body).toContain("waitForServiceReady(paths)");
    expect(body.indexOf("bootstrapService(")).toBeLessThan(body.indexOf("waitForServiceReady(paths)"));
  });

  it("retires exact pre-cutover jobs before replacing the canonical service", () => {
    const calls: string[][] = [];
    const removed: string[] = [];
    const result = retireLegacyLaunchAgents({
      domain: "gui/501",
      launchAgentDir: "/tmp/LaunchAgents",
      stateDir: "/tmp/rooms-state",
      runLaunchctl: (args) => {
        calls.push([...args]);
        return { ok: true, output: "", error: "" };
      },
      removeFile: (path) => { removed.push(path); },
    });

    expect(calls).toEqual([
      ["print", "gui/501/local.rooms.roomsd-ts"],
      ["bootout", "gui/501/local.rooms.roomsd-ts"],
      ["print", "gui/501/local.rooms.planner-supervisor"],
      ["bootout", "gui/501/local.rooms.planner-supervisor"],
    ]);
    expect(result.labels).toEqual(["local.rooms.roomsd-ts", "local.rooms.planner-supervisor"]);
    expect(removed).toEqual([
      "/tmp/LaunchAgents/local.rooms.roomsd-ts.plist",
      "/tmp/LaunchAgents/local.rooms.planner-supervisor.plist",
      "/tmp/rooms-state/roomsd-ts.stdout.log",
      "/tmp/rooms-state/roomsd-ts.stderr.log",
      "/tmp/rooms-state/planner-supervisor.stdout.log",
      "/tmp/rooms-state/planner-supervisor.stderr.log",
    ]);
    expect(removed).not.toContain("/tmp/LaunchAgents/local.rooms.roomsd.plist");

    const install = source.slice(source.indexOf("export function installService"));
    const body = install.slice(0, install.indexOf("\nexport function "));
    expect(body).toContain("retireLegacyLaunchAgents()");
    expect(body.indexOf("retireLegacyLaunchAgents()")).toBeLessThan(body.indexOf("bootstrapService("));
  });

  it("keeps the readiness failure loud rather than returning optimistically", () => {
    const wait = source.slice(source.indexOf("export function waitForServiceReady"));
    const body = wait.slice(0, wait.indexOf("\n}"));
    expect(body).toContain("did not become ready");
    expect(body).toContain("paths.endpoint");
  });
});

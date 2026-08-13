import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverProviders, inspectProvider, listRegisteredProviders, registerProvider, registeredProviderExecutable, removeProvider, updateProvider } from "../src/cli/provider-registry.js";
import { setupMachineIdentity } from "../src/identity/machine-identity.js";

describe("Rooms machine provider registry", () => {
  it("discovers only providers installed on this machine and persists authority-bound state", () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-providers-"));
    const stateDir = join(root, "state");
    const bin = join(root, "bin");
    mkdirSync(bin);
    setupMachineIdentity(stateDir);
    executable(join(bin, "claude"));

    const registry = discoverProviders(stateDir, { PATH: bin });
    expect(registry.providers.map(item => item.name)).toEqual(["claude"]);
    expect(listRegisteredProviders(stateDir)).toEqual(registry.providers);
    expect(JSON.parse(readFileSync(join(stateDir, "providers.json"), "utf8")).authorityId).toBe(registry.authorityId);
  });

  it("supports explicit registrations and repairs stale registrations", () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-providers-"));
    const stateDir = join(root, "state");
    const bin = join(root, "bin");
    mkdirSync(bin);
    setupMachineIdentity(stateDir);
    const codex = join(bin, "codex-custom");
    executable(codex);

    registerProvider("codex", codex, stateDir, { PATH: "" });
    expect(registeredProviderExecutable("codex", stateDir, { PATH: "" })).toBe(realpathSync(codex));
    discoverProviders(stateDir, { PATH: "" });
    expect(listRegisteredProviders(stateDir).map(item => item.name)).toEqual(["codex"]);
    removeProvider("codex", stateDir);
    expect(listRegisteredProviders(stateDir)).toEqual([]);
    unlinkSync(codex);
    expect(() => registeredProviderExecutable("codex", stateDir, { PATH: "" })).toThrow(/unavailable on this machine/);
  });

  it("persists the generic Gemini agy registration lifecycle and health", () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-providers-"));
    const stateDir = join(root, "state");
    const bin = join(root, "bin");
    mkdirSync(bin);
    setupMachineIdentity(stateDir);
    const agy = join(bin, "agy");
    executable(agy);

    registerProvider("gemini", { executable: agy, defaults: { permissions: "manual", model: "gemini-test" } }, stateDir);
    expect(inspectProvider("gemini", stateDir)).toMatchObject({
      name: "gemini", enabled: true, executable: realpathSync(agy), adapter: "agy",
      defaults: { permissions: "manual", model: "gemini-test" }, health: { status: "available" },
    });
    updateProvider("gemini", { enabled: false }, stateDir);
    expect(inspectProvider("gemini", stateDir)).toMatchObject({ enabled: false, health: { status: "disabled" } });
    expect(() => registeredProviderExecutable("gemini", stateDir, { PATH: "" })).toThrow(/disabled/);
    removeProvider("gemini", stateDir);
    expect(listRegisteredProviders(stateDir)).toEqual([]);
  });

  it("discovers Gemini through the agy executable name", () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-providers-"));
    const stateDir = join(root, "state");
    const bin = join(root, "bin");
    mkdirSync(bin);
    setupMachineIdentity(stateDir);
    executable(join(bin, "agy"));
    expect(discoverProviders(stateDir, { PATH: bin }).providers).toEqual([
      expect.objectContaining({ name: "gemini", adapter: "agy", executable: realpathSync(join(bin, "agy")) }),
    ]);
  });

  it("selects Google's Gemini CLI adapter for a gemini executable", () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-providers-"));
    const stateDir = join(root, "state");
    const bin = join(root, "bin");
    mkdirSync(bin);
    setupMachineIdentity(stateDir);
    executable(join(bin, "gemini"));
    expect(discoverProviders(stateDir, { PATH: bin }).providers).toEqual([
      expect.objectContaining({ name: "gemini", adapter: "gemini", executable: realpathSync(join(bin, "gemini")) }),
    ]);
  });

  it("updates the Gemini adapter when its executable family changes", () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-providers-"));
    const stateDir = join(root, "state");
    const bin = join(root, "bin");
    mkdirSync(bin);
    setupMachineIdentity(stateDir);
    executable(join(bin, "agy"));
    executable(join(bin, "gemini"));
    registerProvider("gemini", { executable: join(bin, "agy") }, stateDir);
    updateProvider("gemini", { executable: join(bin, "gemini") }, stateDir);
    expect(inspectProvider("gemini", stateDir)).toMatchObject({
      adapter: "gemini",
      executable: realpathSync(join(bin, "gemini")),
    });
  });

  it("repairs a discovered Gemini adapter when the executable family changes", () => {
    const root = mkdtempSync(join(tmpdir(), "rooms-providers-"));
    const stateDir = join(root, "state");
    const bin = join(root, "bin");
    mkdirSync(bin);
    setupMachineIdentity(stateDir);
    executable(join(bin, "agy"));
    discoverProviders(stateDir, { PATH: bin });
    unlinkSync(join(bin, "agy"));
    executable(join(bin, "gemini"));

    expect(discoverProviders(stateDir, { PATH: bin }).providers).toEqual([
      expect.objectContaining({ name: "gemini", adapter: "gemini", executable: realpathSync(join(bin, "gemini")) }),
    ]);
  });
});

function executable(path: string): void {
  writeFileSync(path, "#!/bin/sh\n", { mode: 0o700 });
  chmodSync(path, 0o700);
}

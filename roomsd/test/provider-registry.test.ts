import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverProviders, listRegisteredProviders, registerProvider, registeredProviderExecutable, unregisterProvider } from "../src/cli/provider-registry.js";
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
    unregisterProvider("codex", stateDir);
    expect(listRegisteredProviders(stateDir)).toEqual([]);
    unlinkSync(codex);
    expect(() => registeredProviderExecutable("codex", stateDir, { PATH: "" })).toThrow(/unavailable on this machine/);
  });
});

function executable(path: string): void {
  writeFileSync(path, "#!/bin/sh\n", { mode: 0o700 });
  chmodSync(path, 0o700);
}

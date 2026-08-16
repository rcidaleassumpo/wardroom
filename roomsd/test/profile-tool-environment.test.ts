import { lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeProfileToolEnvironment } from "../src/index.js";

const roots: string[] = [];
const emptyPolicy = { npmUserConfig: false, browserRuntime: false, sandyboxySandbox: null } as const;

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rooms-tool-environment-"));
  roots.push(root);
  const userHome = join(root, "user");
  const generatedHome = join(root, "generated");
  mkdirSync(userHome);
  return { root, userHome, generatedHome };
}

describe("profile tool environment", () => {
  it("links npm user configuration and makes its use explicit", () => {
    const { userHome, generatedHome } = fixture();
    writeFileSync(join(userHome, ".npmrc"), "registry=https://registry.example.invalid/\n");
    const result = materializeProfileToolEnvironment(generatedHome, { ...emptyPolicy, npmUserConfig: true }, { userHome });
    const target = join(generatedHome, ".npmrc");
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(result.environment).toEqual({ HOME: generatedHome, NPM_CONFIG_USERCONFIG: target });
    expect(() => materializeProfileToolEnvironment(join(generatedHome, "missing"), { ...emptyPolicy, npmUserConfig: true }, { userHome: join(userHome, "missing") })).toThrow(/authentication source is missing/);
  });

  it("writes only the selected Sandyboxy sandbox and disables its gateway", () => {
    const { userHome, generatedHome } = fixture();
    const sourceDirectory = join(userHome, ".sandyboxy");
    mkdirSync(sourceDirectory);
    writeFileSync(join(sourceDirectory, "config.json"), JSON.stringify({ default: "other", sandboxes: {
      selected: { root: "/synthetic/selected", config: { frontendGateway: { enabled: true }, keep: true } },
      other: { root: "/synthetic/other" },
    } }));
    const result = materializeProfileToolEnvironment(generatedHome, { ...emptyPolicy, sandyboxySandbox: "selected" }, { userHome });
    const target = join(generatedHome, ".sandyboxy", "config.json");
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ default: "selected", sandboxes: {
      selected: { root: "/synthetic/selected", config: { frontendGateway: { enabled: false }, keep: true } },
    } });
    expect(result.environment).toEqual({ HOME: generatedHome });
  });

  it("reuses the user Playwright cache and creates a stable session socket directory", () => {
    const { root, userHome, generatedHome } = fixture();
    const socketRoot = join(root, "sockets");
    const first = materializeProfileToolEnvironment(generatedHome, { ...emptyPolicy, browserRuntime: true }, { userHome, browserSocketRoot: socketRoot });
    const second = materializeProfileToolEnvironment(generatedHome, { ...emptyPolicy, browserRuntime: true }, { userHome, browserSocketRoot: socketRoot });
    expect(first.environment.PLAYWRIGHT_BROWSERS_PATH).toBe(join(userHome, "Library", "Caches", "ms-playwright"));
    expect(first.environment.AGENT_BROWSER_SOCKET_DIR).toBe(second.environment.AGENT_BROWSER_SOCKET_DIR);
    expect(first.environment.AGENT_BROWSER_SOCKET_DIR).toMatch(new RegExp(`^${socketRoot}/[0-9a-f]{12}$`));
  });
});

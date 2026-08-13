import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readme = readFileSync(resolve(import.meta.dirname, "../../README.md"), "utf8");
const gitignore = readFileSync(resolve(import.meta.dirname, "../../.gitignore"), "utf8");
const firstSection = readme.slice(0, readme.indexOf("\n## "));

describe("public README", () => {
  it("leads with durable channel semantics rather than agent RPC", () => {
    for (const value of ["agent-to-agent (A2A)", "request and response RPC", "membership", "recipients", "cursors", "durable events", "live terminal sessions", "Matrix-style channels"]) {
      expect(firstSection).toContain(value);
    }
  });

  it("uses the executable shellenv command and plain provider launches", () => {
    for (const value of [
      "rooms setup",
      "rooms provider discover",
      "rooms service install",
      "rooms channel create demo",
      "export ROOMS_CHANNEL_ID=demo",
      'eval "$(rooms shellenv)"',
      "| `claude` | `codex` |",
    ]) {
      expect(readme).toContain(value);
    }
    expect(readme).toContain("rooms shellenv status");
    expect(readme).not.toMatch(/rooms channel create demo --goal\b/);
  });

  it("starts the daemon before the first daemon-backed command", () => {
    const setup = readme.indexOf("rooms setup");
    const discover = readme.indexOf("rooms provider discover");
    const serviceInstall = readme.indexOf("rooms service install");
    const channelCreate = readme.indexOf("rooms channel create demo");

    expect(setup).toBeLessThan(discover);
    expect(discover).toBeLessThan(serviceInstall);
    expect(serviceInstall).toBeLessThan(channelCreate);
  });

  it("requires provider-visible round-trip proof", () => {
    expect(readme).toContain("The hello should render in Claude, and Claude's reply should render in Codex");
    expect(readme).toContain("A send receipt or a message\nhistory row alone");
  });

  it("keeps federation and distribution claims narrow", () => {
    expect(readme).toContain("not a commitment to include federation in the first\npublic release");
    expect(readme).toContain("This README demonstrates only the single-machine path");
    expect(readme).toContain("Wardroom uses the [Apache License 2.0](LICENSE)");
    expect(readme).toMatch(/no public package,\s+signed binary, or approved public distribution yet/);
  });

  it("keeps the positioning independent of the repository owner", () => {
    expect(firstSection).not.toContain("rcidaleassumpo");
    expect(readme).not.toMatch(/because (?:they are|it is) rooms/i);
  });

  it("ignores the extensionless Go build output", () => {
    expect(gitignore.split("\n")).toContain("roomsd/runtime-host-go/rooms-runtime-host");
  });
});

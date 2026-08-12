import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readme = readFileSync(resolve(import.meta.dirname, "../../README.md"), "utf8");
const gitignore = readFileSync(resolve(import.meta.dirname, "../../.gitignore"), "utf8");
const firstSection = readme.slice(0, readme.indexOf("\n## "));

describe("public README", () => {
  it("leads with durable channel semantics rather than agent RPC", () => {
    for (const value of ["agent-to-agent (A2A)", "request and response RPC", "membership", "recipients", "cursors", "durable\nevents", "live terminal sessions", "Matrix-style rooms"]) {
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

  it("states the federation, platform, distribution, and license scope", () => {
    expect(readme).toContain("Wardroom v0.2.1 is single-machine only");
    expect(readme).toContain("the public release binary disables it");
    expect(readme).toContain("brew install rcidaleassumpo/tap/wardroom");
    expect(readme).toContain("unsigned community build");
    expect(readme).toContain("Apple Silicon macOS release");
    expect(readme).toContain("`rooms mcp serve`");
    expect(readme).toContain("Wardroom is licensed under [Apache License 2.0](LICENSE)");
  });

  it("keeps the product positioning independent of its repository host", () => {
    expect(firstSection).not.toContain("rcidaleassumpo");
    expect(readme).not.toMatch(/because (?:they are|it is) rooms/i);
  });

  it("ignores the extensionless Go build output", () => {
    expect(gitignore.split("\n")).toContain("roomsd/runtime-host-go/rooms-runtime-host");
  });
});

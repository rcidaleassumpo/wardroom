import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");
const exporterPath = resolve(root, "scripts/export-public.mjs");

const contributing = read("CONTRIBUTING.md");
const security = read("SECURITY.md");
const exporter = existsSync(exporterPath) ? readFileSync(exporterPath, "utf8") : null;
const bug = read(".github/ISSUE_TEMPLATE/1-bug-report.yml");
const feature = read(".github/ISSUE_TEMPLATE/2-feature-request.yml");
const protocol = read(".github/ISSUE_TEMPLATE/3-protocol-design.yml");
const chooser = read(".github/ISSUE_TEMPLATE/config.yml");

describe("public contribution files", () => {
  it("gives a clean-checkout build path without touching installed Wardroom state", () => {
    for (const value of ["Node.js 22", "npm ci", "npm run typecheck", "npm test", "npm run build", "go test ./...", "go vet ./..."]) {
      expect(contributing).toContain(value);
    }
    expect(contributing).toContain("They do not install or\nrestart the per-user Wardroom service");
    expect(contributing).toContain("Never read or write an\n   installed `~/.rooms` state directory");
  });

  it("routes vulnerability detail privately and states the real trust boundary", () => {
    expect(security).toContain("https://github.com/rcidaleassumpo/wardroom/security");
    expect(security).toContain("Report a vulnerability");
    expect(security).toContain("Do not open a public issue with credentials");
    expect(security).toContain("does not protect against root");
    expect(security).toContain("It is not a sandbox");
    expect(security).toContain("omits federation and remote terminal");
  });

  it("ships structured bug, feature, and protocol forms in every export", () => {
    const paths = [
      ".github/ISSUE_TEMPLATE/1-bug-report.yml",
      ".github/ISSUE_TEMPLATE/2-feature-request.yml",
      ".github/ISSUE_TEMPLATE/3-protocol-design.yml",
      ".github/ISSUE_TEMPLATE/config.yml",
      ".github/workflows/release.yml",
      "roomsd/scripts/build-release.mjs",
      "roomsd/scripts/package-distributions.mjs",
    ];
    if (exporter !== null) for (const path of paths) expect(exporter).toContain(`\"${path}\"`);
    for (const form of [bug, feature, protocol]) {
      expect(form).toMatch(/^name: .+$/m);
      expect(form).toMatch(/^description: .+$/m);
      expect(form).toMatch(/^body:$/m);
    }
  });

  it("keeps public bug reports on disposable, redacted state", () => {
    expect(bug).toContain("temporary ROOMS_STATE_DIR");
    expect(bug).toContain("Never upload installed state");
    expect(bug).toContain("I did not attach real Wardroom state");
    expect(bug).toContain("removed secrets, real identities, private paths, host details, message data, and transcripts");
  });

  it("requires protocol proposals to define the non-composable semantics", () => {
    for (const id of ["authority", "concurrency", "ordering", "failures", "compatibility", "security", "tests"]) {
      expect(protocol).toContain(`id: ${id}`);
    }
    expect(protocol).toContain("winner and loser results");
    expect(protocol).toContain("protocol-version handling");
    expect(protocol).toContain("authorization, failure, compatibility, and restart cases");
  });

  it("offers private security reporting while preserving the detail-free fallback", () => {
    expect(chooser).toContain("blank_issues_enabled: true");
    expect(chooser).toContain("https://github.com/rcidaleassumpo/wardroom/security");
    expect(chooser).toContain("Do not put security details in a public issue");
    expect(security).toContain('open a public issue containing only the\nwords "private security contact requested"');
  });
});

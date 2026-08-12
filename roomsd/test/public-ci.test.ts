import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = resolve(import.meta.dirname, "../../.github/workflows/ci.yml");
const workflow = readFileSync(workflowPath, "utf8");
const releaseWorkflow = readFileSync(resolve(import.meta.dirname, "../../.github/workflows/release.yml"), "utf8");
const distributionScript = readFileSync(resolve(import.meta.dirname, "../scripts/package-distributions.mjs"), "utf8");
const releaseScript = readFileSync(resolve(import.meta.dirname, "../scripts/build-release.mjs"), "utf8");

describe("public pull-request CI", () => {
  it("runs fork code with a read-only token and no persisted checkout credential", () => {
    expect(workflow).toMatch(/^\s*pull_request:\s*$/m);
    expect(workflow).not.toMatch(/^\s*pull_request_target:\s*$/m);
    expect(workflow).toMatch(/^permissions:\n\s+contents: read$/m);
    const checkouts = workflow.match(/actions\/checkout@/g) ?? [];
    expect(workflow.match(/persist-credentials: false/g) ?? []).toHaveLength(checkouts.length);
  });

  it("publishes only from a version tag after local package proof", () => {
    expect(releaseWorkflow).toContain("tags:");
    expect(releaseWorkflow).not.toMatch(/^\s*pull_request(?:_target)?:\s*$/m);
    expect(releaseWorkflow).toContain("persist-credentials: false");
    expect(releaseWorkflow).toContain("npm run typecheck");
    expect(releaseWorkflow).toContain("npm test");
    expect(releaseWorkflow).toContain("package-distributions.mjs");
    expect(releaseWorkflow).toContain("npm install --global --prefix");
    expect(releaseWorkflow).toContain("--verify-tag --generate-notes");
    expect(releaseWorkflow).toContain("Publish unsigned community release");
    expect(releaseWorkflow).toContain("Unsigned Apple Silicon community build");
    expect(releaseWorkflow).toContain("ROOMS_RELEASE_FEDERATION: disabled");
    expect(releaseWorkflow).toContain("ROOMS_ALLOW_UNSTABLE_IDENTITY: '1'");
    expect(releaseScript).toContain('features: {');
    expect(releaseScript).toContain('federation: federationEnabled');
    expect(releaseWorkflow).not.toContain("npm publish");
  });

  it("publishes Wardroom while preserving the rooms executable", () => {
    expect(distributionScript).toContain('name: "wardroom"');
    expect(distributionScript).toContain('bin: { rooms: "./release/rooms" }');
    expect(distributionScript).toContain('class Wardroom < Formula');
    expect(distributionScript).toContain('version "${version}"');
    expect(distributionScript).toContain('Formula/wardroom.rb');
    expect(releaseWorkflow).toContain("wardroom-*.tgz");
    expect(releaseWorkflow).toContain("Wardroom ${GITHUB_REF_NAME#v}");
    expect(releaseScript).toContain('execArgv: ["--disable-warning=ExperimentalWarning"]');
  });

  it("pins every action to an immutable commit", () => {
    const uses = [...workflow.matchAll(/^\s*- uses: ([^@\s]+)@([^\s#]+)/gm)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, action, ref] of uses) {
      expect(action).toMatch(/^actions\/(checkout|setup-node|setup-go)$/);
      expect(ref).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("checks the supported source, host, and release surfaces", () => {
    expect(workflow).toContain("os: [ubuntu-24.04, macos-14]");
    expect(workflow).toContain("npm run typecheck");
    expect(workflow).toContain("npm test");
    expect(workflow).toContain("npm run build");
    expect(workflow).toContain("go test ./...");
    expect(workflow).toContain("go vet ./...");
    expect(workflow).toContain("GOOS: darwin");
    expect(workflow).toContain("GOARCH: arm64");
    expect(workflow).toContain("npm run build:release");
    expect(workflow).toContain("ROOMS_SIGNING_MODE: LOCAL_PROOF_ONLY");
    expect(workflow).toContain("Run the published quickstart against an isolated service");
    expect(workflow).toContain('"${task_rooms}" service install');
    expect(workflow).toContain('"${task_rooms}" channel create demo');
    expect(workflow).toContain('"${task_rooms}" service uninstall');
    expect(workflow).toContain("local\\.rooms\\.roomsd\\.state-[0-9a-f]{16}");
  });
});

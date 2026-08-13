import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = resolve(import.meta.dirname, "../../.github/workflows/ci.yml");
const workflow = readFileSync(workflowPath, "utf8");

describe("public pull-request CI", () => {
  it("runs fork code with a read-only token and no persisted checkout credential", () => {
    expect(workflow).toMatch(/^\s*pull_request:\s*$/m);
    expect(workflow).not.toMatch(/^\s*pull_request_target:\s*$/m);
    expect(workflow).toMatch(/^permissions:\n\s+contents: read$/m);
    const checkouts = workflow.match(/actions\/checkout@/g) ?? [];
    expect(workflow.match(/persist-credentials: false/g) ?? []).toHaveLength(checkouts.length);
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
    expect(workflow).toContain("Go runtime host (${{ matrix.os }})");
    expect(workflow).toMatch(/runtime-host-native:[\s\S]*os: \[ubuntu-24\.04, macos-14\]/);
    expect(workflow).toContain("npm run build:release");
    expect(workflow).toContain("ROOMS_SIGNING_MODE: LOCAL_PROOF_ONLY");
    expect(workflow).toContain("Run the published quickstart against an isolated service");
    expect(workflow).toContain('"${task_rooms}" service install');
    expect(workflow).toContain('"${task_rooms}" channel create demo');
    expect(workflow).toContain('"${task_rooms}" service uninstall');
    expect(workflow).toContain("local\\.rooms\\.roomsd\\.state-[0-9a-f]{16}");
  });
});

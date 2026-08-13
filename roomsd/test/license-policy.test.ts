// SPDX-License-Identifier: Apache-2.0
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const spdx = "// SPDX-License-Identifier: Apache-2.0";

function filesUnder(path: string, extensions: ReadonlySet<string>): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) return filesUnder(child, extensions);
    return entry.isFile() && extensions.has(extname(entry.name)) ? [child] : [];
  });
}

describe("Rooms Apache-2.0 policy", () => {
  it("keeps the canonical license and notice in the public export", () => {
    expect(readFileSync(resolve(repositoryRoot, "LICENSE"), "utf8")).toContain("Apache License\n                           Version 2.0");
    expect(readFileSync(resolve(repositoryRoot, "NOTICE"), "utf8")).toBe("Rooms\nCopyright 2026 Renan Cidale Assumpcao\n");

    const exporterPath = resolve(repositoryRoot, "scripts/export-public.mjs");
    if (existsSync(exporterPath)) {
      const exporter = readFileSync(exporterPath, "utf8");
      expect(exporter).toContain('"LICENSE"');
      expect(exporter).toContain('"NOTICE"');
    } else {
      expect(readFileSync(resolve(repositoryRoot, "roomsd/LICENSE"), "utf8")).toContain("Apache License\n                           Version 2.0");
      expect(readFileSync(resolve(repositoryRoot, "roomsd/NOTICE"), "utf8")).toBe("Rooms\nCopyright 2026 Renan Cidale Assumpcao\n");
      const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, "PUBLIC_EXPORT_MANIFEST.json"), "utf8"));
      const paths = manifest.files.map((file: { path: string }) => file.path);
      expect(paths).toEqual(expect.arrayContaining(["LICENSE", "NOTICE", "roomsd/LICENSE", "roomsd/NOTICE"]));
    }
  });

  it("puts an SPDX header on every shipped implementation source", () => {
    const sources = [
      ...filesUnder(resolve(repositoryRoot, "roomsd/src"), new Set([".ts"])),
      ...filesUnder(resolve(repositoryRoot, "roomsd/runtime-host-go"), new Set([".go"])),
      ...filesUnder(resolve(repositoryRoot, "roomsd/proto"), new Set([".proto"])),
    ];
    expect(sources.length).toBeGreaterThan(100);
    for (const source of sources) {
      const lines = readFileSync(source, "utf8").split("\n", 2);
      const headerLine = lines[0].startsWith("#!") ? lines[1] : lines[0];
      expect(headerLine, source).toBe(spdx);
    }
  });
});

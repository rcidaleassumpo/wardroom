#!/usr/bin/env node

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = parse(process.argv.slice(2));
const releaseDir = resolve(args.releaseDir);
const outputDir = resolve(args.output);
const manifest = JSON.parse(readFileSync(join(releaseDir, "manifest.json"), "utf8"));
const releaseFiles = ["rooms", "roomsd", "rooms-runtime-host", "manifest.json"];

if (manifest.product !== "rooms" || manifest.architecture !== "darwin-arm64") fail("distribution input must be a verified Rooms darwin-arm64 release");
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) fail(`release version is not valid semver: ${manifest.version}`);
for (const name of releaseFiles) if (!existsSync(join(releaseDir, name))) fail(`release file is missing: ${name}`);
for (const name of releaseFiles.slice(0, 3)) {
  const expected = manifest.files?.[name]?.sha256;
  const actual = sha256(join(releaseDir, name));
  if (!expected || expected !== actual) fail(`release checksum mismatch: ${name}`);
}

mkdirSync(outputDir, { recursive: true });
const archiveName = `wardroom-${manifest.version}-darwin-arm64.tar.gz`;
const archivePath = join(outputDir, archiveName);
execFileSync("tar", ["-czf", archivePath, "-C", releaseDir, ...releaseFiles]);
const archiveSha256 = sha256(archivePath);

const npmRoot = join(outputDir, "npm-package");
mkdirSync(npmRoot, { recursive: true });
const npmRelease = join(npmRoot, "release");
mkdirSync(npmRelease, { recursive: true });
for (const name of releaseFiles) cpSync(join(releaseDir, name), join(npmRelease, name));
for (const name of ["LICENSE", "NOTICE"]) cpSync(join(root, name), join(npmRoot, name));
writeFileSync(join(npmRoot, "README.md"), npmReadme(manifest.version));
writeFileSync(join(npmRoot, "package.json"), `${JSON.stringify({
  name: "wardroom",
  version: manifest.version,
  description: "Wardroom: local-first durable channels and live message delivery for AI agent sessions",
  license: "Apache-2.0",
  repository: { type: "git", url: "git+https://github.com/rcidaleassumpo/wardroom.git" },
  homepage: "https://github.com/rcidaleassumpo/wardroom#readme",
  bugs: { url: "https://github.com/rcidaleassumpo/wardroom/issues" },
  os: ["darwin"],
  cpu: ["arm64"],
  bin: { rooms: "./release/rooms" },
  files: ["release"],
}, null, 2)}\n`);
const packed = execFileSync("npm", ["pack", npmRoot, "--pack-destination", outputDir], { encoding: "utf8" }).trim().split("\n").at(-1);
if (!packed) fail("npm pack did not return an archive name");

const formulaDir = join(outputDir, "homebrew-tap", "Formula");
mkdirSync(formulaDir, { recursive: true });
writeFileSync(join(formulaDir, "wardroom.rb"), formula(manifest.version, archiveName, archiveSha256));
writeFileSync(join(outputDir, "distribution-manifest.json"), `${JSON.stringify({
  schemaVersion: 1,
  version: manifest.version,
  sourceRelease: releaseDir,
  releaseArchive: { file: archiveName, sha256: archiveSha256 },
  npmPackage: { file: basename(packed), sha256: sha256(join(outputDir, basename(packed))) },
  homebrewFormula: { file: "homebrew-tap/Formula/wardroom.rb" },
}, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ output: outputDir, version: manifest.version, archive: archiveName, npm: basename(packed), formula: "homebrew-tap/Formula/wardroom.rb" }, null, 2)}\n`);

function parse(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--release-dir") result.releaseDir = values[++index];
    else if (values[index] === "--output") result.output = values[++index];
    else fail(`unknown argument: ${values[index]}`);
  }
  if (!result.releaseDir || !result.output) fail("usage: package-distributions.mjs --release-dir <path> --output <path>");
  return result;
}

function npmReadme(version) {
  return `# Wardroom ${version}\n\nThis package contains the complete Wardroom release for Apple Silicon macOS. The installed command is \`rooms\`.\n\n\`\`\`sh\nnpm install --global wardroom\nrooms install\nrooms setup\nrooms provider discover\nrooms service install\n\`\`\`\n\nSource, documentation, and security policy: https://github.com/rcidaleassumpo/wardroom\n`;
}

function formula(version, archiveName, checksum) {
  return `class Wardroom < Formula\n  desc "Local-first durable channels for AI agent sessions"\n  homepage "https://github.com/rcidaleassumpo/wardroom"\n  url "https://github.com/rcidaleassumpo/wardroom/releases/download/v${version}/${archiveName}"\n  version "${version}"\n  sha256 "${checksum}"\n  license "Apache-2.0"\n\n  depends_on arch: :arm64\n  depends_on :macos\n\n  def install\n    libexec.install "rooms", "roomsd", "rooms-runtime-host", "manifest.json"\n    bin.install_symlink libexec/"rooms"\n  end\n\n  def caveats\n    <<~EOS\n      Finish the per-user setup:\n        rooms install\n        rooms setup\n        rooms provider discover\n        rooms service install\n    EOS\n  end\n\n  test do\n    assert_match "rooms ${version}", shell_output("#{bin}/rooms --version")\n  end\nend\n`;
}

function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function fail(message) { throw new Error(message); }

#!/usr/bin/env node

import { build } from "esbuild";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import releaseContract from "../release-contract.json" with { type: "json" };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.env.ROOMS_RELEASE_VERSION ?? JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const outputRoot = resolve(process.env.ROOMS_RELEASE_OUT ?? join(root, "release", version));
const signingIdentity = process.env.ROOMS_SIGNING_IDENTITY ?? "-";
const signingMode = process.env.ROOMS_SIGNING_MODE ?? "LOCAL_PROOF_ONLY";
const nodeTarget = `node${process.versions.node.split(".")[0]}`;
const postject = join(root, "node_modules", ".bin", "postject");
const seaFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
if (platform !== "darwin" || arch !== "arm64") throw new Error("release builder requires native Apple Silicon macOS");
if (!readFileSync(process.execPath).includes(Buffer.from(`${seaFuse}:0`))) throw new Error("this Node executable cannot build Single Executable Applications; use an official SEA-enabled Node release builder");
if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(version)) throw new Error("invalid release version");
if (signingMode !== "LOCAL_PROOF_ONLY" && signingMode !== "DEVELOPER_ID_NOTARIZED") throw new Error("ROOMS_SIGNING_MODE must be LOCAL_PROOF_ONLY or DEVELOPER_ID_NOTARIZED");
if (signingMode === "DEVELOPER_ID_NOTARIZED" && signingIdentity === "-") throw new Error("a Developer ID identity is required for a notarized release");

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
const staging = join(outputRoot, `.build-${randomUUID()}`);
mkdirSync(staging, { recursive: true, mode: 0o700 });

const bundles = {
  rooms: join(staging, "rooms-entry.cjs"),
  roomsd: join(staging, "roomsd-entry.cjs"),
};
// Bundled entrypoints cannot follow the federation loader's dynamic import;
// a tree that ships src/federation uses the registering entries, and a
// single-machine tree falls back to the core entries.
const federationEnabled = existsSync(join(root, "src/federation/standalone-cli.ts"));
const cliEntry = federationEnabled ? "src/federation/standalone-cli.ts" : "src/cli/standalone.ts";
const daemonEntry = federationEnabled ? "src/federation/standalone-daemon.ts" : "src/runtime/native/standalone.ts";
await build({ entryPoints: [join(root, cliEntry)], bundle: true, platform: "node", format: "cjs", target: nodeTarget, outfile: bundles.rooms, external: ["node:*"], logLevel: "silent" });
await build({ entryPoints: [join(root, daemonEntry)], bundle: true, platform: "node", format: "cjs", target: nodeTarget, outfile: bundles.roomsd, external: ["node:*"], logLevel: "silent" });

const binaryPaths = { rooms: join(outputRoot, "rooms"), roomsd: join(outputRoot, "roomsd") };
for (const [name, entry] of Object.entries(bundles)) {
  const config = join(staging, `${name}-sea.json`);
  const blob = join(staging, `${name}-sea.blob`);
  writeFileSync(config, JSON.stringify({
    main: entry.slice(staging.length + 1),
    output: blob.slice(staging.length + 1),
    disableExperimentalSEAWarning: true,
    useCodeCache: true,
    execArgv: ["--disable-warning=ExperimentalWarning"],
    execArgvExtension: "env",
  }, null, 2));
  execFileSync(process.execPath, ["--experimental-sea-config", config.slice(staging.length + 1)], { cwd: staging, stdio: "inherit" });
  copyFileSync(process.execPath, binaryPaths[name]);
  chmodSync(binaryPaths[name], 0o755);
  execFileSync("codesign", ["--remove-signature", binaryPaths[name]], { stdio: "inherit" });
  execFileSync(postject, [binaryPaths[name], "NODE_SEA_BLOB", blob, "--sentinel-fuse", seaFuse, "--macho-segment-name", "NODE_SEA"], { stdio: "inherit" });
  execFileSync("codesign", ["--force", "--sign", signingIdentity, "--timestamp=none", binaryPaths[name]], { stdio: "inherit" });
}

const goRoot = join(root, "runtime-host-go");
execFileSync(join(goRoot, "build.sh"), [], { cwd: goRoot, env: { ...process.env, ROOMS_GO_HOST_OUT: staging, GOOS: "darwin", GOARCH: "arm64", CGO_ENABLED: "0" }, stdio: "inherit" });
execFileSync("cp", [join(staging, "rooms-runtime-host-darwin-arm64"), join(outputRoot, "rooms-runtime-host")], { stdio: "inherit" });
chmodSync(join(outputRoot, "rooms-runtime-host"), 0o755);
execFileSync("codesign", ["--force", "--sign", signingIdentity, "--timestamp=none", join(outputRoot, "rooms-runtime-host")], { stdio: "inherit" });

const files = {};
for (const name of ["rooms", "roomsd", "rooms-runtime-host"]) files[name] = { sha256: sha256(join(outputRoot, name)), mode: "0755" };
const signature = signatureDetails(binaryPaths.rooms);
const manifest = {
  schemaVersion: 1,
  product: "rooms",
  version,
  architecture: "darwin-arm64",
  minimumMacOS: process.env.ROOMS_MINIMUM_MACOS ?? "13.0",
  protocolVersion: releaseContract.protocolVersion,
  storeSchemaVersion: releaseContract.storeSchemaVersion,
  features: {
    federation: federationEnabled,
  },
  signing: {
    mode: signingMode,
    identity: signingIdentity === "-" ? null : signingIdentity,
    teamIdentifier: signature.teamIdentifier,
    designatedRequirement: signature.designatedRequirement,
    notarized: signingMode === "DEVELOPER_ID_NOTARIZED",
  },
  files,
};
writeFileSync(join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
rmSync(staging, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ releaseDirectory: outputRoot, version, signing: signingMode, files }, null, 2)}\n`);

function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function signatureDetails(path) {
  const verbose = spawnSync("codesign", ["-dvvv", path], { encoding: "utf8" });
  const requirements = spawnSync("codesign", ["-d", "-r-", path], { encoding: "utf8" });
  if (verbose.status !== 0 || requirements.status !== 0) throw new Error(`cannot inspect code signature: ${path}`);
  return { teamIdentifier: /^TeamIdentifier=(.+)$/m.exec(`${verbose.stdout}\n${verbose.stderr}`)?.[1]?.trim() ?? null, designatedRequirement: /^designated => (.+)$/m.exec(`${requirements.stdout}\n${requirements.stderr}`)?.[1]?.trim() ?? null };
}

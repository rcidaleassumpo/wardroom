import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:process";
import { join, relative, resolve } from "node:path";
import { assertAbsolutePath, assertSafeVersion, isPresent, roomsPaths, type RoomsPaths } from "./paths.js";
import releaseContract from "../../release-contract.json" with { type: "json" };
import { storeSchemaVersion } from "../storage/migrations.js";

export { DEFAULT_ROOMS_SERVICE_LABEL as RELEASE_SERVICE_LABEL } from "./paths.js";

export const RELEASE_SCHEMA_VERSION = 1;
export const RELEASE_PROTOCOL_VERSION = releaseContract.protocolVersion;
export const RELEASE_STORE_SCHEMA_VERSION = releaseContract.storeSchemaVersion;
export const RELEASE_ARCHITECTURE = "darwin-arm64";
export const RELEASE_FILES = ["rooms", "roomsd", "rooms-runtime-host"] as const;
export type ReleaseSigningMode = "LOCAL_PROOF_ONLY" | "DEVELOPER_ID_NOTARIZED";
export type ReleaseManifest = Readonly<{
  schemaVersion: 1;
  product: "rooms";
  version: string;
  architecture: typeof RELEASE_ARCHITECTURE;
  minimumMacOS: string;
  protocolVersion: number;
  storeSchemaVersion: number;
  features?: Readonly<{
    federation: boolean;
  }>;
  signing: Readonly<{
    mode: ReleaseSigningMode;
    identity: string | null;
    teamIdentifier: string | null;
    designatedRequirement: string | null;
    notarized: boolean;
  }>;
  files: Readonly<Record<string, Readonly<{ sha256: string; mode: "0755" }>>>;
}>;

export type VerifiedRelease = Readonly<{ directory: string; manifest: ReleaseManifest }>;
export type InstalledReleaseContract = Readonly<{ version: string; storeSchemaVersion: number }>;

export function readReleaseManifest(directoryInput: string): ReleaseManifest {
  const directory = assertAbsolutePath(directoryInput, "release directory");
  const manifestPath = join(directory, "manifest.json");
  const value: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Rooms release manifest must be an object");
  const manifest = value as Partial<ReleaseManifest>;
  if (manifest.schemaVersion !== RELEASE_SCHEMA_VERSION || manifest.product !== "rooms") throw new Error("Rooms release manifest schema or product is invalid");
  if (typeof manifest.version !== "string") throw new Error("Rooms release manifest version is invalid");
  assertSafeVersion(manifest.version);
  if (manifest.architecture !== RELEASE_ARCHITECTURE) throw new Error(`Rooms release architecture must be ${RELEASE_ARCHITECTURE}`);
  // Deliberately a sanity check, not a match against this binary's own contract:
  // requiring equality made a release that advances the store schema or protocol
  // impossible to install with the binary being replaced. Compatibility is decided
  // against the live store in assertReleaseUpgradeCompatible below.
  if (!Number.isSafeInteger(manifest.protocolVersion) || Number(manifest.protocolVersion) < 1) throw new Error("Rooms release protocol version is invalid");
  if (!Number.isSafeInteger(manifest.storeSchemaVersion) || Number(manifest.storeSchemaVersion) < 1) throw new Error("Rooms release store schema version is invalid");
  if (manifest.features !== undefined && (
    !manifest.features ||
    typeof manifest.features !== "object" ||
    typeof manifest.features.federation !== "boolean" ||
    Object.keys(manifest.features).some(name => name !== "federation")
  )) throw new Error("Rooms release feature metadata is invalid");
  if (!manifest.signing || !["LOCAL_PROOF_ONLY", "DEVELOPER_ID_NOTARIZED"].includes(manifest.signing.mode)) throw new Error("Rooms release signing mode is invalid");
  if (manifest.signing.notarized !== (manifest.signing.mode === "DEVELOPER_ID_NOTARIZED")) throw new Error("Rooms release notarization claim does not match signing mode");
  if (!manifest.files || typeof manifest.files !== "object") throw new Error("Rooms release file checksums are missing");
  for (const name of RELEASE_FILES) {
    const file = (manifest.files as Record<string, { sha256?: unknown; mode?: unknown }>)[name];
    if (!file || typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256) || file.mode !== "0755") throw new Error(`Rooms release checksum entry is invalid: ${name}`);
  }
  if (Object.keys(manifest.files).some(name => !(RELEASE_FILES as readonly string[]).includes(name))) throw new Error("Rooms release contains an unexpected file entry");
  return manifest as ReleaseManifest;
}

export function verifyRelease(directoryInput: string, options: { allowQuarantine?: boolean } = {}): VerifiedRelease {
  const directory = assertAbsolutePath(directoryInput, "release directory");
  const manifest = readReleaseManifest(directory);
  const allowedEntries = new Set(["manifest.json", ...RELEASE_FILES]);
  for (const entry of readdirSync(directory)) if (!allowedEntries.has(entry)) throw new Error(`Rooms release contains an unexpected artifact: ${entry}`);
  if (manifest.signing.mode === "LOCAL_PROOF_ONLY" && hasQuarantine(directory) && !options.allowQuarantine) {
    throw new Error("Rooms local-proof release is quarantined; transfer it without quarantine or use a notarized release");
  }
  for (const name of RELEASE_FILES) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Rooms release binary must be a regular file: ${name}`);
    if ((stat.mode & 0o777) !== 0o755) throw new Error(`Rooms release binary mode must be 755: ${name}`);
    const digest = sha256(path);
    if (digest !== manifest.files[name].sha256) throw new Error(`Rooms release checksum mismatch: ${name}`);
    verifyCodeSignature(path, manifest.signing.mode, manifest.signing.teamIdentifier, manifest.signing.designatedRequirement);
  }
  if (platform !== "darwin" || arch !== "arm64") throw new Error("Rooms provisioning targets native Apple Silicon macOS (darwin-arm64)");
  return { directory, manifest };
}

/**
 * A release may carry the current store schema or a newer one, because the daemon
 * migrates forward on start. A release older than the store cannot read it at all,
 * so refuse that here with the remedy rather than letting the daemon start and exit.
 */
export function assertReleaseUpgradeCompatible(manifest: ReleaseManifest, storePath: string): void {
  if (!existsSync(storePath)) return;
  let storeSchema: number;
  try { storeSchema = storeSchemaVersion(storePath); } catch { return; }
  if (manifest.storeSchemaVersion < storeSchema) {
    throw new Error(
      `Rooms release ${manifest.version} supports store schema ${manifest.storeSchemaVersion}, but this machine's store is already at schema ${storeSchema}; installing it would leave roomsd unable to read the store. Install a release supporting schema ${storeSchema} or later, or restore a store backup taken before the schema advanced.`,
    );
  }
}

export function installRelease(releaseDirectory: string, options: { stateDir?: string; installRoot?: string } = {}): VerifiedRelease {
  const verified = verifyRelease(releaseDirectory);
  const paths = roomsPaths(options.stateDir, options.installRoot);
  assertReleaseUpgradeCompatible(verified.manifest, paths.storePath);
  ensureDirectory(paths.releaseRoot, 0o700);
  const destination = join(paths.releaseRoot, verified.manifest.version);
  if (isPresent(destination)) {
    const existing = verifyRelease(destination);
    if (existing.manifest.version !== verified.manifest.version) throw new Error("Rooms release destination version collision");
  } else {
    const temporary = join(paths.releaseRoot, `.staging-${verified.manifest.version}-${randomUUID()}`);
    mkdirSync(temporary, { mode: 0o700 });
    try {
      for (const name of [...RELEASE_FILES, "manifest.json"]) {
        const source = join(verified.directory, name);
        const target = join(temporary, name);
        if (name === "manifest.json") writeFileSync(target, readFileSync(source), { mode: 0o600 });
        else { cpSync(source, target); chmodSync(target, 0o755); }
      }
      verifyRelease(temporary);
      renameSync(temporary, destination);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* directory cleanup is intentionally conservative */ }
      throw error;
    }
  }
  const installed = verifyRelease(destination);
  atomicSwitch(paths.currentLink, destination);
  ensureDirectory(paths.binDir, 0o700);
  atomicSymlink(paths.roomsLink, paths.currentLink + "/rooms");
  return installed;
}

export function verifyCurrentRelease(options: { stateDir?: string; installRoot?: string } = {}): VerifiedRelease {
  const paths = roomsPaths(options.stateDir, options.installRoot);
  if (!isSymlinkToDirectory(paths.currentLink)) throw new Error(`Rooms current release is not an installed symlink: ${paths.currentLink}`);
  return verifyRelease(realpathSync(paths.currentLink));
}

/** Read only the installed release values needed to diagnose an older daemon. */
export function readInstalledReleaseContract(options: { stateDir?: string; installRoot?: string } = {}): InstalledReleaseContract {
  const paths = roomsPaths(options.stateDir, options.installRoot);
  if (!isSymlinkToDirectory(paths.currentLink)) throw new Error(`Rooms current release is not an installed symlink: ${paths.currentLink}`);
  const directory = realpathSync(paths.currentLink);
  const releaseRoot = realpathSync(paths.releaseRoot);
  const relativeDirectory = relative(releaseRoot, directory);
  if (relativeDirectory.startsWith("..") || resolve(releaseRoot, relativeDirectory) !== directory) throw new Error("Rooms current release points outside the installed release root");
  const value: unknown = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Rooms installed release manifest must be an object");
  const manifest = value as { product?: unknown; version?: unknown; storeSchemaVersion?: unknown };
  if (manifest.product !== "rooms" || typeof manifest.version !== "string" || !Number.isSafeInteger(manifest.storeSchemaVersion) || Number(manifest.storeSchemaVersion) < 1) {
    throw new Error("Rooms installed release manifest has no valid store schema version");
  }
  assertSafeVersion(manifest.version);
  return { version: manifest.version, storeSchemaVersion: Number(manifest.storeSchemaVersion) };
}

export function switchToRelease(version: string, options: { stateDir?: string; installRoot?: string } = {}): VerifiedRelease {
  const paths = roomsPaths(options.stateDir, options.installRoot);
  const safeVersion = assertSafeVersion(version);
  const directory = join(paths.releaseRoot, safeVersion);
  const verified = verifyRelease(directory);
  atomicSwitch(paths.currentLink, directory);
  atomicSymlink(paths.roomsLink, paths.currentLink + "/rooms");
  return verified;
}

export function releasePaths(options: { stateDir?: string; installRoot?: string } = {}): RoomsPaths { return roomsPaths(options.stateDir, options.installRoot); }

function atomicSwitch(link: string, target: string): void {
  mkdirSync(resolve(link, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${link}.tmp-${randomUUID()}`;
  symlinkSync(target, temporary, "dir");
  renameSync(temporary, link);
}

function atomicSymlink(link: string, target: string): void {
  const temporary = `${link}.tmp-${randomUUID()}`;
  try { symlinkSync(target, temporary); renameSync(temporary, link); }
  catch (error) { try { unlinkSync(temporary); } catch { /* preserve the existing link */ } throw error; }
}

function ensureDirectory(path: string, mode: number): void { mkdirSync(path, { recursive: true, mode }); chmodSync(path, mode); }
function sha256(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

function verifyCodeSignature(path: string, mode: ReleaseSigningMode, teamIdentifier: string | null, designatedRequirement: string | null): void {
  try { execFileSync("codesign", ["--verify", "--strict", "--verbose=2", path], { stdio: "pipe" }); }
  catch { throw new Error(`Rooms release signature verification failed: ${path}`); }
  if (mode === "DEVELOPER_ID_NOTARIZED") {
    try { execFileSync("spctl", ["--assess", "--type", "execute", "--verbose=2", path], { stdio: "pipe" }); }
    catch { throw new Error(`Rooms notarized release assessment failed: ${path}`); }
  }
  const details = signatureDetails(path);
  if (teamIdentifier && details.teamIdentifier !== teamIdentifier) throw new Error(`Rooms release TeamIdentifier mismatch: ${path}`);
  if (designatedRequirement && details.designatedRequirement !== designatedRequirement) throw new Error(`Rooms release designated requirement mismatch: ${path}`);
}

function signatureDetails(path: string): { teamIdentifier: string | null; designatedRequirement: string | null } {
  const verbose = spawnSync("codesign", ["-dvvv", path], { encoding: "utf8" });
  const requirements = spawnSync("codesign", ["-d", "-r-", path], { encoding: "utf8" });
  if (verbose.status !== 0 || requirements.status !== 0) throw new Error(`cannot inspect code signature: ${path}`);
  return { teamIdentifier: /^TeamIdentifier=(.+)$/m.exec(`${verbose.stdout}\n${verbose.stderr}`)?.[1]?.trim() ?? null, designatedRequirement: /^designated => (.+)$/m.exec(`${requirements.stdout}\n${requirements.stderr}`)?.[1]?.trim() ?? null };
}

function hasQuarantine(path: string): boolean {
  try { execFileSync("xattr", ["-p", "com.apple.quarantine", path], { stdio: "pipe" }); return true; }
  catch { return false; }
}

function isSymlinkToDirectory(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink() && statSync(path).isDirectory(); } catch { return false; }
}

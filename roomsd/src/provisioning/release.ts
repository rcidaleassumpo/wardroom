// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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
/**
 * One macOS code identity per executable, fixed for the life of the product.
 * macOS keys App Management, Full Disk Access and Automation on the designated
 * requirement, so an identifier that moves with the build makes every installed
 * release a different program and asks the operator to grant access again.
 */
export const RELEASE_CODE_IDENTIFIERS: Readonly<Record<string, string>> = releaseContract.codeIdentifiers;
export type ReleaseSigningMode = "LOCAL_PROOF_ONLY" | "DEVELOPER_ID_NOTARIZED";
export type ReleaseManifest = Readonly<{
  schemaVersion: 1;
  product: "rooms";
  version: string;
  architecture: typeof RELEASE_ARCHITECTURE;
  minimumMacOS: string;
  protocolVersion: number;
  storeSchemaVersion: number;
  signing: Readonly<{
    mode: ReleaseSigningMode;
    identity: string | null;
    teamIdentifier: string | null;
    /** Legacy single requirement, kept for releases built before per-binary identity. */
    designatedRequirement: string | null;
    notarized: boolean;
    /** Per-binary code identity, absent on releases built before this contract. */
    identifiers?: Readonly<Record<string, string>>;
    designatedRequirements?: Readonly<Record<string, string>>;
    /** True only when every binary carries an identifier-anchored requirement. */
    stableIdentity?: boolean;
  }>;
  files: Readonly<Record<string, Readonly<{ sha256: string; mode: "0755" }>>>;
}>;

export type VerifiedRelease = Readonly<{ directory: string; manifest: ReleaseManifest }>;
export type InstalledReleaseContract = Readonly<{ version: string; storeSchemaVersion: number }>;
export type ReleasePruneResult = Readonly<{ removed: readonly string[]; retained: readonly string[]; skipped: readonly string[] }>;
export type ReleasePruneCandidate = Readonly<{ name: string; manifest: ReleaseManifest; modified: number }>;

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
  if (!manifest.signing || !["LOCAL_PROOF_ONLY", "DEVELOPER_ID_NOTARIZED"].includes(manifest.signing.mode)) throw new Error("Rooms release signing mode is invalid");
  if (manifest.signing.notarized !== (manifest.signing.mode === "DEVELOPER_ID_NOTARIZED")) throw new Error("Rooms release notarization claim does not match signing mode");
  if (!manifest.files || typeof manifest.files !== "object") throw new Error("Rooms release file checksums are missing");
  for (const name of RELEASE_FILES) {
    const file = (manifest.files as Record<string, { sha256?: unknown; mode?: unknown }>)[name];
    if (!file || typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256) || file.mode !== "0755") throw new Error(`Rooms release checksum entry is invalid: ${name}`);
  }
  if (Object.keys(manifest.files).some(name => !(RELEASE_FILES as readonly string[]).includes(name))) throw new Error("Rooms release contains an unexpected file entry");
  assertManifestCodeIdentity(manifest.signing);
  return manifest as ReleaseManifest;
}

/**
 * Releases built before per-binary identity carry none of these fields and stay
 * installable. A release that does claim them must claim this product's own
 * identifiers, because a release naming a different identity for `roomsd` is the
 * duplicate-App-Management defect arriving in manifest form.
 */
function assertManifestCodeIdentity(signing: ReleaseManifest["signing"]): void {
  const { identifiers, designatedRequirements, stableIdentity } = signing;
  if (identifiers === undefined && designatedRequirements === undefined && stableIdentity === undefined) return;
  if (!identifiers || typeof identifiers !== "object" || Array.isArray(identifiers)) throw new Error("Rooms release code identifiers are invalid");
  if (!designatedRequirements || typeof designatedRequirements !== "object" || Array.isArray(designatedRequirements)) throw new Error("Rooms release designated requirements are invalid");
  if (typeof stableIdentity !== "boolean") throw new Error("Rooms release stable identity claim is invalid");
  for (const name of RELEASE_FILES) {
    const expected = RELEASE_CODE_IDENTIFIERS[name];
    if (identifiers[name] !== expected) throw new Error(`Rooms release code identifier for ${name} must be ${expected}`);
    if (typeof designatedRequirements[name] !== "string" || !designatedRequirements[name].trim()) throw new Error(`Rooms release designated requirement is missing for ${name}`);
  }
  for (const name of Object.keys(identifiers)) if (!(RELEASE_FILES as readonly string[]).includes(name)) throw new Error(`Rooms release code identifier names an unexpected binary: ${name}`);
  if (stableIdentity !== RELEASE_FILES.every(name => isStableCodeIdentity(designatedRequirements[name], RELEASE_CODE_IDENTIFIERS[name]))) {
    throw new Error("Rooms release stable identity claim does not match its designated requirements");
  }
}

/**
 * An ad-hoc signature has no designated requirement of its own, so `codesign`
 * reports the implicit `cdhash H"…"` of that exact build. Only an
 * identifier-anchored requirement survives a rebuild, and only that keeps one
 * macOS authorization across installed releases.
 */
export function requirementIdentifier(requirement: string): string | null {
  return /^identifier\s+("?)([^\s"]+)\1(?:\s+and\s[\s\S]+)?$/.exec(requirement.trim())?.[2] ?? null;
}

export function isStableCodeIdentity(requirement: string | null | undefined, expectedIdentifier: string): boolean {
  return typeof requirement === "string" && requirementIdentifier(requirement) === expectedIdentifier;
}

/**
 * macOS keys App Management and the other TCC grants on the designated
 * requirement, so a release that changes it is a different program to the
 * system: the operator is asked to grant access again and the old grant is
 * stranded in System Settings. Refuse the swap instead of producing that.
 */
export function assertReleaseIdentityUnchanged(installed: ReleaseManifest, incoming: ReleaseManifest): void {
  const before = installed.signing.designatedRequirements;
  const after = incoming.signing.designatedRequirements;
  if (!before || !after) return;
  const changed = RELEASE_FILES.filter(name => before[name] !== after[name]);
  if (!changed.length) return;
  const adHoc = !incoming.signing.stableIdentity || !installed.signing.stableIdentity;
  throw new Error(
    `Rooms release ${incoming.version} does not carry the macOS code identity of the installed release ${installed.version} (${changed.join(", ")}); installing it would make macOS treat Rooms as a new program and ask for App Management again, leaving the old grant stranded in System Settings. ` +
    (adHoc
      ? "At least one of these releases is ad-hoc signed, which gives every build its own identity: rebuild with ROOMS_SIGNING_IDENTITY set to a code-signing certificate."
      : "If this is a deliberate signing-certificate change, install it with --allow-identity-change and re-grant App Management once."),
  );
}

export function hasSameReleaseIdentity(left: ReleaseManifest, right: ReleaseManifest): boolean {
  const before = left.signing.designatedRequirements;
  const after = right.signing.designatedRequirements;
  return left.signing.stableIdentity === true && right.signing.stableIdentity === true &&
    before !== undefined && after !== undefined && RELEASE_FILES.every(name => before[name] === after[name]);
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
    verifyCodeSignature(path, name, manifest);
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

export function installRelease(releaseDirectory: string, options: { stateDir?: string; installRoot?: string; allowIdentityChange?: boolean } = {}): VerifiedRelease {
  const verified = verifyRelease(releaseDirectory);
  const paths = roomsPaths(options.stateDir, options.installRoot);
  assertReleaseUpgradeCompatible(verified.manifest, paths.storePath);
  if (!options.allowIdentityChange) {
    const current = currentReleaseManifest(paths);
    if (current) assertReleaseIdentityUnchanged(current, verified.manifest);
  }
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

/**
 * Keep the current release and one verified rollback release with the same
 * stable macOS code identity. Invalid entries and symlinks are never removed.
 * A legacy or ad-hoc current release disables pruning because it cannot prove
 * that its rollback candidate represents the same program to macOS.
 */
export function pruneOldReleases(options: { stateDir?: string; installRoot?: string } = {}): ReleasePruneResult {
  const paths = roomsPaths(options.stateDir, options.installRoot);
  const current = verifyCurrentRelease(paths);
  const retained = [current.manifest.version];
  const removed: string[] = [];
  const skipped: string[] = [];
  if (current.manifest.signing.stableIdentity !== true || !current.manifest.signing.designatedRequirements) {
    return { removed, retained, skipped: existingReleaseNames(paths).filter(name => name !== current.manifest.version) };
  }

  const root = realpathSync(paths.releaseRoot);
  const candidates: Array<ReleasePruneCandidate & { directory: string }> = [];
  for (const name of existingReleaseNames(paths)) {
    if (name === current.manifest.version) continue;
    const directory = join(root, name);
    try {
      const metadata = lstatSync(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(directory) !== directory) throw new Error("unsafe release entry");
      const release = verifyRelease(directory);
      candidates.push({ name, directory, manifest: release.manifest, modified: metadata.mtimeMs });
    } catch {
      skipped.push(name);
    }
  }
  const plan = planReleasePruning(current.manifest, candidates);
  retained.push(...plan.retained);
  for (const candidate of candidates.filter(item => plan.removed.includes(item.name))) {
    try {
      const metadata = lstatSync(candidate.directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(candidate.directory) !== candidate.directory) throw new Error("release entry changed during pruning");
      rmSync(candidate.directory, { recursive: true });
      removed.push(candidate.name);
    } catch {
      skipped.push(candidate.name);
    }
  }
  return { removed, retained, skipped };
}

export function planReleasePruning(current: ReleaseManifest, candidates: readonly ReleasePruneCandidate[]): Readonly<{ retained: readonly string[]; removed: readonly string[] }> {
  if (current.signing.stableIdentity !== true || !current.signing.designatedRequirements) {
    return { retained: candidates.map(candidate => candidate.name), removed: [] };
  }
  const ordered = [...candidates].sort((left, right) => right.modified - left.modified || right.name.localeCompare(left.name));
  const rollback = ordered.find(candidate => hasSameReleaseIdentity(current, candidate.manifest));
  return {
    retained: rollback ? [rollback.name] : [],
    removed: ordered.filter(candidate => candidate !== rollback).map(candidate => candidate.name),
  };
}

function existingReleaseNames(paths: RoomsPaths): string[] {
  if (!existsSync(paths.releaseRoot)) return [];
  return readdirSync(paths.releaseRoot).filter(name => !name.startsWith(".") && (() => { try { assertSafeVersion(name); return true; } catch { return false; } })());
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

function verifyCodeSignature(path: string, name: string, manifest: ReleaseManifest): void {
  const { mode, teamIdentifier, designatedRequirement, identifiers, designatedRequirements } = manifest.signing;
  try { execFileSync("codesign", ["--verify", "--strict", "--verbose=2", path], { stdio: "pipe" }); }
  catch { throw new Error(`Rooms release signature verification failed: ${path}`); }
  if (mode === "DEVELOPER_ID_NOTARIZED") {
    try { execFileSync("spctl", ["--assess", "--type", "execute", "--verbose=2", path], { stdio: "pipe" }); }
    catch { throw new Error(`Rooms notarized release assessment failed: ${path}`); }
  }
  const details = signatureDetails(path);
  if (teamIdentifier && details.teamIdentifier !== teamIdentifier) throw new Error(`Rooms release TeamIdentifier mismatch: ${path}`);
  if (identifiers && designatedRequirements) {
    if (details.identifier !== identifiers[name]) throw new Error(`Rooms release code identifier mismatch for ${name}: signed as ${details.identifier ?? "none"}, manifest claims ${identifiers[name]}`);
    if (details.designatedRequirement !== designatedRequirements[name]) throw new Error(`Rooms release designated requirement mismatch: ${path}`);
    return;
  }
  if (designatedRequirement && details.designatedRequirement !== designatedRequirement) throw new Error(`Rooms release designated requirement mismatch: ${path}`);
}

/**
 * `codesign -d -r-` prints an explicit requirement plainly and an ad-hoc build's
 * implicit `cdhash` requirement as a comment. Read both, so an ad-hoc identity is
 * recorded and compared rather than silently read as "no requirement".
 */
function signatureDetails(path: string): { identifier: string | null; teamIdentifier: string | null; designatedRequirement: string | null } {
  const verbose = spawnSync("codesign", ["-dvvv", path], { encoding: "utf8" });
  const requirements = spawnSync("codesign", ["-d", "-r-", path], { encoding: "utf8" });
  if (verbose.status !== 0 || requirements.status !== 0) throw new Error(`cannot inspect code signature: ${path}`);
  const described = `${verbose.stdout}\n${verbose.stderr}`;
  return {
    identifier: /^Identifier=(.+)$/m.exec(described)?.[1]?.trim() ?? null,
    teamIdentifier: /^TeamIdentifier=(.+)$/m.exec(described)?.[1]?.trim() ?? null,
    designatedRequirement: /^(?:#\s*)?designated => (.+)$/m.exec(`${requirements.stdout}\n${requirements.stderr}`)?.[1]?.trim() ?? null,
  };
}

function hasQuarantine(path: string): boolean {
  try { execFileSync("xattr", ["-p", "com.apple.quarantine", path], { stdio: "pipe" }); return true; }
  catch { return false; }
}

/** The identity of what is live now, read without failing an install for an unrelated defect. */
function currentReleaseManifest(paths: RoomsPaths): ReleaseManifest | null {
  try { return isSymlinkToDirectory(paths.currentLink) ? readReleaseManifest(realpathSync(paths.currentLink)) : null; }
  catch { return null; }
}

function isSymlinkToDirectory(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink() && statSync(path).isDirectory(); } catch { return false; }
}

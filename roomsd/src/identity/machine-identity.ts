import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const IDENTITY_VERSION = 1;
const IDENTITY_DIRECTORY = join("federation", "identity");
const PRIVATE_KEY_FILE = "daemon-ed25519-private.pem";
const PUBLIC_KEY_FILE = "daemon-ed25519-public.pem";
const METADATA_FILE = "identity.json";
const DIRECTORY_MODE = 0o700;
const SECRET_MODE = 0o600;

export type MachineIdentityStatus = Readonly<{
  authorityId: string;
  publicFingerprint: string;
  statePath: string;
  lifecycleState: "identityCreated" | "ready";
  networkListener: false;
}>;

type IdentityMetadata = Readonly<{
  version: 1;
  authorityId: string;
  publicFingerprint: string;
  publicKeyFile: typeof PUBLIC_KEY_FILE;
  createdAt: string;
}>;

export function defaultRoomsStateDir(): string {
  return join(homedir(), ".rooms");
}

export function resolveRoomsStateDir(value?: string): string {
  if (value !== undefined && !isAbsolute(value)) throw new Error("--state-dir must be an absolute path");
  const requested = resolve(value ?? defaultRoomsStateDir());
  if (existsAsAny(requested)) {
    if (lstatSync(requested).isSymbolicLink()) throw new Error(`Rooms state directory must not be a symlink: ${requested}`);
    return realpathSync(requested);
  }
  const missing: string[] = [];
  let existing = requested;
  while (!existsAsAny(existing)) {
    missing.unshift(existing.slice(existing.lastIndexOf("/") + 1));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...missing);
}

export function setupMachineIdentity(stateDirInput?: string): MachineIdentityStatus {
  const stateDir = resolveRoomsStateDir(stateDirInput);
  const identityDir = join(stateDir, IDENTITY_DIRECTORY);
  assertSafePath(stateDir);
  ensureDirectory(stateDir, "state directory");
  ensureDirectory(join(stateDir, "federation"), "federation directory");
  assertSafePath(identityDir);
  if (existsAsAny(identityDir)) return validateIdentity(identityDir);

  const parent = dirname(identityDir);
  const temporary = join(parent, `.identity.tmp-${randomUUID()}`);
  if (readdirSync(parent).some((entry) => entry.startsWith(".identity.tmp-"))) {
    throw new Error(`incomplete identity temporary state exists under ${parent}; remove it after inspection`);
  }
  mkdirSync(temporary, { mode: DIRECTORY_MODE });
  try {
    assertMode(temporary, DIRECTORY_MODE, "identity temporary directory");
    const generated = generateKeyPairSync("ed25519");
    const privatePem = generated.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicPem = generated.publicKey.export({ type: "spki", format: "pem" }).toString();
    const fingerprint = fingerprintForPem(publicPem);
    const metadata: IdentityMetadata = {
      version: IDENTITY_VERSION,
      authorityId: `authority-${fingerprint}`,
      publicFingerprint: fingerprint,
      publicKeyFile: PUBLIC_KEY_FILE,
      createdAt: new Date().toISOString(),
    };
    writeSecret(join(temporary, PRIVATE_KEY_FILE), privatePem);
    writeSecret(join(temporary, PUBLIC_KEY_FILE), publicPem);
    writeSecret(join(temporary, METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`);
    renameSync(temporary, identityDir);
  } catch (error) {
    if (!existsAsAny(identityDir)) throw error;
    rmSync(temporary, { recursive: true, force: true });
  }
  return validateIdentity(identityDir);
}

export function readMachineIdentityStatus(stateDirInput?: string): MachineIdentityStatus {
  const stateDir = resolveRoomsStateDir(stateDirInput);
  const identityDir = join(stateDir, IDENTITY_DIRECTORY);
  assertSafePath(stateDir);
  if (!existsAsAny(identityDir)) throw new Error(`Rooms identity is uninitialized at ${identityDir}`);
  return validateIdentity(identityDir);
}

export type MachineSigningKeys = Readonly<{
  authorityId: string;
  publicFingerprint: string;
  privateKey: import("node:crypto").KeyObject;
  publicKey: import("node:crypto").KeyObject;
}>;

/**
 * Loads the local Ed25519 keypair for signing enrollment artifacts. The private key never
 * leaves this process boundary: it is not serializable by callers and must never be
 * accepted from a CLI flag, artifact, or any other external input — it is loaded only from
 * this Rooms-owned setup identity.
 */
export function loadMachineSigningKeys(stateDirInput?: string): MachineSigningKeys {
  const stateDir = resolveRoomsStateDir(stateDirInput);
  const identityDir = join(stateDir, IDENTITY_DIRECTORY);
  assertSafePath(stateDir);
  if (!existsAsAny(identityDir)) throw new Error(`Rooms identity is uninitialized at ${identityDir}`);
  const status = validateIdentity(identityDir);
  const privateKey = createPrivateKey(readFileSync(join(identityDir, PRIVATE_KEY_FILE)));
  const publicKey = createPublicKey(readFileSync(join(identityDir, PUBLIC_KEY_FILE)));
  return { authorityId: status.authorityId, publicFingerprint: status.publicFingerprint, privateKey, publicKey };
}

function validateIdentity(identityDir: string): MachineIdentityStatus {
  assertSafePath(identityDir);
  assertMode(identityDir, DIRECTORY_MODE, "identity directory");
  const privatePath = join(identityDir, PRIVATE_KEY_FILE);
  const publicPath = join(identityDir, PUBLIC_KEY_FILE);
  const metadataPath = join(identityDir, METADATA_FILE);
  for (const [file, label] of [[privatePath, "private key"], [publicPath, "public key"], [metadataPath, "identity metadata"]] as const) {
    if (!existsAsAny(file)) throw new Error(`Rooms identity is incomplete: missing ${label}`);
    assertRegularNonSymlink(file, label);
    assertMode(file, SECRET_MODE, label);
  }
  const metadata = parseMetadata(readFileSync(metadataPath, "utf8"));
  const privateKey = createPrivateKey(readFileSync(privatePath));
  const publicKey = createPublicKey(readFileSync(publicPath));
  const privateDerivedPublic = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  if (!buffersEqual(privateDerivedPublic, publicDer)) throw new Error("Rooms identity private/public key mismatch");
  const fingerprint = fingerprintForDer(publicDer);
  if (metadata.publicFingerprint !== fingerprint) throw new Error("Rooms identity public fingerprint mismatch");
  if (metadata.authorityId !== `authority-${fingerprint}`) throw new Error("Rooms identity authority id mismatch");
  return { authorityId: metadata.authorityId, publicFingerprint: fingerprint, statePath: identityDir, lifecycleState: "ready", networkListener: false };
}

function parseMetadata(serialized: string): IdentityMetadata {
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { throw new Error("Rooms identity metadata is malformed JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Rooms identity metadata must be an object");
  const record = value as Record<string, unknown>;
  const expected = ["version", "authorityId", "publicFingerprint", "publicKeyFile", "createdAt"];
  if (Object.keys(record).some((key) => !expected.includes(key)) || expected.some((key) => !(key in record))) throw new Error("Rooms identity metadata fields are malformed");
  if (record.version !== IDENTITY_VERSION || record.publicKeyFile !== PUBLIC_KEY_FILE) throw new Error("Rooms identity metadata version or key file is invalid");
  for (const field of ["authorityId", "publicFingerprint", "createdAt"]) if (typeof record[field] !== "string" || record[field].trim() === "") throw new Error(`Rooms identity metadata ${field} is invalid`);
  if (!/^[0-9a-f]{64}$/.test(record.publicFingerprint as string)) throw new Error("Rooms identity fingerprint is invalid");
  if (!Number.isFinite(Date.parse(record.createdAt as string))) throw new Error("Rooms identity createdAt is invalid");
  return record as unknown as IdentityMetadata;
}

function fingerprintForPem(publicPem: string): string {
  return fingerprintForDer(createPublicKey(publicPem).export({ type: "spki", format: "der" }));
}

function fingerprintForDer(publicDer: Uint8Array): string {
  return createHash("sha256").update(publicDer).digest("hex");
}

function buffersEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function ensureDirectory(path: string, label: string): void {
  if (!existsAsAny(path)) mkdirSync(path, { mode: DIRECTORY_MODE });
  assertRegularDirectory(path, label);
  assertMode(path, DIRECTORY_MODE, label);
}

function writeSecret(path: string, contents: string): void {
  const fd = openSync(path, "wx", SECRET_MODE);
  try {
    fchmodSync(fd, SECRET_MODE);
    writeFileSync(fd, contents, { encoding: "utf8" });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  assertMode(path, SECRET_MODE, "identity file");
}

function assertSafePath(path: string): void {
  const absolute = resolve(path);
  let current = "/";
  for (const component of absolute.split("/").filter(Boolean)) {
    current = join(current, component);
    if (!existsAsAny(current)) break;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Rooms identity path contains a symlink: ${current}`);
  }
}

function existsAsAny(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function assertRegularNonSymlink(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Rooms ${label} must not be a symlink`);
  if (!stat.isFile()) throw new Error(`Rooms ${label} must be a regular file`);
}

function assertRegularDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Rooms ${label} must not be a symlink`);
  if (!stat.isDirectory()) throw new Error(`Rooms ${label} must be a directory`);
}

function assertMode(path: string, mode: number, label: string): void {
  const actual = statSync(path).mode & 0o777;
  if (actual !== mode) throw new Error(`Rooms ${label} permissions must be ${mode.toString(8)}, found ${actual.toString(8)}`);
}

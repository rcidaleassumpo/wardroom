// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  PROFILE_REVISIONS_STATE_PATH,
  canonicalChannelProfileRevisionContent,
  canonicalSkillSnapshotManifest,
  type ChannelProfileRevision,
  type PinnedTextSnapshot,
  type ProjectInstructionsPolicy,
  type ProviderModelSkillSet,
  type ProviderSpecificResolvedItem,
  type SkillSnapshot,
  type SnapshotFile,
  type ControlledProvider,
} from "./contracts.js";
import {
  OWNER_DIRECTORY_MODE,
  OWNER_EXECUTABLE_FILE_MODE,
  OWNER_FILE_MODE,
  assertOwnerFile,
  assertSafeStateSegment,
  ensureOwnerDirectory,
  fsyncDirectory,
  readOwnerFile,
  withOwnerFileLock,
  writeNewOwnerFile,
} from "./secure-state-files.js";

const PROFILE_FILE = "profile.json";
const MAX_PROFILE_BYTES = 16 * 1024 * 1024;

export interface TextProfileSource {
  id: string;
  text: string;
  sourcePath?: string | null;
}

export interface FileProfileSource {
  id: string;
  path: string;
}

export interface SkillFolderSource {
  id: string;
  name: string;
  path: string;
}

export interface ProviderModelSkillSetSource {
  id: string;
  provider: ControlledProvider;
  model: string;
  catalogVersion: string;
  authMode: "subscription";
  skills: readonly SkillFolderSource[];
  allowedBuiltinTools: readonly string[];
  providerSpecificResolvedItems: readonly ProviderSpecificResolvedItem[];
  toolEnvironment?: Readonly<{
    npmUserConfig: boolean;
    browserRuntime: boolean;
    sandyboxySandbox: string | null;
  }>;
}

export type ProjectInstructionsSource =
  | Readonly<{ mode: "exclude" }>
  | Readonly<{ mode: "snapshot"; files: readonly FileProfileSource[] }>;

export interface CreateChannelProfileRevisionInput {
  stateDir: string;
  id: string;
  name: string;
  channelId: string;
  version: number;
  createdAt: string;
  createdBySessionId: string;
  instructions: TextProfileSource;
  projectInstructions: ProjectInstructionsSource;
  modelSkillSets: readonly ProviderModelSkillSetSource[];
}

/** Copy live profile sources into one immutable, owner-only revision directory. */
export function createChannelProfileRevision(input: CreateChannelProfileRevisionInput): ChannelProfileRevision {
  validateCreateInput(input);
  const revisionsDirectory = ensureProfileRevisionsDirectory(input.stateDir);
  const revisionId = assertSafeStateSegment(input.id, "profile revision id");
  const finalRoot = join(revisionsDirectory, revisionId);
  return withOwnerFileLock(join(revisionsDirectory, `.${revisionId}.lock`), () => {
    if (existsSync(finalRoot)) throw new Error(`profile revision already exists: ${revisionId}`);
    const stagingRoot = join(revisionsDirectory, `.${revisionId}.tmp-${randomUUID()}`);
    mkdirSync(stagingRoot, { mode: OWNER_DIRECTORY_MODE });
    assertOwnerDirectory(stagingRoot);
    try {
      const instructions = snapshotText(
        input.instructions,
        join(stagingRoot, "instructions", "channel.md"),
        join(finalRoot, "instructions", "channel.md"),
      );
      const projectInstructions = snapshotProjectInstructions(input.projectInstructions, stagingRoot, finalRoot);
      const skillCache = new Map<string, Readonly<{ source: SkillFolderSource; snapshot: SkillSnapshot }>>();
      const modelSkillSets = input.modelSkillSets.map((set) => snapshotModelSkillSet(set, stagingRoot, finalRoot, skillCache));
      const unhashed: ChannelProfileRevision = {
        id: input.id,
        name: input.name,
        channelId: input.channelId,
        version: input.version,
        sha256: "",
        createdAt: input.createdAt,
        createdBySessionId: input.createdBySessionId,
        harnessMode: "controlled",
        instructions,
        projectInstructions,
        modelSkillSets,
      };
      const profile: ChannelProfileRevision = {
        ...unhashed,
        sha256: sha256(canonicalChannelProfileRevisionContent(unhashed)),
      };
      writeJson(join(stagingRoot, PROFILE_FILE), profile);
      renameSync(stagingRoot, finalRoot);
      fsyncDirectory(revisionsDirectory);
      return profile;
    } catch (error) {
      rmSync(stagingRoot, { recursive: true, force: true });
      throw error;
    }
  });
}

/** Read a stored revision and re-verify every persisted byte and canonical hash. */
export function readChannelProfileRevision(stateDir: string, revisionIdInput: string): ChannelProfileRevision {
  const revisionId = assertSafeStateSegment(revisionIdInput, "profile revision id");
  const root = join(ensureProfileRevisionsDirectory(stateDir), revisionId);
  assertOwnerDirectory(root);
  const parsed: unknown = JSON.parse(readOwnerFile(join(root, PROFILE_FILE), MAX_PROFILE_BYTES).toString("utf8"));
  const profile = parseProfile(parsed);
  if (profile.id !== revisionId) throw new Error("profile revision id does not match its storage path");
  if (resolve(profile.instructions.snapshotPath) !== join(root, "instructions", "channel.md")) throw new Error("channel instruction snapshot path does not match the revision layout");
  verifyTextSnapshot(profile.instructions, root);
  if (profile.projectInstructions.mode === "snapshot") {
    const projectRoot = join(root, "instructions", "project");
    for (const snapshot of profile.projectInstructions.snapshots) {
      assertSnapshotPath(snapshot.snapshotPath, projectRoot);
      verifyTextSnapshot(snapshot, root);
    }
  }
  for (const set of profile.modelSkillSets) {
    for (const skill of set.skills) {
      if (resolve(skill.snapshotPath) !== join(root, "skills", assertSafeStateSegment(skill.id, "skill snapshot id"))) throw new Error(`skill snapshot path does not match the revision layout: ${skill.id}`);
      if (resolve(skill.instruction.snapshotPath) !== join(skill.snapshotPath, "SKILL.md")) throw new Error(`skill instruction path does not match the revision layout: ${skill.id}`);
      verifySkillSnapshot(skill, root);
    }
  }
  const expected = sha256(canonicalChannelProfileRevisionContent({ ...profile, sha256: "" }));
  if (profile.sha256 !== expected) throw new Error("profile revision canonical hash mismatch");
  return profile;
}

/** List verified immutable revisions belonging to one channel. */
export function listChannelProfileRevisions(stateDir: string, channelId: string): readonly ChannelProfileRevision[] {
  nonempty(channelId, "channelId");
  const revisionsDirectory = ensureProfileRevisionsDirectory(stateDir);
  return readdirSync(revisionsDirectory)
    .filter((entry) => !entry.startsWith("."))
    .map((id) => readChannelProfileRevision(stateDir, id))
    .filter((profile) => profile.channelId === channelId)
    .sort((left, right) => right.version - left.version || left.id.localeCompare(right.id));
}

export function profileRevisionPath(stateDir: string, revisionId: string): string {
  return join(resolve(stateDir), PROFILE_REVISIONS_STATE_PATH, assertSafeStateSegment(revisionId, "profile revision id"));
}

function snapshotProjectInstructions(source: ProjectInstructionsSource, stagingRoot: string, finalRoot: string): ProjectInstructionsPolicy {
  if (source.mode === "exclude") return { mode: "exclude" };
  const seen = new Set<string>();
  const snapshots = source.files.map((file, index) => {
    const id = assertSafeStateSegment(file.id, "project instruction id");
    if (seen.has(id)) throw new Error(`duplicate project instruction id: ${id}`);
    seen.add(id);
    const { bytes } = readRegularSourceFile(file.path, "project instruction");
    const suffix = basename(resolve(file.path)).replace(/[^A-Za-z0-9._-]/g, "-") || "instructions.md";
    const filename = `${String(index).padStart(4, "0")}-${id}-${suffix}`;
    return snapshotBytes(
      id,
      resolve(file.path),
      bytes,
      join(stagingRoot, "instructions", "project", filename),
      join(finalRoot, "instructions", "project", filename),
    );
  });
  return { mode: "snapshot", snapshots };
}

function snapshotModelSkillSet(
  source: ProviderModelSkillSetSource,
  stagingRoot: string,
  finalRoot: string,
  cache: Map<string, Readonly<{ source: SkillFolderSource; snapshot: SkillSnapshot }>>,
): ProviderModelSkillSet {
  const skills = source.skills.map((skillSource) => {
    const skillId = assertSafeStateSegment(skillSource.id, "skill snapshot id");
    const prior = cache.get(skillId);
    if (prior) {
      if (prior.source.name !== skillSource.name || resolve(prior.source.path) !== resolve(skillSource.path)) {
        throw new Error(`skill snapshot id maps to different live sources: ${skillId}`);
      }
      return prior.snapshot;
    }
    const snapshot = snapshotSkill(skillSource, stagingRoot, finalRoot);
    cache.set(skillId, { source: skillSource, snapshot });
    return snapshot;
  });
  return {
    id: source.id,
    provider: source.provider,
    model: source.model,
    catalogVersion: source.catalogVersion,
    authMode: source.authMode,
    skills,
    allowedBuiltinTools: [...source.allowedBuiltinTools],
    providerSpecificResolvedItems: source.providerSpecificResolvedItems.map((item) => ({ ...item })),
    toolEnvironment: source.toolEnvironment ?? {
      npmUserConfig: false,
      browserRuntime: false,
      sandyboxySandbox: null,
    },
  };
}

function snapshotSkill(source: SkillFolderSource, stagingRoot: string, finalRoot: string): SkillSnapshot {
  const id = assertSafeStateSegment(source.id, "skill snapshot id");
  const sourceRoot = resolve(source.path);
  const sourceStat = lstatSync(sourceRoot);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) throw new Error(`skill source is not a regular directory: ${sourceRoot}`);
  const stagingSnapshotRoot = join(stagingRoot, "skills", id);
  const finalSnapshotRoot = join(finalRoot, "skills", id);
  const sourceFiles = collectSkillFiles(sourceRoot);
  const files: SnapshotFile[] = sourceFiles.map(({ absolutePath, relativePath }) => {
    const { bytes, executable } = readRegularSourceFile(absolutePath, "skill file");
    const destination = join(stagingSnapshotRoot, ...relativePath.split("/"));
    ensureOwnerDirectory(dirname(destination));
    writeNewOwnerFile(destination, bytes, executable ? OWNER_EXECUTABLE_FILE_MODE : OWNER_FILE_MODE);
    return { relativePath, sha256: sha256(bytes), byteSize: bytes.byteLength, executable };
  });
  const sourcePathsAfterCopy = collectSkillFiles(sourceRoot).map((file) => file.relativePath);
  if (JSON.stringify(sourceFiles.map((file) => file.relativePath)) !== JSON.stringify(sourcePathsAfterCopy)) {
    throw new Error(`skill source changed while it was snapshotted: ${sourceRoot}`);
  }
  const instructionFile = files.find((file) => file.relativePath === "SKILL.md");
  if (!instructionFile) throw new Error(`skill source lacks SKILL.md: ${sourceRoot}`);
  const instructionBytes = readFileSync(join(stagingSnapshotRoot, "SKILL.md"));
  const instruction: PinnedTextSnapshot = {
    id: `${id}-instructions`,
    sourcePath: join(sourceRoot, "SKILL.md"),
    snapshotPath: join(finalSnapshotRoot, "SKILL.md"),
    sha256: instructionFile.sha256,
    byteSize: instructionFile.byteSize,
    text: decodeUtf8(instructionBytes, "skill instructions"),
  };
  return {
    id,
    name: source.name,
    sourcePath: sourceRoot,
    snapshotPath: finalSnapshotRoot,
    rootSha256: sha256(canonicalSkillSnapshotManifest(files)),
    instruction,
    files,
  };
}

function collectSkillFiles(sourceRoot: string): Array<{ absolutePath: string; relativePath: string }> {
  const files: Array<{ absolutePath: string; relativePath: string }> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const value = lstatSync(absolutePath);
      if (value.isSymbolicLink()) throw new Error(`skill source contains a symbolic link: ${absolutePath}`);
      if (value.isDirectory()) visit(absolutePath);
      else if (value.isFile()) {
        const relativePath = relative(sourceRoot, absolutePath).split(sep).join("/");
        if (!relativePath || relativePath.startsWith("../") || relativePath.includes("\u0000")) throw new Error(`invalid skill file path: ${absolutePath}`);
        files.push({ absolutePath, relativePath });
      } else throw new Error(`skill source contains a special file: ${absolutePath}`);
    }
  };
  visit(sourceRoot);
  files.sort((left, right) => Buffer.from(left.relativePath).compare(Buffer.from(right.relativePath)));
  return files;
}

function snapshotText(source: TextProfileSource, stagingPath: string, finalPath: string): PinnedTextSnapshot {
  if (typeof source.text !== "string") throw new Error("channel instructions must be text");
  return snapshotBytes(
    assertSafeStateSegment(source.id, "channel instruction id"),
    source.sourcePath === undefined ? null : source.sourcePath,
    Buffer.from(source.text, "utf8"),
    stagingPath,
    finalPath,
  );
}

function snapshotBytes(id: string, sourcePath: string | null, bytes: Uint8Array, stagingPath: string, finalPath: string): PinnedTextSnapshot {
  const text = decodeUtf8(bytes, "profile instructions");
  ensureOwnerDirectory(dirname(stagingPath));
  writeNewOwnerFile(stagingPath, bytes);
  return { id, sourcePath, snapshotPath: finalPath, sha256: sha256(bytes), byteSize: bytes.byteLength, text };
}

function verifyTextSnapshot(snapshot: PinnedTextSnapshot, revisionRoot: string, expectedMode = OWNER_FILE_MODE): void {
  assertSnapshotPath(snapshot.snapshotPath, revisionRoot);
  const bytes = readOwnerFile(snapshot.snapshotPath, MAX_PROFILE_BYTES, expectedMode);
  if (bytes.byteLength !== snapshot.byteSize || sha256(bytes) !== snapshot.sha256 || decodeUtf8(bytes, "stored profile instructions") !== snapshot.text) {
    throw new Error(`profile text snapshot mismatch: ${snapshot.id}`);
  }
}

function verifySkillSnapshot(skill: SkillSnapshot, revisionRoot: string): void {
  assertSnapshotPath(skill.snapshotPath, revisionRoot);
  assertOwnerDirectory(skill.snapshotPath);
  const instructionFile = skill.files.find((file) => file.relativePath === "SKILL.md");
  if (!instructionFile) throw new Error(`skill snapshot lacks SKILL.md: ${skill.id}`);
  verifyTextSnapshot(skill.instruction, revisionRoot, instructionFile.executable ? OWNER_EXECUTABLE_FILE_MODE : OWNER_FILE_MODE);
  const expectedPaths = skill.files.map((file) => file.relativePath).sort(compareUtf8);
  const actualPaths = collectStoredSnapshotFiles(skill.snapshotPath).sort(compareUtf8);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) throw new Error(`skill snapshot file inventory mismatch: ${skill.id}`);
  for (const file of skill.files) {
    const path = join(skill.snapshotPath, ...file.relativePath.split("/"));
    assertSnapshotPath(path, skill.snapshotPath);
    const mode = file.executable ? OWNER_EXECUTABLE_FILE_MODE : OWNER_FILE_MODE;
    const bytes = readOwnerFile(path, MAX_PROFILE_BYTES, mode);
    if (bytes.byteLength !== file.byteSize || sha256(bytes) !== file.sha256) throw new Error(`skill snapshot file mismatch: ${skill.id}/${file.relativePath}`);
  }
  if (sha256(canonicalSkillSnapshotManifest(skill.files)) !== skill.rootSha256) throw new Error(`skill snapshot root hash mismatch: ${skill.id}`);
}

function collectStoredSnapshotFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    assertOwnerDirectory(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const value = lstatSync(path);
      if (value.isSymbolicLink()) throw new Error(`skill snapshot contains a symbolic link: ${path}`);
      if (value.isDirectory()) visit(path);
      else if (value.isFile()) {
        const mode = value.mode & 0o777;
        if (mode !== OWNER_FILE_MODE && mode !== OWNER_EXECUTABLE_FILE_MODE) throw new Error(`refusing insecure skill snapshot file: ${path}`);
        assertOwnerFile(path, mode);
        files.push(relative(root, path).split(sep).join("/"));
      } else throw new Error(`skill snapshot contains a special file: ${path}`);
    }
  };
  visit(root);
  return files;
}

function assertSnapshotPath(path: string, root: string): void {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  if (!isAbsolute(path) || (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`))) throw new Error(`profile snapshot path escapes revision root: ${path}`);
}

function readRegularSourceFile(pathInput: string, label: string): Readonly<{ bytes: Buffer; executable: boolean }> {
  const path = resolve(pathInput);
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
  const bytes = readFileSync(path);
  const after = lstatSync(path);
  if (after.isSymbolicLink() || !after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || (before.mode & 0o111) !== (after.mode & 0o111)) throw new Error(`${label} changed while it was snapshotted: ${path}`);
  return { bytes, executable: (before.mode & 0o111) !== 0 };
}

function ensureProfileRevisionsDirectory(stateDirInput: string): string {
  if (!isAbsolute(stateDirInput)) throw new Error("profile state directory must be absolute");
  const stateDir = ensureOwnerDirectory(resolve(stateDirInput));
  const profilesDirectory = ensureOwnerDirectory(join(stateDir, "profiles"));
  return ensureOwnerDirectory(join(profilesDirectory, "revisions"));
}

function assertOwnerDirectory(path: string): void {
  const value = lstatSync(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (value.isSymbolicLink() || !value.isDirectory() || (value.mode & 0o777) !== OWNER_DIRECTORY_MODE || (uid !== undefined && value.uid !== uid)) {
    throw new Error(`refusing insecure profile revision directory: ${path}`);
  }
}

function writeJson(path: string, value: unknown): void {
  writeNewOwnerFile(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(`${label} must contain valid UTF-8`); }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateCreateInput(input: CreateChannelProfileRevisionInput): void {
  assertSafeStateSegment(input.id, "profile revision id");
  nonempty(input.name, "profile name");
  nonempty(input.channelId, "channelId");
  nonempty(input.createdBySessionId, "createdBySessionId");
  if (!Number.isSafeInteger(input.version) || input.version < 1) throw new Error("invalid profile version");
  if (!Number.isFinite(Date.parse(input.createdAt))) throw new Error("invalid profile creation time");
  const setIds = new Set<string>();
  const targets = new Set<string>();
  for (const set of input.modelSkillSets) {
    nonempty(set.id, "model skill set id");
    nonempty(set.model, "model");
    nonempty(set.catalogVersion, "catalogVersion");
    if (set.authMode !== "subscription" || !["codex", "claude"].includes(set.provider)) throw new Error("invalid controlled provider model set");
    if (setIds.has(set.id)) throw new Error(`duplicate model skill set id: ${set.id}`);
    setIds.add(set.id);
    const target = `${set.provider}\u0000${set.model}`;
    if (targets.has(target)) throw new Error(`duplicate provider model profile: ${set.provider}/${set.model}`);
    targets.add(target);
    const skillIds = new Set<string>();
    for (const skill of set.skills) {
      const skillId = assertSafeStateSegment(skill.id, "skill snapshot id");
      nonempty(skill.name, "skill name");
      nonempty(skill.path, "skill source path");
      if (skillIds.has(skillId)) throw new Error(`duplicate skill snapshot in model set: ${skillId}`);
      skillIds.add(skillId);
    }
    for (const tool of set.allowedBuiltinTools) nonempty(tool, "allowed tool");
    if (new Set(set.allowedBuiltinTools).size !== set.allowedBuiltinTools.length) throw new Error(`duplicate allowed tool in model set: ${set.id}`);
    if (!set.providerSpecificResolvedItems.every(isProviderSpecificResolvedItem)) throw new Error(`invalid provider-specific resolved item in model set: ${set.id}`);
    if (set.toolEnvironment !== undefined) validateToolEnvironment(set.toolEnvironment, set.id);
  }
  if (input.projectInstructions.mode === "snapshot") {
    for (const file of input.projectInstructions.files) {
      assertSafeStateSegment(file.id, "project instruction id");
      nonempty(file.path, "project instruction path");
    }
  }
}

function nonempty(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\u0000") || Buffer.byteLength(value) > 4096) throw new Error(`invalid ${field}`);
  return value;
}

function parseProfile(value: unknown): ChannelProfileRevision {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid stored profile revision");
  const legacy = !Object.hasOwn(value, "name");
  const expected = legacy
    ? ["id", "channelId", "version", "sha256", "createdAt", "createdBySessionId", "harnessMode", "instructions", "projectInstructions", "modelSkillSets"]
    : ["id", "name", "channelId", "version", "sha256", "createdAt", "createdBySessionId", "harnessMode", "instructions", "projectInstructions", "modelSkillSets"];
  if (!hasExactKeys(value, expected)) throw new Error("stored profile revision contains unknown or missing fields");
  const profile = { ...(value as Partial<ChannelProfileRevision>), ...(legacy && typeof (value as { id?: unknown }).id === "string" ? { name: (value as { id: string }).id } : {}) };
  if (typeof profile.id !== "string" || typeof profile.name !== "string" || !profile.name.trim() || typeof profile.channelId !== "string" || typeof profile.version !== "number" || typeof profile.sha256 !== "string" || typeof profile.createdAt !== "string" || typeof profile.createdBySessionId !== "string" || profile.harnessMode !== "controlled") throw new Error("invalid stored profile revision metadata");
  if (!isTextSnapshot(profile.instructions) || !isProjectInstructions(profile.projectInstructions) || !Array.isArray(profile.modelSkillSets) || !profile.modelSkillSets.every(isModelSkillSet)) throw new Error("invalid stored profile revision policy");
  if (!/^[0-9a-f]{64}$/.test(profile.sha256)) throw new Error("invalid stored profile revision hash");
  return profile as ChannelProfileRevision;
}

function isTextSnapshot(value: unknown): value is PinnedTextSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!hasExactKeys(value, ["id", "sourcePath", "snapshotPath", "sha256", "byteSize", "text"])) return false;
  const row = value as Partial<PinnedTextSnapshot>;
  return typeof row.id === "string" && (row.sourcePath === null || typeof row.sourcePath === "string") && typeof row.snapshotPath === "string" && typeof row.sha256 === "string" && /^[0-9a-f]{64}$/.test(row.sha256) && Number.isSafeInteger(row.byteSize) && row.byteSize! >= 0 && typeof row.text === "string";
}

function isProjectInstructions(value: unknown): value is ProjectInstructionsPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<ProjectInstructionsPolicy> & { snapshots?: unknown };
  return (row.mode === "exclude" && hasExactKeys(value, ["mode"])) || (row.mode === "snapshot" && hasExactKeys(value, ["mode", "snapshots"]) && Array.isArray(row.snapshots) && row.snapshots.every(isTextSnapshot));
}

function isModelSkillSet(value: unknown): value is ProviderModelSkillSet {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!hasExactKeys(value, ["id", "provider", "model", "catalogVersion", "authMode", "skills", "allowedBuiltinTools", "providerSpecificResolvedItems", "toolEnvironment"])) return false;
  const row = value as Partial<ProviderModelSkillSet>;
  return typeof row.id === "string" && (row.provider === "codex" || row.provider === "claude") && typeof row.model === "string" && typeof row.catalogVersion === "string" && row.authMode === "subscription" && Array.isArray(row.skills) && row.skills.every(isSkillSnapshot) && Array.isArray(row.allowedBuiltinTools) && row.allowedBuiltinTools.every((item) => typeof item === "string") && Array.isArray(row.providerSpecificResolvedItems) && row.providerSpecificResolvedItems.every(isProviderSpecificResolvedItem) && isToolEnvironment(row.toolEnvironment);
}

function validateToolEnvironment(value: ProviderModelSkillSetSource["toolEnvironment"], setId: string): void {
  if (!isToolEnvironment(value)) throw new Error(`invalid tool environment in model set: ${setId}`);
  if (value.sandyboxySandbox !== null) nonempty(value.sandyboxySandbox, "Sandyboxy sandbox");
}

function isToolEnvironment(value: unknown): value is ProviderModelSkillSet["toolEnvironment"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!hasExactKeys(value, ["npmUserConfig", "browserRuntime", "sandyboxySandbox"])) return false;
  const row = value as Record<string, unknown>;
  return typeof row.npmUserConfig === "boolean" && typeof row.browserRuntime === "boolean" && (row.sandyboxySandbox === null || typeof row.sandyboxySandbox === "string");
}

function isSkillSnapshot(value: unknown): value is SkillSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!hasExactKeys(value, ["id", "name", "sourcePath", "snapshotPath", "rootSha256", "instruction", "files"])) return false;
  const row = value as Partial<SkillSnapshot>;
  return typeof row.id === "string" && typeof row.name === "string" && typeof row.sourcePath === "string" && typeof row.snapshotPath === "string" && typeof row.rootSha256 === "string" && /^[0-9a-f]{64}$/.test(row.rootSha256) && isTextSnapshot(row.instruction) && Array.isArray(row.files) && row.files.every(isSnapshotFile);
}

function isSnapshotFile(value: unknown): value is SnapshotFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!hasExactKeys(value, ["relativePath", "sha256", "byteSize", "executable"])) return false;
  const row = value as Partial<SnapshotFile>;
  return typeof row.relativePath === "string" && typeof row.sha256 === "string" && /^[0-9a-f]{64}$/.test(row.sha256) && Number.isSafeInteger(row.byteSize) && row.byteSize! >= 0 && typeof row.executable === "boolean";
}

function isProviderSpecificResolvedItem(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) || !hasExactKeys(value, ["surface", "id", "sha256"])) return false;
  const row = value as Record<string, unknown>;
  return ["instructions", "projectInstructions", "skills", "plugins", "hooks", "memories", "mcpServers", "apps", "webAccess", "subagents", "tools"].includes(String(row.surface)) && typeof row.id === "string" && (row.sha256 === null || (typeof row.sha256 === "string" && /^[0-9a-f]{64}$/.test(row.sha256)));
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

// SPDX-License-Identifier: Apache-2.0

export type ControlledProvider = "codex" | "claude";
export type ControlledAuthMode = "subscription";

/**
 * Immutable snapshots live below this state-relative directory:
 *
 * `<stateDir>/profiles/revisions/<revisionId>/`
 *
 * Channel text uses `instructions/channel.md`, pinned project files use
 * `instructions/project/`, and complete skill folders use
 * `skills/<skillSnapshotId>/`. Every `snapshotPath` is the absolute resolved
 * path below that revision directory. Adapters consume the stored path and
 * must not reconstruct it from a live source path.
 */
export const PROFILE_REVISIONS_STATE_PATH = "profiles/revisions";

export interface SnapshotFile {
  relativePath: string;
  sha256: string;
  byteSize: number;
  executable: boolean;
}

/** Exact text retained for inspection and provider injection. */
export interface PinnedTextSnapshot {
  id: string;
  sourcePath: string | null;
  snapshotPath: string;
  sha256: string;
  byteSize: number;
  text: string;
}

/** Immutable copy of one complete skill folder. */
export interface SkillSnapshot {
  id: string;
  name: string;
  sourcePath: string;
  snapshotPath: string;
  rootSha256: string;
  instruction: PinnedTextSnapshot;
  files: readonly SnapshotFile[];
}

export type ProjectInstructionsPolicy =
  | Readonly<{ mode: "exclude" }>
  | Readonly<{ mode: "snapshot"; snapshots: readonly PinnedTextSnapshot[] }>;

export type ResolvedStateSurface =
  | "instructions"
  | "projectInstructions"
  | "skills"
  | "plugins"
  | "hooks"
  | "memories"
  | "mcpServers"
  | "apps"
  | "webAccess"
  | "subagents"
  | "tools";

/** One item that the provider may expose after profile materialization. */
export interface ResolvedStateItem {
  id: string;
  sha256: string | null;
}

/**
 * Provider-specific visible items required to deliver a semantic profile.
 * For example, Claude may expose a profile skill through one generated plugin.
 */
export interface ProviderSpecificResolvedItem extends ResolvedStateItem {
  surface: ResolvedStateSurface;
}

/** Skills and controlled capabilities selected for one exact provider model. */
export interface ProviderModelSkillSet {
  id: string;
  provider: ControlledProvider;
  /** Canonical model catalog id. Aliases resolve before this set is selected. */
  model: string;
  catalogVersion: string;
  authMode: ControlledAuthMode;
  skills: readonly SkillSnapshot[];
  allowedBuiltinTools: readonly string[];
  providerSpecificResolvedItems: readonly ProviderSpecificResolvedItem[];
  toolEnvironment: ProfileToolEnvironment;
}

/** Non-secret launch inputs for tools exposed by this profile. */
export interface ProfileToolEnvironment {
  npmUserConfig: boolean;
  browserRuntime: boolean;
  sandyboxySandbox: string | null;
}

/** Immutable channel-level policy revision. */
export interface ChannelProfileRevision {
  id: string;
  name: string;
  channelId: string;
  version: number;
  sha256: string;
  createdAt: string;
  createdBySessionId: string;
  harnessMode: "controlled";
  instructions: PinnedTextSnapshot;
  projectInstructions: ProjectInstructionsPolicy;
  modelSkillSets: readonly ProviderModelSkillSet[];
}

export type ProviderCredentialSource =
  | "chatgptSubscription"
  | "oauth"
  | "keychain"
  | "apiKey"
  | "unknown";

/** Non-secret authentication facts. Never add credential values or hashes. */
export interface ProviderAuthAttestation {
  requiredMode: ControlledAuthMode;
  resolvedMode: "subscription" | "api" | "unknown";
  credentialSource: ProviderCredentialSource;
  accountPresent: boolean;
  /** Variable names only. Values are never collected. */
  apiKeyEnvironmentVariables: readonly string[];
  verifiedAt: string;
}

export type ResolvedStateInspection = "verified" | "unsupported" | "unavailable";

/** Complete inventory for one provider surface, including an empty surface. */
export interface ResolvedStateSurfaceAttestation {
  surface: ResolvedStateSurface;
  inspection: ResolvedStateInspection;
  items: readonly ResolvedStateItem[];
}

export interface ProviderResolvedStateAttestation {
  profileRevisionId: string;
  profileSha256: string;
  modelSkillSetId: string;
  provider: ControlledProvider;
  requestedModel: string;
  effectiveModel: string;
  inspectedAt: string;
  surfaces: readonly ResolvedStateSurfaceAttestation[];
}

export interface SessionProfileBinding {
  id: string;
  sessionId: string;
  channelId: string;
  profileRevisionId: string;
  profileSha256: string;
  modelSkillSetId: string;
  provider: ControlledProvider;
  requestedModel: string;
  effectiveModel: string;
  executablePath: string;
  executableVersion: string;
  authAttestation: ProviderAuthAttestation;
  resolvedStateAttestation: ProviderResolvedStateAttestation | null;
  boundAt: string;
}

export type ResolvedStateGateRejectionCode =
  | "profileRevisionMismatch"
  | "modelProfileMismatch"
  | "attestationMetadataMismatch"
  | "executableUnverified"
  | "authModeMismatch"
  | "authAccountMissing"
  | "apiKeyEnvironmentPresent"
  | "surfaceMissing"
  | "surfaceDuplicate"
  | "surfaceUnverified"
  | "requiredItemMissing"
  | "unexpectedItem";

export interface ResolvedStateGateRejection {
  code: ResolvedStateGateRejectionCode;
  detail: string;
}

export type ResolvedStateGateDecision =
  | Readonly<{ accepted: true; rejections: readonly [] }>
  | Readonly<{ accepted: false; rejections: readonly ResolvedStateGateRejection[] }>;

export interface ResolvedStateGateInput {
  profile: ChannelProfileRevision;
  binding: SessionProfileBinding;
  attestation: ProviderResolvedStateAttestation;
}

/** Provider adapters must pass this gate before a controlled session is ready. */
export interface ResolvedStateGate {
  evaluate(input: ResolvedStateGateInput): ResolvedStateGateDecision;
}

/**
 * Canonical hash rules, version 1:
 *
 * - Text and file SHA-256 values use the exact file bytes. Text bytes are the
 *   stored UTF-8 bytes with no newline or Unicode normalization.
 * - Hash strings are lowercase hexadecimal.
 * - `SkillSnapshot.rootSha256` hashes `canonicalSkillSnapshotManifest(files)`.
 *   The manifest starts with `rooms-skill-snapshot-v1` and NUL. Each file then
 *   contributes UTF-8 relative path, NUL, lowercase SHA-256, NUL, base-10 byte
 *   size, NUL, the literal `true` or `false` executable flag, and NUL. Files
 *   sort by unsigned UTF-8 byte order. Any source execute bit maps to `true`.
 * - `ChannelProfileRevision.sha256` hashes
 *   `canonicalChannelProfileRevisionContent(revision)`. The canonical JSON
 *   contains policy content only. It excludes revision identity, channel,
 *   creator, timestamps, mutable source paths, snapshot paths, and `sha256`
 *   itself. Project instruction order is retained because injection order is
 *   meaningful. Model sets, skills, files, tools, and provider-specific items
 *   sort by their documented identifiers.
 *
 * These functions return canonical bytes but do not hash them. Provider
 * adapters may use their native SHA-256 implementation over the returned
 * bytes without importing filesystem or process state into this module.
 */
export function canonicalSkillSnapshotManifest(files: readonly SnapshotFile[]): Uint8Array {
  const records = [...files].sort((left, right) => compareUtf8(left.relativePath, right.relativePath));
  return utf8([
    "rooms-skill-snapshot-v1",
    ...records.flatMap((file) => [file.relativePath, file.sha256, String(file.byteSize), String(file.executable)]),
    "",
  ].join("\u0000"));
}

export function canonicalChannelProfileRevisionContent(revision: ChannelProfileRevision): Uint8Array {
  const projectInstructions = revision.projectInstructions.mode === "exclude"
    ? { mode: "exclude" as const }
    : {
      mode: "snapshot" as const,
      snapshots: revision.projectInstructions.snapshots.map(textSnapshotContent),
    };
  const modelSkillSets = [...revision.modelSkillSets]
    .sort((left, right) => compareUtf8(`${left.provider}\u0000${left.model}\u0000${left.id}`, `${right.provider}\u0000${right.model}\u0000${right.id}`))
    .map((set) => ({
      id: set.id,
      provider: set.provider,
      model: set.model,
      catalogVersion: set.catalogVersion,
      authMode: set.authMode,
      skills: [...set.skills].sort((left, right) => compareUtf8(left.id, right.id)).map((skill) => ({
        id: skill.id,
        name: skill.name,
        rootSha256: skill.rootSha256,
        instruction: textSnapshotContent(skill.instruction),
        files: [...skill.files].sort((left, right) => compareUtf8(left.relativePath, right.relativePath)).map((file) => ({
          relativePath: file.relativePath,
          sha256: file.sha256,
          byteSize: file.byteSize,
          executable: file.executable,
        })),
      })),
      allowedBuiltinTools: [...set.allowedBuiltinTools].sort(compareUtf8),
      providerSpecificResolvedItems: [...set.providerSpecificResolvedItems]
        .sort((left, right) => compareUtf8(`${left.surface}\u0000${left.id}\u0000${left.sha256 ?? ""}`, `${right.surface}\u0000${right.id}\u0000${right.sha256 ?? ""}`))
        .map((item) => ({ surface: item.surface, id: item.id, sha256: item.sha256 })),
      toolEnvironment: set.toolEnvironment,
    }));
  return utf8(JSON.stringify({
    schema: "rooms-channel-profile-v1",
    harnessMode: revision.harnessMode,
    instructions: textSnapshotContent(revision.instructions),
    projectInstructions,
    modelSkillSets,
  }));
}

function textSnapshotContent(snapshot: PinnedTextSnapshot) {
  return { id: snapshot.id, sha256: snapshot.sha256, byteSize: snapshot.byteSize, text: snapshot.text };
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = utf8(left);
  const rightBytes = utf8(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index]! - rightBytes[index]!;
  }
  return leftBytes.length - rightBytes.length;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

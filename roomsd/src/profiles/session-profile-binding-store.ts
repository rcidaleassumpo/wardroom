// SPDX-License-Identifier: Apache-2.0
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { SessionProfileBinding } from "./contracts.js";
import { readChannelProfileRevision } from "./profile-revision-store.js";
import {
  assertSafeStateSegment,
  ensureOwnerDirectory,
  readOwnerFile,
  replaceOwnerFile,
  withOwnerFileLock,
} from "./secure-state-files.js";

export const PROFILE_BINDINGS_STATE_PATH = "profiles/bindings";
const MAX_BINDING_BYTES = 1024 * 1024;

/**
 * Persist a binding atomically. The only permitted update attaches the first
 * resolved-state attestation; all launch, model, executable, and auth facts
 * stay fixed for the life of the binding.
 */
export function persistSessionProfileBinding(stateDir: string, binding: SessionProfileBinding): SessionProfileBinding {
  validateBinding(binding);
  const profile = readChannelProfileRevision(stateDir, binding.profileRevisionId);
  if (profile.sha256 !== binding.profileSha256 || profile.channelId !== binding.channelId) throw new Error("session profile binding does not match its profile revision");
  const modelSet = profile.modelSkillSets.find((set) => set.id === binding.modelSkillSetId);
  if (!modelSet || modelSet.provider !== binding.provider || modelSet.model !== binding.effectiveModel || modelSet.authMode !== binding.authAttestation.requiredMode) {
    throw new Error("session profile binding does not match its provider model profile");
  }
  const path = sessionProfileBindingPath(stateDir, binding.id);
  return withOwnerFileLock(`${path}.lock`, () => {
    const existing = existsSync(path) ? readSessionProfileBinding(stateDir, binding.id) : null;
    if (existing) assertPermittedUpdate(existing, binding);
    replaceOwnerFile(path, Buffer.from(`${JSON.stringify(binding, null, 2)}\n`, "utf8"));
    return binding;
  });
}

export function readSessionProfileBinding(stateDir: string, bindingId: string): SessionProfileBinding {
  const path = sessionProfileBindingPath(stateDir, bindingId);
  const parsed: unknown = JSON.parse(readOwnerFile(path, MAX_BINDING_BYTES).toString("utf8"));
  validateBinding(parsed);
  if (parsed.id !== bindingId) throw new Error("session profile binding id does not match its storage path");
  return parsed;
}

/** Read every binding for one Rooms session, newest first. */
export function listSessionProfileBindings(stateDir: string, sessionId: string): readonly SessionProfileBinding[] {
  if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("invalid binding session id");
  const directory = sessionProfileBindingsDirectory(stateDir);
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.startsWith("."))
    .map((entry) => readSessionProfileBinding(stateDir, entry.name.slice(0, -".json".length)))
    .filter((binding) => binding.sessionId === sessionId)
    .sort((left, right) => right.boundAt.localeCompare(left.boundAt) || left.id.localeCompare(right.id));
}

export function sessionProfileBindingPath(stateDirInput: string, bindingId: string): string {
  return join(sessionProfileBindingsDirectory(stateDirInput), `${assertSafeStateSegment(bindingId, "session profile binding id")}.json`);
}

function sessionProfileBindingsDirectory(stateDirInput: string): string {
  if (!isAbsolute(stateDirInput)) throw new Error("profile state directory must be absolute");
  const stateDir = ensureOwnerDirectory(resolve(stateDirInput));
  const profilesDirectory = ensureOwnerDirectory(join(stateDir, "profiles"));
  return ensureOwnerDirectory(join(profilesDirectory, "bindings"));
}

function assertPermittedUpdate(existing: SessionProfileBinding, next: SessionProfileBinding): void {
  const existingFixed = { ...existing, resolvedStateAttestation: null };
  const nextFixed = { ...next, resolvedStateAttestation: null };
  if (JSON.stringify(existingFixed) !== JSON.stringify(nextFixed)) throw new Error("session profile binding immutable fields changed");
  if (existing.resolvedStateAttestation !== null && JSON.stringify(existing.resolvedStateAttestation) !== JSON.stringify(next.resolvedStateAttestation)) {
    throw new Error("session profile binding attestation is already fixed");
  }
  if (existing.resolvedStateAttestation !== null && next.resolvedStateAttestation === null) throw new Error("session profile binding attestation cannot be removed");
}

function validateBinding(value: unknown): asserts value is SessionProfileBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid session profile binding");
  if (!hasExactKeys(value, ["id", "sessionId", "channelId", "profileRevisionId", "profileSha256", "modelSkillSetId", "provider", "requestedModel", "effectiveModel", "executablePath", "executableVersion", "authAttestation", "resolvedStateAttestation", "boundAt"])) throw new Error("session profile binding contains unknown or missing fields");
  const row = value as Partial<SessionProfileBinding>;
  for (const field of ["id", "sessionId", "channelId", "profileRevisionId", "profileSha256", "modelSkillSetId", "requestedModel", "effectiveModel", "executablePath", "executableVersion", "boundAt"] as const) {
    if (typeof row[field] !== "string" || !row[field]) throw new Error(`invalid session profile binding ${field}`);
  }
  if (row.provider !== "codex" && row.provider !== "claude") throw new Error("invalid session profile binding provider");
  if (!/^[0-9a-f]{64}$/.test(row.profileSha256!) || !isAbsolute(row.executablePath!) || !Number.isFinite(Date.parse(row.boundAt!))) throw new Error("invalid session profile binding fixed evidence");
  if (!row.authAttestation || typeof row.authAttestation !== "object" || row.authAttestation.requiredMode !== "subscription") throw new Error("invalid session profile binding auth attestation");
  if (!hasExactKeys(row.authAttestation, ["requiredMode", "resolvedMode", "credentialSource", "accountPresent", "apiKeyEnvironmentVariables", "verifiedAt"])) throw new Error("session profile binding auth attestation contains unknown or missing fields");
  if (!["subscription", "api", "unknown"].includes(row.authAttestation.resolvedMode) || !["chatgptSubscription", "oauth", "keychain", "apiKey", "unknown"].includes(row.authAttestation.credentialSource) || typeof row.authAttestation.accountPresent !== "boolean" || typeof row.authAttestation.verifiedAt !== "string") throw new Error("invalid session profile binding auth evidence");
  if (!Array.isArray(row.authAttestation.apiKeyEnvironmentVariables) || !row.authAttestation.apiKeyEnvironmentVariables.every((item) => typeof item === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(item)) || new Set(row.authAttestation.apiKeyEnvironmentVariables).size !== row.authAttestation.apiKeyEnvironmentVariables.length || !Number.isFinite(Date.parse(row.authAttestation.verifiedAt))) throw new Error("invalid session profile binding auth environment evidence");
  if (row.resolvedStateAttestation !== null) {
    const attestation = row.resolvedStateAttestation;
    if (!attestation || typeof attestation !== "object" || !hasExactKeys(attestation, ["profileRevisionId", "profileSha256", "modelSkillSetId", "provider", "requestedModel", "effectiveModel", "inspectedAt", "surfaces"]) || attestation.profileRevisionId !== row.profileRevisionId || attestation.profileSha256 !== row.profileSha256 || attestation.modelSkillSetId !== row.modelSkillSetId || attestation.provider !== row.provider || attestation.requestedModel !== row.requestedModel || attestation.effectiveModel !== row.effectiveModel || typeof attestation.inspectedAt !== "string" || !Array.isArray(attestation.surfaces) || !attestation.surfaces.every(isSurfaceAttestation)) throw new Error("session profile binding resolved-state attestation mismatch");
  }
}

function isSurfaceAttestation(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) || !hasExactKeys(value, ["surface", "inspection", "items"])) return false;
  const row = value as Record<string, unknown>;
  if (!["instructions", "projectInstructions", "skills", "plugins", "hooks", "memories", "mcpServers", "apps", "webAccess", "subagents", "tools"].includes(String(row.surface)) || !["verified", "unsupported", "unavailable"].includes(String(row.inspection)) || !Array.isArray(row.items)) return false;
  return row.items.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || !hasExactKeys(item, ["id", "sha256"])) return false;
    const resolved = item as Record<string, unknown>;
    return typeof resolved.id === "string" && (resolved.sha256 === null || (typeof resolved.sha256 === "string" && /^[0-9a-f]{64}$/.test(resolved.sha256)));
  });
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

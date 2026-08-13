// SPDX-License-Identifier: Apache-2.0
import { constants, accessSync, chmodSync, closeSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readMachineIdentityStatus, resolveRoomsStateDir } from "../identity/machine-identity.js";

export const ROOM_PROVIDERS = ["codex", "claude", "grok", "gemini"] as const;
export type RoomsProvider = typeof ROOM_PROVIDERS[number];
export const PROVIDER_ADAPTERS = ["codex", "claude", "grok", "agy", "gemini"] as const;
export type ProviderAdapter = typeof PROVIDER_ADAPTERS[number];
export type ProviderDefaults = Readonly<Record<string, string | boolean>>;
export type ProviderHealth = Readonly<{ status: "available" | "missing" | "disabled"; checkedAt: string; message?: string }>;

export type ProviderRegistration = Readonly<{
  name: RoomsProvider;
  enabled: boolean;
  executable: string;
  adapter: ProviderAdapter;
  defaults: ProviderDefaults;
  health: ProviderHealth;
  discoveredAt: string;
  updatedAt: string;
}>;

export type ProviderRegistrationInput = Readonly<{
  executable?: string;
  adapter?: string;
  enabled?: boolean;
  defaults?: ProviderDefaults;
}>;

export type ProviderRegistry = Readonly<{ version: 2; authorityId: string; providers: readonly ProviderRegistration[]; updatedAt: string }>;

const CATALOG: Readonly<Record<RoomsProvider, { adapter: ProviderAdapter; executables: readonly string[] }>> = {
  codex: { adapter: "codex", executables: ["codex"] },
  claude: { adapter: "claude", executables: ["claude"] },
  grok: { adapter: "grok", executables: ["grok"] },
  gemini: { adapter: "agy", executables: ["agy", "gemini"] },
};

export function discoverProviders(stateDirInput?: string, environment: NodeJS.ProcessEnv = process.env): ProviderRegistry {
  const stateDir = initializedStateDir(stateDirInput);
  const existing = readRegistry(stateDir);
  const now = new Date().toISOString();
  const providers = ROOM_PROVIDERS.flatMap((name) => {
    const previous = existing?.providers.find((item) => item.name === name);
    const executable = discoverProviderExecutable(name, environment) ?? validExistingExecutable(previous?.executable, name);
    if (!executable) return previous ? [{ ...previous, health: health(previous.enabled, previous.executable, now) }] : [];
    const adapter = previous?.executable === executable
      ? previous.adapter
      : inferredAdapter(name, executable);
    return [{ name, enabled: previous?.enabled ?? true, executable, adapter, defaults: previous?.defaults ?? {}, health: health(previous?.enabled ?? true, executable, now), discoveredAt: previous?.discoveredAt ?? now, updatedAt: now }];
  });
  return writeRegistry(stateDir, providers, existing?.authorityId);
}

export function listRegisteredProviders(stateDirInput?: string): readonly ProviderRegistration[] {
  return readRegistry(initializedStateDir(stateDirInput))?.providers ?? [];
}

export function inspectProvider(name: RoomsProvider, stateDirInput?: string): ProviderRegistration {
  const item = listRegisteredProviders(stateDirInput).find((provider) => provider.name === name);
  if (!item) throw new Error(`Rooms provider ${name} is not registered`);
  return item;
}

export function registerProvider(name: RoomsProvider, input: string | ProviderRegistrationInput | undefined = undefined, stateDirInput?: string, environment: NodeJS.ProcessEnv = process.env): ProviderRegistry {
  const options = typeof input === "string" ? { executable: input } : input ?? {};
  const stateDir = initializedStateDir(stateDirInput);
  const executable = options.executable ? validateExecutable(options.executable, name) : discoverProviderExecutable(name, environment);
  if (!executable) throw new Error(`Rooms provider ${name} is unavailable on this machine; install it or pass --executable <absolute-path>`);
  const existing = readRegistry(stateDir);
  if (existing?.providers.some((item) => item.name === name)) throw new Error(`Rooms provider ${name} is already registered; use provider update`);
  const now = new Date().toISOString();
  const enabled = options.enabled ?? true;
  const item: ProviderRegistration = { name, enabled, executable, adapter: providerAdapter(options.adapter ?? inferredAdapter(name, executable)), defaults: validateDefaults(options.defaults ?? {}), health: health(enabled, executable, now), discoveredAt: now, updatedAt: now };
  return writeRegistry(stateDir, [...(existing?.providers ?? []), item].sort(byName), existing?.authorityId);
}

export function updateProvider(name: RoomsProvider, input: ProviderRegistrationInput, stateDirInput?: string): ProviderRegistry {
  const stateDir = initializedStateDir(stateDirInput);
  const existing = readRegistry(stateDir);
  const current = existing?.providers.find((item) => item.name === name);
  if (!current) throw new Error(`Rooms provider ${name} is not registered`);
  const now = new Date().toISOString();
  const executable = input.executable ? validateExecutable(input.executable, name) : current.executable;
  const enabled = input.enabled ?? current.enabled;
  const adapter = input.adapter
    ? providerAdapter(input.adapter)
    : input.executable
      ? inferredAdapter(name, executable)
      : current.adapter;
  const updated: ProviderRegistration = { ...current, enabled, executable, adapter, defaults: input.defaults === undefined ? current.defaults : validateDefaults(input.defaults), health: health(enabled, executable, now), updatedAt: now };
  return writeRegistry(stateDir, existing!.providers.map((item) => item.name === name ? updated : item), existing!.authorityId);
}

export function removeProvider(name: RoomsProvider, stateDirInput?: string): ProviderRegistry {
  const stateDir = initializedStateDir(stateDirInput);
  const existing = readRegistry(stateDir);
  return writeRegistry(stateDir, (existing?.providers ?? []).filter((item) => item.name !== name), existing?.authorityId);
}
export const unregisterProvider = removeProvider;

export function registeredProvider(name: RoomsProvider, stateDirInput?: string, environment: NodeJS.ProcessEnv = process.env): ProviderRegistration {
  const current = listRegisteredProviders(stateDirInput).find((item) => item.name === name);
  if (current) {
    if (!current.enabled) throw new Error(`Rooms provider ${name} is disabled`);
    try { validateExecutable(current.executable, name); return current; } catch { /* repair below */ }
  }
  if (current) {
    const executable = discoverProviderExecutable(name, environment);
    if (!executable) throw new Error(`Rooms provider ${name} is unavailable on this machine; update its executable path`);
    return updateProvider(name, { executable }, stateDirInput).providers.find((item) => item.name === name)!;
  }
  return registerProvider(name, undefined, stateDirInput, environment).providers.find((item) => item.name === name)!;
}

export function registeredProviderExecutable(name: RoomsProvider, stateDirInput?: string, environment: NodeJS.ProcessEnv = process.env): string {
  return registeredProvider(name, stateDirInput, environment).executable;
}

export function providerName(value: string): RoomsProvider {
  if (!(ROOM_PROVIDERS as readonly string[]).includes(value)) throw new Error(`Rooms supports providers: ${ROOM_PROVIDERS.join(", ")}`);
  return value as RoomsProvider;
}
export function providerAdapter(value: string): ProviderAdapter {
  if (!(PROVIDER_ADAPTERS as readonly string[]).includes(value)) throw new Error(`Rooms supports provider adapters: ${PROVIDER_ADAPTERS.join(", ")}`);
  return value as ProviderAdapter;
}

function inferredAdapter(name: RoomsProvider, executable: string): ProviderAdapter {
  if (name !== "gemini") return CATALOG[name].adapter;
  return executable.includes("@google/gemini-cli") || basename(executable).startsWith("gemini") ? "gemini" : "agy";
}

export function discoverProviderExecutable(name: RoomsProvider, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = String(environment[`ROOMS_${name.toUpperCase()}_BIN`] ?? "").trim();
  if (configured) return validateExecutable(configured, name);
  for (const command of CATALOG[name].executables) for (const directory of String(environment.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    try { return validateExecutable(join(directory, command), name); } catch { /* continue */ }
  }
  return undefined;
}

export function providerInterpreterCommand(executable: string): string | undefined {
  const header = shebang(executable);
  if (!header) return undefined;
  const [interpreter, ...rest] = header.split(/\s+/).filter(Boolean);
  if (!interpreter || interpreter.split("/").pop() !== "env") return undefined;
  return rest.find((token) => !token.startsWith("-") && !token.includes("="));
}
export function resolveOnPath(command: string, pathValue: string): string | undefined {
  for (const directory of pathValue.split(delimiter)) { if (!isAbsolute(directory)) continue; try { const candidate = join(directory, command); accessSync(candidate, constants.X_OK); return candidate; } catch { /* continue */ } }
  return undefined;
}
function shebang(executable: string): string | undefined { let descriptor: number; try { descriptor = openSync(executable, "r"); } catch { return undefined; } try { const buffer = Buffer.alloc(256); const read = readSync(descriptor, buffer, 0, buffer.length, 0); const first = buffer.subarray(0, read).toString("utf8").split("\n", 1)[0]; return first.startsWith("#!") ? first.slice(2).trim() : undefined; } catch { return undefined; } finally { closeSync(descriptor); } }
function initializedStateDir(input?: string): string { const stateDir = resolveRoomsStateDir(input ?? process.env.ROOMS_STATE_DIR); readMachineIdentityStatus(stateDir); return stateDir; }
function registryPath(stateDir: string): string { return join(stateDir, "providers.json"); }

function readRegistry(stateDir: string): ProviderRegistry | undefined {
  let raw: unknown; try { raw = JSON.parse(readFileSync(registryPath(stateDir), "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error(`Rooms provider registry is unreadable: ${String((error as Error).message ?? error)}`); }
  if (!raw || typeof raw !== "object") throw new Error("Rooms provider registry is invalid");
  const value = raw as Record<string, unknown>;
  if (![1, 2].includes(Number(value.version)) || typeof value.authorityId !== "string" || typeof value.updatedAt !== "string" || !Array.isArray(value.providers)) throw new Error("Rooms provider registry is invalid");
  if (value.authorityId !== readMachineIdentityStatus(stateDir).authorityId) throw new Error("Rooms provider registry belongs to another machine authority");
  const providers = value.providers.map((entry) => parseRegistration(entry, Number(value.version)));
  return { version: 2, authorityId: value.authorityId, providers, updatedAt: value.updatedAt };
}
function parseRegistration(entry: unknown, version: number): ProviderRegistration {
  if (!entry || typeof entry !== "object") throw new Error("Rooms provider registry contains an invalid provider");
  const item = entry as Record<string, unknown>; const name = providerName(String(item.name ?? ""));
  if (typeof item.executable !== "string" || !isAbsolute(item.executable) || typeof item.discoveredAt !== "string") throw new Error(`Rooms provider registry contains an invalid ${name} registration`);
  if (version === 1) return { name, enabled: true, executable: item.executable, adapter: CATALOG[name].adapter, defaults: {}, health: health(true, item.executable, item.discoveredAt), discoveredAt: item.discoveredAt, updatedAt: item.discoveredAt };
  const enabled = item.enabled; const updatedAt = item.updatedAt; const rawHealth = item.health as Record<string, unknown> | undefined;
  if (typeof enabled !== "boolean" || typeof updatedAt !== "string" || !rawHealth || !["available", "missing", "disabled"].includes(String(rawHealth.status)) || typeof rawHealth.checkedAt !== "string") throw new Error(`Rooms provider registry contains an invalid ${name} registration`);
  return { name, enabled, executable: item.executable, adapter: providerAdapter(String(item.adapter)), defaults: validateDefaults(item.defaults), health: { status: rawHealth.status as ProviderHealth["status"], checkedAt: rawHealth.checkedAt, ...(typeof rawHealth.message === "string" ? { message: rawHealth.message } : {}) }, discoveredAt: item.discoveredAt, updatedAt };
}
function writeRegistry(stateDir: string, providers: readonly ProviderRegistration[], authorityIdInput?: string): ProviderRegistry { const identity = readMachineIdentityStatus(stateDir); if (authorityIdInput && authorityIdInput !== identity.authorityId) throw new Error("Rooms provider registry belongs to another machine authority"); const registry: ProviderRegistry = { version: 2, authorityId: identity.authorityId, providers, updatedAt: new Date().toISOString() }; const path = registryPath(stateDir); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); const temporary = `${path}.tmp-${randomUUID()}`; writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); renameSync(temporary, path); chmodSync(path, 0o600); return registry; }
function validateExecutable(input: string, name: RoomsProvider): string { if (!isAbsolute(input)) throw new Error(`Rooms ${name} executable must be an absolute path`); accessSync(input, constants.X_OK); return realpathSync(input); }
function validExistingExecutable(input: string | undefined, name: RoomsProvider): string | undefined { if (!input) return undefined; try { return validateExecutable(input, name); } catch { return undefined; } }
function validateDefaults(input: unknown): ProviderDefaults { if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("provider defaults must be a JSON object"); const result: Record<string, string | boolean> = {}; for (const [key, value] of Object.entries(input)) { if (!key || !["string", "boolean"].includes(typeof value)) throw new Error(`invalid provider default ${key}`); result[key] = value as string | boolean; } return result; }
function health(enabled: boolean, executable: string, checkedAt: string): ProviderHealth { if (!enabled) return { status: "disabled", checkedAt }; try { accessSync(executable, constants.X_OK); return { status: "available", checkedAt }; } catch { return { status: "missing", checkedAt, message: "executable is not available" }; } }
function byName(left: ProviderRegistration, right: ProviderRegistration): number { return left.name.localeCompare(right.name); }

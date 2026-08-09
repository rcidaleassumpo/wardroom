import { constants, accessSync, chmodSync, closeSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readMachineIdentityStatus, resolveRoomsStateDir } from "../identity/machine-identity.js";

export const ROOM_PROVIDERS = ["codex", "claude", "grok"] as const;
export type RoomsProvider = typeof ROOM_PROVIDERS[number];

export type ProviderRegistration = Readonly<{
  name: RoomsProvider;
  executable: string;
  discoveredAt: string;
}>;

type ProviderRegistry = Readonly<{
  version: 1;
  authorityId: string;
  providers: readonly ProviderRegistration[];
  updatedAt: string;
}>;

export function discoverProviders(stateDirInput?: string, environment: NodeJS.ProcessEnv = process.env): ProviderRegistry {
  const stateDir = initializedStateDir(stateDirInput);
  const existing = readRegistry(stateDir);
  const discoveredAt = new Date().toISOString();
  const providers = ROOM_PROVIDERS.flatMap((name) => {
    const previous = existing?.providers.find((item) => item.name === name)?.executable;
    const executable = discoverProviderExecutable(name, environment) ?? validExistingExecutable(previous, name);
    return executable ? [{ name, executable, discoveredAt }] : [];
  });
  return writeRegistry(stateDir, providers, existing?.authorityId);
}

export function listRegisteredProviders(stateDirInput?: string): readonly ProviderRegistration[] {
  const stateDir = initializedStateDir(stateDirInput);
  return readRegistry(stateDir)?.providers ?? [];
}

export function registerProvider(name: RoomsProvider, executableInput?: string, stateDirInput?: string, environment: NodeJS.ProcessEnv = process.env): ProviderRegistry {
  const stateDir = initializedStateDir(stateDirInput);
  const executable = executableInput ? validateExecutable(executableInput, name) : discoverProviderExecutable(name, environment);
  if (!executable) throw new Error(`Rooms provider ${name} is unavailable on this machine; install it or pass --executable <absolute-path>`);
  const existing = readRegistry(stateDir);
  const providers = [...(existing?.providers ?? []).filter((item) => item.name !== name), { name, executable, discoveredAt: new Date().toISOString() }]
    .sort((left, right) => left.name.localeCompare(right.name));
  return writeRegistry(stateDir, providers, existing?.authorityId);
}

export function unregisterProvider(name: RoomsProvider, stateDirInput?: string): ProviderRegistry {
  const stateDir = initializedStateDir(stateDirInput);
  const existing = readRegistry(stateDir);
  return writeRegistry(stateDir, (existing?.providers ?? []).filter((item) => item.name !== name), existing?.authorityId);
}

/** Resolves a launch target from machine-owned state, discovering it once when absent. */
export function registeredProviderExecutable(name: RoomsProvider, stateDirInput?: string, environment: NodeJS.ProcessEnv = process.env): string {
  const current = listRegisteredProviders(stateDirInput).find((item) => item.name === name);
  if (current) {
    try { return validateExecutable(current.executable, name); }
    catch { /* stale registrations are repaired by discovery below */ }
  }
  const registry = registerProvider(name, undefined, stateDirInput, environment);
  return registry.providers.find((item) => item.name === name)!.executable;
}

export function providerName(value: string): RoomsProvider {
  if (!(ROOM_PROVIDERS as readonly string[]).includes(value)) throw new Error(`Rooms supports providers: ${ROOM_PROVIDERS.join(", ")}`);
  return value as RoomsProvider;
}

export function discoverProviderExecutable(name: RoomsProvider, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = String(environment[`ROOMS_${name.toUpperCase()}_BIN`] ?? "").trim();
  if (configured) return validateExecutable(configured, name);
  for (const directory of String(environment.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try { return validateExecutable(candidate, name); }
    catch { /* continue through PATH */ }
  }
  return undefined;
}

/**
 * Reports the interpreter a registered provider resolves through PATH at exec
 * time. Providers packaged as an interpreted script carry a
 * `#!/usr/bin/env <interpreter>` header, so launching them needs more than the
 * launchd default PATH. Natively compiled providers need nothing and return
 * undefined.
 */
export function providerInterpreterCommand(executable: string): string | undefined {
  const header = shebang(executable);
  if (!header) return undefined;
  const [interpreter, ...rest] = header.split(/\s+/).filter(Boolean);
  if (!interpreter || interpreter.split("/").pop() !== "env") return undefined;
  return rest.find((token) => !token.startsWith("-") && !token.includes("="));
}

/** Resolves an executable command against a specific PATH value. */
export function resolveOnPath(command: string, pathValue: string): string | undefined {
  for (const directory of pathValue.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, command);
    try { accessSync(candidate, constants.X_OK); return candidate; }
    catch { /* continue through PATH */ }
  }
  return undefined;
}

function shebang(executable: string): string | undefined {
  let descriptor: number;
  try { descriptor = openSync(executable, "r"); } catch { return undefined; }
  try {
    const buffer = Buffer.alloc(256);
    const read = readSync(descriptor, buffer, 0, buffer.length, 0);
    const first = buffer.subarray(0, read).toString("utf8").split("\n", 1)[0];
    return first.startsWith("#!") ? first.slice(2).trim() : undefined;
  } catch { return undefined; }
  finally { closeSync(descriptor); }
}

function initializedStateDir(stateDirInput?: string): string {
  const requested = stateDirInput ?? process.env.ROOMS_STATE_DIR;
  const stateDir = resolveRoomsStateDir(requested);
  readMachineIdentityStatus(stateDir);
  return stateDir;
}

function registryPath(stateDir: string): string { return join(stateDir, "providers.json"); }

function readRegistry(stateDir: string): ProviderRegistry | undefined {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(registryPath(stateDir), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Rooms provider registry is unreadable: ${String((error as Error).message ?? error)}`);
  }
  if (!raw || typeof raw !== "object") throw new Error("Rooms provider registry is invalid");
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || typeof value.authorityId !== "string" || typeof value.updatedAt !== "string" || !Array.isArray(value.providers)) throw new Error("Rooms provider registry is invalid");
  const identity = readMachineIdentityStatus(stateDir);
  if (value.authorityId !== identity.authorityId) throw new Error("Rooms provider registry belongs to another machine authority");
  const providers = value.providers.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Rooms provider registry contains an invalid provider");
    const item = entry as Record<string, unknown>;
    const name = providerName(String(item.name ?? ""));
    if (typeof item.executable !== "string" || !isAbsolute(item.executable) || typeof item.discoveredAt !== "string") throw new Error(`Rooms provider registry contains an invalid ${name} registration`);
    return { name, executable: item.executable, discoveredAt: item.discoveredAt };
  });
  return { version: 1, authorityId: value.authorityId, providers, updatedAt: value.updatedAt };
}

function writeRegistry(stateDir: string, providers: readonly ProviderRegistration[], authorityIdInput?: string): ProviderRegistry {
  const identity = readMachineIdentityStatus(stateDir);
  if (authorityIdInput && authorityIdInput !== identity.authorityId) throw new Error("Rooms provider registry belongs to another machine authority");
  const registry: ProviderRegistry = { version: 1, authorityId: identity.authorityId, providers, updatedAt: new Date().toISOString() };
  const path = registryPath(stateDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return registry;
}

function validateExecutable(input: string, name: RoomsProvider): string {
  if (!isAbsolute(input)) throw new Error(`Rooms ${name} executable must be an absolute path`);
  accessSync(input, constants.X_OK);
  return realpathSync(input);
}

function validExistingExecutable(input: string | undefined, name: RoomsProvider): string | undefined {
  if (!input) return undefined;
  try { return validateExecutable(input, name); }
  catch { return undefined; }
}

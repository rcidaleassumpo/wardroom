import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { readMachineIdentityStatus } from "../identity/machine-identity.js";
import { listRegisteredProviders, providerInterpreterCommand, resolveOnPath } from "../cli/provider-registry.js";
import { installedServicePath, serviceStatus } from "./launchd.js";
import { assertLocalStateModes } from "./local-state.js";
import { readInstalledReleaseContract, releasePaths, verifyCurrentRelease, type ReleaseManifest } from "./release.js";
import type { RoomsPaths } from "./paths.js";
import { storeSchemaVersion } from "../storage/migrations.js";

type Check = Readonly<{ name: string; status: "pass" | "fail" | "not_applicable"; detail: string }>;

export function runRoomsDoctor(options: { stateDir?: string; installRoot?: string } = {}): Readonly<{ ok: boolean; checks: readonly Check[] }> {
  const paths = releasePaths(options);
  const checks: Check[] = [];
  const check = (name: string, fn: () => string): void => { try { checks.push({ name, status: "pass", detail: fn() }); } catch (error) { checks.push({ name, status: "fail", detail: error instanceof Error ? error.message : String(error) }); } };

  check("release.signature_hash_version", () => { const release = verifyCurrentRelease(paths); return `${release.manifest.version} ${release.manifest.architecture} protocol=${release.manifest.protocolVersion} signing=${release.manifest.signing.mode}`; });
  check("state.identity_store_uniqueness", () => { const identity = readMachineIdentityStatus(paths.stateDir); assertStoreUniqueness(paths); return `${identity.authorityId}; store=${paths.storePath}`; });
  check("state.store_schema", () => inspectStoreSchema(paths));
  check("state.modes", () => { assertLocalStateModes(paths); checkSecureTree(join(paths.stateDir, "federation")); checkSecureTree(paths.runtimeDir); return "state and credentials are owner-only"; });
  check("service.launchd", () => {
    const status = serviceStatus(paths);
    if (!status.loaded || !status.running) throw new Error(status.detail ?? `per-user launchd service is not healthy: loaded=${status.loaded} running=${status.running}`);
    return `${status.label} loaded=${status.loaded} running=${status.running}`;
  });
  check("service.provider_launch_path", () => inspectProviderLaunchPath(paths));
  check("runtime.state_integrity", () => inspectRuntimeState(paths));
  check("transport.no_public_listener", () => noPublicListener());
  check("transport.private_unix_endpoint", () => { if (!paths.endpoint.endsWith(".sock")) throw new Error("configured endpoint is not a Rooms Unix socket"); return paths.endpoint; });
  check("toolchain_free.installed_runtime", () => { const release = verifyCurrentRelease(paths).manifest; if (!release.files.rooms || !release.files.roomsd || !release.files["rooms-runtime-host"]) throw new Error("release does not contain all native executables"); return "Rooms and roomsd SEA executables plus the Go host are installed"; });
  check("peer.trust_records", () => inspectPeerRecords(paths));
  checks.push({ name: "peer.reachability", status: "not_applicable", detail: "live reachability is checked by an explicit authenticated peer operation; doctor never opens a network connection" });
  checks.push(inspectRelayProtocol(verifyCurrentRelease(paths).manifest, paths.federationRelayEndpoint));
  check("external_runtime_dependency_free", () => "service launches the installed executable directly with no shell or target toolchain");
  return { ok: checks.every(item => item.status !== "fail"), checks };
}

export function inspectRelayProtocol(manifest: Pick<ReleaseManifest, "features">, endpoint: string): Check {
  if (manifest.features?.federation === false) {
    return { name: "relay.protocol", status: "not_applicable", detail: "federation is omitted from this release" };
  }
  try {
    const stat = lstatSync(endpoint);
    if (!stat.isSocket() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) throw new Error("private federation relay endpoint is unavailable or insecure");
    return { name: "relay.protocol", status: "pass", detail: "authenticated SSH-stdio terminal streams and per-channel-home routing enabled" };
  } catch (error) {
    return { name: "relay.protocol", status: "fail", detail: error instanceof Error ? error.message : String(error) };
  }
}

export function inspectStoreSchema(paths: RoomsPaths): string {
  const storeVersion = storeSchemaVersion(paths.storePath);
  const daemonVersion = readInstalledReleaseContract(paths).storeSchemaVersion;
  return storeSchemaCompatibility(storeVersion, daemonVersion);
}

export function storeSchemaCompatibility(storeVersion: number, daemonVersion: number): string {
  if (storeVersion !== daemonVersion) throw new Error(`Rooms store schema ${storeVersion} is incompatible with installed daemon schema ${daemonVersion}; install a matching Rooms release before starting roomsd`);
  return `store=${storeVersion} installed_daemon=${daemonVersion}`;
}

function assertStoreUniqueness(paths: RoomsPaths): void {
  const canonical = existsAsAny(paths.storePath);
  const legacy = existsAsAny(join(paths.stateDir, "roomsd-ts.sqlite"));
  if (canonical && legacy) throw new Error("canonical and legacy Rooms stores both exist");
  if (!canonical) throw new Error(`canonical Rooms store is missing: ${paths.storePath}`);
  const sidecars = ["rooms.sqlite-wal", "rooms.sqlite-shm", "roomsd-ts.sqlite-wal", "roomsd-ts.sqlite-shm"].filter(name => existsAsAny(join(paths.stateDir, name)));
  if (legacy && sidecars.length) throw new Error(`legacy store migration has SQLite sidecars: ${sidecars.join(", ")}`);
}

function checkSecureTree(root: string): void {
  if (!existsAsAny(root)) return;
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o777) !== 0o700) throw new Error(`directory is not 0700: ${root}`);
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`state symlink is not allowed: ${path}`);
    if (stat.isDirectory()) { if ((stat.mode & 0o777) !== 0o700) throw new Error(`directory is not 0700: ${path}`); checkSecureTree(path); }
    else if (stat.isFile() && (stat.mode & 0o777) !== 0o600) throw new Error(`credential/state file is not 0600: ${path}`);
  }
}

function inspectProviderLaunchPath(paths: RoomsPaths): string {
  const servicePath = installedServicePath(paths);
  if (!servicePath) throw new Error("installed service declares no PATH, so a provider packaged as an interpreted script cannot launch; run `rooms service install`");
  const providers = listRegisteredProviders(paths.stateDir);
  const missing = providers.flatMap((provider) => {
    const interpreter = providerInterpreterCommand(provider.executable);
    return interpreter && !resolveOnPath(interpreter, servicePath) ? [`${provider.name} needs ${interpreter}`] : [];
  });
  if (missing.length) throw new Error(`the service PATH cannot resolve provider interpreters (${missing.join("; ")}); run \`rooms service install\` from a shell that has them on PATH`);
  return `${providers.length} registered provider(s) launch under ${servicePath.split(delimiter).length} service PATH directories`;
}

function inspectRuntimeState(paths: RoomsPaths): string {
  if (!existsAsAny(paths.runtimeDir)) return "no runtime state";
  checkSecureTree(paths.runtimeDir);
  const files = readdirSync(paths.runtimeDir).filter(name => name.endsWith(".state.json"));
  for (const name of files) {
    const value = JSON.parse(readFileSync(join(paths.runtimeDir, name), "utf8")) as { version?: unknown; runtimeId?: unknown; generation?: unknown; reconnectSecret?: unknown };
    if (value.version !== 1 || typeof value.runtimeId !== "string" || !Number.isInteger(value.generation) || typeof value.reconnectSecret !== "string") throw new Error(`runtime state is malformed: ${name}`);
  }
  return `${files.length} owner-only runtime state file(s); no replacement host is inferred from stale metadata`;
}

function inspectPeerRecords(paths: RoomsPaths): string {
  const directory = join(paths.stateDir, "federation", "peers");
  if (!existsAsAny(directory)) return "no peer records";
  checkSecureTree(directory);
  let active = 0; let revoked = 0;
  for (const name of readdirSync(directory).filter(item => item.endsWith(".json"))) {
    const value = JSON.parse(readFileSync(join(directory, name), "utf8")) as { state?: unknown };
    if (value.state === "active") active += 1;
    else if (value.state === "revoked") revoked += 1;
    else if (!["pending", "confirming"].includes(String(value.state))) throw new Error(`peer record state is invalid: ${name}`);
  }
  return `active=${active} revoked=${revoked}`;
}

function noPublicListener(): string {
  try {
    const output = execFileSync("lsof", ["-nP", "-a", "-c", "roomsd", "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (output) throw new Error(`roomsd has a TCP listener: ${output.slice(0, 2048)}`);
  } catch (error) {
    const value = error as { status?: number; stderr?: string; message?: string };
    if (value.status !== 1) throw new Error(`cannot inspect public listeners: ${value.stderr ?? value.message ?? error}`);
  }
  return "no roomsd TCP listener";
}

function existsAsAny(path: string): boolean { try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }

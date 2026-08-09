import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, relative, resolve } from "node:path";
import { releasePaths, verifyCurrentRelease } from "./release.js";
import { assertLocalStateModes } from "./local-state.js";
import type { RoomsPaths } from "./paths.js";

export type RoomsServiceCommand = "install" | "start" | "stop" | "restart" | "status" | "uninstall";

export function runRoomsService(command: RoomsServiceCommand, options: { stateDir?: string; installRoot?: string } = {}): unknown {
  const paths = releasePaths(options);
  if (command === "status") return serviceStatus(paths);
  if (command === "install") return installService(paths);
  if (command === "uninstall") return uninstallService(paths);
  const domain = launchDomain();
  const target = serviceTarget(paths, domain);
  if (command === "start") launchctl(["kickstart", target]);
  else if (command === "restart") launchctl(["kickstart", "-k", target]);
  else if (command === "stop") launchctl(["kill", "SIGTERM", target]);
  return serviceStatus(paths);
}

export function installService(paths: RoomsPaths): unknown {
  const release = verifyCurrentRelease(paths);
  assertLocalStateModes(paths);
  mkdirSync(paths.launchAgentDir, { recursive: true, mode: 0o700 });
  const plist = launchAgentPlist(paths, release.directory);
  writeAtomic(paths.launchAgentPlist, plist, 0o600);
  const domain = launchDomain();
  const target = serviceTarget(paths, domain);
  launchctl(["bootout", target], true);
  // A prior operator or retired installer may have disabled this label. An
  // explicit install owns making the service launchable again.
  launchctl(["enable", target]);
  bootstrapService(domain, paths.launchAgentPlist);
  waitForServiceReady(paths);
  try { unlinkSync(paths.drainMarker); } catch { /* no pending drain */ }
  return { installed: true, label: paths.serviceLabel, program: `${paths.currentLink}/roomsd`, release: release.manifest.version, plist: paths.launchAgentPlist };
}

export function uninstallService(paths: RoomsPaths): unknown {
  const domain = launchDomain();
  launchctl(["bootout", serviceTarget(paths, domain)], true);
  try { unlinkSync(paths.launchAgentPlist); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return { uninstalled: true, label: paths.serviceLabel, plist: paths.launchAgentPlist };
}

export function serviceStatus(paths: RoomsPaths): Readonly<{ label: string; loaded: boolean; running: boolean; plist: string; program: string; release: string | null; detail?: string }> {
  let release: string | null = null;
  try { release = verifyCurrentRelease(paths).manifest.version; } catch { /* reported through release doctor check */ }
  const result = launchctl(["print", serviceTarget(paths, launchDomain())], true);
  return { label: paths.serviceLabel, loaded: result.ok, running: result.ok && /\bstate\s*=\s*running\b/.test(result.output), plist: paths.launchAgentPlist, program: `${paths.currentLink}/roomsd`, release, ...(result.ok ? {} : { detail: result.error }) };
}

export function serviceTarget(paths: RoomsPaths, domain: string): string { return `${domain}/${paths.serviceLabel}`; }

export function waitForServiceReady(
  paths: RoomsPaths,
  options: Readonly<{ attempts?: number; isReady?: () => boolean; pause?: () => void }> = {},
): void {
  const attempts = options.attempts ?? 100;
  const isReady = options.isReady ?? (() => serviceEndpointReady(paths));
  const pause = options.pause ?? (() => execFileSync("/bin/sleep", ["0.05"], { stdio: "ignore" }));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (isReady()) return;
    if (attempt < attempts - 1) pause();
  }
  throw new Error(`Rooms service ${paths.serviceLabel} did not become ready at ${paths.endpoint}`);
}

/** launchd starts a per-user service with only these directories on PATH. */
const LAUNCHD_DEFAULT_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;

/**
 * Providers live under operator-owned prefixes, and some ship an interpreted
 * entry point that resolves its interpreter through PATH when Rooms execs it.
 * The service therefore records the installing operator's directories: with the
 * launchd default PATH alone, roomsd launches such a provider and the exec
 * fails with "env: <interpreter>: No such file or directory".
 */
export function serviceLaunchPath(environment: NodeJS.ProcessEnv = process.env): string {
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const directory of [...String(environment.PATH ?? "").split(delimiter), ...LAUNCHD_DEFAULT_PATH]) {
    if (!isAbsolute(directory) || seen.has(directory)) continue;
    seen.add(directory);
    try { if (statSync(directory).isDirectory()) directories.push(directory); } catch { /* this machine does not have the directory */ }
  }
  if (!directories.length) throw new Error("Rooms service PATH resolved to no usable directory");
  return directories.join(delimiter);
}

/** Reads the PATH the installed service actually launches providers with. */
export function installedServicePath(paths: RoomsPaths): string | undefined {
  const result = plutil(["-extract", "EnvironmentVariables.PATH", "raw", "-o", "-", paths.launchAgentPlist]);
  const value = result.ok ? result.output.trim() : "";
  return value || undefined;
}

export function launchAgentPlist(paths: RoomsPaths, releaseDirectory: string, environment: NodeJS.ProcessEnv = process.env): string {
  const values: Record<string, string> = {
    label: paths.serviceLabel,
    program: `${paths.currentLink}/roomsd`,
    stateDir: paths.stateDir,
    endpoint: paths.endpoint,
    store: paths.storePath,
    runtimeHost: `${paths.currentLink}/rooms-runtime-host`,
    stdout: `${paths.logsDir}/roomsd.stdout.log`,
    stderr: `${paths.logsDir}/roomsd.stderr.log`,
    home: homedir(),
    path: serviceLaunchPath(environment),
  };
  // releaseDirectory is intentionally checked here so future callers cannot silently
  // generate a service for an unverified arbitrary binary.
  const directory = realpathSync(releaseDirectory);
  const releaseRoot = realpathSync(paths.releaseRoot);
  const relativeDirectory = relative(releaseRoot, directory);
  if (relativeDirectory.startsWith("..") || resolve(releaseRoot, relativeDirectory) !== directory) throw new Error("Rooms launchd program must be inside the verified release root");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n` +
    `<key>Label</key><string>${xml(values.label)}</string>\n` +
    `<key>ProgramArguments</key><array><string>${xml(values.program)}</string></array>\n` +
    `<key>EnvironmentVariables</key><dict><key>ROOMS_STATE_DIR</key><string>${xml(values.stateDir)}</string><key>ROOMS_ENDPOINT</key><string>${xml(values.endpoint)}</string><key>ROOMS_DB_PATH</key><string>${xml(values.store)}</string><key>ROOMS_RUNTIME_HOST_BIN</key><string>${xml(values.runtimeHost)}</string><key>HOME</key><string>${xml(values.home)}</string><key>PATH</key><string>${xml(values.path)}</string></dict>\n` +
    `<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n` +
    `<key>ProcessType</key><string>Interactive</string>\n` +
    `<key>StandardOutPath</key><string>${xml(values.stdout)}</string><key>StandardErrorPath</key><string>${xml(values.stderr)}</string>\n` +
    `</dict></plist>\n`;
}

function launchDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  if (!uid) throw new Error("Rooms per-user launchd requires a non-root login user");
  return `gui/${uid}`;
}

function serviceEndpointReady(paths: RoomsPaths): boolean {
  const status = launchctl(["print", serviceTarget(paths, launchDomain())], true);
  if (!status.ok || !/\bstate\s*=\s*running\b/.test(status.output)) return false;
  try {
    const endpoint = lstatSync(paths.endpoint);
    return endpoint.isSocket() && !endpoint.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function launchctl(args: readonly string[], allowFailure = false): { ok: boolean; output: string; error: string } {
  try { return { ok: true, output: execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), error: "" }; }
  catch (error) {
    if (!allowFailure) throw new Error(`launchctl ${args.join(" ")} failed: ${message(error)}`);
    return { ok: false, output: "", error: message(error) };
  }
}

/**
 * launchd can briefly reject bootstrap with error 5 after a successful
 * bootout while it finishes removing the prior job. Retry that bounded local
 * transition; the final launchctl error remains the caller-visible failure.
 */
function bootstrapService(domain: string, plist: string): void {
  const args = ["bootstrap", domain, plist] as const;
  // On real machines launchd can keep the old job transition in flight for
  // several seconds after bootout. Keep this bounded, but long enough that an
  // ordinary install does not require the operator to run it twice.
  const attempts = 12;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = launchctl(args, true);
    if (result.ok) return;
    if (attempt < attempts - 1) execFileSync("/bin/sleep", ["0.5"], { stdio: "ignore" });
  }
  launchctl(args);
}

function plutil(args: readonly string[]): { ok: boolean; output: string } {
  try { return { ok: true, output: execFileSync("plutil", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch { return { ok: false, output: "" }; }
}

function writeAtomic(path: string, value: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, value, { encoding: "utf8", mode });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}
function xml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }
function message(error: unknown): string { const value = error as { stderr?: Buffer | string; message?: string }; return String(value.stderr ?? value.message ?? error).trim().slice(0, 4096); }

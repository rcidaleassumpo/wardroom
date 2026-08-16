// SPDX-License-Identifier: Apache-2.0
import { startNativeRooms, type NativeRoomsRuntime, type NativeRuntimeDependencies, type NativeRuntimeOptions } from "./runtime.js";
import { createNativeComposition } from "./composition.js";
import { restoreInterruptedSessions } from "./restore.js";
import { RuntimeRepository } from "../../storage/runtime-repository.js";
import { prepareCanonicalStorePath } from "../../storage/store-migration.js";
import { roomsPaths } from "../../provisioning/paths.js";
import { loadFederationModule } from "../../federation-loader.js";
import { RoomsSchemaVersionError } from "../../storage/migrations.js";

export function nativeRuntimeOptions(env: NodeJS.ProcessEnv = process.env): NativeRuntimeOptions {
  const paths = roomsPaths(env.ROOMS_STATE_DIR, env.ROOMS_INSTALL_ROOT);
  const transport = env.ROOMS_TRANSPORT ?? "unix";
  const endpoint = env.ROOMS_ENDPOINT ?? paths.endpoint;
  const databasePath = prepareCanonicalStorePath(env.ROOMS_DB_PATH ?? paths.storePath);
  if (transport === "unix") {
    if (!endpoint) throw new Error("ROOMS_ENDPOINT is required for unix native runtime");
    return { endpoint: { kind: "unix", path: endpoint }, databasePath };
  }
  if (transport === "named-pipe") {
    if (!endpoint) throw new Error("ROOMS_ENDPOINT is required for named-pipe native runtime");
    return { endpoint: { kind: "namedPipe", name: endpoint }, databasePath };
  }
  if (transport === "tcp") {
    const port = Number(env.ROOMS_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("ROOMS_PORT must be a valid TCP port");
    return { endpoint: { kind: "tcp", host: env.ROOMS_HOST ?? "127.0.0.1", port }, databasePath };
  }
  throw new Error(`unsupported ROOMS_TRANSPORT: ${transport}`);
}

export function startNativeFromEnvironment(deps: NativeRuntimeDependencies, env: NodeJS.ProcessEnv = process.env): Promise<NativeRoomsRuntime> {
  return startNativeRooms(nativeRuntimeOptions(env), deps);
}

/**
 * Run the daemon: local channel/session/runtime authority always; the
 * federation relay server and channel subscriptions only when a federation
 * module is present (registered by a federation-enabled entrypoint or
 * resolved from the tree).
 */
export async function runNativeDaemon(): Promise<void> {
  const options = nativeRuntimeOptions();
  const paths = roomsPaths(process.env.ROOMS_STATE_DIR);
  const federation = await loadFederationModule();
  const composition = createNativeComposition(options.databasePath, process.env.ROOMS_RUNTIME_HOST_BIN, paths.stateDir, federation ?? undefined);
  // Record hosts that died while this daemon was down before the first caller
  // can read runtime state, so nothing is told an absent runtime is running.
  await composition.runtimeService.reconcileLocalRuntimeHosts()
    .catch((error) => { console.error(`Rooms runtime reconciliation failed: ${error instanceof Error ? error.message : String(error)}`); });
  const subscriptions = federation ? federation.startFederatedChannelSubscriptions({ stateDir: paths.stateDir, runtimeService: composition.runtimeService }) : { close: () => undefined };
  const deps: NativeRuntimeDependencies = { openDatabase: () => composition.database, createServiceHandler: () => composition.handler, bindRoomsService: async (handler, endpoint) => (await import("../../transports/unix/index.js")).bindRoomsService(handler, endpoint) };
  await Promise.all([
    startNativeRooms({ ...options, installSignalHandlers: false }, deps),
    federation && composition.relayHandlerFactory
      ? federation.bindLocalRelayServer(paths.federationRelayEndpoint, paths.stateDir, composition.relayHandlerFactory)
      : Promise.resolve({ close: () => undefined }),
  ]).then(([runtime, relay]) => {
    // Restore runs after the endpoint is live, so a login that brings back many
    // providers never delays the first client and never blocks the daemon.
    if (process.env.ROOMS_RESTORE_INTERRUPTED !== "0") {
      void restoreInterruptedSessions({
        runtimeService: composition.runtimeService,
        runtimes: new RuntimeRepository(composition.database.db),
        database: composition.database,
        homeAuthorityId: composition.homeAuthorityId,
        stateDir: paths.stateDir,
      }).catch((error) => { console.error(`Rooms session restore failed: ${error instanceof Error ? error.message : String(error)}`); });
    }
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      void Promise.allSettled([runtime.close(), Promise.resolve(relay.close()), Promise.resolve(subscriptions.close())]).then(() => process.exit(0));
    };
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
  }).catch((error) => { void subscriptions.close(); reportDaemonFailure(error); });
}

export function daemonFailureExitCode(error: unknown): number {
  return error instanceof RoomsSchemaVersionError && error.storeVersion > error.supportedVersion ? 0 : 1;
}

function reportDaemonFailure(error: unknown): void {
  const permanentSchemaMismatch = daemonFailureExitCode(error) === 0;
  console.error(permanentSchemaMismatch
    ? `Rooms permanent startup error: ${error instanceof Error ? error.message : String(error)}; launchd will not retry until Rooms is upgraded`
    : error);
  process.exitCode = permanentSchemaMismatch ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runNativeDaemon().catch(reportDaemonFailure);
}

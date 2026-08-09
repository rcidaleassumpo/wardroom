import type { RoomsCLIBackend } from "./cli/backend.js";
import type { RoomsRuntimeService } from "./runtime/service.js";
import type { FederationCompositionPlug } from "./runtime/native/composition.js";
import type { AuthorityId } from "./identity/authority.js";

/**
 * The federation seam. Core never imports src/federation (or the federation
 * CLI files) statically: it asks this loader, and a tree without those files
 * resolves to null at runtime and stays a single-machine build. The structural
 * types below mirror src/federation/plug.ts, which is the only module the
 * dynamic path resolves.
 */
export type FederationModule = FederationCompositionPlug & Readonly<{
  bindLocalRelayServer(endpoint: string, stateDir: string, relayHandlerFactory: () => unknown): Promise<Readonly<{ close(): unknown }>>;
  startFederatedChannelSubscriptions(input: Readonly<{ stateDir: string; runtimeService: RoomsRuntimeService }>): Readonly<{ close(): unknown }>;
  readMachineRoute(authorityId: AuthorityId, stateDirInput?: string): Readonly<{ sshHost?: string; remoteStateDir?: string }> | undefined;
  readActivePeerTrust(authorityIdInput: string, stateDirInput?: string): Readonly<{ transportPolicy: Readonly<{ kind: string; sshDestination: string }> }> | null;
  FEDERATION_PEER_COMMANDS: readonly string[];
  FEDERATION_ENROLL_COMMANDS: readonly string[];
  FEDERATION_RELAY_COMMANDS: readonly string[];
  FEDERATION_CHANNEL_COMMANDS: readonly string[];
  FEDERATION_CAPABILITY_COMMANDS: readonly string[];
  runRoomsFederationPeerCommand(command: string, flags: ReadonlyMap<string, string>): Promise<unknown>;
  runRoomsFederationEnrollCommand(command: string, flags: ReadonlyMap<string, string>): unknown;
  runRoomsFederationRelayCommand(command: string, flags: ReadonlyMap<string, string>): Promise<unknown>;
  runRoomsFederationChannelCommand(command: string, flags: ReadonlyMap<string, string>): Promise<unknown>;
  runRoomsFederationCapabilityCommand(command: string, flags: ReadonlyMap<string, string>): unknown;
  listMachines(stateDir?: string): unknown;
  configureMachineRoute(authorityId: AuthorityId, flags: ReadonlyMap<string, string>): unknown;
  inspectMachine(authorityIdInput: string | undefined, backend: RoomsCLIBackend, options?: Readonly<{ stateDir?: string; includeEnded?: boolean; sshHost?: string; remoteStateDir?: string }>): Promise<unknown>;
  locateSession(sessionIdInput: string, backend: RoomsCLIBackend, options?: Readonly<{ stateDir?: string; includeEnded?: boolean }>): Promise<unknown>;
  runInteractiveRemoteRuntimeAttach(input: Readonly<{ sessionId: string; sshHost: string; peerAuthorityId: AuthorityId; capabilityFile?: string; localStateDir?: string; remoteStateDir?: string; mode: "observe" | "controller"; outputCursor?: string }>): Promise<void>;
}>;

let registered: FederationModule | null | undefined;
let loaded: Promise<FederationModule | null> | undefined;

/**
 * Bundled builds (Node SEA via esbuild) cannot resolve the computed dynamic
 * import below; their federation-enabled entrypoints register the plug
 * statically before the daemon or CLI starts.
 */
export function registerFederationModule(module: FederationModule): void {
  registered = module;
}

export function loadFederationModule(): Promise<FederationModule | null> {
  if (registered !== undefined) return Promise.resolve(registered);
  loaded ??= (async () => {
    // Computed specifier: neither tsc nor a bundler resolves it statically,
    // so deleting src/federation/ keeps typecheck and build green.
    const specifier = ["./federation", "plug.js"].join("/");
    try {
      return await import(specifier) as FederationModule;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || error instanceof TypeError) return null;
      throw error;
    }
  })();
  return loaded;
}

/** CLI surfaces that require federation fail with one consistent error. */
export async function requireFederationModule(capability: string): Promise<FederationModule> {
  const module = await loadFederationModule();
  if (!module) throw new Error(`${capability} requires federation, which is not available in this single-machine build`);
  return module;
}

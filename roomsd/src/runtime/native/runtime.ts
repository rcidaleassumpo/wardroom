import type { RoomsServiceHandler } from "../../api/service/handler.js";
import type { RoomsEndpoint, RoomsListener } from "../../transports/unix/index.js";

export interface NativeRuntimeOptions {
  endpoint: RoomsEndpoint;
  databasePath: string;
  installSignalHandlers?: boolean;
}

export interface NativeServiceComposition { close?(): void | Promise<void>; }

export interface NativeRuntimeDependencies {
  openDatabase(path: string): NativeServiceComposition;
  createServiceHandler(config: { database: NativeServiceComposition; databasePath: string }): RoomsServiceHandler;
  bindRoomsService(handler: RoomsServiceHandler, endpoint: RoomsEndpoint): Promise<RoomsListener>;
}

export interface NativeRoomsRuntime {
  health(): ReturnType<RoomsListener["health"]>;
  close(): Promise<void>;
}

/** Compose the shared handler and bind one local endpoint; own lifecycle only. */
export async function startNativeRooms(options: NativeRuntimeOptions, deps: NativeRuntimeDependencies): Promise<NativeRoomsRuntime> {
  const database = deps.openDatabase(options.databasePath);
  const handler = deps.createServiceHandler({ database, databasePath: options.databasePath });
  let listener: RoomsListener;
  try {
    listener = await deps.bindRoomsService(handler, options.endpoint);
  } catch (error) {
    await database.close?.();
    throw error;
  }

  let closed = false;
  let signalClosing: Promise<void> | undefined;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await listener.close(); } finally { await database.close?.(); }
  };
  const onSignal = () => { signalClosing = close(); };
  const installSignals = options.installSignalHandlers ?? true;
  if (installSignals) {
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
  }
  return {
    health: () => listener.health(),
    close: async () => {
      await (signalClosing ?? close());
      if (installSignals) { process.off("SIGTERM", onSignal); process.off("SIGINT", onSignal); }
    },
  };
}

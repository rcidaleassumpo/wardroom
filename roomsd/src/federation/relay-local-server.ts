// SPDX-License-Identifier: Apache-2.0
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { chmod, lstat, unlink } from "node:fs/promises";
import { RelayConnection, type RelayApplicationHandler, type RelayByteDuplex, type RelayTransportCloseInfo } from "./relay-connection.js";

export interface LocalRelayServer { close(): Promise<void> }

/**
 * Outbound dialing already holds a per-peer exclusive lock, but the responder
 * bounded nothing: a peer could open unbounded concurrent relay sessions, each
 * one an SSH child. Mirror the outbound policy with one authenticated session
 * per peer, plus a cap on sessions still in the handshake, since a peer has no
 * identity to account against until it authenticates.
 */
export const MAX_AUTHENTICATED_SESSIONS_PER_PEER = 1;
export const MAX_HANDSHAKING_SESSIONS = 8;

export type RelayAdmission = Readonly<{
  /** Returns false when the caller must close the socket instead of serving it. */
  admitHandshake(): boolean;
  /** Returns false when this peer already holds its allowed session. */
  admitPeer(peerAuthorityId: string): boolean;
  releaseHandshake(): void;
  releasePeer(peerAuthorityId: string): void;
  counts(): Readonly<{ handshaking: number; authenticated: Readonly<Record<string, number>> }>;
}>;

export function createRelayAdmission(
  limits: { maxPerPeer?: number; maxHandshaking?: number } = {},
): RelayAdmission {
  const maxPerPeer = limits.maxPerPeer ?? MAX_AUTHENTICATED_SESSIONS_PER_PEER;
  const maxHandshaking = limits.maxHandshaking ?? MAX_HANDSHAKING_SESSIONS;
  const authenticated = new Map<string, number>();
  let handshaking = 0;
  return {
    admitHandshake: () => {
      if (handshaking >= maxHandshaking) return false;
      handshaking += 1;
      return true;
    },
    admitPeer: (peerAuthorityId) => {
      if ((authenticated.get(peerAuthorityId) ?? 0) >= maxPerPeer) return false;
      authenticated.set(peerAuthorityId, (authenticated.get(peerAuthorityId) ?? 0) + 1);
      return true;
    },
    releaseHandshake: () => { handshaking = Math.max(0, handshaking - 1); },
    releasePeer: (peerAuthorityId) => {
      const next = (authenticated.get(peerAuthorityId) ?? 0) - 1;
      if (next > 0) authenticated.set(peerAuthorityId, next); else authenticated.delete(peerAuthorityId);
    },
    counts: () => ({ handshaking, authenticated: Object.fromEntries(authenticated) }),
  };
}

/** Private same-uid ingress used only by the fixed SSH stdio proxy. Never binds TCP. */
export async function bindLocalRelayServer(
  path: string,
  localStateDir: string,
  handlerFactory: () => RelayApplicationHandler,
  admission: RelayAdmission = createRelayAdmission(),
): Promise<LocalRelayServer> {
  await removeStaleSocket(path);
  const server = createServer((socket) => {
    if (!admission.admitHandshake()) {
      process.stderr.write(`roomsd: federation relay refused a session: too many handshakes already in progress (${admission.counts().handshaking})\n`);
      socket.destroy();
      return;
    }
    serve(socket, localStateDir, handlerFactory(), admission);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  await chmod(path, 0o600);
  return { close: async () => { await closeServer(server); try { await unlink(path); } catch { /* already absent */ } } };
}

function serve(socket: Socket, localStateDir: string, handler: RelayApplicationHandler, admission: RelayAdmission): void {
  let onData: ((chunk: Buffer) => void) | undefined;
  let onDrain: (() => void) | undefined;
  let onClose: ((info: RelayTransportCloseInfo) => void) | undefined;
  socket.on("data", (chunk) => onData?.(chunk));
  socket.on("drain", () => onDrain?.());
  socket.once("close", () => onClose?.({ reason: "peerClosed", message: "local relay proxy closed" }));
  // A broken pipe can emit more than one socket error while RelayConnection
  // tears the duplex down. Keep the listener for the socket's full lifetime so
  // a second EPIPE cannot become an uncaught process error.
  socket.on("error", (error) => onClose?.({ reason: "transportError", message: error.message }));
  const duplex: RelayByteDuplex = { write: (data) => socket.write(data), onData: (cb) => { onData = cb; }, onDrain: (cb) => { onDrain = cb; }, onceClose: (cb) => { onClose = cb; }, destroy: () => socket.destroy() };
  let handshakeHeld = true;
  let admittedPeer: string | undefined;
  const releaseAll = (): void => {
    if (handshakeHeld) { admission.releaseHandshake(); handshakeHeld = false; }
    if (admittedPeer !== undefined) { admission.releasePeer(admittedPeer); admittedPeer = undefined; }
  };
  new RelayConnection({
    role: "responder", duplex, localStateDir, handler,
    onStatusChange: (status) => {
      // A responder learns the peer only once the handshake authenticates it, so
      // the per-peer bound can only be applied here.
      if (status.state === "connected" && status.peerAuthorityId && admittedPeer === undefined) {
        if (!admission.admitPeer(status.peerAuthorityId)) {
          process.stderr.write(`roomsd: federation relay refused a session: peer ${status.peerAuthorityId} already holds its allowed session\n`);
          socket.destroy();
          releaseAll();
          return;
        }
        admittedPeer = status.peerAuthorityId;
        if (handshakeHeld) { admission.releaseHandshake(); handshakeHeld = false; }
      }
      if (status.state === "closed") {
        releaseAll();
        if (status.disconnectReason !== "peerClosed" && status.disconnectReason !== "gracefulClose") {
          process.stderr.write(`roomsd: federation relay closed: ${status.disconnectReason}: ${status.disconnectMessage ?? ""}\n`);
        }
      }
    },
  }).start();
  socket.once("close", () => releaseAll());
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isSocket() || (stat.mode & 0o777) !== 0o600 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error(`refusing insecure federation relay endpoint: ${path}`);
    const active = await new Promise<boolean>((resolve, reject) => {
      const socket = createConnection(path);
      const finish = (value: boolean) => { socket.removeAllListeners(); socket.destroy(); resolve(value); };
      socket.setTimeout(500, () => finish(true));
      socket.once("connect", () => finish(true));
      socket.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED" || error.code === "ENOENT") finish(false);
        else reject(error);
      });
    });
    if (active) throw Object.assign(new Error(`Rooms federation relay endpoint is already active: ${path}`), { code: "EADDRINUSE" });
    await unlink(path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function closeServer(server: Server): Promise<void> { return new Promise((resolve) => server.close(() => resolve())); }

import { createConnection, createServer, type Server, type Socket } from "node:net";
import { chmod, lstat, stat, unlink } from "node:fs/promises";
import type { RoomsServiceHandler } from "../../api/service/handler.js";
import releaseContract from "../../../release-contract.json" with { type: "json" };

export type RoomsEndpoint =
  | { kind: "unix"; path: string }
  | { kind: "namedPipe"; name: string }
  | { kind: "tcp"; host: string; port: number };

export interface RoomsListener {
  readonly endpoint: RoomsEndpoint;
  health(): Promise<boolean>;
  close(): Promise<void>;
}

export interface RoomsConnectionState { authenticatedSessionId?: string; authenticatedCredential?: string; credentials: Map<string, string>; onClose: Set<() => void>; }
const legacyCredentials = new Map<string, string>();

/** Binds one API-owned typed handler to Unix, named-pipe, or TCP endpoint. */
export async function bindRoomsService(handler: RoomsServiceHandler, endpoint: RoomsEndpoint): Promise<RoomsListener> {
  if (endpoint.kind === "unix") await prepareUnixEndpoint(endpoint.path);
  const server = createServer((socket) => serveConnection(socket, handler));
  await listen(server, endpoint);
  const boundEndpoint = endpoint.kind === "tcp" ? { ...endpoint, port: (server.address() as { port: number }).port } : endpoint;
  return { endpoint: boundEndpoint, health: async () => server.listening, close: () => closeServer(server, endpoint) };
}

async function prepareUnixEndpoint(path: string): Promise<void> {
  let endpointStat;
  try { endpointStat = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const mode = endpointStat.mode & 0o777;
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (endpointStat.isSymbolicLink() || !endpointStat.isSocket() || mode !== 0o600 || (currentUid !== undefined && endpointStat.uid !== currentUid)) {
    throw new Error(`refusing to replace insecure or unowned Rooms endpoint: ${path}`);
  }
  const active = await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(path);
    const finish = (value: boolean): void => { socket.removeAllListeners(); socket.destroy(); resolve(value); };
    socket.setTimeout(500, () => finish(true));
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") finish(false);
      else { socket.destroy(); reject(error); }
    });
  });
  if (active) throw Object.assign(new Error(`Rooms endpoint is already active: ${path}`), { code: "EADDRINUSE" });
  try { await unlink(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export function connectRoomsService(endpoint: RoomsEndpoint): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = endpoint.kind === "tcp"
      ? createConnection({ host: endpoint.host, port: endpoint.port })
      : createConnection(endpoint.kind === "unix" ? endpoint.path : endpoint.name);
    socket.once("error", reject);
    socket.once("connect", () => { socket.removeListener("error", reject); resolve(socket); });
  });
}

function serveConnection(socket: Socket, handler: RoomsServiceHandler): void {
  const connection: RoomsConnectionState = { credentials: new Map(), onClose: new Set() };
  let buffer = "";
  let legacyQueue = Promise.resolve();
  // Clients may disconnect while an asynchronous handler is producing its
  // response. A peer-side EPIPE must close only that connection, never roomsd.
  socket.on("error", () => socket.destroy());
  socket.once("close", () => {
    for (const close of connection.onClose) {
      try { close(); } catch { /* connection cleanup is best effort */ }
    }
    connection.onClose.clear();
  });
  socket.setEncoding("utf8");
  socket.on("data", async (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n"); if (newline < 0) return;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const request = JSON.parse(line) as { method?: string; request?: unknown; protocolVersion?: number; kind?: string; [key: string]: unknown };
        if (request.protocolVersion === releaseContract.protocolVersion && typeof request.kind === "string") {
          legacyQueue = legacyQueue.then(() => serveLegacyConnection(socket, handler, request, connection));
          continue;
        }
        if (!request.method) throw Object.assign(new Error("missing method"), { code: "invalidRequest" });
        const method = request.method as keyof RoomsServiceHandler;
        if (typeof handler[method] !== "function") throw Object.assign(new Error(`unknown method ${request.method}`), { code: "unknownMethod" });
        const invoke = handler[method] as unknown as (request: unknown) => unknown;
        const payload = request.request && typeof request.request === "object" ? { ...(request.request as Record<string, unknown>), __connection: connection } : request.request;
        const result = await invoke(payload);
        if (isAsyncIterable(result)) {
          for await (const item of result) socket.write(JSON.stringify({ stream: item }) + "\n");
          socket.write(JSON.stringify({ streamEnd: true }) + "\n");
        } else socket.write(JSON.stringify({ response: result }) + "\n");
      }
      catch (error) { const e = error as { code?: string; message?: string }; socket.write(JSON.stringify({ error: { code: e.code ?? "handlerError", message: e.message ?? "handler error" } }) + "\n"); }
    }
  });
}

async function serveLegacyConnection(socket: Socket, handler: RoomsServiceHandler, request: Record<string, unknown>, connection: RoomsConnectionState): Promise<void> {
  const kind = request.kind as string;
  const send = (value: Record<string, unknown>) => socket.write(JSON.stringify({ protocolVersion: releaseContract.protocolVersion, ...value }) + "\n");
  const channelID = request.channelID as string | undefined;
  try {
    if (kind === "registerSession") {
      const result = await handler.registerSession({
        sessionId: String(request.sessionID ?? ""),
        displayName: request.displayName as string | undefined,
        role: request.role as never,
      } as never) as any;
      send({ ok: true, session: result.session });
    } else if (kind === "registerChannel") {
      const result = await handler.createChannel({
        channelName: String(request.channelID ?? ""),
        ownerOperatorSessionId: String(request.ownerOperatorSessionID ?? ""),
      } as never) as any;
      send({ ok: true, channel: result.channel });
    } else if (kind === "join") {
      const result = await handler.join({
        channelId: String(request.channelID ?? ""),
        sessionId: String(request.sessionID ?? ""),
        authorizedBySessionId: request.authorizedBySessionID as string | undefined,
        workUnitId: request.workUnitID as string | undefined,
      } as never) as any;
      send({ ok: true, membership: result.membership });
    } else if (kind === "leave") {
      const result = await handler.leave({
        channelId: String(request.channelID ?? ""),
        sessionId: String(request.sessionID ?? ""),
      } as never) as any;
      send({ ok: true, didLeave: result.didLeave });
    } else if (kind === "endSession") {
      await handler.endSession({ sessionId: String(request.sessionID ?? ""), authorizedBySessionId: request.authorizedBySessionId } as never);
      send({ ok: true });
    } else if (kind === "updateSessionRole") {
      const result = await handler.updateSessionRole({ channelId: String(request.channelID ?? request.channelId ?? ""), sessionId: String(request.sessionID ?? request.sessionId ?? ""), role: request.role as never, context: { protocolVersion: 1, credential: connection.authenticatedCredential }, __connection: connection } as never) as any;
      send({ ok: true, session: result.session, cursor: result.cursor });
    } else if (kind === "closeChannel") {
      const result = await handler.closeChannel({ channelId: String(request.channelID ?? ""), authorizedBySessionId: request.authorizedBySessionID } as never) as any;
      send({ ok: true, channel: result.channel });
    } else if (kind === "updateChannelLabel") {
      const result = await handler.updateChannelLabel({ channelId: String(request.channelID ?? request.channelId ?? ""), label: request.label == null ? undefined : String(request.label), context: { protocolVersion: releaseContract.protocolVersion, credential: connection.authenticatedCredential }, __connection: connection } as never) as any;
      send({ ok: true, channel: result.channel, cursor: result.cursor });
    } else if (kind === "channels") {
      const result = await handler.listChannels({} as never) as any;
      send({ ok: true, channels: (result.channels ?? []).map((channel: any) => ({ id: channel.id, label: channel.label ?? null, registeredAt: channel.registeredAt, lifecycleState: channel.lifecycleState, ownerOperatorSessionID: channel.ownerOperatorSessionId })) });
    } else if (kind === "sessions") {
      const result = await handler.getSessions({ includeEnded: Boolean(request.includeEnded) } as never) as any;
      send({ ok: true, sessions: result.sessions ?? [] });
    } else if (kind === "sessionMemberships") {
      const channels = await handler.listChannels({} as never) as any;
      const sessionID = String(request.sessionID ?? "");
      const membershipHistory: any[] = [];
      for (const channel of channels.channels ?? []) {
        const result = await handler.getMembershipHistory({ channelId: channel.id } as never) as any;
        for (const membership of result.membershipHistory ?? []) if (membership.sessionId === sessionID || membership.sessionID === sessionID) membershipHistory.push({ ...membership, channelID: membership.channelId ?? membership.channelID });
      }
      send({ ok: true, memberships: membershipHistory, membershipHistory });
    } else if (kind === "sessionEvents") {
      const channels = await handler.listChannels({} as never) as any;
      const sessionID = String(request.sessionID ?? ""); const events: any[] = [];
      for (const channel of channels.channels ?? []) { const result = await handler.getEvents({ channelId: channel.id, afterCursor: "0" } as never) as any; for (const event of result.events ?? []) if (event.senderSessionId === sessionID || event.target?.sessionId === sessionID || event.deliveredRecipientSessionIds?.includes(sessionID)) events.push(event); }
      send({ ok: true, events });
    } else if (kind === "activeRoster") {
      const result = await handler.getRoster({ channelId: channelID } as never) as any;
      send({ ok: true, roster: (result.roster ?? []).map((member: any) => ({ ...member, sessionID: member.sessionId })) });
    } else if (kind === "latestCursor") {
      const result = await handler.getEvents({ afterCursor: "0" } as never) as any;
      send({ ok: true, cursor: result.cursor });
    } else if (kind === "issueCredential") {
      const result = await handler.issueCredential({ sessionId: String(request.sessionID ?? request.sessionId ?? ""), __connection: connection } as never) as any;
      if (result.credential) legacyCredentials.set(result.credential, String(request.sessionID ?? request.sessionId ?? ""));
      send({ ok: true, credential: result.credential });
    } else if (kind === "authenticate") {
      const credential = String(request.credential ?? "");
      const owner = legacyCredentials.get(credential);
      if (owner) connection.credentials.set(credential, owner);
      const result = await handler.authenticate({ credential, __connection: connection } as never) as any;
      connection.authenticatedCredential = credential;
      send({ ok: true, authenticatedSessionID: result.authenticatedSessionId });
    } else if (kind === "send") {
      const requestedTarget = request.target as { kind?: string; sessionID?: string; sessionId?: string; sessionIDs?: string[]; sessionIds?: string[] } | undefined;
      const requestedRecipients = Array.isArray(requestedTarget?.sessionIDs)
        ? requestedTarget.sessionIDs
        : Array.isArray(requestedTarget?.sessionIds)
          ? requestedTarget.sessionIds
          : Array.isArray(request.recipientSessionIDs)
            ? request.recipientSessionIDs
            : [];
      const directSessionId = requestedTarget?.sessionID ?? requestedTarget?.sessionId;
      const target = requestedTarget?.kind === "directToSession" || requestedTarget?.kind === "direct"
        ? { kind: "direct", sessionId: directSessionId ?? requestedRecipients[0], sessionIds: [directSessionId ?? requestedRecipients[0]] }
        : { kind: "broadcast", sessionIds: requestedRecipients };
      const result = await handler.send({ channelId: request.channelID ?? null, senderSessionId: connection.authenticatedSessionId, body: request.body, target, correlation: request.correlation, __connection: connection } as never) as any;
      send({ ok: true, event: result.event, cursor: result.cursor });
    } else if (kind === "channelEvents") {
      const result = await handler.getEvents({ channelId: channelID, afterCursor: "0" } as never) as any;
      send({ ok: true, events: result.events ?? [], cursor: result.cursor });
    } else if (kind === "channelSnapshot") {
      const result = await handler.getSnapshot({ channelId: channelID } as never) as any;
      const snapshot = result.snapshot;
      send({ ok: true, snapshot: { channel: snapshot.channel, roster: snapshot.sessions.map((session: any) => ({ sessionID: session.id, displayName: session.displayName, joinedAt: session.registeredAt, role: session.role ?? "worker" })), sessions: snapshot.sessions, events: snapshot.events, cursor: snapshot.cursor } });
    } else if (kind === "search") {
      const result = await handler.search({ channelId: channelID, query: request.query, afterCursor: "0" } as never) as any;
      send({ ok: true, events: result.events ?? [] });
    } else if (kind === "recipients") {
      const result = await handler.getRecipients({ eventId: request.eventID ?? request.eventId } as never) as any;
      send({ ok: true, recipients: result.recipients ?? [] });
    } else if (kind === "subscribe") {
      send({ ok: true });
      const result = handler.watch({ channelId: channelID, afterCursor: String(request.afterCursor ?? "0") } as never);
      for await (const item of result) {
        const value = item as any;
        if (value.snapshot) send({ change: { channelID, ...value.snapshot } });
        else if (value.delta) send({ change: { channelID: value.delta.channelId, event: value.delta.payload, cursor: value.delta.cursor } });
      }
    } else throw Object.assign(new Error(`unknown legacy operation ${kind}`), { code: "unknownMethod" });
  } catch (error) { const e = error as { code?: string; message?: string }; send({ ok: false, errorCode: e.code ?? "handlerError", errorDescription: e.message ?? "handler error" }); }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

function listen(server: Server, endpoint: RoomsEndpoint): Promise<void> {
  if (endpoint.kind === "tcp" && !["127.0.0.1", "localhost", "::1"].includes(endpoint.host)) return Promise.reject(new Error("TCP Rooms transport must bind loopback"));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint.kind === "tcp" ? { host: endpoint.host, port: endpoint.port } : endpoint.kind === "unix" ? endpoint.path : endpoint.name, async () => {
      try {
        if (endpoint.kind === "unix") {
          await chmod(endpoint.path, 0o600);
          const mode = (await stat(endpoint.path)).mode & 0o777;
          if (mode !== 0o600) throw new Error(`Rooms socket mode is ${mode.toString(8)}, expected 600`);
        }
        server.removeListener("error", reject); resolve();
      } catch (error) { server.close(() => reject(error)); }
    });
  });
}

async function closeServer(server: Server, endpoint: RoomsEndpoint): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (endpoint.kind !== "tcp") { try { await unlink(endpoint.kind === "unix" ? endpoint.path : endpoint.name); } catch { /* endpoint was already removed */ } }
}

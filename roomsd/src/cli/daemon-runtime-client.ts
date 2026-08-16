// SPDX-License-Identifier: Apache-2.0
import { lstatSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { ROOMS_PROTOCOL_MAX_VERSION } from "../api/protocol-compatibility.js";
import { readSessionBootstrap } from "../credentials/session-proof-bootstrap.js";
import { readOperatorCredentialSecret } from "../credentials/operator-credential.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Bounded request/response client for the private local roomsd Unix endpoint. */
export class RoomsDaemonRuntimeClient {
  constructor(private readonly endpoint: string, private readonly unavailableReason?: () => string, private readonly stateDir?: string) {}

  async call(method: string, request: object): Promise<unknown> {
    const socket = await this.connect();
    try { return await call(socket, method, withProtocolContext(request)); }
    finally { socket.destroy(); }
  }

  async callAs(sessionId: string, method: string, request: object): Promise<unknown> {
    const socket = await this.connect();
    try {
      const credential = await authenticate(socket, sessionId, this.stateDir);
      return await call(socket, method, withProtocolContext(request, credential));
    } finally { socket.destroy(); }
  }

  async attachInteractive(sessionId: string, request: object, handlers: Readonly<{
    onOutput(value: { cursor: string; bytes: Uint8Array }): void;
    onExit(value: { code: number }): void;
    onError(value: { code: number; message: string }): void;
    onClose(): void;
  }>): Promise<Readonly<{
    hello: { replayFrom: string; head: string; gap: boolean };
    input(bytes: Uint8Array): Promise<unknown>;
    resize(columns: number, rows: number): Promise<unknown>;
    detach(): Promise<unknown>;
  }>> {
    const socket = await this.connect();
    const credential = await authenticate(socket, sessionId, this.stateDir);
    // Request setup is bounded, but an interactive terminal is intentionally
    // long-lived and may be idle. Heartbeat/lifecycle checks own liveness.
    socket.setTimeout(0);
    return await new Promise((resolve, reject) => {
      let buffer = "";
      let attachmentId: string | undefined;
      let settled = false;
      // Once attached, a daemon socket failure is recoverable: the PTY host
      // is a separate process and the CLI will reconnect to it through the
      // restarted daemon. Protocol/runtime errors still arrive as stream
      // items below and remain terminal.
      const fail = (error: Error): void => { if (!settled) reject(error); socket.destroy(); };
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        if (Buffer.byteLength(buffer) > MAX_RESPONSE_BYTES) return fail(new Error("roomsd interactive response exceeded 1 MiB"));
        for (;;) {
          const newline = buffer.indexOf("\n"); if (newline < 0) break;
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let parsed: { stream?: any; streamEnd?: boolean; error?: { code?: string; message?: string } };
          try { parsed = JSON.parse(line); } catch { return fail(new Error("roomsd returned malformed interactive JSON")); }
          if (parsed.error) return fail(Object.assign(new Error(parsed.error.message ?? "roomsd interactive attach failed"), { code: parsed.error.code }));
          if (parsed.streamEnd) { handlers.onClose(); socket.destroy(); return; }
          const item = parsed.stream;
          if (!item || typeof item.kind !== "string") continue;
          if (item.kind === "hello") {
            attachmentId = item.response?.attachment?.attachmentId;
            if (!attachmentId || !item.hello) return fail(new Error("roomsd interactive hello is incomplete"));
            settled = true;
            resolve({
              hello: item.hello,
              input: (bytes) => this.callAs(sessionId, "runtimeInput", { attachmentId, bytes: Buffer.from(bytes).toString("base64") }),
              resize: (columns, rows) => this.callAs(sessionId, "runtimeResize", { attachmentId, columns, rows }),
              // Closing an interactive terminal detaches only this stream.
              // The daemon-side view refcount releases the shared controller
              // lease when the final view closes. Calling runtimeDetach here
              // would tear the controller out from under sibling panes.
              detach: async () => { socket.destroy(); return { ok: true }; },
            });
          } else if (item.kind === "output" && typeof item.cursor === "string" && typeof item.bytes === "string") handlers.onOutput({ cursor: item.cursor, bytes: Buffer.from(item.bytes, "base64") });
          else if (item.kind === "exit" && Number.isInteger(item.code)) handlers.onExit({ code: item.code });
          else if (item.kind === "error") handlers.onError({ code: Number(item.code) || 1, message: String(item.message ?? "runtime error") });
        }
      });
      socket.once("error", fail);
      socket.once("close", () => { if (!settled) reject(new Error("roomsd closed before interactive attach completed")); else handlers.onClose(); });
      socket.write(`${JSON.stringify({ method: "runtimeAttachStream", request: withProtocolContext(request, credential) })}\n`);
    });
  }

  private async connect(): Promise<Socket> {
    let value;
    try { value = lstatSync(this.endpoint); }
    catch (error) { throw this.connectionError(error); }
    if (value.isSymbolicLink() || !value.isSocket() || (value.mode & 0o777) !== 0o600 || (typeof process.getuid === "function" && value.uid !== process.getuid())) throw new Error(`refusing insecure roomsd endpoint: ${this.endpoint}`);
    return await new Promise((resolve, reject) => {
      const socket = createConnection(this.endpoint);
      socket.setTimeout(10_000, () => socket.destroy(new Error("roomsd request timed out")));
      const onError = (error: Error): void => reject(this.connectionError(error));
      socket.once("error", onError);
      socket.once("connect", () => { socket.removeListener("error", onError); resolve(socket); });
    });
  }

  private connectionError(error: unknown): Error {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT" && code !== "ECONNREFUSED") return error instanceof Error ? error : new Error(String(error));
    let message = `roomsd is not running at ${this.endpoint}; run \`rooms doctor\``;
    try { message = this.unavailableReason?.() ?? message; } catch { /* keep the actionable generic error */ }
    return Object.assign(new Error(message), { code });
  }
}

async function authenticate(socket: Socket, sessionId: string, stateDir?: string): Promise<string> {
  const runtimeProof = String(process.env.ROOMS_SESSION_PROOF ?? "").trim();
  // A durable operator credential lets a trusted local operator client
  // authenticate after a daemon restart without a launched runtime. The daemon
  // accepts it as a possession proof for that operator session only.
  const operatorProof = !runtimeProof && stateDir ? readOperatorCredentialSecret(stateDir, sessionId) : null;
  const proof = runtimeProof || operatorProof || "";
  const bootstrap = !proof && stateDir ? readSessionBootstrap(stateDir, sessionId) : null;
  if (!proof && !bootstrap) throw new Error("Rooms session possession proof is unavailable; launch or resume this session through Rooms");
  const credentialResponse = await call(socket, proof ? "issueCredential" : "issueBootstrapCredential", withProtocolContext(proof ? { sessionId, proof } : { sessionId, bootstrap })) as { credential?: string };
  if (!credentialResponse.credential) throw new Error("roomsd did not issue a runtime credential");
  await call(socket, "authenticate", withProtocolContext({ credential: credentialResponse.credential }));
  return credentialResponse.credential;
}

function withProtocolContext(request: object, credential?: string): Record<string, unknown> {
  const value = request as Record<string, unknown>;
  const current = value.context && typeof value.context === "object" ? value.context as Record<string, unknown> : {};
  return { ...value, context: { ...current, protocolVersion: ROOMS_PROTOCOL_MAX_VERSION, ...(credential ? { credential } : {}) } };
}

function call(socket: Socket, method: string, request: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = (): void => { socket.off("data", onData); socket.off("error", onError); socket.off("close", onClose); };
    const fail = (error: Error): void => { cleanup(); reject(error); };
    const onError = (error: Error): void => fail(error);
    const onClose = (): void => fail(new Error(`roomsd closed while handling ${method}`));
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > MAX_RESPONSE_BYTES) return fail(new Error("roomsd response exceeded 1 MiB"));
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      let parsed: { response?: unknown; error?: { code?: string; domainCode?: string; message?: string } };
      try { parsed = JSON.parse(buffer.slice(0, newline)); }
      catch { return reject(new Error("roomsd returned malformed JSON")); }
      if (parsed.error) {
        const domainCode = parsed.error.domainCode;
        const message = parsed.error.message ?? "roomsd request failed";
        return reject(Object.assign(new Error(domainCode ? `${domainCode}: ${message}` : message), {
          code: domainCode ?? parsed.error.code,
          transportCode: parsed.error.code,
        }));
      }
      resolve(parsed.response);
    };
    socket.on("data", onData); socket.once("error", onError); socket.once("close", onClose);
    socket.write(`${JSON.stringify({ method, request })}\n`);
  });
}

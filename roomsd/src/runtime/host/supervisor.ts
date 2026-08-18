// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { mkdirSync, chmodSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { arch, platform } from "node:process";
import { EventEmitter } from "node:events";
import { encodeEnrollment, HostFrameDecoder, HOST_TYPES, decodeReady, type HostHelloAck, type HostOutput } from "./codec.js";
import { RuntimeHostClient } from "./client.js";
import { ensureRuntimeSocketDirectory, runtimeSocketPath } from "./endpoint.js";

export type HostSupervisorState = "starting" | "running" | "recovering" | "crashed" | "terminated";
export interface RuntimeHostSpec { sessionId: string; channelId?: string | null; runtimeId: string; homeAuthorityId: string; generation: number; stateDir: string; socketPath?: string; executable?: string; shell?: string; command?: readonly string[]; cwd?: string; ringBytes?: number; secret?: Uint8Array; sessionProof?: Uint8Array; capabilityRenewal?: boolean; }

/** Rooms owns host process lifecycle; reconnect never starts a replacement host. */
export class RuntimeHostSupervisor extends EventEmitter {
  readonly spec: RuntimeHostSpec;
  readonly secret: Buffer;
  readonly supportsCapabilityRenewal: boolean;
  state: HostSupervisorState = "starting";
  client?: RuntimeHostClient;
  lastHelloAck?: HostHelloAck;
  private child?: ChildProcess;
  private ready?: Promise<void>;
  private stderr = "";
  private stderrBytes = 0;
  constructor(spec: RuntimeHostSpec) { super(); const persisted = loadPersistedHostState(spec.stateDir, spec.runtimeId); this.spec = spec; this.secret = Buffer.from(spec.secret ?? persisted?.secret ?? randomBytes(32)); this.supportsCapabilityRenewal = spec.capabilityRenewal ?? persisted?.capabilityRenewal === true; }

  async start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.spawnAndEnroll();
    try { await this.ready; this.state = "running"; this.emit("state", this.state); }
    catch (error) { this.state = "crashed"; const reported = this.hostFailure(error); this.emit("state", this.state, reported); throw reported; }
  }

  async reconnect(mode: "observe" | "controller", actions: readonly string[], cursor = 0n): Promise<RuntimeHostClient> {
    if (this.state === "terminated") throw new Error("runtime host generation is terminated");
    const client = new RuntimeHostClient(this.socketPath(), { sessionId: this.spec.sessionId, runtimeId: this.spec.runtimeId, homeAuthorityId: this.spec.homeAuthorityId, generation: this.spec.generation, secret: this.secret }, { renewCapabilities: this.supportsCapabilityRenewal });
    try {
      this.lastHelloAck = await client.connect(mode, actions, cursor);
      this.client?.close();
      this.client = client;
      this.wire(client);
      this.state = "running";
      this.emit("state", this.state);
      return client;
    } catch (error) {
      client.close();
      this.state = this.childIsAlive() ? "recovering" : "crashed";
      this.emit("state", this.state, error);
      throw this.hostFailure(error);
    }
  }

  socketEndpoint(): string { return this.socketPath(); }

  async stop(): Promise<void> {
    if (this.state === "terminated") return;
    try { await this.client?.terminate(); } catch { /* host exit is terminal below */ }
    this.client?.close();
    const child = this.child;
    if (child && child.exitCode === null && !child.signalCode) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    this.state = "terminated";
    this.emit("state", this.state);
  }

  async cleanup(): Promise<void> {
    try { await this.stop(); } catch { this.child?.kill("SIGKILL"); }
    for (const path of [this.socketPath(), this.statePath(), `${this.statePath()}.new`]) {
      try { unlinkSync(path); } catch { /* exact cleanup is best effort */ }
    }
  }

  private async spawnAndEnroll(): Promise<void> {
    mkdirSync(this.spec.stateDir, { recursive: true, mode: 0o700 });
    chmodSync(this.spec.stateDir, 0o700);
    ensureRuntimeSocketDirectory(dirname(this.socketPath()));
    const executable = this.spec.executable ?? join(dirname(fileURLToPath(import.meta.url)), `../../../../runtime-host-go/dist/${runtimeHostBinaryName(platform, arch)}`);
    const statePath = this.statePath();
    const socketPath = this.socketPath();
    const child = spawn(executable, ["run", "--ring-bytes", String(this.spec.ringBytes ?? 262144), ...(this.spec.shell ? ["--shell", this.spec.shell] : [])], {
      cwd: this.spec.stateDir,
      env: {
        ...process.env,
        TERM: "xterm-256color",
      },
      detached: true,
      stdio: ["ignore", "ignore", "pipe", "pipe"],
    });
    this.child = child;
    child.once("exit", (code, signal) => { if (this.state === "running" || this.state === "starting") { this.state = "crashed"; this.emit("state", this.state, new Error(`runtime host exited (${code ?? signal ?? "unknown"})`)); } });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => this.captureStderr(chunk));
    const enrollment = child.stdio[3] as NodeJS.WritableStream | null;
    if (!enrollment || typeof enrollment.write !== "function") throw new Error("runtime host enrollment channel unavailable");
    const decoder = new HostFrameDecoder();
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("runtime host enrollment timed out")), 15_000);
      enrollment.on("data", (chunk: Buffer) => {
        try {
          for (const item of decoder.push(chunk)) if (item.type === HOST_TYPES.ready) { clearTimeout(timer); decodeReady(item.payload); resolve(); }
        } catch (error) { clearTimeout(timer); reject(error); }
      });
      child.once("error", reject);
      // The host may close its stdin immediately after a failed spawn. Keep
      // that asynchronous EPIPE from becoming an unhandled stream error;
      // the child exit/error handlers below provide the enrollment failure.
      enrollment.on("error", () => {});
      child.once("exit", (code, signal) => { if (code !== null || signal) reject(new Error("runtime host exited during enrollment")); });
    });
    try {
      enrollment.write(encodeEnrollment({ sessionId: this.spec.sessionId, channelId: this.spec.channelId, runtimeId: this.spec.runtimeId, homeAuthorityId: this.spec.homeAuthorityId, generation: this.spec.generation, protocolVersion: 1, expiresAt: Math.floor(Date.now() / 1000) + 86400, reconnectSecret: this.secret, sessionProof: this.spec.sessionProof, statePath, socketPath, ringBytes: this.spec.ringBytes ?? 262144, command: this.spec.command, cwd: this.spec.cwd }));
    } catch (error) {
      throw this.hostFailure(error);
    }
    try { await ready; } catch (error) { throw this.hostFailure(error); }
    enrollment.end();
    child.unref();
    (child.stderr as (NodeJS.ReadableStream & { unref?: () => void }) | null)?.unref?.();
    (enrollment as NodeJS.WritableStream & { unref?: () => void }).unref?.();
  }

  private socketPath(): string { return this.spec.socketPath ?? runtimeSocketPath({ homeAuthorityId: this.spec.homeAuthorityId, sessionId: this.spec.sessionId, runtimeId: this.spec.runtimeId, generation: this.spec.generation }); }
  private childIsAlive(): boolean {
    const child = this.child;
    if (!child || child.exitCode !== null || !child.pid) return false;
    try { process.kill(child.pid, 0); return true; } catch { return false; }
  }
  private statePath(): string { return join(this.spec.stateDir, `${this.spec.runtimeId}.state.json`); }
  private captureStderr(chunk: string): void {
    const remaining = 16_384 - this.stderrBytes;
    if (remaining <= 0) return;
    const value = Buffer.from(chunk, "utf8").subarray(0, remaining).toString("utf8");
    this.stderr += value;
    this.stderrBytes += Buffer.byteLength(value, "utf8");
  }
  private hostFailure(error: unknown): Error {
    const base = error instanceof Error ? error.message : String(error);
    const stderr = redactHostStderr(this.stderr, this.secret);
    return new Error(stderr && !base.includes(stderr) ? `${base}; host stderr: ${stderr}` : base);
  }
  private wire(client: RuntimeHostClient): void {
    client.on("output", (value: HostOutput) => this.emit("output", value));
    client.on("exit", (value) => { this.state = "terminated"; this.emit("exit", value); this.emit("state", this.state); });
    client.on("close", () => { if (this.state === "running") { this.state = this.child?.exitCode === null ? "recovering" : "crashed"; this.emit("state", this.state); } });
  }
}

export function runtimeHostBinaryName(hostPlatform: NodeJS.Platform, hostArch: string): string {
  return `rooms-runtime-host-${hostPlatform}-${hostArch === "x64" ? "amd64" : hostArch}`;
}

function redactHostStderr(value: string, secret: Uint8Array): string {
  const variants = [Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("base64url"), Buffer.from(secret).toString("hex")];
  let result = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "?").replace(/\s+/g, " ").trim().slice(0, 16_384);
  for (const variant of variants) if (variant) result = result.split(variant).join("[REDACTED]");
  return result;
}

function loadPersistedHostState(stateDir: string, runtimeId: string): { secret: Buffer; capabilityRenewal: boolean } | undefined {
  try {
    const dir = statSync(stateDir);
    const file = statSync(join(stateDir, `${runtimeId}.state.json`));
    if (!dir.isDirectory() || (dir.mode & 0o777) !== 0o700 || !file.isFile() || (file.mode & 0o777) !== 0o600) return undefined;
    const state = JSON.parse(readFileSync(join(stateDir, `${runtimeId}.state.json`), "utf8")) as { reconnectSecret?: unknown; capabilityRenewal?: unknown };
    if (typeof state.reconnectSecret !== "string" || !state.reconnectSecret) return undefined;
    const secret = Buffer.from(state.reconnectSecret, "base64url");
    return secret.length >= 32 && secret.length <= 256 ? { secret, capabilityRenewal: state.capabilityRenewal === true } : undefined;
  } catch { return undefined; }
}

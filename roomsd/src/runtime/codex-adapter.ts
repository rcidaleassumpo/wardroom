import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import type { AllowlistedLaunchConfig, LayoutMetadata } from "../blueprints/resumable.js";
import type { ProviderConversationPort, RuntimeGenerationPort, TeardownFence } from "../lifecycle/suspend-resume.js";

export interface SpawnedCodex { process: ChildProcess; runtimeId: string }
export type SpawnCodex = (executable: string, args: readonly string[], cwd: string) => SpawnedCodex;
export type SpawnCodexConversation = (executable: string, args: readonly string[], cwd: string) => ChildProcess;
export type LaunchAllowlist = (input: { executable: string; args: readonly string[]; cwd: string }) => boolean;
export type TeardownFenceVerifier = (token: string) => boolean | Promise<boolean>;
export interface FenceTokenStore { verifyFenceToken(token: string): boolean }
export interface ProviderExecutableRegistration { name: "codex" | "claude" | "grok"; executable: string }
export interface HeadlessProviderContract {
  provider: "claude" | "grok";
  executable: string;
  arguments(conversationId: string, prompt: string): readonly string[];
  reply(stdout: string): string;
}
export interface RuntimeOwnershipStore { read(priorSessionId: string, generation: number): { runtimeId: string; pid: number; startIdentity: string } | null; readByRuntime(runtimeId: string): { priorSessionId: string; generation: number; pid: number; startIdentity: string } | null; claim(priorSessionId: string, generation: number, runtimeId: string): boolean; write(priorSessionId: string, generation: number, value: { runtimeId: string; pid: number; startIdentity: string }): void; remove(priorSessionId: string, generation: number, runtimeId?: string): void }
export class MemoryRuntimeOwnershipStore implements RuntimeOwnershipStore {
  private readonly values = new Map<string, { runtimeId: string; pid: number; startIdentity: string }>();
  read(priorSessionId: string, generation: number) { return this.values.get(`${priorSessionId}:${generation}`) ?? null; }
  readByRuntime(runtimeId: string) { const found = [...this.values.entries()].find(([, value]) => value.runtimeId === runtimeId); if (!found) return null; const [key, value] = found; const [priorSessionId, generation] = key.split(":"); return { priorSessionId, generation: Number(generation), ...value }; }
  claim(priorSessionId: string, generation: number, runtimeId: string) { const key = `${priorSessionId}:${generation}`; if (this.values.has(key)) return false; this.values.set(key, { runtimeId, pid: 0, startIdentity: "" }); return true; }
  write(priorSessionId: string, generation: number, value: { runtimeId: string; pid: number; startIdentity: string }) { this.values.set(`${priorSessionId}:${generation}`, value); }
  remove(priorSessionId: string, generation: number, runtimeId?: string) { const key = `${priorSessionId}:${generation}`; const current = this.values.get(key); if (current && (runtimeId == null || current.runtimeId === runtimeId)) this.values.delete(key); }
}
export function createCodexAdapters(store: FenceTokenStore, options: { runtimeOwnership?: RuntimeOwnershipStore; spawnCodex?: SpawnCodex; spawnConversation?: SpawnCodexConversation; allowlist?: LaunchAllowlist; providerRegistrations?: readonly ProviderExecutableRegistration[] }): { runtime: CodexRuntimeAdapter; provider: ProviderConversationAdapter } {
  const verify = (token: string) => store.verifyFenceToken(token);
  const codex = new CodexConversationAdapter(options.allowlist, verify, options.spawnConversation);
  const headless = registeredHeadlessProviderContracts(options.providerRegistrations ?? [
    { name: "claude", executable: "claude" },
    { name: "grok", executable: "grok" },
  ]).map(contract => new HeadlessProviderConversationAdapter(contract, verify, options.spawnConversation));
  return {
    runtime: new CodexRuntimeAdapter(options.spawnCodex, options.allowlist, verify, options.runtimeOwnership ?? new MemoryRuntimeOwnershipStore()),
    provider: new ProviderConversationAdapter(codex, headless),
  };
}

export function registeredHeadlessProviderContracts(registrations: readonly ProviderExecutableRegistration[]): HeadlessProviderContract[] {
  const contracts: HeadlessProviderContract[] = [];
  for (const registration of registrations) {
    if (registration.name === "claude") contracts.push({
      provider: "claude" as const,
      executable: registration.executable,
      arguments: (conversationId: string, prompt: string) => ["-p", prompt, "--resume", conversationId, "--output-format", "json"],
      reply: (stdout: string) => jsonReply(stdout, "result", "Claude"),
    });
    if (registration.name === "grok") contracts.push({
      provider: "grok" as const,
      executable: registration.executable,
      arguments: (conversationId: string, prompt: string) => ["--no-auto-update", "-p", prompt, "--resume", conversationId, "--output-format", "json"],
      reply: (stdout: string) => jsonReply(stdout, "text", "Grok"),
    });
  }
  return contracts;
}

/** Provider-neutral resume dispatcher; behavior comes from registered contracts. */
export class ProviderConversationAdapter implements ProviderConversationPort {
  private readonly headless: Map<string, HeadlessProviderConversationAdapter>;
  constructor(private readonly codex: CodexConversationAdapter, headless: readonly HeadlessProviderConversationAdapter[] = []) {
    this.headless = new Map(headless.map(driver => [driver.provider, driver]));
  }
  stop(ref: any, fence: TeardownFence) { return this.driver(ref).stop(ref, fence); }
  stopRollback(ref: any, fence: TeardownFence) { return this.driver(ref).stopRollback(ref, fence); }
  async validateResume(ref: any): Promise<void> {
    if (typeof ref?.conversationId !== "string" || !ref.conversationId.trim()) throw new Error("provider resume identity is missing");
    const descriptor = ref.resumeDescriptor as { provider?: string; cwd?: string; prompt?: string } | null;
    if (!descriptor || typeof descriptor.cwd !== "string" || typeof descriptor.prompt !== "string") throw new Error("provider resume descriptor is invalid");
    this.driver(ref);
  }
  async resume(ref: any, generation: number): Promise<void> {
    await this.resumeWithReply(ref, generation);
  }
  resumeWithReply(ref: any, generation: number): Promise<string> {
    return this.driver(ref).resumeWithReply(ref, generation);
  }
  private driver(ref: any): CodexConversationAdapter | HeadlessProviderConversationAdapter {
    const provider = (ref?.resumeDescriptor as { provider?: string } | null)?.provider ?? "codex";
    if (provider === "codex") return this.codex;
    const driver = this.headless.get(provider);
    if (!driver) throw new Error(`unsupported provider resume adapter ${provider}`);
    return driver;
  }
}

export class HeadlessProviderConversationAdapter implements ProviderConversationPort {
  private readonly active = new Map<string, { process: ChildProcess; generation: number }>();
  readonly provider: "claude" | "grok";
  constructor(private readonly contract: HeadlessProviderContract, private readonly verifyFence: TeardownFenceVerifier = () => false, private readonly spawnConversation: SpawnCodexConversation = (executable, args, cwd) => spawn(executable, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] })) { this.provider = contract.provider; }
  async resume(ref: any, generation: number): Promise<void> { await this.resumeWithReply(ref, generation); }
  async resumeWithReply(ref: any, generation: number): Promise<string> {
    const descriptor = ref?.resumeDescriptor as { provider?: string; cwd?: string; prompt?: string } | null;
    if (typeof ref?.conversationId !== "string" || !ref.conversationId.trim() || descriptor?.provider !== this.provider || typeof descriptor.cwd !== "string" || typeof descriptor.prompt !== "string" || !descriptor.prompt) throw new Error(`invalid ${this.provider} resume descriptor`);
    if (this.active.has(ref.conversationId)) throw new Error(`${this.provider} conversation is already active`);
    const child = this.spawnConversation(this.contract.executable, this.contract.arguments(ref.conversationId, descriptor.prompt), descriptor.cwd);
    this.active.set(ref.conversationId, { process: child, generation });
    let timer: NodeJS.Timeout | undefined;
    try {
      const output = await Promise.race([collect(child), new Promise<never>((_, reject) => { timer = setTimeout(async () => { await terminate(child); reject(new Error(`${this.provider} resume timed out`)); }, 120_000); })]);
      if (child.exitCode !== 0) throw new Error(`${this.provider} resume exited ${child.exitCode}: ${output.stderr}`);
      return this.contract.reply(output.stdout);
    } finally { if (timer) clearTimeout(timer); this.active.delete(ref.conversationId); }
  }
  async stop(ref: any, fence: TeardownFence): Promise<void> { await this.stopActive(ref, fence); }
  async stopRollback(ref: any, fence: TeardownFence): Promise<void> { await this.stopActive(ref, fence); }
  private async stopActive(ref: any, fence: TeardownFence): Promise<void> {
    const active = this.active.get(ref.conversationId);
    if (!active) return;
    if (!fence.token || !await this.verifyFence(fence.token)) throw new Error("stale teardown fence");
    await fence.assertCurrent();
    await terminate(active.process);
    this.active.delete(ref.conversationId);
  }
}

/** Native Codex process owner. It receives an allowlisted launch config only. */
export class CodexRuntimeAdapter implements RuntimeGenerationPort {
  private readonly processes = new Map<string, SpawnedCodex & { generation: number }>();
  public lastTeardown: { priorSessionId: string; generation: number; pid: number | null; observedExit: boolean; exitCode: number | null } | null = null;
  constructor(private readonly spawnCodex: SpawnCodex = (executable, args, cwd) => ({ process: spawn(executable, [...args], { cwd, stdio: "ignore" }), runtimeId: `runtime-${Date.now()}-${Math.random().toString(16).slice(2)}` }), private readonly allowlist: LaunchAllowlist = defaultLaunchAllowlist, private readonly verifyFence: TeardownFenceVerifier = () => false, private readonly ownership: RuntimeOwnershipStore = new MemoryRuntimeOwnershipStore()) {}

  async launch(input: { channelId: string; priorSessionId: string; generation: number; launch: AllowlistedLaunchConfig; layout: LayoutMetadata; adapterKind: string }): Promise<{ sessionId: string; runtimeId: string }> {
    if (!["codex", "claude", "grok", "agy"].includes(input.adapterKind)) throw new Error(`unsupported runtime adapter ${input.adapterKind}`);
    if (!this.allowlist(input.launch)) throw new Error("launch configuration is not allowlisted");
    const existing = this.processes.get(input.priorSessionId);
    if (existing && existing.generation >= input.generation) throw new Error("runtime generation is already active");
    const runtimeId = `pending-${input.priorSessionId}-${input.generation}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    if (!this.ownership.claim(input.priorSessionId, input.generation, runtimeId)) throw new Error("runtime generation already has durable ownership");
    let launched: SpawnedCodex;
    try { launched = this.spawnCodex(input.launch.executable, input.launch.args, input.launch.cwd); }
    catch (error) { this.ownership.remove(input.priorSessionId, input.generation, runtimeId); throw error; }
    const sessionId = `session-${input.channelId}-${input.generation}-${runtimeId}`;
    const ownedLaunch = { ...launched, runtimeId };
    this.processes.set(input.priorSessionId, { ...ownedLaunch, generation: input.generation });
    if (!launched.process.pid) { this.processes.delete(input.priorSessionId); this.ownership.remove(input.priorSessionId, input.generation, runtimeId); throw new Error("runtime process has no PID"); }
    try { this.ownership.write(input.priorSessionId, input.generation, { runtimeId, pid: launched.process.pid, startIdentity: processIdentity(launched.process.pid) }); }
    catch (error) { this.processes.delete(input.priorSessionId); await terminate(launched.process); this.ownership.remove(input.priorSessionId, input.generation, runtimeId); throw error; }
    return { sessionId, runtimeId };
  }

  async stop(input: { sessionId: string; runtimeId: string; fence: TeardownFence }): Promise<void> {
    const processEntry = [...this.processes.entries()].find(([, value]) => value.runtimeId === input.runtimeId);
    const owned = this.ownership.readByRuntime(input.runtimeId);
    // Missing ownership means the generation is already gone (mass terminate,
    // prior stop, or never claimed). Ensure-stopped is a successful no-op.
    if (!owned) {
      if (processEntry) this.processes.delete(processEntry[0]);
      return;
    }
    if (!await this.verifyFence(input.fence.token)) throw new Error("stale teardown fence");
    await input.fence.assertCurrent();
    if (processEntry) await terminate(processEntry[1].process); else await terminatePid(owned.pid, owned.startIdentity);
    this.ownership.remove(owned.priorSessionId, owned.generation);
    if (processEntry) this.processes.delete(processEntry[0]);
  }

  async stopGeneration(input: { priorSessionId: string; generation: number; fence: TeardownFence }): Promise<void> {
    const entry = this.processes.get(input.priorSessionId);
    const owned = this.ownership.read(input.priorSessionId, input.generation);
    if (!owned) {
      if (entry && entry.generation === input.generation) this.processes.delete(input.priorSessionId);
      return;
    }
    if (entry && entry.generation !== input.generation) throw new Error("runtime generation is not owned by this lifecycle");
    if (!await this.verifyFence(input.fence.token)) throw new Error("stale teardown fence");
    await input.fence.assertCurrent();
    this.processes.delete(input.priorSessionId);
    if (entry) await terminate(entry.process); else await terminatePid(owned.pid, owned.startIdentity);
    this.ownership.remove(input.priorSessionId, input.generation);
    this.lastTeardown = { priorSessionId: input.priorSessionId, generation: input.generation, pid: owned.pid, observedExit: !isAlive(owned.pid), exitCode: entry?.process.exitCode ?? null };
  }
}

export interface CodexResumeDescriptor { cwd: string; prompt: string }

/** Provider adapter for the real durable `codex exec resume <thread-id>` path. */
export class CodexConversationAdapter implements ProviderConversationPort {
  private readonly active = new Map<string, { process: ChildProcess; generation: number }>();
  public lastRun: { conversationId: string; generation: number; pid: number | null; exitCode: number | null; signal: NodeJS.Signals | null } | null = null;
  constructor(private readonly allowlist: LaunchAllowlist = defaultLaunchAllowlist, private readonly verifyFence: TeardownFenceVerifier = () => false, private readonly spawnConversation: SpawnCodexConversation = (executable, args, cwd) => spawn(executable, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] })) {}

  async resume(ref: { conversationId: string; resumeDescriptor: unknown }, generation: number): Promise<void> {
    await this.resumeWithReply(ref, generation);
  }

  async resumeWithReply(ref: { conversationId: string; resumeDescriptor: unknown }, generation: number): Promise<string> {
    const descriptor = ref.resumeDescriptor as Partial<CodexResumeDescriptor>;
    if (typeof descriptor.cwd !== "string" || typeof descriptor.prompt !== "string") throw new Error("invalid Codex resume descriptor");
    return this.sendPrompt(ref, descriptor.cwd, descriptor.prompt, generation);
  }

  private async sendPrompt(ref: { conversationId: string }, cwd: string, prompt: string, generation: number): Promise<string> {
    const args = ["exec", "resume", "--json", ref.conversationId, prompt] as const;
    if (!this.allowlist({ executable: "codex", args, cwd })) throw new Error("invalid Codex resume descriptor");
    if (this.active.has(ref.conversationId)) throw new Error("Codex conversation is already active");
    const child = this.spawnConversation("codex", args, cwd);
    this.active.set(ref.conversationId, { process: child, generation });
    let timer: NodeJS.Timeout | undefined;
    try {
      const output = await Promise.race([collect(child), new Promise<never>((_, reject) => { timer = setTimeout(async () => { await terminate(child); reject(new Error("codex resume timed out")); }, 120_000); })]);
      this.lastRun = { conversationId: ref.conversationId, generation, pid: child.pid ?? null, exitCode: child.exitCode, signal: child.signalCode };
      if (child.exitCode !== 0) throw new Error(`codex resume exited ${child.exitCode}: ${output.stderr}`);
      const message = output.stdout.split("\n").map(line => { try { return JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } } } catch { return null; } }).find(event => event?.type === "item.completed" && event.item?.type === "agent_message")?.item?.text;
      if (!message) throw new Error("codex resume returned no agent message");
      return message;
    } finally { if (timer) clearTimeout(timer); this.active.delete(ref.conversationId); }
  }

  async stop(ref: { conversationId: string }, fence: TeardownFence): Promise<void> {
    const active = this.active.get(ref.conversationId);
    if (active) { if (!fence.token || !await this.verifyFence(fence.token)) throw new Error("stale teardown fence"); await fence.assertCurrent(); await terminate(active.process); this.active.delete(ref.conversationId); }
  }

  async stopRollback(ref: { conversationId: string }, fence: TeardownFence): Promise<void> {
    const active = this.active.get(ref.conversationId);
    if (active) { if (!await this.verifyFence(fence.token)) throw new Error("stale teardown fence"); await fence.assertCurrent(); await terminate(active.process); this.active.delete(ref.conversationId); }
  }
}

async function terminate(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  process.kill("SIGTERM");
  if (typeof (process as ChildProcess & { once?: unknown }).once !== "function") return;
  await new Promise<void>((resolve, reject) => {
    let forceTimer: NodeJS.Timeout | undefined;
    let failTimer: NodeJS.Timeout | undefined;
    const onExit = () => { if (forceTimer) clearTimeout(forceTimer); if (failTimer) clearTimeout(failTimer); resolve(); };
    process.once("exit", onExit);
    forceTimer = setTimeout(() => {
      if (process.exitCode !== null || process.signalCode !== null) return;
      process.kill("SIGKILL");
      failTimer = setTimeout(() => { process.removeListener("exit", onExit); reject(new Error("process did not exit after SIGKILL")); }, 2_000);
    }, 2_000);
  });
}
async function terminatePid(pid: number, startIdentity: string): Promise<void> {
  if (pid <= 0) return;
  if (!isAlive(pid)) return;
  if (processIdentity(pid) !== startIdentity) throw new Error("runtime PID identity mismatch");
  try { process.kill(pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && isAlive(pid)) await new Promise(resolve => setTimeout(resolve, 25));
  if (isAlive(pid)) process.kill(pid, "SIGKILL");
  const finalDeadline = Date.now() + 2_000;
  while (Date.now() < finalDeadline && isAlive(pid)) await new Promise(resolve => setTimeout(resolve, 25));
  if (isAlive(pid)) throw new Error("runtime process did not exit");
}
function isAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } }
function processIdentity(pid: number): string { try { const identity = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim(); if (identity) return identity; } catch { /* test doubles and already-exited children have no ps identity */ } return `pid:${pid}`; }

function collect(process: ChildProcess): Promise<{ stdout: string; stderr: string }> {
  let stdout = ""; let stderr = "";
  let overflow = false;
  process.stdout?.on("data", chunk => { if (stdout.length <= 1_000_000) stdout += String(chunk).slice(0, 1_000_001 - stdout.length); if (stdout.length > 1_000_000) overflow = true; });
  process.stderr?.on("data", chunk => { stderr += String(chunk).slice(0, 16_000); });
  return new Promise((resolve, reject) => {
    process.once("error", reject);
    process.once("close", () => overflow ? reject(new Error("codex resume output exceeded limit")) : resolve({ stdout, stderr }));
  });
}

function jsonReply(stdout: string, field: string, provider: string): string {
  let value: unknown;
  try { value = JSON.parse(stdout); }
  catch { throw new Error(`${provider} resume returned invalid JSON`); }
  const reply = value && typeof value === "object" ? (value as Record<string, unknown>)[field] : null;
  if (typeof reply !== "string" || !reply.trim()) throw new Error(`${provider} resume returned no agent message`);
  return reply;
}

function defaultLaunchAllowlist(input: { executable: string; args: readonly string[]; cwd: string }): boolean {
  if (input.cwd.length === 0) return false;
  if (input.executable === "claude") return input.args.length > 0 && input.args.some(arg => arg === "-p" || arg === "--resume");
  if (input.executable === "grok") return input.args.length > 0;
  if (input.executable !== "codex" || input.args[0] !== "exec") return false;
  if (input.args[1] === "resume") return input.args.length === 5 && input.args[2] === "--json" && input.args[3].length > 0 && input.args[4].length > 0;
  if (input.args.length < 2) return false;
  const flags = input.args.slice(1, -1);
  const prompt = input.args.at(-1) ?? "";
  return prompt.length > 0 && !prompt.startsWith("--") && flags.every(arg => arg === "--ephemeral" || arg === "--json");
}

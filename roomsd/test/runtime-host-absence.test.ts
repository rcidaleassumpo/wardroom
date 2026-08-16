// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:net";
import { RoomsRepository } from "../src/storage/repository.js";
import { RuntimeRepository } from "../src/storage/runtime-repository.js";
import { RoomsRuntimeService } from "../src/runtime/service.js";
import { encodeProviderSubmission } from "../src/runtime/service.js";
import { runtimeHandleRef } from "../src/runtime/host/endpoint.js";

const operator = { sessionId: "operator", role: "operator" as const, credentialId: "operator" };
const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function listeningSocket(directory: string, name: string): Promise<string> {
  const socketPath = join(directory, name);
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  return socketPath;
}

function proofStore(): { database: RoomsRepository; runtimes: RuntimeRepository; service: RoomsRuntimeService; stateDir: string } {
  const database = new RoomsRepository(":memory:");
  database.insertChannel({ id: "proof" });
  database.insertSession({ id: "operator", role: "operator" });
  database.insertSession({ id: "worker", role: "worker" });
  database.insertSession({ id: "worker-live", role: "worker" });
  database.insertSession({ id: "worker-elsewhere", role: "worker" });
  database.insertMembership("proof", "operator", "operator");
  database.insertMembership("proof", "worker", "worker");
  database.insertMembership("proof", "worker-live", "worker");
  database.insertMembership("proof", "worker-elsewhere", "worker");
  const stateDir = temporaryDirectory("rooms-absence-state-");
  const runtimes = new RuntimeRepository(database.db);
  const service = new RoomsRuntimeService(runtimes, {
    machineId: "machine",
    defaultHomeAuthorityId: "authority-test",
    stateDir,
    socketDirectory: temporaryDirectory("rooms-absence-sockets-"),
  });
  return { database, runtimes, service, stateDir };
}

function runningRuntime(runtimes: RuntimeRepository, input: { runtimeId: string; socketPath: string; stateDir: string; homeAuthorityId?: string; machineId?: string; sessionId?: string }): void {
  const sessionId = input.sessionId ?? "worker";
  const runtime = runtimes.create({
    runtimeId: input.runtimeId,
    homeAuthorityId: input.homeAuthorityId ?? "authority-test",
    sessionId,
    generation: 1,
    protocolVersion: 1,
    transportKind: "localPty",
    machineId: input.machineId ?? "machine",
    providerThreadId: null,
    reconnectSecret: randomBytes(32),
  });
  runtimes.bind({
    bindingId: `binding-${input.runtimeId}`,
    runtimeId: runtime.runtimeId,
    homeAuthorityId: runtime.homeAuthorityId,
    sessionId: runtime.sessionId,
    generation: runtime.generation,
    channelId: "proof",
    adapterKind: "codex",
    handleRef: runtimeHandleRef(input.socketPath, input.stateDir),
    launchPolicyRef: null,
  });
  runtimes.markState(runtime.runtimeId, runtime.generation, "running");
}

describe("runtime host absence", () => {
  it("records the hosts that died while the daemon was down and keeps the ones still listening", async () => {
    const { runtimes, service, stateDir } = proofStore();
    const sockets = temporaryDirectory("rooms-absence-live-");
    // Written under an earlier hostname: the machine keeps its home authority
    // when it joins another network, so the row is still this daemon's to fix.
    runningRuntime(runtimes, { runtimeId: "runtime-gone", socketPath: join(sockets, "gone.sock"), stateDir, machineId: "machine.old-network" });
    runningRuntime(runtimes, { runtimeId: "runtime-live", socketPath: await listeningSocket(sockets, "live.sock"), stateDir, sessionId: "worker-live" });
    runningRuntime(runtimes, { runtimeId: "runtime-elsewhere", socketPath: join(sockets, "elsewhere.sock"), stateDir, homeAuthorityId: "authority-other-machine", sessionId: "worker-elsewhere" });

    const result = await service.reconcileLocalRuntimeHosts();

    expect(result).toEqual({ checked: 2, crashed: ["runtime-gone"] });
    expect(runtimes.get("runtime-gone")).toMatchObject({ state: "crashed", exitReason: "runtime host is absent" });
    expect(runtimes.get("runtime-gone")?.endedAt).not.toBeNull();
    expect(runtimes.get("runtime-live")).toMatchObject({ state: "running", endedAt: null });
    expect(runtimes.get("runtime-elsewhere")).toMatchObject({ state: "running", endedAt: null });
  });

  it("leaves an already finished generation alone", async () => {
    const { runtimes, service, stateDir } = proofStore();
    const sockets = temporaryDirectory("rooms-absence-ended-");
    runningRuntime(runtimes, { runtimeId: "runtime-exited", socketPath: join(sockets, "exited.sock"), stateDir });
    runtimes.markState("runtime-exited", 1, "exited", "exit:0");

    expect(await service.reconcileLocalRuntimeHosts()).toEqual({ checked: 0, crashed: [] });
    expect(runtimes.get("runtime-exited")).toMatchObject({ state: "exited", exitReason: "exit:0" });
  });

  it("records the absence a send discovers instead of leaving the runtime claiming to run", async () => {
    const { database, runtimes, service, stateDir } = proofStore();
    const sockets = temporaryDirectory("rooms-absence-send-");
    runningRuntime(runtimes, { runtimeId: "runtime-gone", socketPath: join(sockets, "gone.sock"), stateDir });
    const committed = database.commitMessage({
      channelId: "proof",
      senderSessionId: "operator",
      body: "all good ?",
      target: { kind: "direct", sessionId: "worker" },
    } as never) as { event: { id: string } };
    const submission = encodeProviderSubmission("all good ?");

    await expect(service.deliverMessage({
      runtimeId: "runtime-gone",
      generation: 1,
      messageId: committed.event.id,
      frames: submission.frames,
      delaysMs: submission.delaysMs,
    } as never, operator)).rejects.toThrow();

    expect(runtimes.get("runtime-gone")).toMatchObject({ state: "crashed", exitReason: "runtime host is absent" });
    // The next send resolves no live runtime, so the caller is told the agent
    // is offline instead of being handed the same undeliverable generation.
    expect(() => service.resolveActiveSessionRuntimeForDelivery("worker", operator)).toThrow(/runtimeNotFound/);
  });
});

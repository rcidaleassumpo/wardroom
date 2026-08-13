import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadMachineSigningKeys, setupMachineIdentity } from "../src/identity/machine-identity.js";
import { createTerminalRuntimeHandler } from "../src/federation/terminal-runtime-handler.js";
import { encodeTerminalCapability, issueTerminalCapability, parseTerminalCapability, verifyTerminalCapability } from "../src/federation/terminal-capability.js";
import type { RelayConnection } from "../src/federation/relay-connection.js";
import { encodeRelayFrame, parseRelayFrame, type RelayTerminalFrame } from "../src/federation/relay-protocol.js";
import type { AuthorityId } from "../src/federation/contracts.js";
import { advancePeerTrustFromEnrollmentProof } from "../src/federation/peer-trust.js";
import { runRoomsFederationCapabilityCommand } from "../src/cli/federation.js";
import { RoomsRepository } from "../src/storage/repository.js";
import { RuntimeRepository } from "../src/storage/runtime-repository.js";
import { RoomsRuntimeService } from "../src/runtime/service.js";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function identity() {
  const stateDir = mkdtempSync(join(tmpdir(), "rooms-terminal-capability-"));
  temporary.push(stateDir);
  const status = setupMachineIdentity(stateDir);
  return { stateDir, status, keys: loadMachineSigningKeys(stateDir) };
}

function openFrame(capability: ReturnType<typeof issueTerminalCapability>, streamId = "stream-1", mode: "observe" | "controller" = "controller"): Extract<RelayTerminalFrame, { kind: "terminalOpen" }> {
  return {
    kind: "terminalOpen",
    connectionId: "00000000-0000-0000-0000-000000000001",
    direction: "initiatorToResponder",
    seq: 1,
    streamId,
    homeAuthorityId: capability.issuer,
    sessionId: capability.sessionId,
    capability: encodeTerminalCapability(capability),
    mode,
    outputCursor: "0",
  };
}

describe("federated terminal capabilities", () => {
  it("rejects a changed session, audience, action set, signature, or expiry", () => {
    const home = identity();
    const capability = issueTerminalCapability({
      issuer: home.status.authorityId as AuthorityId,
      audience: "authority-peer" as AuthorityId,
      sessionId: "session-owned",
      runtimeId: "runtime-owned",
      generation: 4,
      mode: "observe",
      privateKey: home.keys.privateKey,
      now: new Date("2026-08-04T12:00:00.000Z"),
      ttlSeconds: 60,
    });
    const verify = (value = capability, overrides: Partial<Parameters<typeof verifyTerminalCapability>[0]> = {}) => verifyTerminalCapability({
      capability: value,
      publicKey: home.keys.publicKey,
      issuer: home.status.authorityId as AuthorityId,
      audience: "authority-peer" as AuthorityId,
      sessionId: "session-owned",
      mode: "observe",
      now: new Date("2026-08-04T12:00:30.000Z"),
      ...overrides,
    });
    expect(() => verify()).not.toThrow();
    expect(() => verify(capability, { sessionId: "another-session" })).toThrow("session mismatch");
    expect(() => verify(capability, { audience: "authority-other" as AuthorityId })).toThrow("audience mismatch");
    expect(() => verify(capability, { mode: "controller" })).toThrow("action mismatch");
    expect(() => verify({ ...capability, channelId: "channel-attacker" })).toThrow("signature is invalid");
    expect(() => verify({ ...capability, runtimeId: "runtime-attacker" })).toThrow("signature is invalid");
    expect(() => verify(capability, { now: new Date("2026-08-04T12:01:00.000Z") })).toThrow("expired");
  });

  it("round-trips only the signed capability form on the relay wire", () => {
    const home = identity();
    const capability = issueTerminalCapability({ issuer: home.status.authorityId as AuthorityId, audience: "authority-peer" as AuthorityId, sessionId: "session-owned", runtimeId: "runtime-owned", generation: 1, mode: "observe", privateKey: home.keys.privateKey });
    const frame = openFrame(capability, "stream-wire", "observe");
    expect(parseRelayFrame(encodeRelayFrame(frame).trim())).toEqual(frame);
    expect(() => parseRelayFrame(JSON.stringify({ ...frame, capabilityId: capability.capabilityId }))).toThrow("unknown field capabilityId");
  });

  it("uses a worker actor scoped to the signed runtime and burns the capability before attach", async () => {
    const home = identity();
    const peer = "authority-peer" as AuthorityId;
    const capability = issueTerminalCapability({ issuer: home.status.authorityId as AuthorityId, audience: peer, sessionId: "session-owned", runtimeId: "runtime-owned", generation: 4, mode: "controller", privateKey: home.keys.privateKey });
    const sent: unknown[] = [];
    const connection = {
      status: () => ({ state: "connected", peerAuthorityId: peer }),
      sendTerminal: (frame: unknown) => sent.push(frame),
    } as unknown as RelayConnection;
    const resolveActiveSessionRuntime = vi.fn((_sessionId, actor, action) => {
      expect(actor).toMatchObject({ sessionId: `federation:${peer}`, role: "worker", capability: { capabilityId: capability.capabilityId, runtimeId: "runtime-owned", generation: 4, sessionId: "session-owned", channelId: null } });
      expect(action).toBe("controller");
      return { runtimeId: "runtime-owned", homeAuthorityId: home.status.authorityId, sessionId: "session-owned", generation: 4 };
    });
    const federatedTerminalBindingChannel = vi.fn(() => null);
    const consumeFederatedTerminalCapability = vi.fn();
    const attachInteractive = vi.fn(async (_request, actor) => {
      expect(consumeFederatedTerminalCapability).toHaveBeenCalledOnce();
      expect(actor.role).toBe("worker");
      return { hello: { gap: false, head: 0n, replayFrom: 0n }, input: vi.fn(), resize: vi.fn(), detach: vi.fn() };
    });
    const handler = createTerminalRuntimeHandler({ resolveActiveSessionRuntime, federatedTerminalBindingChannel, consumeFederatedTerminalCapability, attachInteractive } as never, home.status.authorityId, home.stateDir);
    await handler.handleTerminal?.(openFrame(capability), connection);
    expect(resolveActiveSessionRuntime).toHaveBeenCalledOnce();
    expect(consumeFederatedTerminalCapability).toHaveBeenCalledWith({ runtimeId: "runtime-owned", generation: 4, capabilityId: capability.capabilityId, nonce: capability.nonce, expiresAt: capability.expiresAt });
    expect(attachInteractive).toHaveBeenCalledOnce();
    expect(sent).toContainEqual(expect.objectContaining({ kind: "terminalOpenAck", runtimeId: "runtime-owned", generation: 4 }));
  });

  it("rejects forged, misaddressed, expired, misbound, and under-scoped opens at the runtime handler", async () => {
    const home = identity();
    const peer = "authority-peer" as AuthorityId;
    const issue = (overrides: Partial<Parameters<typeof issueTerminalCapability>[0]> = {}) => issueTerminalCapability({
      issuer: home.status.authorityId as AuthorityId,
      audience: peer,
      sessionId: "session-owned",
      runtimeId: "runtime-owned",
      generation: 4,
      mode: "controller",
      privateKey: home.keys.privateKey,
      ...overrides,
    });
    const runtimeService = {
      resolveActiveSessionRuntime: vi.fn(() => ({ runtimeId: "runtime-owned", homeAuthorityId: home.status.authorityId, sessionId: "session-owned", generation: 4 })),
      federatedTerminalBindingChannel: vi.fn(() => null),
      consumeFederatedTerminalCapability: vi.fn(),
      attachInteractive: vi.fn(),
    };
    const connection = { status: () => ({ state: "connected", peerAuthorityId: peer }), sendTerminal: vi.fn() } as unknown as RelayConnection;
    const handler = createTerminalRuntimeHandler(runtimeService as never, home.status.authorityId, home.stateDir);
    const valid = issue();
    const failures = [
      { name: "forged signature", capability: { ...valid, signature: `${valid.signature.slice(0, -2)}AA` }, expected: "signature is invalid" },
      { name: "wrong audience", capability: issue({ audience: "authority-other" as AuthorityId }), expected: "audience mismatch" },
      { name: "wrong runtime", capability: issue({ runtimeId: "runtime-other" }), expected: "stale terminal capability binding" },
      { name: "wrong generation", capability: issue({ generation: 3 }), expected: "stale terminal capability binding" },
      { name: "expired", capability: issue({ now: new Date("2020-01-01T00:00:00.000Z"), ttlSeconds: 1 }), expected: "expired" },
      { name: "missing controller action", capability: issueTerminalCapability({ issuer: home.status.authorityId as AuthorityId, audience: peer, sessionId: "session-owned", runtimeId: "runtime-owned", generation: 4, mode: "observe", privateKey: home.keys.privateKey }), expected: "action mismatch" },
    ];
    for (const [index, failure] of failures.entries()) {
      await expect(handler.handleTerminal?.(openFrame(failure.capability, `stream-rejected-${index}`), connection), failure.name).rejects.toThrow(failure.expected);
    }
    expect(runtimeService.consumeFederatedTerminalCapability).not.toHaveBeenCalled();
    expect(runtimeService.attachInteractive).not.toHaveBeenCalled();
  });

  it("fails closed when the durable replay fence rejects a reused capability", async () => {
    const home = identity();
    const peer = "authority-peer" as AuthorityId;
    const capability = issueTerminalCapability({ issuer: home.status.authorityId as AuthorityId, audience: peer, sessionId: "session-owned", runtimeId: "runtime-owned", generation: 1, mode: "observe", privateKey: home.keys.privateKey });
    const connection = { status: () => ({ state: "connected", peerAuthorityId: peer }), sendTerminal: vi.fn() } as unknown as RelayConnection;
    let consumed = false;
    const runtimeService = {
      resolveActiveSessionRuntime: () => ({ runtimeId: "runtime-owned", homeAuthorityId: home.status.authorityId, sessionId: "session-owned", generation: 1 }),
      federatedTerminalBindingChannel: () => null,
      consumeFederatedTerminalCapability: () => { if (consumed) throw new Error("capabilityReplay"); consumed = true; },
      attachInteractive: async () => ({ hello: { gap: false, head: 0n, replayFrom: 0n }, input: vi.fn(), resize: vi.fn(), detach: vi.fn() }),
    };
    const handler = createTerminalRuntimeHandler(runtimeService as never, home.status.authorityId, home.stateDir);
    await handler.handleTerminal?.(openFrame(capability, "stream-1", "observe"), connection);
    await expect(handler.handleTerminal?.(openFrame(capability, "stream-2", "observe"), connection)).rejects.toThrow("capabilityReplay");
  });

  it("lets only the runtime owner or an operator issue a capability to an active peer", () => {
    const home = identity();
    const repository = new RoomsRepository(join(home.stateDir, "rooms.sqlite"));
    const runtimes = new RuntimeRepository(repository.db);
    repository.insertSession({ id: "owner", role: "worker" });
    repository.insertSession({ id: "intruder", role: "worker" });
    runtimes.create({ runtimeId: "runtime-owned", homeAuthorityId: home.status.authorityId, sessionId: "owner", generation: 1, protocolVersion: 4, transportKind: "localPty", machineId: "machine-home", reconnectSecret: Buffer.alloc(32, 7) });
    runtimes.markState("runtime-owned", 1, "running");
    const peerKeys = generateKeyPairSync("ed25519");
    const publicKeyPem = peerKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const fingerprint = createHash("sha256").update(peerKeys.publicKey.export({ type: "spki", format: "der" })).digest("hex");
    const peer = `authority-${fingerprint}` as AuthorityId;
    advancePeerTrustFromEnrollmentProof({ stateDir: home.stateDir, authorityId: peer, publicKeyPem, toState: "active", transportPolicy: { kind: "loopbackSsh", peerAuthorityId: peer, sshDestination: "peer-host", sshUser: "operator", localEndpoint: "127.0.0.1", localPort: 1 } });
    repository.close();

    const out = join(home.stateDir, "owner.capability.json");
    const flags = new Map([["state-dir", home.stateDir], ["credential", "owner"], ["session", "owner"], ["peer-authority-id", peer], ["mode", "controller"], ["out", out]]);
    expect(runRoomsFederationCapabilityCommand("issue", flags)).toMatchObject({ audience: peer, sessionId: "owner", runtimeId: "runtime-owned", generation: 1, actions: ["observe", "controller", "input", "resize"], file: out });
    const capability = parseTerminalCapability(readFileSync(out, "utf8"));
    expect(() => verifyTerminalCapability({ capability, publicKey: home.keys.publicKey, issuer: home.status.authorityId as AuthorityId, audience: peer, sessionId: "owner", mode: "controller" })).not.toThrow();
    const replayRepository = new RoomsRepository(join(home.stateDir, "rooms.sqlite"));
    const runtimeService = new RoomsRuntimeService(new RuntimeRepository(replayRepository.db), { machineId: "machine-home", defaultHomeAuthorityId: home.status.authorityId, stateDir: join(home.stateDir, "runtime-service") });
    const consume = (capabilityId = capability.capabilityId) => runtimeService.consumeFederatedTerminalCapability({ runtimeId: capability.runtimeId, generation: capability.generation, capabilityId, nonce: capability.nonce, expiresAt: capability.expiresAt });
    expect(() => consume()).not.toThrow();
    expect(() => consume(`${capability.capabilityId}-same-nonce`)).toThrow("capabilityReplay");
    replayRepository.close();

    const denied = new Map(flags);
    denied.set("credential", "intruder");
    denied.set("out", join(home.stateDir, "intruder.capability.json"));
    expect(() => runRoomsFederationCapabilityCommand("issue", denied)).toThrow("requires the runtime owner or an operator");
  });
});

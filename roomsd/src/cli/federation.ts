// SPDX-License-Identifier: Apache-2.0
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  preparePeerTrust,
  listPeerTrust,
  readActivePeerTrust,
  readPeerTrust,
  revokePeerTrust,
  type PeerTrustRecord,
} from "../federation/peer-trust.js";
import {
  createEnrollmentAccept,
  createEnrollmentChallenge,
  createEnrollmentConfirm,
  createEnrollmentOffer,
  finalizeEnrollment,
} from "../federation/enrollment.js";
import type { EnrollmentAccept, EnrollmentChallenge, EnrollmentConfirm, EnrollmentOffer } from "../federation/contracts.js";
import type { AuthorityId } from "../federation/contracts.js";
import { connectPeerOverSsh, type SshConnectResult } from "../federation/ssh-connect.js";
import { runEnrollRemoteStep } from "../federation/enroll-remote-step.js";
import { resolveRoomsStateDir } from "../identity/machine-identity.js";
import { acquireOutboundRelayLock, RelayConnectionLockError } from "../federation/relay-connection-lock.js";
import { RelayReconnectLoop } from "../federation/relay-reconnect.js";
import { isGracefulRelayDisconnect, runRelayServeStdio } from "../federation/relay-serve-stdio.js";
import { createSshRelayConnection, type SshRelayConnectInput } from "../federation/ssh-relay-transport.js";
import { neutralRelayApplicationHandler } from "../federation/relay-connection.js";
import type { RelayChannelFrame } from "../federation/relay-protocol.js";
import { removeFederatedChannelRoute, upsertFederatedChannelRoute } from "../federation/channel-route-store.js";
import { upsertMachineRoute } from "../federation/machine-route-store.js";
import { ChannelResultAssembler } from "../federation/channel-result.js";
import { issueTerminalCapability } from "../federation/terminal-capability.js";
import { loadMachineSigningKeys } from "../identity/machine-identity.js";
import { RoomsRepository } from "../storage/repository.js";
import { RuntimeRepository } from "../storage/runtime-repository.js";
import { roomsPaths } from "../provisioning/paths.js";

export type FederationPeerCommand = "prepare" | "revoke" | "list" | "show" | "connect";

export const FEDERATION_PEER_COMMANDS: readonly FederationPeerCommand[] = ["prepare", "revoke", "list", "show", "connect"];

export type FederationEnrollCommand = "offer" | "challenge" | "accept" | "confirm" | "finalize" | "remote-step";

export const FEDERATION_ENROLL_COMMANDS: readonly FederationEnrollCommand[] = ["offer", "challenge", "accept", "confirm", "finalize", "remote-step"];

export type FederationRelayCommand = "serve-stdio" | "connect";

export const FEDERATION_RELAY_COMMANDS: readonly FederationRelayCommand[] = ["serve-stdio", "connect"];

export type FederationChannelCommand = "admit" | "revoke-admission" | "admissions" | "register" | "leave" | "send" | "direct-send" | "snapshot" | "messages";
export const FEDERATION_CHANNEL_COMMANDS: readonly FederationChannelCommand[] = ["admit", "revoke-admission", "admissions", "register", "leave", "send", "direct-send", "snapshot", "messages"];

export type FederationCapabilityCommand = "issue";
export const FEDERATION_CAPABILITY_COMMANDS: readonly FederationCapabilityCommand[] = ["issue"];

/**
 * Mint one short-lived capability on the runtime's home machine. Only the runtime owner
 * or a local operator may issue it, and the audience must already be an active peer.
 */
export function runRoomsFederationCapabilityCommand(command: FederationCapabilityCommand, flags: ReadonlyMap<string, string>): unknown {
  if (command !== "issue") throw new Error("unknown federation capability command");
  const paths = roomsPaths(flags.get("state-dir"));
  const repository = new RoomsRepository(paths.storePath, { schemaPolicy: "require-current", schemaActor: "Rooms capability issuer" });
  try {
    const credential = required(flags, "credential");
    const actorSessionIds = repository.sessionsForExternalId(credential);
    if (actorSessionIds.length === 0 && repository.currentSession(credential)?.endedAt === null) actorSessionIds.push(credential);
    if (actorSessionIds.length !== 1) throw new Error("invalid runtime credential");
    const actor = repository.currentSession(actorSessionIds[0]!);
    if (!actor || actor.endedAt !== null || !actor.role) throw new Error("invalid runtime credential");

    const sessionId = required(flags, "session");
    const target = repository.currentSession(sessionId);
    if (!target || target.endedAt !== null) throw new Error("terminal capability session is not active");
    if (actor.role !== "operator" && actor.id !== sessionId) throw new Error("terminal capability issuance requires the runtime owner or an operator");

    const audience = required(flags, "peer-authority-id") as AuthorityId;
    if (!readActivePeerTrust(audience, paths.stateDir)) {
      throw new Error("terminal capability audience is not an active enrolled peer");
    }
    const runtimeRepository = new RuntimeRepository(repository.db);
    const runtime = runtimeRepository.list()
      .filter((item) => item.sessionId === sessionId && !item.endedAt && ["running", "recovering"].includes(item.state))
      .sort((left, right) => right.generation - left.generation)[0];
    if (!runtime) throw new Error("terminal capability session has no active runtime");
    const mode = flags.get("mode") ?? "observe";
    if (mode !== "observe" && mode !== "controller") throw new Error("--mode must be observe or controller");
    const ttlSeconds = flags.has("ttl-seconds") ? requireInteger(required(flags, "ttl-seconds"), "ttl-seconds") : undefined;
    const keys = loadMachineSigningKeys(paths.stateDir);
    const capability = issueTerminalCapability({
      issuer: keys.authorityId as AuthorityId,
      audience,
      sessionId,
      channelId: runtimeRepository.getBinding(runtime.runtimeId)?.channelId ?? null,
      runtimeId: runtime.runtimeId,
      generation: runtime.generation,
      mode,
      privateKey: keys.privateKey,
      ttlSeconds,
    });
    const out = required(flags, "out");
    writeFileSync(out, `${JSON.stringify(capability, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const modeBits = statSync(out).mode & 0o777;
    if (modeBits !== 0o600) throw new Error(`terminal capability file permissions must be 600, found ${modeBits.toString(8)}`);
    return { capabilityId: capability.capabilityId, issuer: capability.issuer, audience: capability.audience, sessionId, runtimeId: runtime.runtimeId, generation: runtime.generation, actions: capability.actions, expiresAt: capability.expiresAt, file: out };
  } finally {
    repository.close();
  }
}

/** Route one bounded channel operation to the authority that owns that channel. */
export async function runRoomsFederationChannelCommand(command: FederationChannelCommand, flags: ReadonlyMap<string, string>): Promise<unknown> {
  if (command === "admit" || command === "revoke-admission" || command === "admissions") {
    const paths = roomsPaths(flags.get("state-dir"));
    const repository = new RoomsRepository(paths.storePath, { schemaPolicy: "require-current", schemaActor: "Rooms federation admission CLI" });
    try {
      const credential = required(flags, "credential");
      const actorSessionIds = repository.sessionsForExternalId(credential);
      if (actorSessionIds.length === 0 && repository.currentSession(credential)?.endedAt === null) actorSessionIds.push(credential);
      if (actorSessionIds.length !== 1) throw new Error("invalid federation admission credential");
      const actorSessionId = actorSessionIds[0]!;
      const channelId = required(flags, "channel");
      if (command === "admissions") return { channelId, admissions: repository.listFederatedChannelAdmissions(channelId, actorSessionId) };
      const peerAuthorityId = required(flags, "peer-authority-id") as AuthorityId;
      if (command === "admit" && !readActivePeerTrust(peerAuthorityId, paths.stateDir)) throw new Error("federated channel admission requires an active enrolled peer");
      const admission = command === "admit"
        ? repository.grantFederatedChannelAdmission(channelId, peerAuthorityId, actorSessionId)
        : repository.revokeFederatedChannelAdmission(channelId, peerAuthorityId, actorSessionId);
      return { admission };
    } finally {
      repository.close();
    }
  }
  const replyToEventId = optionalReplyTo(flags);
  if (command === "direct-send" && replyToEventId) {
    throw new Error("structured replies to federated direct messages are unavailable because the parent event belongs to another Rooms authority");
  }
  const sshHost = required(flags, "ssh-host");
  const peerAuthorityId = required(flags, "peer-authority-id") as AuthorityId;
  const actorSessionId = required(flags, "session");
  const requestId = randomUUID();
  const payload: Record<string, unknown> = {};
  if (command === "register") { payload.displayName = flags.get("display-name") ?? actorSessionId; payload.channelId = required(flags, "channel"); }
  else if (command === "direct-send") { payload.targetSessionId = required(flags, "target-session"); payload.body = required(flags, "body"); if (replyToEventId) payload.replyToEventId = replyToEventId; }
  else {
    payload.channelId = required(flags, "channel");
    if (command === "send") {
      payload.body = required(flags, "body");
      if (replyToEventId) payload.replyToEventId = replyToEventId;
    }
    if (command === "messages") payload.afterCursor = flags.get("after-cursor") ?? "0";
  }
  return await new Promise((resolve, reject) => {
    let settled = false;
    const assembler = new ChannelResultAssembler();
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      assembler.clear(requestId);
      connection.drain();
      if (error) reject(error); else resolve(value);
    };
    const handler = {
      ...neutralRelayApplicationHandler,
      handleChannel(frame: RelayChannelFrame): void {
        if (frame.kind !== "channelResult" || frame.requestId !== requestId) throw new Error("unexpected channel result");
        const assembled = assembler.accept(frame);
        if (!assembled) return;
        const value = assembled.value as { message?: string; code?: string; cursor?: string };
        if (!assembled.ok) finish(Object.assign(new Error(value?.message ?? "remote channel command failed"), { code: value?.code }));
        else {
          if (command === "register") {
            upsertFederatedChannelRoute({
              stateDir: flags.get("local-state-dir"),
              homeAuthorityId: peerAuthorityId,
              channelId: required(flags, "channel"),
              localSessionId: actorSessionId,
              sshHost,
              remoteStateDir: flags.get("remote-state-dir"),
              cursor: value.cursor,
            });
          } else if (command === "leave") {
            removeFederatedChannelRoute({ stateDir: flags.get("local-state-dir"), homeAuthorityId: peerAuthorityId, channelId: required(flags, "channel"), localSessionId: actorSessionId });
          }
          finish(undefined, value);
        }
      },
    };
    const connection = createSshRelayConnection({
      sshHost, peerAuthorityId, localStateDir: flags.get("local-state-dir"), remoteStateDir: flags.get("remote-state-dir"), handler,
      onStatusChange(status) {
        if (status.state === "connected") connection.sendChannel({ kind: "channelCommand", requestId, homeAuthorityId: peerAuthorityId, operation: command === "direct-send" ? "directSend" : command, actorSessionId, payload: Buffer.from(JSON.stringify(payload), "utf8").toString("base64") });
        if (status.state === "closed" && !settled) finish(new Error(`channel relay closed: ${status.disconnectReason}: ${status.disconnectMessage ?? ""}`));
      },
    });
    const timer = setTimeout(() => finish(new Error("channel federation command timed out")), 15_000);
    connection.start();
  });
}

function optionalReplyTo(flags: ReadonlyMap<string, string>): string | undefined {
  const replyTo = flags.get("reply-to")?.trim();
  const replyToEvent = flags.get("reply-to-event")?.trim();
  if (flags.has("reply-to") && !replyTo) throw new Error("--reply-to requires an event id");
  if (flags.has("reply-to-event") && !replyToEvent) throw new Error("--reply-to-event requires an event id");
  if (replyTo && replyToEvent && replyTo !== replyToEvent) throw new Error("--reply-to and --reply-to-event must name the same event");
  return replyTo ?? replyToEvent;
}

/**
 * Local-only Rooms peer trust inspection, plus the Rooms-owned SSH connect automation:
 * `prepare`/`revoke`/`list`/`show` never contact a peer or open a listener. `prepare`
 * records a self-asserted, unauthenticated candidate; a record can only ever reach
 * `confirming`/`active` through cryptographically verified Ed25519 proof — either the
 * manual `rooms federation enroll` artifact exchange, or `connect`, which automates that
 * same exchange over SSH (ssh-connect.ts) without adding any new trust primitive.
 */
export async function runRoomsFederationPeerCommand(
  command: FederationPeerCommand,
  flags: ReadonlyMap<string, string>,
): Promise<PeerTrustRecord | readonly PeerTrustRecord[] | SshConnectResult> {
  const stateDir = flags.get("state-dir");
  switch (command) {
    case "prepare":
      return preparePeerTrust({
        stateDir,
        authorityId: required(flags, "authority-id"),
        publicKeyPem: readFileSync(required(flags, "public-key-file"), "utf8"),
        transportPolicy: parseTransportPolicy(required(flags, "transport")),
      });
    case "revoke":
      return revokePeerTrust({ stateDir, authorityId: required(flags, "authority-id"), reason: required(flags, "reason") });
    case "list":
      return listPeerTrust(stateDir);
    case "show":
      return readPeerTrust(required(flags, "authority-id"), stateDir);
    case "connect": {
      const transport = required(flags, "transport");
      if (transport !== "ssh") throw new Error(`unsupported --transport ${transport}; only "ssh" is implemented`);
      const sshHost = required(flags, "ssh-host");
      const result = await connectPeerOverSsh({
        sshHost,
        localStateDir: flags.get("local-state-dir"),
        remoteStateDir: flags.get("remote-state-dir"),
      });
      upsertMachineRoute({ authorityId: result.local.peerAuthorityId as AuthorityId, sshHost, remoteStateDir: flags.get("remote-state-dir"), stateDir: flags.get("local-state-dir") });
      return result;
    }
  }
}

/**
 * Rooms-owned CLI primitives for the cryptographically authenticated mutual enrollment
 * handshake. `offer`/`challenge`/`accept`/`confirm`/`finalize` each consume/produce a
 * bounded, machine-readable, public JSON artifact file; none of them contact a peer or
 * open a listener, and none claim remote proof beyond the Ed25519 signatures they verify.
 * An operator moving the artifact file between the two machines by hand remains fully
 * supported. `remote-step` is the responder-side (`challenge`/`confirm`) counterpart used
 * only by Rooms-owned SSH orchestration (`rooms federation peer connect --transport ssh`,
 * ssh-connect.ts): it reads one bounded JSON request from stdin and writes one JSON
 * response to stdout instead of files, so the SSH adapter never needs remote temp files.
 * It is not intended for direct manual operator use.
 */
export function runRoomsFederationEnrollCommand(
  command: FederationEnrollCommand,
  flags: ReadonlyMap<string, string>,
): unknown {
  const stateDir = flags.get("state-dir");
  switch (command) {
    case "offer": {
      const ttlSeconds = flags.get("ttl-seconds");
      const artifact = createEnrollmentOffer({
        stateDir,
        peerAuthorityId: required(flags, "peer-authority-id"),
        transportPolicy: parseTransportPolicy(required(flags, "transport")),
        ttlSeconds: ttlSeconds === undefined ? undefined : requireInteger(ttlSeconds, "ttl-seconds"),
      });
      writeArtifact(flags, artifact);
      return artifact;
    }
    case "challenge": {
      const offerRaw = readFileSync(required(flags, "offer-file"), "utf8");
      const { artifact, peer } = createEnrollmentChallenge({
        stateDir,
        offerRaw,
        transportPolicy: parseTransportPolicy(required(flags, "transport")),
      });
      writeArtifact(flags, artifact);
      return { artifact, peer };
    }
    case "accept": {
      const challengeRaw = readFileSync(required(flags, "challenge-file"), "utf8");
      const { artifact, peer } = createEnrollmentAccept({ stateDir, challengeRaw });
      writeArtifact(flags, artifact);
      return { artifact, peer };
    }
    case "confirm": {
      const acceptRaw = readFileSync(required(flags, "accept-file"), "utf8");
      const { artifact, peer } = createEnrollmentConfirm({ stateDir, acceptRaw });
      writeArtifact(flags, artifact);
      return { artifact, peer };
    }
    case "finalize": {
      const confirmRaw = readFileSync(required(flags, "confirm-file"), "utf8");
      const { peer } = finalizeEnrollment({ stateDir, confirmRaw });
      return { peer };
    }
    case "remote-step": {
      const rawRequest = readFileSync(0, "utf8");
      return runEnrollRemoteStep(rawRequest);
    }
  }
}

/**
 * Rooms-owned relay connection lifecycle. `serve-stdio` is the fixed
 * remote entry point `rooms federation relay connect` dials over SSH
 * (ssh-relay-transport.ts): it takes no flags at all, because every dynamic parameter
 * (which peer, which state dir) travels inside the authenticated handshake frame instead —
 * the SSH remote argv vocabulary for it is completely fixed. `connect` is the local dialer:
 * it authenticates the pinned peer before any application frame, proves mutual liveness with
 * a bounded echo/status/heartbeat exchange, and reconnects with capped exponential backoff
 * on a transient disconnect only — never on a revoked, mismatched, or rejected peer, which
 * fails closed instead of retrying a connection that cannot succeed. Both commands emit
 * newline-delimited JSON status events for manual proof/scripting: `serve-stdio` writes them
 * to stderr only (stdout carries nothing but the relay wire protocol bytes its SSH peer
 * expects), `connect` writes them to stdout since nothing else uses its stdout.
 */
export async function runRoomsFederationRelayCommand(command: FederationRelayCommand, flags: ReadonlyMap<string, string>): Promise<void> {
  if (command === "serve-stdio") {
    const status = await runRelayServeStdio();
    process.exitCode = isGracefulRelayDisconnect(status.disconnectReason) ? 0 : 1;
    return;
  }
  await runRelayConnectCommand(flags);
}

async function runRelayConnectCommand(flags: ReadonlyMap<string, string>): Promise<void> {
  const sshHost = required(flags, "ssh-host");
  const peerAuthorityId = required(flags, "peer-authority-id") as AuthorityId;
  const localStateDir = flags.get("local-state-dir");
  const remoteStateDir = flags.get("remote-state-dir");
  const heartbeatIntervalMs = optionalNonNegativeInteger(flags, "heartbeat-interval-ms");
  const idleTimeoutMs = optionalNonNegativeInteger(flags, "idle-timeout-ms");
  const handshakeTimeoutMs = optionalNonNegativeInteger(flags, "handshake-timeout-ms");
  const durationMs = optionalNonNegativeInteger(flags, "duration-ms");
  const echoPayload = flags.get("echo-payload") ?? "ping";

  const emit = (event: Record<string, unknown>): void => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  };

  const lockStateDir = resolveRoomsStateDir(localStateDir);
  let releaseLock: (() => void) | null;
  try {
    releaseLock = acquireOutboundRelayLock(lockStateDir, peerAuthorityId);
  } catch (error) {
    if (!(error instanceof RelayConnectionLockError)) throw error;
    emit({ event: "rejected", reason: "duplicateOutboundConnection", message: error.message });
    process.exitCode = 1;
    return;
  }

  const dialInput: SshRelayConnectInput = { sshHost, peerAuthorityId, localStateDir, remoteStateDir, heartbeatIntervalMs, idleTimeoutMs, handshakeTimeoutMs };

  await new Promise<void>((resolve) => {
    const loop = new RelayReconnectLoop({
      connect: (hooks) => {
        let echoSent = false;
        let durationTimer: ReturnType<typeof setTimeout> | null = null;
        const connection = createSshRelayConnection({
          ...dialInput,
          onStatusChange: (status) => {
            hooks.onStatusChange?.(status);
            if (status.state === "connected" && !echoSent) {
              echoSent = true;
              connection.sendEcho(echoPayload);
              connection.requestStatus();
              if (durationMs !== undefined) durationTimer = setTimeout(() => connection.drain(), durationMs);
            }
            if (status.state === "closed" && durationTimer) clearTimeout(durationTimer);
          },
          onEchoReply: hooks.onEchoReply,
          onStatusReply: hooks.onStatusReply,
        });
        return connection;
      },
      onAttempt: (attempt, delayMs) => emit({ event: "reconnectScheduled", attempt, delayMs }),
      onStatusChange: (status, attempt) => emit({ event: "status", attempt, ...status }),
      onEchoReply: (payload, seq) => emit({ event: "echoReply", seq, payload }),
      onStatusReply: (peerStatus, seq) => emit({ event: "statusReply", seq, status: peerStatus }),
      onGiveUp: (status) => {
        emit({ event: "giveUp", ...status });
        process.exitCode = isGracefulRelayDisconnect(status.disconnectReason) ? 0 : 1;
        finish();
      },
    });

    const onSignal = (): void => loop.stop();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    const finish = (): void => {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      releaseLock?.();
      releaseLock = null;
      resolve();
    };

    loop.start();
  });
}

function optionalNonNegativeInteger(flags: ReadonlyMap<string, string>, name: string): number | undefined {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) throw new Error(`--${name} must be a non-negative integer`);
  return Number(value);
}

function writeArtifact(flags: ReadonlyMap<string, string>, artifact: EnrollmentOffer | EnrollmentChallenge | EnrollmentAccept | EnrollmentConfirm): void {
  const out = required(flags, "out");
  writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8" });
}

function required(flags: ReadonlyMap<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function requireInteger(value: string, name: string): number {
  if (!/^[0-9]+$/.test(value)) throw new Error(`--${name} must be a non-negative integer`);
  return Number(value);
}

function parseTransportPolicy(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("--transport must be valid JSON");
  }
}

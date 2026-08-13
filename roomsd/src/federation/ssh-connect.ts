// SPDX-License-Identifier: Apache-2.0
/**
 * Rooms-owned SSH connect orchestration: `rooms federation peer connect --transport ssh`.
 * Drives remote `rooms setup` and the existing offer/challenge/accept/confirm/finalize
 * mutual enrollment exchange (enrollment.ts) end to end over SSH, so an operator never
 * manually shuttles an artifact file between two machines. This module depends only on
 * the transport-neutral `RemoteCommandPort` (remote-command-port.ts), not on SSH specifics
 * directly, so a later Tailscale/direct adapter can reuse this same state machine.
 *
 * SSH success alone never activates trust: every stage below still goes through the
 * cryptographic verification and replay-resistant ledger in enrollment.ts/peer-trust.ts
 * exactly as a manual, file-shuttled run would. This orchestration only automates moving
 * the bounded public artifacts; it adds no new trust primitive.
 */

import { createEnrollmentAccept, createEnrollmentOffer, finalizeEnrollment } from "./enrollment.js";
import { setupMachineIdentity } from "../identity/machine-identity.js";
import { createSshCommandPort, parseSshTarget, SshTargetError } from "./ssh-command-adapter.js";
import { assertSafeRemoteAbsolutePath, RemoteCommandError, ROOMS_REMOTE_BINARY, type RemoteCommandErrorCode, type RemoteCommandPort } from "./remote-command-port.js";
import { parseRemoteStepResponse, type RemoteStepRequest } from "./enroll-remote-step.js";
import type { AuthorityId, FederationTransportPolicy } from "./contracts.js";

/**
 * Placeholder local forwarded port recorded in the loopbackSsh transport policy. This unit
 * automates enrollment artifact exchange only; it does not open a live SSH port-forward
 * tunnel for message traffic. Wiring a real forwarded port (and correct per-side dialing
 * parameters instead of mirroring the initiator's SSH destination on both sides) is the
 * later Rooms-owned SSH connector management unit described in federation-architecture.md.
 */
export const LOOPBACK_SSH_PLACEHOLDER_LOCAL_PORT = 47_990;

export type SshConnectErrorCode =
  | RemoteCommandErrorCode
  | "invalidSshTarget"
  | "invalidRemoteStateDir"
  | "malformedFraming"
  | "protocolMismatch"
  | "remoteEnrollmentRejected"
  | "conflictingPeer";

export class SshConnectError extends Error {
  readonly code: SshConnectErrorCode;
  constructor(code: SshConnectErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "SshConnectError";
    this.code = code;
  }
}

export type SshConnectPeerSummary = Readonly<{
  authorityId: string;
  fingerprint: string;
  peerAuthorityId: string;
  peerFingerprint: string;
  state: string;
}>;

export type SshConnectResult = Readonly<{
  transport: "loopbackSsh";
  networkListener: false;
  local: SshConnectPeerSummary;
  remote: SshConnectPeerSummary;
}>;

export type SshConnectInput = Readonly<{
  sshHost: string;
  localStateDir?: string;
  remoteStateDir?: string;
  timeoutMs?: number;
  /** Injectable for callers/tests that supply a stand-in RemoteCommandPort; defaults to the real SSH adapter. */
  commandPortFactory?: (sshHost: string) => RemoteCommandPort;
}>;

/**
 * Validates an operator-supplied absolute remote path strictly enough to appear safely as a
 * single SSH remote argv token: no whitespace, quotes, or shell metacharacters. Delegates to
 * the same `assertSafeRemoteAbsolutePath` the port boundary itself re-checks (defense in
 * depth: even if this call were skipped or buggy, `assertAllowedRemoteArgv` independently
 * re-validates the `--state-dir` token before it can ever reach `ssh`).
 */
export function assertSafeRemoteStateDir(value: string): string {
  try {
    return assertSafeRemoteAbsolutePath(value, "--remote-state-dir");
  } catch (error) {
    throw new SshConnectError("invalidRemoteStateDir", error instanceof Error ? error.message : String(error));
  }
}

export async function connectPeerOverSsh(input: SshConnectInput): Promise<SshConnectResult> {
  try {
    return await connectPeerOverSshUnwrapped(input);
  } catch (error) {
    if (error instanceof SshConnectError || error instanceof RemoteCommandError) throw error;
    if (error instanceof SshTargetError) throw new SshConnectError("invalidSshTarget", error.message);
    if (error instanceof Error && /already pinned to different key material/i.test(error.message)) {
      throw new SshConnectError("conflictingPeer", error.message);
    }
    throw error;
  }
}

async function connectPeerOverSshUnwrapped(input: SshConnectInput): Promise<SshConnectResult> {
  const parsedTarget = parseSshTarget(input.sshHost);
  const remoteStateDir = input.remoteStateDir === undefined ? undefined : assertSafeRemoteStateDir(input.remoteStateDir);
  const port = (input.commandPortFactory ?? ((host: string) => createSshCommandPort(host)))(parsedTarget.target);
  const timeoutMs = input.timeoutMs;

  const local = setupMachineIdentity(input.localStateDir);

  const remoteSetupArgv = remoteStateDir ? [ROOMS_REMOTE_BINARY, "setup", "--state-dir", remoteStateDir] : [ROOMS_REMOTE_BINARY, "setup"];
  const remoteSetupOutput = await runRemote(port, remoteSetupArgv, undefined, timeoutMs, "remote setup");
  const remote = parseRemoteSetupOutput(remoteSetupOutput.stdout);

  const localTransportPolicy = loopbackSshPolicy(remote.authorityId, parsedTarget.sshDestination, parsedTarget.sshUser);
  const remoteTransportPolicy = loopbackSshPolicy(local.authorityId as AuthorityId, parsedTarget.sshDestination, parsedTarget.sshUser);

  const offer = createEnrollmentOffer({
    stateDir: input.localStateDir,
    peerAuthorityId: remote.authorityId,
    transportPolicy: localTransportPolicy,
  });

  const challengeResponse = await remoteStep(
    port,
    { stage: "challenge", stateDir: remoteStateDir, transportPolicy: remoteTransportPolicy, artifact: JSON.stringify(offer) },
    timeoutMs,
    "challenge step",
  );
  // challengeResponse.artifact is the exact raw JSON text the responder produced, carried
  // through as an opaque string end to end (see enroll-remote-step.ts): it is fed straight
  // into createEnrollmentAccept's own strict parser, never re-parsed/re-stringified here,
  // so a duplicate or mutated key can never be silently collapsed before that parser sees it.
  const { artifact: accept } = createEnrollmentAccept({ stateDir: input.localStateDir, challengeRaw: challengeResponse.artifact });

  const confirmResponse = await remoteStep(
    port,
    { stage: "confirm", stateDir: remoteStateDir, artifact: JSON.stringify(accept) },
    timeoutMs,
    "confirm step",
  );
  const { peer: localPeer } = finalizeEnrollment({ stateDir: input.localStateDir, confirmRaw: confirmResponse.artifact });

  return {
    transport: "loopbackSsh",
    networkListener: false,
    local: {
      authorityId: local.authorityId,
      fingerprint: local.publicFingerprint,
      peerAuthorityId: remote.authorityId,
      peerFingerprint: remote.publicFingerprint,
      state: localPeer.state,
    },
    remote: {
      authorityId: remote.authorityId,
      fingerprint: remote.publicFingerprint,
      peerAuthorityId: local.authorityId,
      peerFingerprint: local.publicFingerprint,
      state: confirmResponse.peerState,
    },
  };
}

function loopbackSshPolicy(peerAuthorityId: AuthorityId, sshDestination: string, sshUser: string): FederationTransportPolicy {
  return {
    kind: "loopbackSsh",
    peerAuthorityId,
    sshDestination,
    sshUser,
    localEndpoint: "127.0.0.1",
    localPort: LOOPBACK_SSH_PLACEHOLDER_LOCAL_PORT,
  };
}

async function runRemote(
  port: RemoteCommandPort,
  argv: readonly string[],
  stdin: string | undefined,
  timeoutMs: number | undefined,
  contextLabel: string,
): Promise<Readonly<{ stdout: string; stderr: string }>> {
  try {
    return await port.run(argv, { stdin, timeoutMs });
  } catch (error) {
    if (error instanceof RemoteCommandError) throw new SshConnectError(error.code, `${contextLabel}: ${error.message}`);
    throw error;
  }
}

function parseRemoteSetupOutput(stdout: string): Readonly<{ authorityId: AuthorityId; publicFingerprint: string }> {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new SshConnectError("malformedFraming", "remote setup output is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SshConnectError("malformedFraming", "remote setup output must be an object");
  const record = value as Record<string, unknown>;
  if (record.networkListener !== false) throw new SshConnectError("malformedFraming", "remote setup output must report networkListener=false");
  if (typeof record.authorityId !== "string" || !/^authority-[0-9a-f]{64}$/.test(record.authorityId)) {
    throw new SshConnectError("malformedFraming", "remote setup output authorityId is malformed");
  }
  if (typeof record.publicFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(record.publicFingerprint)) {
    throw new SshConnectError("malformedFraming", "remote setup output publicFingerprint is malformed");
  }
  return { authorityId: record.authorityId as AuthorityId, publicFingerprint: record.publicFingerprint };
}

async function remoteStep(
  port: RemoteCommandPort,
  request: RemoteStepRequest,
  timeoutMs: number | undefined,
  contextLabel: string,
): Promise<Readonly<{ artifact: string; peerState: string }>> {
  const output = await runRemote(port, [ROOMS_REMOTE_BINARY, "federation", "enroll", "remote-step"], JSON.stringify(request), timeoutMs, contextLabel);
  let response: ReturnType<typeof parseRemoteStepResponse>;
  try {
    // Bounded, strict, duplicate-key-rejecting, exact-keys parse of the whole frame; the
    // embedded artifact is returned as the exact raw string the responder produced.
    response = parseRemoteStepResponse(output.stdout);
  } catch (error) {
    throw new SshConnectError("malformedFraming", `${contextLabel}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.ok === true) {
    if (response.stage !== request.stage) {
      throw new SshConnectError("malformedFraming", `${contextLabel}: remote-step returned stage ${response.stage}, expected ${request.stage}`);
    }
    return { artifact: response.artifact, peerState: response.peerState };
  }
  const message = response.message || "remote enrollment step failed";
  if (/unsupported version/i.test(message)) throw new SshConnectError("protocolMismatch", `${contextLabel}: ${message}`);
  if (/already pinned to different key material/i.test(message)) throw new SshConnectError("conflictingPeer", `${contextLabel}: ${message}`);
  throw new SshConnectError("remoteEnrollmentRejected", `${contextLabel}: ${message}`);
}

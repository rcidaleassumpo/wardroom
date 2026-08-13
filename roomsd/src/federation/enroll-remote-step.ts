// SPDX-License-Identifier: Apache-2.0
/**
 * Stdin/stdout JSON-framed entry point for the responder side of mutual enrollment
 * (`challenge`, `confirm`), invoked over SSH by `ssh-connect.ts` from the initiator
 * machine. This is not a new protocol stage: it wraps the existing
 * `createEnrollmentChallenge`/`createEnrollmentConfirm` functions in `enrollment.ts`
 * verbatim so the same signed offer/challenge/accept/confirm/finalize exchange documented
 * in `roomsd/docs/federation-architecture.md` runs automatically instead of an operator
 * moving artifact files by hand. It reads exactly one bounded JSON request from stdin and
 * writes exactly one JSON response, never touches a file, and never opens a listener.
 *
 * Both the request and the response frame are bounded and parsed with the same strict,
 * duplicate-key-rejecting parser (`parseEnrollmentArtifactJson` in `codec.ts`) used for
 * every other enrollment artifact, and both reject any unknown top-level field. Critically,
 * the signed enrollment artifact itself (`artifact`) is carried as an opaque raw JSON
 * *string* in both directions, never re-parsed into a JS object and re-serialized by this
 * module or by the caller: a JSON string value is decoded losslessly by an outer parse (its
 * escaped content is never itself interpreted as nested object keys), so the exact raw
 * bytes this process received are the exact raw bytes handed to
 * `createEnrollmentChallenge`/`createEnrollmentConfirm` (on the responder) or
 * `createEnrollmentAccept`/`finalizeEnrollment` (on the initiator, in `ssh-connect.ts`),
 * which independently re-validate it with that same strict parser. A duplicate or mutated
 * key inside a naively-JSON.parse'd-and-re-stringified artifact can never reach either
 * enrollment function, because no such parse-then-restringify round trip ever happens here.
 */

import { createEnrollmentChallenge, createEnrollmentConfirm } from "./enrollment.js";
import { parseEnrollmentArtifactJson } from "./codec.js";

export const REMOTE_STEP_MAX_REQUEST_BYTES = 16_384;
export const REMOTE_STEP_MAX_RESPONSE_BYTES = 16_384;

export type RemoteStepStage = "challenge" | "confirm";

export type RemoteStepRequest = Readonly<{
  stage: RemoteStepStage;
  stateDir?: string;
  transportPolicy?: unknown;
  /** Raw JSON text of the offer (stage "challenge") or accept (stage "confirm") artifact — never a parsed object. */
  artifact: string;
}>;

export type RemoteStepResponse =
  | Readonly<{ ok: true; stage: RemoteStepStage; artifact: string; peerState: string }>
  | Readonly<{ ok: false; stage: RemoteStepStage | "unknown"; errorName: string; message: string }>;

const REQUEST_REQUIRED_FIELDS = ["stage", "artifact"] as const;
const REQUEST_ALLOWED_FIELDS = ["stage", "stateDir", "transportPolicy", "artifact"] as const;
const RESPONSE_OK_FIELDS = ["ok", "stage", "artifact", "peerState"] as const;
const RESPONSE_ERROR_FIELDS = ["ok", "stage", "errorName", "message"] as const;

/** Reads/dispatches one bounded remote-step request and returns the serialized response (no trailing newline; the CLI layer appends exactly one). */
export function runEnrollRemoteStep(rawRequest: string): string {
  let stage: RemoteStepStage | "unknown" = "unknown";
  try {
    const request = parseRequest(rawRequest);
    stage = request.stage;
    if (request.stage === "challenge") {
      const { artifact, peer } = createEnrollmentChallenge({
        stateDir: request.stateDir,
        offerRaw: request.artifact,
        transportPolicy: request.transportPolicy,
      });
      return serializeResponse({ ok: true, stage: "challenge", artifact: JSON.stringify(artifact), peerState: peer.state });
    }
    const { artifact, peer } = createEnrollmentConfirm({ stateDir: request.stateDir, acceptRaw: request.artifact });
    return serializeResponse({ ok: true, stage: "confirm", artifact: JSON.stringify(artifact), peerState: peer.state });
  } catch (error) {
    return serializeResponse({
      ok: false,
      stage,
      errorName: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseRequest(raw: string): RemoteStepRequest {
  const record = parseBoundedFrame(raw, REMOTE_STEP_MAX_REQUEST_BYTES, "remote-step request");
  assertExactKeys(record, REQUEST_ALLOWED_FIELDS, REQUEST_REQUIRED_FIELDS, "remote-step request");
  if (record.stage !== "challenge" && record.stage !== "confirm") throw new Error('remote-step request stage must be "challenge" or "confirm"');
  if (typeof record.artifact !== "string" || record.artifact.trim() === "") throw new Error("remote-step request artifact must be a non-blank string");
  if (record.stateDir !== undefined && typeof record.stateDir !== "string") throw new Error("remote-step request stateDir must be a string");
  if (record.stage === "challenge" && record.transportPolicy === undefined) throw new Error("remote-step challenge request requires transportPolicy");
  return { stage: record.stage, stateDir: record.stateDir as string | undefined, transportPolicy: record.transportPolicy, artifact: record.artifact };
}

/** Bounded, strict-parsed, exact-keys-checked read of a remote-step response frame; exported so `ssh-connect.ts` never does its own ad hoc `JSON.parse` of this wire format. */
export function parseRemoteStepResponse(raw: string): RemoteStepResponse {
  const record = parseBoundedFrame(raw, REMOTE_STEP_MAX_RESPONSE_BYTES, "remote-step response");
  if (record.ok !== true && record.ok !== false) throw new Error("remote-step response ok must be a boolean");
  if (record.ok === true) {
    assertExactKeys(record, RESPONSE_OK_FIELDS, RESPONSE_OK_FIELDS, "remote-step response");
    if (record.stage !== "challenge" && record.stage !== "confirm") throw new Error('remote-step response stage must be "challenge" or "confirm"');
    if (typeof record.artifact !== "string" || record.artifact.trim() === "") throw new Error("remote-step response artifact must be a non-blank string");
    if (typeof record.peerState !== "string" || record.peerState.trim() === "") throw new Error("remote-step response peerState must be a non-blank string");
    return { ok: true, stage: record.stage, artifact: record.artifact, peerState: record.peerState };
  }
  assertExactKeys(record, RESPONSE_ERROR_FIELDS, RESPONSE_ERROR_FIELDS, "remote-step response");
  if (record.stage !== "challenge" && record.stage !== "confirm" && record.stage !== "unknown") throw new Error("remote-step response stage is malformed");
  if (typeof record.errorName !== "string") throw new Error("remote-step response errorName must be a string");
  if (typeof record.message !== "string") throw new Error("remote-step response message must be a string");
  return { ok: false, stage: record.stage, errorName: record.errorName, message: record.message };
}

/** Bounds the frame before it is ever parsed, then strictly parses it with the same duplicate-key-rejecting parser used for every other enrollment artifact — at any nesting depth, including inside an embedded `transportPolicy`. */
function parseBoundedFrame(raw: string, maxBytes: number, label: string): Record<string, unknown> {
  if (Buffer.byteLength(raw, "utf8") > maxBytes) throw new Error(`${label} exceeds the maximum size of ${maxBytes} bytes`);
  let value: unknown;
  try {
    value = parseEnrollmentArtifactJson(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[], required: readonly string[], label: string): void {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new Error(`${label} has unknown field ${key}`);
  for (const key of required) if (!(key in record)) throw new Error(`${label} is missing ${key}`);
}

function serializeResponse(response: RemoteStepResponse): string {
  return JSON.stringify(response);
}

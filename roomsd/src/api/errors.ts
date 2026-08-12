import type { RoomsError, RoomsErrorCode } from "../generated/rooms/v1/rooms.js";

const exactCodes = new Map<string, RoomsErrorCode>([
  ["invalidCredential", "unauthenticated"],
  ["credentialRevoked", "unauthenticated"],
  ["unauthorized", "permission_denied"],
  ["unauthorizedActor", "permission_denied"],
  ["ownerAuthorizationRequired", "permission_denied"],
  ["plannerAuthorizationRequired", "permission_denied"],
  ["broadcastRestricted", "permission_denied"],
  ["unknownMethod", "unimplemented"],
  ["unsupported", "unimplemented"],
  ["handlerError", "internal"],
]);

/** Maps implementation error codes to the stable Rooms protocol categories. */
export function roomsErrorCode(domainCode: string | undefined): RoomsErrorCode {
  if (!domainCode) return "internal";
  const exact = exactCodes.get(domainCode);
  if (exact) return exact;
  if (/NotFound$|^unknown/.test(domainCode)) return "not_found";
  if (/AlreadyExists$|^already|Conflict$|Replay$/.test(domainCode)) return "already_exists";
  if (/QuotaExceeded$|BatchTooLarge$|^backpressure$/.test(domainCode)) return "resource_exhausted";
  if (/Unavailable$|^sourceLost$/.test(domainCode)) return "unavailable";
  if (/^invalid|^empty|^missing/.test(domainCode)) return "invalid_argument";
  return "failed_precondition";
}

export function toRoomsError(error: unknown): RoomsError {
  const value = error as { code?: unknown; message?: unknown };
  const domainCode = typeof value?.code === "string" ? value.code : undefined;
  return {
    code: roomsErrorCode(domainCode),
    message: typeof value?.message === "string" ? value.message : "handler error",
    ...(domainCode ? { domainCode } : {}),
  };
}

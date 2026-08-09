const FEDERATED_SESSION = /^federation:authority-[^:]+:(.+)$/;

/** The stable agent-facing identity; transport routing prefixes stay internal. */
export function visibleRoomsSessionId(canonicalSessionId: string): string {
  return FEDERATED_SESSION.exec(canonicalSessionId)?.[1] ?? canonicalSessionId;
}

/** Stamp sender provenance once, regardless of the local or federated send path. */
export function stampRoomsProvenance(canonicalSessionId: string, body: string): string {
  const prefix = `@${visibleRoomsSessionId(canonicalSessionId)}`;
  return body === prefix || body.startsWith(`${prefix} `) ? body : `${prefix} ${body}`;
}

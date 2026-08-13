// SPDX-License-Identifier: Apache-2.0
import { createHash, timingSafeEqual } from "node:crypto";
import type { AuthenticatedCommandContext, DomainRepository } from "../domain/application.js";
import type { CredentialRecord, CredentialRepository } from "../credentials/credential-repository.js";

export class AuthenticationError extends Error {
  constructor(public readonly code: "invalidCredential" | "credentialRevoked") {
    super(code);
    this.name = "AuthenticationError";
  }
}

/** Converts a server-issued credential into the context consumed by domain commands. */
export class CredentialAuthenticator {
  constructor(
    private readonly credentials: CredentialRepository,
    private readonly domain: Pick<DomainRepository, "currentSession">,
  ) {}

  authenticate(token: string): AuthenticatedCommandContext {
    if (typeof token !== "string" || token.trim() === "") {
      throw new AuthenticationError("invalidCredential");
    }

    const record = this.credentials.resolve(token);
    if (!record || !this.isWellFormed(record)) throw new AuthenticationError("invalidCredential");
    if (record.revokedAt !== null) throw new AuthenticationError("credentialRevoked");
    if (!sameHash(token, record.secretHash)) throw new AuthenticationError("invalidCredential");

    const actor = this.domain.currentSession(record.actorSessionId);
    if (!actor || actor.endedAt !== null || actor.role === null) throw new AuthenticationError("invalidCredential");

    return {
      credentialId: record.id,
      actorSessionId: record.actorSessionId,
      role: actor.role,
    };
  }

  private isWellFormed(record: CredentialRecord): boolean {
    return record.id === record.id.trim()
      && record.id.length > 0
      && record.actorSessionId === record.actorSessionId.trim()
      && record.actorSessionId.length > 0
      && record.issuedAt.trim().length > 0
      && /^[0-9a-f]{64}$/i.test(record.secretHash);
  }
}

export const createCredentialSecretHash = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

function sameHash(token: string, expected: string): boolean {
  const actual = Buffer.from(createCredentialSecretHash(token), "hex");
  const supplied = Buffer.from(expected, "hex");
  return actual.length === supplied.length && timingSafeEqual(actual, supplied);
}

export type { CredentialRecord, CredentialRepository } from "../credentials/credential-repository.js";
export { InMemoryCredentialRepository } from "../credentials/credential-repository.js";

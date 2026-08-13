// SPDX-License-Identifier: Apache-2.0
import type { SessionRole } from "../domain/contracts.js";

/** The only credential data the command boundary may use. */
export interface CredentialRecord {
  readonly id: string;
  readonly actorSessionId: string;
  readonly issuedAt: string;
  readonly revokedAt: string | null;
  /** A one-way digest of the opaque token; never persist the token itself. */
  readonly secretHash: string;
}

/** Resolves opaque, server-issued credentials; it does not accept caller claims. */
export interface CredentialRepository {
  resolve(token: string): CredentialRecord | null;
}

export class InMemoryCredentialRepository implements CredentialRepository {
  private readonly records: ReadonlyMap<string, CredentialRecord>;

  constructor(records: readonly CredentialRecord[] = []) {
    this.records = new Map(records.map((record) => [record.id, record]));
  }

  resolve(token: string): CredentialRecord | null {
    return this.records.get(token) ?? null;
  }
}

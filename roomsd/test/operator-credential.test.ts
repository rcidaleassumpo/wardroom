import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mintOperatorCredential, operatorCredentialPath, readOperatorCredentialSecret, OperatorCredentialStore } from "../src/credentials/operator-credential.js";
import { setupMachineIdentity } from "../src/identity/machine-identity.js";
import { createNativeComposition } from "../src/runtime/native/composition.js";
import { RoomsRepository } from "../src/storage/repository.js";

function operatorState(): { stateDir: string; cleanup(): void } {
  const stateDir = mkdtempSync(join(tmpdir(), "rooms-operator-credential-"));
  setupMachineIdentity(stateDir);
  const database = new RoomsRepository(join(stateDir, "rooms.sqlite"));
  database.insertSession({ id: "operator", role: "operator" });
  database.insertSession({ id: "other-operator", role: "operator" });
  database.insertSession({ id: "worker", role: "worker" });
  database.close();
  return { stateDir, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}

const connection = () => ({ credentials: new Map(), onClose: new Set() });
const proofOf = (secret: string) => secret; // the CLI sends the raw base64url secret as the proof field

describe("durable operator credential", () => {
  it("is owner-only, restart-surviving, and issues a full operator credential", async () => {
    const fixture = operatorState();
    try {
      mintOperatorCredential(fixture.stateDir, "operator");
      const secret = readOperatorCredentialSecret(fixture.stateDir, "operator");
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect((statSync(operatorCredentialPath(fixture.stateDir, "operator")).mode & 0o777)).toBe(0o600);

      // A fresh composition models a daemon restart: no runtime, no bootstrap,
      // yet the durable credential still authenticates the operator.
      const composition = createNativeComposition(join(fixture.stateDir, "rooms.sqlite"), undefined, fixture.stateDir);
      const issued = await composition.handler.issueCredential({ sessionId: "operator", proof: proofOf(secret!), __connection: connection() } as never);
      expect(issued.credential).toMatch(/^rooms_/);

      // The issued credential is a full operator credential (not a one-shot
      // bootstrap): it authenticates the operator session on its connection and
      // is not marked as a bootstrap credential.
      const conn = connection();
      const authed = await composition.handler.issueCredential({ sessionId: "operator", proof: proofOf(secret!), __connection: conn } as never);
      await expect(composition.handler.authenticate({ credential: authed.credential, __connection: conn } as never)).resolves.toEqual({ authenticatedSessionId: "operator" });
      expect((conn as unknown as { bootstrapCredentials?: Map<string, string> }).bootstrapCredentials?.has(authed.credential)).toBeFalsy();
      composition.database.close();
    } finally { fixture.cleanup(); }
  });

  it("keeps internal work item: missing, forged, and cross-session proof stay denied", async () => {
    const fixture = operatorState();
    try {
      mintOperatorCredential(fixture.stateDir, "operator");
      const secret = readOperatorCredentialSecret(fixture.stateDir, "operator")!;
      const composition = createNativeComposition(join(fixture.stateDir, "rooms.sqlite"), undefined, fixture.stateDir);

      // Missing proof.
      await expect(composition.handler.issueCredential({ sessionId: "operator", proof: "", __connection: connection() } as never)).rejects.toThrow("session possession proof is required");
      // Forged proof (32 random bytes that are not the secret).
      await expect(composition.handler.issueCredential({ sessionId: "operator", proof: Buffer.alloc(32, 3).toString("base64url"), __connection: connection() } as never)).rejects.toThrow("session possession proof is required");
      // Cross-session: a worker named with the operator secret (worker is not an operator).
      await expect(composition.handler.issueCredential({ sessionId: "worker", proof: secret, __connection: connection() } as never)).rejects.toThrow("session possession proof is required");
      // Cross-session: another operator named with the first operator's secret (no file for it).
      await expect(composition.handler.issueCredential({ sessionId: "other-operator", proof: secret, __connection: connection() } as never)).rejects.toThrow("session possession proof is required");
      composition.database.close();
    } finally { fixture.cleanup(); }
  });

  it("uses durable proof to recover an ended operator without restoring external ownership", async () => {
    const fixture = operatorState();
    try {
      mintOperatorCredential(fixture.stateDir, "operator");
      const database = new RoomsRepository(join(fixture.stateDir, "rooms.sqlite"));
      database.insertChannel({ id: "proof", ownerOperatorSessionId: "operator" });
      database.registerSession("proof", "operator", "operator", null, "log", { externalOwner: "operator", externalAgentId: "mycelia-operator" });
      database.markSessionEnded("operator");
      database.close();

      const composition = createNativeComposition(join(fixture.stateDir, "rooms.sqlite"), undefined, fixture.stateDir);
      const conn = connection();
      const issued = await composition.handler.issueCredential({ sessionId: "operator", proof: proofOf(readOperatorCredentialSecret(fixture.stateDir, "operator")!), __connection: conn } as never);
      await composition.handler.authenticate({ credential: issued.credential, __connection: conn } as never);
      await expect(composition.handler.registerSession({ sessionId: "operator", role: "operator", deliveryMode: "log", context: { credential: issued.credential }, __connection: conn } as never))
        .resolves.toMatchObject({ session: { id: "operator", endedAt: null, externalOwner: null, externalAgentId: null } });
      expect(composition.database.isActiveMember("proof", "operator", "operator")).toBe(true);
      composition.database.close();
    } finally { fixture.cleanup(); }
  });

  it("verifier rejects everything but the exact stored secret", () => {
    const fixture = operatorState();
    try {
      mintOperatorCredential(fixture.stateDir, "operator");
      const store = new OperatorCredentialStore(fixture.stateDir);
      const secret = readOperatorCredentialSecret(fixture.stateDir, "operator")!;
      expect(store.verify("operator", secret)).toBe(true);
      expect(store.verify("operator", "")).toBe(false);
      expect(store.verify("operator", Buffer.alloc(32, 1))).toBe(false);
      expect(store.verify("operator", Buffer.alloc(16, 1))).toBe(false);
      expect(store.verify("missing-operator", secret)).toBe(false);
      // Rotation replaces the secret; the old one no longer verifies.
      mintOperatorCredential(fixture.stateDir, "operator", { rotate: true });
      expect(store.verify("operator", secret)).toBe(false);
      expect(store.verify("operator", readOperatorCredentialSecret(fixture.stateDir, "operator")!)).toBe(true);
    } finally { fixture.cleanup(); }
  });
});

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readSessionBootstrap, SessionProofBootstrap, sessionBootstrapPath } from "../src/credentials/session-proof-bootstrap.js";
import { setupMachineIdentity } from "../src/identity/machine-identity.js";
import { createNativeComposition } from "../src/runtime/native/composition.js";
import { RoomsRepository } from "../src/storage/repository.js";
import { RuntimeRepository } from "../src/storage/runtime-repository.js";

function legacyState(): { stateDir: string; cleanup(): void } {
  const stateDir = mkdtempSync(join(tmpdir(), "rooms-proof-bootstrap-"));
  setupMachineIdentity(stateDir);
  const database = new RoomsRepository(join(stateDir, "rooms.sqlite"));
  database.insertSession({ id: "operator", role: "operator" });
  database.insertSession({ id: "other-operator", role: "operator" });
  database.insertSession({ id: "worker", role: "worker" });
  const runtimes = new RuntimeRepository(database.db);
  for (const [runtimeId, sessionId] of [["legacy-operator", "operator"], ["legacy-other-operator", "other-operator"], ["legacy-worker", "worker"]] as const) {
    runtimes.create({ runtimeId, homeAuthorityId: "authority-local", sessionId, generation: 1, protocolVersion: 1, transportKind: "localPty", machineId: "local", reconnectSecret: Buffer.alloc(32, 7) });
    runtimes.markState(runtimeId, 1, "running");
    runtimes.markState(runtimeId, 1, "terminated", "upgrade-drain");
  }
  database.db.exec("PRAGMA user_version=23");
  database.close();
  return { stateDir, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}

describe("post-upgrade session proof bootstrap", () => {
  it("is owner-only, session-bound, single-use, and hands off to normal proof", async () => {
    const fixture = legacyState();
    try {
      const composition = createNativeComposition(join(fixture.stateDir, "rooms.sqlite"), undefined, fixture.stateDir);
      const bootstrap = readSessionBootstrap(fixture.stateDir, "operator");
      const otherBootstrap = readSessionBootstrap(fixture.stateDir, "other-operator");
      expect(bootstrap).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(otherBootstrap).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(readSessionBootstrap(fixture.stateDir, "worker")).toBeNull();
      expect(composition.database.db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 27 });

      const request = (sessionId: string, secret: string) => ({ sessionId, bootstrap: secret, __connection: { credentials: new Map(), onClose: new Set() } });
      await expect(composition.handler.issueBootstrapCredential!(request("operator", "") as never)).rejects.toThrow("invalid or expired");
      await expect(composition.handler.issueBootstrapCredential!(request("other-operator", bootstrap!) as never)).rejects.toThrow("invalid or expired");
      await expect(composition.handler.issueBootstrapCredential!(request("worker", "worker-secret") as never)).rejects.toThrow("owner operator bootstrap is required");

      const connection = { credentials: new Map(), onClose: new Set() };
      const issued = await composition.handler.issueBootstrapCredential!({ sessionId: "operator", bootstrap: bootstrap!, __connection: connection } as never);
      expect(issued.credential).toMatch(/^rooms_/);
      await expect(composition.handler.authenticate({ credential: issued.credential, __connection: connection } as never)).resolves.toEqual({ authenticatedSessionId: "operator" });
      await expect(composition.handler.runtimeCreate({ sessionId: "other-operator", generation: 2, context: { credential: issued.credential }, __connection: connection } as never)).rejects.toThrow("permits only its session relaunch");
      await expect(composition.handler.runtimeList({ context: { credential: issued.credential }, __connection: connection } as never)).rejects.toThrow("invalid or missing credential");
      await expect(composition.handler.issueBootstrapCredential!(request("operator", bootstrap!) as never)).rejects.toThrow("invalid or expired");
      const retryBootstrap = readSessionBootstrap(fixture.stateDir, "operator");
      expect(retryBootstrap).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(retryBootstrap).not.toBe(bootstrap);
      expect(readSessionBootstrap(fixture.stateDir, "other-operator")).toBe(otherBootstrap);

      const failedConnection = { credentials: new Map(), onClose: new Set() };
      const failed = await composition.handler.issueBootstrapCredential!({ sessionId: "operator", bootstrap: retryBootstrap!, __connection: failedConnection } as never);
      await composition.handler.authenticate({ credential: failed.credential, __connection: failedConnection } as never);
      await expect(composition.handler.runtimeCreate({ sessionId: "operator", generation: 0, context: { credential: failed.credential }, __connection: failedConnection } as never)).rejects.toThrow();
      await expect(composition.handler.runtimeList({ context: { credential: failed.credential }, __connection: failedConnection } as never)).rejects.toThrow("invalid or missing credential");
      const recoveryBootstrap = readSessionBootstrap(fixture.stateDir, "operator");
      expect(recoveryBootstrap).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(recoveryBootstrap).not.toBe(retryBootstrap);

      const runtimes = new RuntimeRepository(composition.database.db);
      const proof = Buffer.alloc(32, 9);
      vi.spyOn(composition.runtimeService, "create").mockImplementation(async (request: any) => {
        const runtime = runtimes.create({ runtimeId: "current-operator", homeAuthorityId: "authority-local", sessionId: request.sessionId, generation: 2, protocolVersion: 1, transportKind: "localPty", machineId: "local", reconnectSecret: Buffer.alloc(32, 8), sessionProof: proof });
        return { runtime: runtimes.markState(runtime.runtimeId, 2, "running") } as never;
      });
      const retryConnection = { credentials: new Map(), onClose: new Set() };
      const retry = await composition.handler.issueBootstrapCredential!({ sessionId: "operator", bootstrap: recoveryBootstrap!, __connection: retryConnection } as never);
      await composition.handler.authenticate({ credential: retry.credential, __connection: retryConnection } as never);
      await expect(composition.handler.runtimeCreate({ sessionId: "operator", generation: 2, context: { credential: retry.credential }, __connection: retryConnection } as never)).resolves.toMatchObject({ runtime: { generation: 2, sessionId: "operator", sessionProofHash: expect.any(String) } });
      await expect(composition.handler.runtimeList({ context: { credential: retry.credential }, __connection: retryConnection } as never)).rejects.toThrow("invalid or missing credential");
      await expect(composition.handler.runtimeCreate({ sessionId: "operator", generation: 3, context: { credential: retry.credential }, __connection: retryConnection } as never)).rejects.toThrow("invalid or missing credential");
      expect(retryConnection).toMatchObject({ authenticatedSessionId: undefined });
      expect(retryConnection.credentials.size).toBe(0);
      expect(readSessionBootstrap(fixture.stateDir, "operator")).toBeNull();
      new SessionProofBootstrap(fixture.stateDir, ["operator"]);
      expect(readSessionBootstrap(fixture.stateDir, "operator")).toBeNull();
      expect(readFileSync(`${sessionBootstrapPath(fixture.stateDir, "operator")}.used`, "utf8")).not.toContain(recoveryBootstrap!);
      const normal = await composition.handler.issueCredential({ sessionId: "operator", proof: proof.toString("base64url"), __connection: { credentials: new Map(), onClose: new Set() } } as never);
      expect(normal.credential).toMatch(/^rooms_/);
      expect(composition.database.db.prepare("SELECT COUNT(*) AS count FROM runtime_events WHERE payload_json LIKE ? OR payload_json LIKE ? OR payload_json LIKE ?").get(`%${bootstrap}%`, `%${retryBootstrap}%`, `%${recoveryBootstrap}%`)).toMatchObject({ count: 0 });
      expect(process.argv).not.toContain(bootstrap!);
      expect(Object.values(process.env)).not.toContain(bootstrap!);
      composition.database.close();
    } finally { fixture.cleanup(); }
  });

  it("rejects an expired bootstrap without consuming another session credential", async () => {
    const fixture = legacyState();
    try {
      const composition = createNativeComposition(join(fixture.stateDir, "rooms.sqlite"), undefined, fixture.stateDir);
      const path = sessionBootstrapPath(fixture.stateDir, "operator");
      const record = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, JSON.stringify({ ...record, expiresAt: 0 }) + "\n", { mode: 0o600 });
      chmodSync(path, 0o600);
      await expect(composition.handler.issueBootstrapCredential!({ sessionId: "operator", bootstrap: record.secret, __connection: { credentials: new Map(), onClose: new Set() } } as never)).rejects.toThrow("invalid or expired");
      composition.database.close();
    } finally { fixture.cleanup(); }
  });
});

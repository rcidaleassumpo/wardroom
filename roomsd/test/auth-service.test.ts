import { describe, expect, it, vi } from "vitest";
import { AuthenticationError, createCredentialSecretHash, CredentialAuthenticator, InMemoryCredentialRepository } from "../src/auth/authenticator.js";
import { RoomsCommandService } from "../src/api/service/rooms-command-service.js";

const issued = (overrides: Partial<{ id: string; actorSessionId: string; issuedAt: string; revokedAt: string | null; secretHash: string }> = {}) => ({
  id: "opaque-credential",
  actorSessionId: "operator-1",
  issuedAt: "2026-07-30T10:00:00.000Z",
  revokedAt: null,
  secretHash: createCredentialSecretHash("opaque-credential"),
  ...overrides,
});

describe("server-issued credential authentication", () => {
  it("resolves only the server-owned actor context", () => {
    const authenticator = new CredentialAuthenticator(new InMemoryCredentialRepository([issued()]), { currentSession: () => ({ id: "operator-1", registeredAt: "now", endedAt: null, displayName: null, role: "operator" }) });

    expect(authenticator.authenticate("opaque-credential")).toEqual({
      credentialId: "opaque-credential",
      actorSessionId: "operator-1",
      role: "operator",
    });
  });

  it.each(["", " ", "unknown"]) ("fails closed for credential %j", (credentialId) => {
    const authenticator = new CredentialAuthenticator(new InMemoryCredentialRepository([issued()]), { currentSession: () => ({ id: "operator-1", registeredAt: "now", endedAt: null, displayName: null, role: "operator" }) });

    expect(() => authenticator.authenticate(credentialId)).toThrowError(new AuthenticationError("invalidCredential"));
  });

  it("fails closed for revoked credentials", () => {
    const authenticator = new CredentialAuthenticator(new InMemoryCredentialRepository([
      issued({ revokedAt: "2026-07-30T11:00:00.000Z" }),
    ]), { currentSession: () => ({ id: "operator-1", registeredAt: "now", endedAt: null, displayName: null, role: "operator" }) });

    expect(() => authenticator.authenticate("opaque-credential")).toThrowError(new AuthenticationError("credentialRevoked"));
  });
});

describe("Rooms command service", () => {
  it("passes the resolved context to RoomsApplication and does not accept caller authority", () => {
    const application = {
      registerSession: vi.fn(() => "receipt"),
      registerChannel: vi.fn(() => "receipt"),
      join: vi.fn(() => "receipt"),
      endSession: vi.fn(() => "receipt"),
    };
    const service = new RoomsCommandService(
      application as unknown as ConstructorParameters<typeof RoomsCommandService>[0],
      new CredentialAuthenticator(new InMemoryCredentialRepository([issued()]), { currentSession: () => ({ id: "operator-1", registeredAt: "now", endedAt: null, displayName: null, role: "operator" }) }),
    );

    expect(service.registerChannel({ id: "build" }, "opaque-credential")).toBe("receipt");
    expect(application.registerChannel).toHaveBeenCalledWith(
      { id: "build" },
      { credentialId: "opaque-credential", actorSessionId: "operator-1", role: "operator" },
    );
    expect(Object.keys(service)).not.toContain("role");
    expect(Object.keys(service)).not.toContain("actorSessionId");
  });

  it("authenticates every command, including commands targeting another session", () => {
    const application = {
      registerSession: vi.fn(() => "receipt"),
      registerChannel: vi.fn(() => "receipt"),
      join: vi.fn(() => "receipt"),
      endSession: vi.fn(() => "receipt"),
    };
    const service = new RoomsCommandService(
      application as unknown as ConstructorParameters<typeof RoomsCommandService>[0],
      new CredentialAuthenticator(new InMemoryCredentialRepository([issued()]), { currentSession: () => ({ id: "operator-1", registeredAt: "now", endedAt: null, displayName: null, role: "operator" }) }),
    );

    expect(() => service.endSession("worker-1", "unknown")).toThrowError(AuthenticationError);
    expect(application.endSession).not.toHaveBeenCalled();
  });
});

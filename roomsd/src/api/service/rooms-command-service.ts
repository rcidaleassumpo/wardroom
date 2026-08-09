import type { RoomsApplication } from "../../domain/application.js";
import type { SessionRole } from "../../domain/contracts.js";
import { CredentialAuthenticator } from "../../auth/authenticator.js";

type Application = Pick<RoomsApplication, "registerSession" | "registerChannel" | "join" | "endSession" | "updateSessionRole">;

/** Public command seam: callers provide only command data and an opaque credential. */
export class RoomsCommandService {
  constructor(
    private readonly application: Application,
    private readonly authenticator: CredentialAuthenticator,
  ) {}

  registerSession(input: { id: string; displayName?: string | null }, credentialId: string) {
    return this.application.registerSession(input, this.authenticator.authenticate(credentialId));
  }

  registerChannel(input: { id: string }, credentialId: string) {
    return this.application.registerChannel(input, this.authenticator.authenticate(credentialId));
  }

  join(channelId: string, sessionId: string, credentialId: string) {
    return this.application.join(channelId, sessionId, this.authenticator.authenticate(credentialId));
  }

  endSession(sessionId: string, credentialId: string) {
    return this.application.endSession(sessionId, this.authenticator.authenticate(credentialId));
  }

  updateSessionRole(channelId: string, sessionId: string, role: Exclude<SessionRole, "operator">, credentialId: string) {
    return this.application.updateSessionRole(channelId, sessionId, role, this.authenticator.authenticate(credentialId));
  }
}

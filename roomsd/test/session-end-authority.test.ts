import { describe, expect, it } from "vitest";
import { RoomsRepository } from "../src/storage/repository.js";
import { RoomsApplication } from "../src/domain/application.js";
import type { AuthenticatedCommandContext } from "../src/domain/application.js";

function operator(sessionId: string): AuthenticatedCommandContext {
  return { credentialId: `credential-${sessionId}`, actorSessionId: sessionId, role: "operator" };
}

/**
 * Two operators, one channel each, plus a worker that joined a channel without
 * being launched by either client. This is the shape that let one client end
 * another operator's live agent.
 */
function seeded(): RoomsRepository {
  const database = new RoomsRepository(":memory:");
  database.insertSession({ id: "operator-one", role: "operator" });
  database.insertSession({ id: "operator-two", role: "operator" });
  database.insertChannel({ id: "channel-one", ownerOperatorSessionId: "operator-one" });
  database.insertChannel({ id: "channel-two", ownerOperatorSessionId: "operator-two" });
  database.insertMembership("channel-one", "operator-one", "operator");
  database.insertMembership("channel-two", "operator-two", "operator");
  database.insertSession({ id: "worker-elsewhere", role: "worker" });
  database.insertMembership("channel-two", "worker-elsewhere", "worker");
  return database;
}

describe("session end authority", () => {
  it("refuses an operator that shares no channel with the session", () => {
    const database = seeded();
    const application = new RoomsApplication(database);

    expect(() => application.endSession("worker-elsewhere", operator("operator-one")))
      .toThrowError(/shares no channel/);
    expect(database.currentSession("worker-elsewhere")?.endedAt).toBeNull();
  });

  it("lets an operator end a member of a channel it owns", () => {
    const database = seeded();
    const application = new RoomsApplication(database);

    application.endSession("worker-elsewhere", operator("operator-two"));

    expect(database.currentSession("worker-elsewhere")?.endedAt).not.toBeNull();
  });

  it("lets an operator end a session Rooms records as its own", () => {
    const database = seeded();
    database.insertSession({ id: "worker-launched", role: "worker", externalOwner: "operator-one", externalAgentId: "agent-7" });
    database.insertMembership("channel-two", "worker-launched", "worker");
    const application = new RoomsApplication(database);

    application.endSession("worker-launched", operator("operator-one"));

    expect(database.currentSession("worker-launched")?.endedAt).not.toBeNull();
  });

  it("keeps orphan cleanup and self-end available", () => {
    const database = seeded();
    database.insertSession({ id: "worker-orphan", role: "worker" });
    const application = new RoomsApplication(database);

    application.endSession("worker-orphan", operator("operator-one"));
    application.endSession("operator-one", operator("operator-one"));

    expect(database.currentSession("worker-orphan")?.endedAt).not.toBeNull();
    expect(database.currentSession("operator-one")?.endedAt).not.toBeNull();
  });
});

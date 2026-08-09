import { describe, expect, it } from "vitest";
import { stampRoomsProvenance, visibleRoomsSessionId } from "../src/domain/message-provenance.js";

describe("Rooms message provenance", () => {
  it("stamps a local sender exactly once", () => {
    expect(stampRoomsProvenance("session-local", "hello")).toBe("@session-local hello");
    expect(stampRoomsProvenance("session-local", "@session-local hello")).toBe("@session-local hello");
  });

  it("keeps federation routing internal to the visible prefix", () => {
    const sender = "federation:authority-abc123:session-remote";
    expect(visibleRoomsSessionId(sender)).toBe("session-remote");
    expect(stampRoomsProvenance(sender, "hello")).toBe("@session-remote hello");
    expect(stampRoomsProvenance(sender, "@session-remote hello")).toBe("@session-remote hello");
  });

  it("does not reinterpret an ordinary session containing a colon", () => {
    expect(visibleRoomsSessionId("session:local")).toBe("session:local");
  });
});

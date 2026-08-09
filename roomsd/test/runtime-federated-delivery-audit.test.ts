import { describe, expect, it } from "vitest";
import { runtimeDeliveryAuditReference } from "../src/runtime/service.js";

describe("runtime delivery audit references", () => {
  it("uses the local canonical message column for a local delivery", () => {
    expect(runtimeDeliveryAuditReference("event-local", 12)).toEqual({
      messageId: "event-local",
      payload: { bytesWritten: 12 },
    });
  });

  it("keeps a federated canonical reference in metadata without claiming a local message", () => {
    expect(runtimeDeliveryAuditReference("event-remote", 24, "authority-remote")).toEqual({
      payload: {
        bytesWritten: 24,
        canonicalMessageId: "event-remote",
        canonicalHomeAuthorityId: "authority-remote",
      },
    });
  });
});

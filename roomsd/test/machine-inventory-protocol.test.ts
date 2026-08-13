import { describe, expect, it } from "vitest";
import { encodeRelayFrame, parseRelayFrame, type RelayInventoryFrame } from "../src/federation/relay-protocol.js";
import type { AuthorityId } from "../src/federation/contracts.js";

const authorityId = `authority-${"a".repeat(64)}` as AuthorityId;
const base = {
  connectionId: "00000000-0000-4000-8000-000000000001",
  direction: "initiatorToResponder" as const,
  seq: 1,
};

describe("machine inventory relay protocol", () => {
  it("round-trips a bounded paginated inventory request", () => {
    const frame: RelayInventoryFrame = { ...base, kind: "inventoryCommand", requestId: "request-1", authorityId, resource: "sessions", cursor: 20, limit: 20, includeEnded: false };
    expect(parseRelayFrame(encodeRelayFrame(frame).trim())).toEqual(frame);
  });

  it("rejects unbounded inventory pages", () => {
    const frame = { ...base, kind: "inventoryCommand", requestId: "request-1", authorityId, resource: "sessions", cursor: 0, limit: 21, includeEnded: false };
    expect(() => parseRelayFrame(JSON.stringify(frame))).toThrow(/limit must be between 1 and 20/);
  });
});

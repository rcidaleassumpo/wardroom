import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { inspectRelayProtocol } from "../src/provisioning/doctor.js";

describe("doctor federation release scope", () => {
  const absentEndpoint = join(tmpdir(), "rooms-doctor-absent-federation-relay.sock");

  it("marks the relay check not applicable when the release omits federation", () => {
    expect(inspectRelayProtocol({ features: { federation: false } }, absentEndpoint)).toEqual({
      name: "relay.protocol",
      status: "not_applicable",
      detail: "federation is omitted from this release",
    });
  });

  it("keeps a missing relay as a failure for federation and older releases", () => {
    expect(inspectRelayProtocol({ features: { federation: true } }, absentEndpoint).status).toBe("fail");
    expect(inspectRelayProtocol({}, absentEndpoint).status).toBe("fail");
  });
});

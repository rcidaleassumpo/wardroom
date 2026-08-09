import { describe, expect, it } from "vitest";
import { HOST_CAPABILITY_RENEWAL_SECONDS, HOST_CAPABILITY_TTL_SECONDS } from "../src/runtime/host/client.js";

describe("runtime host capability renewal", () => {
  it("renews proactively before the short-lived capability expires", () => {
    expect(HOST_CAPABILITY_TTL_SECONDS).toBe(300);
    expect(HOST_CAPABILITY_RENEWAL_SECONDS).toBeGreaterThan(0);
    expect(HOST_CAPABILITY_RENEWAL_SECONDS).toBeLessThan(HOST_CAPABILITY_TTL_SECONDS);
  });
});

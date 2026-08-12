import { describe, expect, it } from "vitest";
import { runtimeHostBinaryName } from "../../src/runtime/host/supervisor.js";

describe("runtime host platform artifact", () => {
  it("maps Node platform names to supported Go build names", () => {
    expect(runtimeHostBinaryName("darwin", "arm64")).toBe("rooms-runtime-host-darwin-arm64");
    expect(runtimeHostBinaryName("linux", "x64")).toBe("rooms-runtime-host-linux-amd64");
    expect(runtimeHostBinaryName("linux", "arm64")).toBe("rooms-runtime-host-linux-arm64");
  });
});

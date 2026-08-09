import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Every worker gets its own temporary Rooms state dir; the live ~/.rooms
    // store must never be read or written by the suite.
    setupFiles: ["test/isolate-state-dir.ts"],
  },
});

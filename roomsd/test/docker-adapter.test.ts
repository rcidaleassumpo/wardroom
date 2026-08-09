import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const compose = readFileSync(join(root, "compose.yml"), "utf8");
const healthcheck = readFileSync(join(root, "docker/healthcheck.mjs"), "utf8");

describe("portable Docker adapter", () => {
  it("builds and runs the service as an unprivileged user", () => {
    expect(dockerfile).toContain("npm ci");
    expect(dockerfile).toContain("npm run build");
    expect(dockerfile).toMatch(/USER\s+roomsd/);
    expect(dockerfile).toContain('CMD ["node", "dist/src/runtime/native/main.js"]');
  });

  it("keeps the service and SQLite database on the same persistent container", () => {
    expect(compose).toContain("roomsd:");
    expect(compose).toContain("roomsd-data:/data");
    expect(compose).toContain("ROOMS_DB_PATH: /data/rooms.sqlite");
    expect(compose).toContain('127.0.0.1:43170:43170');
    expect(compose).toContain("ROOMS_TRANSPORT: tcp");
    expect(compose).toContain("ROOMS_HOST: 0.0.0.0");
    expect(compose).toContain('ROOMS_PORT: "43170"');
    expect(compose).toContain("restart: unless-stopped");
    expect(compose).not.toContain("network_mode: host");
  });

  it("checks the real local health endpoint and fails closed", () => {
    expect(compose).toContain("/app/docker/healthcheck.mjs");
    expect(healthcheck).toContain("ROOMS_HEALTH_URL");
    expect(healthcheck).toContain("/healthz");
    expect(healthcheck).toContain("process.exitCode = 1");
    expect(healthcheck).toContain("response.ok");
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/**
 * The test suite must never read or write the developer's live Rooms store.
 * Point every worker at its own temporary state dir and forbid falling back to
 * the real default, so a test that forgets to set up isolation fails loudly
 * instead of quietly listing hundreds of real channels.
 */
const stateDir = mkdtempSync(join(tmpdir(), "rooms-test-state-"));

process.env.ROOMS_STATE_DIR = stateDir;
process.env.ROOMS_FORBID_DEFAULT_STATE_DIR = "1";
delete process.env.ROOMS_STORE_PATH;
delete process.env.ROOMSD_STORE_PATH;

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

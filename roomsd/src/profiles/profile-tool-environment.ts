// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProfileToolEnvironment } from "./contracts.js";

export interface MaterializedProfileToolEnvironment {
  environment: Readonly<Record<string, string>>;
}

/** Apply explicit tool inputs to one session generated home. */
export function materializeProfileToolEnvironment(
  generatedHome: string,
  policy: ProfileToolEnvironment,
  options: Readonly<{ userHome?: string; browserSocketRoot?: string }> = {},
): MaterializedProfileToolEnvironment {
  const userHome = options.userHome ?? homedir();
  mkdirSync(generatedHome, { recursive: true, mode: 0o700 });
  const environment: Record<string, string> = { HOME: generatedHome };
  if (policy.npmUserConfig) {
    const source = join(userHome, ".npmrc");
    if (!existsSync(source)) throw new Error(`npm authentication source is missing: ${source}`);
    const target = join(generatedHome, ".npmrc");
    symlinkSync(source, target);
    environment.NPM_CONFIG_USERCONFIG = target;
  }
  if (policy.sandyboxySandbox !== null) {
    const sourcePath = join(userHome, ".sandyboxy", "config.json");
    if (!existsSync(sourcePath)) throw new Error(`Sandyboxy config is missing: ${sourcePath}`);
    const source = JSON.parse(readFileSync(sourcePath, "utf8")) as { sandboxes?: Record<string, unknown> };
    const selected = source.sandboxes?.[policy.sandyboxySandbox];
    if (!selected || typeof selected !== "object" || Array.isArray(selected)) throw new Error(`Sandyboxy sandbox is not registered: ${policy.sandyboxySandbox}`);
    const sandbox = structuredClone(selected) as { config?: { frontendGateway?: { enabled?: boolean } } };
    sandbox.config ??= {};
    sandbox.config.frontendGateway ??= {};
    sandbox.config.frontendGateway.enabled = false;
    const targetDirectory = join(generatedHome, ".sandyboxy");
    mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
    const target = join(targetDirectory, "config.json");
    writeFileSync(target, `${JSON.stringify({ default: policy.sandyboxySandbox, sandboxes: { [policy.sandyboxySandbox]: sandbox } }, null, 2)}\n`, { mode: 0o600 });
  }
  if (policy.browserRuntime) {
    const playwrightCache = join(userHome, "Library", "Caches", "ms-playwright");
    mkdirSync(playwrightCache, { recursive: true, mode: 0o700 });
    const socketKey = createHash("sha256").update(generatedHome).digest("hex").slice(0, 12);
    const socketDirectory = join(options.browserSocketRoot ?? "/tmp/rooms-browser", socketKey);
    mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
    environment.PLAYWRIGHT_BROWSERS_PATH = playwrightCache;
    environment.AGENT_BROWSER_SOCKET_DIR = socketDirectory;
  }
  return { environment };
}

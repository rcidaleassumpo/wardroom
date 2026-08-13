// SPDX-License-Identifier: Apache-2.0
/**
 * Federation-enabled SEA CLI entrypoint. Mirrors src/cli/standalone.ts with
 * the federation plug registered statically, because bundled builds cannot
 * resolve the loader's computed dynamic import.
 */
import * as plug from "./plug.js";
import { registerFederationModule, type FederationModule } from "../federation-loader.js";
import { runRoomsCLI } from "../cli/main.js";

registerFederationModule(plug as unknown as FederationModule);
runRoomsCLI(process.argv.slice(2)).then((output) => process.stdout.write(output)).catch((error) => {
  process.stderr.write(`rooms: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

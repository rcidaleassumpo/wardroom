// SPDX-License-Identifier: Apache-2.0
/**
 * Federation-enabled SEA daemon entrypoint. Bundlers cannot follow the
 * loader's computed dynamic import, so this entry registers the plug
 * statically before the daemon starts. The release build selects it when
 * src/federation exists and falls back to the single-machine entry otherwise.
 */
import * as plug from "./plug.js";
import { registerFederationModule, type FederationModule } from "../federation-loader.js";
import { runNativeDaemon } from "../runtime/native/main.js";

registerFederationModule(plug as unknown as FederationModule);
void runNativeDaemon();

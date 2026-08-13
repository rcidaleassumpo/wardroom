// SPDX-License-Identifier: Apache-2.0
/**
 * The single module the federation loader resolves at runtime. Everything the
 * core (composition, daemon entrypoints, CLI dispatch, default backend) needs
 * from federation is re-exported here, so a public single-machine tree can
 * delete src/federation/ and the federation CLI files wholesale: no core file
 * imports any of them statically.
 */
export { bindLocalRelayServer } from "./relay-local-server.js";
export { startFederatedChannelSubscriptions } from "./channel-subscription-manager.js";
export { createTerminalRuntimeHandler } from "./terminal-runtime-handler.js";
export { withChannelHomeRouting } from "./channel-home-handler.js";
export { withMachineInventory } from "./machine-inventory-handler.js";
export { readMachineRoute } from "./machine-route-store.js";
export { readActivePeerTrust } from "./peer-trust.js";
export {
  FEDERATION_PEER_COMMANDS, FEDERATION_ENROLL_COMMANDS, FEDERATION_RELAY_COMMANDS, FEDERATION_CHANNEL_COMMANDS, FEDERATION_CAPABILITY_COMMANDS,
  runRoomsFederationPeerCommand, runRoomsFederationEnrollCommand, runRoomsFederationRelayCommand, runRoomsFederationChannelCommand, runRoomsFederationCapabilityCommand,
} from "../cli/federation.js";
export { configureMachineRoute, inspectMachine, listMachines, locateSession } from "../cli/machine-inventory.js";
export { runInteractiveRemoteRuntimeAttach } from "../cli/remote-runtime-attach.js";

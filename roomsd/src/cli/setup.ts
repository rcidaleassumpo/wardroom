import { provisionLocalState, readLocalStateStatus, type LocalRoomsStatus } from "../provisioning/local-state.js";

export function runRoomsSetup(command: "setup" | "status", stateDir?: string): LocalRoomsStatus {
  return command === "setup" ? provisionLocalState(stateDir) : readLocalStateStatus(stateDir);
}

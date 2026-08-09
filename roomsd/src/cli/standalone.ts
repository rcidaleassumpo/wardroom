import { runRoomsCLI } from "./main.js";

runRoomsCLI(process.argv.slice(2)).then((output) => process.stdout.write(output)).catch((error) => {
  process.stderr.write(`rooms: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

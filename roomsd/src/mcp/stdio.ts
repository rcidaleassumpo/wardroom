#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { RoomsCLIBackend } from "../cli/backend.js";
import { createDefaultRoomsCLIBackend } from "../cli/default-backend.js";
import { createRoomsMcpServer } from "./server.js";

export function runRoomsMcpStdio(
  backend: RoomsCLIBackend = createDefaultRoomsCLIBackend(),
  environment: NodeJS.ProcessEnv = process.env,
): StdioServerHandle {
  return serveStdio(
    () => createRoomsMcpServer(backend, environment),
    { onerror: (error) => process.stderr.write(`rooms-mcp: ${error.message}\n`) },
  );
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (isDirectRun()) {
  try {
    runRoomsMcpStdio();
  } catch (error) {
    process.stderr.write(`rooms-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

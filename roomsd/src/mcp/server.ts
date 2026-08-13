// SPDX-License-Identifier: Apache-2.0
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { RoomsCLIBackend } from "../cli/backend.js";

export const ROOMS_MCP_TOOL_NAMES = ["join", "roster", "send", "inbox"] as const;

const nonEmpty = z.string().trim().min(1);
const optionalSession = nonEmpty.optional().describe("Rooms session ID. Defaults to ROOMS_SESSION_ID when that environment variable is set.");

const joinInput = z.object({
  channel: nonEmpty.describe("Existing Rooms channel to join."),
  session: nonEmpty.describe("Durable Rooms session ID for this MCP client."),
  role: z.enum(["operator", "planner", "worker", "reviewer"]).default("worker").describe("Canonical Rooms membership role metadata."),
  external_id: nonEmpty.optional().describe("Optional stable identity supplied by the MCP host."),
});

const rosterInput = z.object({
  channel: nonEmpty.describe("Rooms channel whose active roster to read."),
  session: optionalSession,
});

const sendInput = z.object({
  session: optionalSession,
  body: nonEmpty.describe("Message body. Rooms adds canonical sender provenance."),
  channel: nonEmpty.optional().describe("Channel for a broadcast. Set either channel or target, not both."),
  target: nonEmpty.optional().describe("Session ID for a direct message. Set either target or channel, not both."),
});

const inboxInput = z.object({
  session: optionalSession,
  cursor: z.string().regex(/^\d+$/).default("0").describe("Return events after this canonical Rooms cursor."),
  channel: nonEmpty.optional().describe("Optional channel filter."),
  limit: z.number().int().min(1).max(500).default(100).describe("Maximum number of events to return."),
});

export function createRoomsMcpServer(
  backend: RoomsCLIBackend,
  environment: NodeJS.ProcessEnv = process.env,
): McpServer {
  const inheritedSession = environment.ROOMS_SESSION_ID?.trim() || undefined;
  const server = new McpServer(
    { name: "rooms", version: "0.1.0" },
    {
      instructions: "Use join to register one log-delivered Rooms session, then use roster, send, and inbox against canonical Rooms state. MCP participation is agent-initiated and does not wake a stopped provider runtime.",
    },
  );

  server.registerTool(
    "join",
    {
      title: "Join a Rooms channel",
      description: "Register this MCP client as a log-delivered session in an existing Rooms channel.",
      inputSchema: joinInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ channel, session, role, external_id }) => toolResult(async () => {
      if (!backend.registerSession) throw new Error("Rooms session registration is unavailable");
      return backend.registerSession({
        channel,
        name: session,
        role,
        externalId: external_id ?? null,
        deliveryMode: "log",
      });
    }),
  );

  server.registerTool(
    "roster",
    {
      title: "Read a Rooms roster",
      description: "Read the canonical active membership of one Rooms channel.",
      inputSchema: rosterInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ channel, session }) => toolResult(async () => {
      if (!backend.channelMembers) throw new Error("Rooms channel roster support is unavailable");
      return backend.channelMembers(channel, resolveSession(session, inheritedSession));
    }),
  );

  server.registerTool(
    "send",
    {
      title: "Send a Rooms message",
      description: "Send one canonical Rooms broadcast or direct message. Set exactly one of channel or target.",
      inputSchema: sendInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ session, body, channel, target }) => toolResult(async () => {
      if (Boolean(channel) === Boolean(target)) throw new Error("send requires exactly one of channel or target");
      return backend.commitMessage({
        channel: channel ?? null,
        sender: resolveSession(session, inheritedSession),
        body,
        target: target ?? null,
      });
    }),
  );

  server.registerTool(
    "inbox",
    {
      title: "Read a Rooms inbox",
      description: "List durable Rooms events for one session after a cursor, with an optional channel filter.",
      inputSchema: inboxInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ session, cursor, channel, limit }) => toolResult(async () => {
      if (!backend.listMessages) throw new Error("Rooms message listing is unavailable");
      return backend.listMessages({
        session: resolveSession(session, inheritedSession),
        since: cursor,
        channel: channel ?? null,
        limit,
      });
    }),
  );

  return server;
}

function resolveSession(explicit: string | undefined, inherited: string | undefined): string {
  const session = explicit?.trim() || inherited;
  if (!session) throw new Error("session is required when ROOMS_SESSION_ID is not set");
  return session;
}

async function toolResult(work: () => Promise<unknown>) {
  try {
    const value = await work();
    const text = JSON.stringify(value, null, 2) ?? "null";
    return {
      content: [{ type: "text" as const, text }],
      structuredContent: { result: JSON.parse(text) as unknown },
    };
  } catch (error) {
    return {
      content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}

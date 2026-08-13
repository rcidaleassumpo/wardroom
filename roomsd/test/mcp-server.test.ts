import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoomsCLIBackend } from "../src/cli/backend.js";
import { createRoomsMcpServer, ROOMS_MCP_TOOL_NAMES } from "../src/mcp/server.js";

const openClients: Client[] = [];

afterEach(async () => {
  await Promise.all(openClients.splice(0).map(async (client) => client.close()));
});

describe("Rooms MCP server", () => {
  it("exposes the canonical Rooms tool inventory", async () => {
    const { client } = await connect(createBackend());

    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name)).toEqual(ROOMS_MCP_TOOL_NAMES);
    expect(listed.tools.every((tool) => tool.description && tool.inputSchema)).toBe(true);
    expect(client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
    expect(client.getServerVersion()).toEqual({ name: "rooms", version: "0.1.0" });
  });

  it("delegates join, roster, send, and inbox to the Rooms backend", async () => {
    const backend = createBackend();
    const { client } = await connect(backend, { ROOMS_SESSION_ID: "mcp-sender" });

    await client.callTool({
      name: "join",
      arguments: { channel: "project", session: "mcp-worker", role: "worker", external_id: "client-17" },
    });
    await client.callTool({ name: "roster", arguments: { channel: "project" } });
    await client.callTool({ name: "send", arguments: { target: "mcp-worker", body: "hello" } });
    await client.callTool({ name: "inbox", arguments: { cursor: "12", channel: "project", limit: 25 } });

    expect(backend.registerSession).toHaveBeenCalledWith({
      channel: "project",
      name: "mcp-worker",
      role: "worker",
      externalId: "client-17",
      deliveryMode: "log",
    });
    expect(backend.channelMembers).toHaveBeenCalledWith("project", "mcp-sender");
    expect(backend.commitMessage).toHaveBeenCalledWith({
      channel: null,
      sender: "mcp-sender",
      body: "hello",
      target: "mcp-worker",
    });
    expect(backend.listMessages).toHaveBeenCalledWith({
      session: "mcp-sender",
      since: "12",
      channel: "project",
      limit: 25,
    });
  });

  it("fails closed when send has no exact destination or session identity", async () => {
    const { client } = await connect(createBackend(), {});

    const ambiguous = await client.callTool({
      name: "send",
      arguments: { session: "sender", channel: "project", target: "worker", body: "hello" },
    });
    const unidentified = await client.callTool({
      name: "inbox",
      arguments: {},
    });

    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content).toContainEqual({ type: "text", text: "send requires exactly one of channel or target" });
    expect(unidentified.isError).toBe(true);
    expect(unidentified.content).toContainEqual({ type: "text", text: "session is required when ROOMS_SESSION_ID is not set" });
  });
});

async function connect(
  backend: RoomsCLIBackend,
  environment: NodeJS.ProcessEnv = {},
): Promise<{ client: Client }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createRoomsMcpServer(backend, environment);
  await server.connect(serverTransport);
  const client = new Client(
    { name: "rooms-mcp-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  await client.connect(clientTransport);
  openClients.push(client);
  return { client };
}

function createBackend(): RoomsCLIBackend {
  return {
    createChannel: vi.fn(async () => ({})),
    listChannels: vi.fn(async () => ({})),
    channelMembers: vi.fn(async () => ({ channel: "project", members: [] })),
    channelStatus: vi.fn(async () => ({})),
    suspendChannel: vi.fn(async () => ({})),
    resumeChannel: vi.fn(async () => ({})),
    createSession: vi.fn(async () => ({})),
    registerSession: vi.fn(async () => ({ session: { id: "mcp-worker" } })),
    commitMessage: vi.fn(async () => ({ event: { id: "event-1" }, cursor: "1" })),
    listMessages: vi.fn(async () => ({ events: [], cursor: "12" })),
    sendPrompt: vi.fn(async () => ({})),
  };
}

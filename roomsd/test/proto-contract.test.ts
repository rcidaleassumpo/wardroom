import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROOMS_LOCAL_EXTENSION_METHODS, ROOMS_PROTO_METHODS, ROOMS_PROTO_PACKAGE, ROOMS_PROTO_VERSION } from "../src/generated/rooms/v1/rooms.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const proto = readFileSync(join(root, "proto/rooms/v1/rooms.proto"), "utf8");
const typescript = readFileSync(join(root, "src/generated/rooms/v1/rooms.ts"), "utf8");

describe("Rooms protobuf client contract", () => {
  it("is a versioned neutral v3 contract", () => {
    expect(proto).toContain('syntax = "proto3";');
    expect(proto).toContain(`package ${ROOMS_PROTO_PACKAGE};`);
    expect(ROOMS_PROTO_VERSION).toBe(1);
  });

  it("covers canonical identity, history, and typed watch surfaces", () => {
    for (const type of ["Channel", "Session", "RosterEntry", "MembershipHistory", "Message", "Change", "Snapshot", "SearchResponse", "WatchEvent"]) {
      expect(proto).toContain(`message ${type} `);
    }
    expect(proto).toContain("rpc Watch(WatchRequest) returns (stream WatchEvent)");
    expect(proto).toContain("rpc Status(StatusRequest) returns (StatusResponse)");
  });

  it("keeps lifecycle control in the neutral contract", () => {
    expect(proto).toContain("rpc Suspend(SuspendRequest) returns (SuspendResponse)");
    expect(proto).toContain("rpc Resume(ResumeRequest) returns (ResumeResponse)");
    expect(proto).toContain("message LifecycleStatus ");
    expect(proto).toContain("repeated MemberSuspendResult members");
    expect(proto).toContain("string idempotency_key");
  });

  it("does not put sender or role authority in request identity", () => {
    const start = proto.indexOf("message RequestContext");
    expect(start).toBeGreaterThan(-1);
    const context = proto.slice(start, proto.indexOf("}", start) + 1);
    expect(context).not.toContain("sender");
    expect(context).not.toContain("role");
    expect(proto).toContain("optional string acknowledged_cursor");
    expect(proto).toContain("oneof value");
  });

  it("keeps role neutral metadata with no fixed vocabulary", () => {
    expect(proto).not.toContain("enum SessionRole");
    expect(proto).toContain("optional string role");
  });

  it("keeps the protobuf and local extension method sets exact", () => {
    const protoMethods = [...proto.matchAll(/^\s*rpc\s+(\w+)\(/gm)].map((match) => lowerFirst(match[1]!));
    expect(protoMethods).toEqual(ROOMS_PROTO_METHODS);
    expect(interfaceMethods(typescript, "RoomsProtoService")).toEqual(ROOMS_PROTO_METHODS);
    expect(interfaceMethods(typescript, "RoomsLocalServiceExtensions")).toEqual(ROOMS_LOCAL_EXTENSION_METHODS);
    expect(new Set([...ROOMS_PROTO_METHODS, ...ROOMS_LOCAL_EXTENSION_METHODS]).size).toBe(77);
  });

  it("pins the GetEvents wire tags and TypeScript fields", () => {
    const fields = protoMessageFields(proto, "GetEventsRequest");
    expect(fields).toEqual({ context: 1, channel_id: 2, after_cursor: 3, after_event_id: 4, session_id: 5, limit: 6, event_id: 7, reply_to_event_id: 8 });
    const request = interfaceFields(typescript, "GetEventsRequest");
    expect(request).toEqual(["context", "channelId", "afterCursor", "afterEventId", "sessionId", "limit", "eventId", "replyToEventId"]);
    expect(protoMessageFields(proto, "EventsResponse")).toEqual({ events: 1, cursor: 2, oldest_cursor: 3, has_more: 4 });
    expect(interfaceFields(typescript, "EventsResponse")).toEqual(["events", "cursor", "oldestCursor", "hasMore"]);
  });

  it("adds delivery status and typed error fields without reusing Message tags", () => {
    expect(proto).toContain("enum DeliveryStatus ");
    expect(proto).toContain("enum RoomsErrorCode ");
    expect(protoMessageFields(proto, "Message")).toEqual({ id: 1, channel_id: 2, sender_session_id: 3, body: 4, target: 5, delivered_recipient_session_ids: 6, correlation: 7, occurred_at: 8, sender_role: 9, recipient_statuses: 10, reply_to_event_id: 11, thread_root_event_id: 12 });
    expect(protoMessageFields(proto, "RoomsError")).toEqual({ code: 1, message: 2, domain_code: 3 });
    expect(interfaceFields(typescript, "Message")).toEqual(["id", "channelId", "senderSessionId", "body", "target", "deliveredRecipientSessionIds", "correlation", "occurredAt", "senderRole", "recipientStatuses", "replyToEventId", "threadRootEventId"]);
    expect(interfaceFields(typescript, "RoomsError")).toEqual(["code", "message", "domainCode"]);
  });

  it("pins canonical reply request and event fields", () => {
    expect(protoMessageFields(proto, "SendRequest")).toEqual({ context: 1, channel_id: 2, body: 3, target: 4, correlation: 5, reply_to_event_id: 6 });
    expect(interfaceFields(typescript, "SendRequest")).toEqual(["context", "channelId", "body", "target", "correlation", "replyToEventId"]);
    expect(protoMessageFields(proto, "Message")).toMatchObject({ reply_to_event_id: 11, thread_root_event_id: 12 });
  });

  it("pins the Search wire tags, including the channel hit surface", () => {
    expect(protoMessageFields(proto, "SearchRequest")).toEqual({ context: 1, query: 2, scope: 3, channel_id: 4, limit: 5, include_control: 6, include_channel_digests: 7, active_only: 8, include_events: 9 });
    expect(interfaceFields(typescript, "SearchRequest")).toEqual(["context", "query", "scope", "channelId", "limit", "includeControl", "includeChannelDigests", "activeOnly", "includeEvents"]);
    expect(protoMessageFields(proto, "SearchResponse")).toEqual({ events: 1, channels: 2 });
    expect(interfaceFields(typescript, "SearchResponse")).toEqual(["events", "channels"]);
    expect(protoMessageFields(proto, "ChannelSearchHit")).toEqual({ channel_id: 1, label: 2, lifecycle_state: 3, message_matches: 4, control_matches: 5, matched_in: 6, last_match_at: 7, last_activity_at: 8, excerpt: 9 });
    expect(interfaceFields(typescript, "ChannelSearchHit")).toEqual(["channelId", "label", "lifecycleState", "messageMatches", "controlMatches", "matchedIn", "lastMatchAt", "lastActivityAt", "excerpt"]);
  });

  it("pins canonical thread lifecycle fields and methods", () => {
    expect(proto).toContain("rpc GetThreadLifecycle(GetThreadLifecycleRequest) returns (ThreadLifecycleResponse)");
    expect(proto).toContain("rpc ResolveThread(ThreadLifecycleMutationRequest) returns (ThreadLifecycleResponse)");
    expect(proto).toContain("rpc ReopenThread(ThreadLifecycleMutationRequest) returns (ThreadLifecycleResponse)");
    expect(protoMessageFields(proto, "GetThreadLifecycleRequest")).toEqual({ context: 1, thread_root_event_id: 2, channel_id: 3 });
    expect(protoMessageFields(proto, "ThreadLifecycleMutationRequest")).toEqual({ context: 1, thread_root_event_id: 2, channel_id: 3 });
    expect(interfaceFields(typescript, "ThreadLifecycle")).toEqual([
      "threadRootEventId", "channelId", "state", "resolvedAt", "resolvedBySessionId", "reopenedAt", "reopenedBySessionId", "updatedAt",
    ]);
  });
});

function lowerFirst(value: string): string { return value[0]!.toLowerCase() + value.slice(1); }

function interfaceBody(source: string, name: string): string {
  const match = source.match(new RegExp(`export interface ${name}(?: extends [^{]+)? \\{([^}]*)\\}`));
  if (!match) throw new Error(`missing interface ${name}`);
  return match[1]!;
}

function interfaceMethods(source: string, name: string): string[] {
  return [...interfaceBody(source, name).matchAll(/^\s*(\w+)\(request:/gm)].map((match) => match[1]!);
}

function interfaceFields(source: string, name: string): string[] {
  return [...interfaceBody(source, name).matchAll(/(?:^|;)\s*(\w+)\??:/g)].map((match) => match[1]!);
}

function protoMessageFields(source: string, name: string): Record<string, number> {
  const match = source.match(new RegExp(`message ${name} \\{([^}]*)\\}`));
  if (!match) throw new Error(`missing message ${name}`);
  return Object.fromEntries([...match[1]!.matchAll(/(?:optional\s+)?(?:map<[^>]+>|[.\w]+)\s+(\w+)\s*=\s*(\d+)/g)].map((field) => [field[1]!, Number(field[2])]));
}

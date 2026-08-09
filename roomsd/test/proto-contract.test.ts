import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROOMS_PROTO_PACKAGE, ROOMS_PROTO_VERSION } from "../src/generated/rooms/v1/rooms.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const proto = readFileSync(join(root, "proto/rooms/v1/rooms.proto"), "utf8");

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
});

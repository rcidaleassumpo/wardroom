import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import releaseContract from "../release-contract.json" with { type: "json" };
import { HOST_PROTOCOL_VERSION } from "../src/runtime/host/codec.js";
import { SUPPORTED_SCHEMA_VERSION } from "../src/storage/migrations.js";
import { DEFAULT_MAX_BUFFERED_DELTA_BATCHES } from "../src/api/subscriptions/subscription.js";
import { DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT } from "../src/runtime/native/composition.js";

const roomsdRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(roomsdRoot, "..");
const proto = readFileSync(join(roomsdRoot, "proto/rooms/v1/rooms.proto"), "utf8");
const specification = readFileSync(join(repositoryRoot, "PROTOCOL.md"), "utf8");
const optionalFederationVersions = [
  sourceVersion("src/federation/contracts.ts", "FEDERATION_PROTOCOL_VERSION"),
  sourceVersion("src/federation/relay-protocol.ts", "RELAY_PROTOCOL_VERSION"),
].filter((version): version is number => version !== null);

describe("Rooms protocol v4 specification", () => {
  it("names every RPC in the canonical protobuf", () => {
    const rpcNames = [...proto.matchAll(/^\s*rpc\s+(\w+)\(/gm)].map((match) => match[1]);
    expect(rpcNames).toHaveLength(28);
    for (const rpcName of rpcNames) expect(specification).toContain(`\`${rpcName}\``);
  });

  it("tracks each implemented version space", () => {
    expect(releaseContract.protocolVersion).toBe(4);
    expect(releaseContract.storeSchemaVersion).toBe(SUPPORTED_SCHEMA_VERSION);
    for (const version of [
      releaseContract.protocolVersion,
      releaseContract.storeSchemaVersion,
      HOST_PROTOCOL_VERSION,
      ...optionalFederationVersions,
    ]) {
      expect(specification).toContain(`\`${version}\``);
    }
  });

  it("states current compatibility and contract boundaries", () => {
    expect(specification).toContain("accepts protocol version 4 only");
    expect(specification).toContain("The enforced supported range is `[4, 4]`");
    expect(specification).toContain("public 28-RPC contract");
    expect(specification).toContain("`RoomsLocalServiceExtensions`");
    expect(specification).toContain("Contract tests pin both sets, the `GetEvents`");
    expect(specification).toContain("request and response field tags");
    expect(specification).toContain("`recipient_statuses` records `delivered`, `queued`, or `undeliverable`");
    expect(specification).toContain("`RoomsErrorCode` supplies stable transport categories");
  });

  it("pins query replay and watch backpressure limits", () => {
    expect(DEFAULT_QUERY_LIMIT).toBe(50);
    expect(MAX_QUERY_LIMIT).toBe(500);
    expect(DEFAULT_MAX_BUFFERED_DELTA_BATCHES).toBe(128);
    for (const statement of [
      "retains committed changes for the lifetime of the",
      "Replay is exclusive: an item at the",
      "default is 50 and the maximum",
      "returns the newest matching",
      "128 pending deltas",
    ]) expect(specification).toContain(statement);
  });
});

function sourceVersion(path: string, name: string): number | null {
  const absolutePath = join(roomsdRoot, path);
  if (!existsSync(absolutePath)) return null;
  const match = new RegExp(`export const ${name} = (\\d+)`).exec(readFileSync(absolutePath, "utf8"));
  if (!match) throw new Error(`missing ${name} in ${path}`);
  return Number(match[1]);
}

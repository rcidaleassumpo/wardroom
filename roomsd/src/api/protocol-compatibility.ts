// SPDX-License-Identifier: Apache-2.0
import releaseContract from "../../release-contract.json" with { type: "json" };

export const ROOMS_PROTOCOL_MIN_VERSION = releaseContract.protocolVersion;
export const ROOMS_PROTOCOL_MAX_VERSION = releaseContract.protocolVersion;

export class RoomsProtocolVersionError extends Error {
  readonly code = "protocolVersionMismatch";

  constructor(
    public readonly receivedVersion: unknown,
    public readonly supportedMinVersion = ROOMS_PROTOCOL_MIN_VERSION,
    public readonly supportedMaxVersion = ROOMS_PROTOCOL_MAX_VERSION,
  ) {
    const received = Number.isSafeInteger(receivedVersion) ? String(receivedVersion) : "missing or invalid";
    const supported = supportedMinVersion === supportedMaxVersion
      ? String(supportedMinVersion)
      : `${supportedMinVersion}-${supportedMaxVersion}`;
    super(`Rooms protocol version ${received} is not supported; supported version: ${supported}`);
    this.name = "RoomsProtocolVersionError";
  }
}

export function assertRoomsProtocolVersion(version: unknown): asserts version is number {
  if (!Number.isSafeInteger(version) || Number(version) < ROOMS_PROTOCOL_MIN_VERSION || Number(version) > ROOMS_PROTOCOL_MAX_VERSION) {
    throw new RoomsProtocolVersionError(version);
  }
}

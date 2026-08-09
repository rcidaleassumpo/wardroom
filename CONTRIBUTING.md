# Contributing to Wardroom

Wardroom keeps channels, sessions, messages, runtimes, and delivery
provider-neutral. Workflow policy and provider-specific storage do not belong
in the core. Public v0.1 is single-machine only; federation is not part of this
cut.

## Before opening an issue

Search existing issues first. Use the bug report for a reproducible defect, the
feature request for a user or operator need, and the protocol design form for a
change to public wire semantics. Security reports do not belong in public
issues; follow [SECURITY.md](SECURITY.md).

## Development setup

You need Git, Node.js 22 or newer, and npm. Work on the Go runtime host also
needs the Go version declared in `roomsd/runtime-host-go/go.mod` and Apple
Silicon macOS for native PTY behavior.

From a fresh checkout:

```sh
git clone https://github.com/rcidaleassumpo/wardroom.git wardroom-source
cd wardroom-source/roomsd
npm ci
npm run typecheck
npm test
npm run build
```

These commands build the daemon and CLI from source. They do not install or
restart the per-user Wardroom service.

## Before changing code

1. Read [PROTOCOL.md](PROTOCOL.md) and the protobuf contract.
2. State whether the change affects public semantics, local implementation, or
   the macOS runtime host.
3. Use fake IDs and temporary directories in tests. Never read or write an
   installed `~/.rooms` state directory.
4. A cross-machine transport needs its own security review before release.

## Checks

For the TypeScript daemon and CLI:

```sh
cd roomsd
npm ci
npm run typecheck
npm test
npm run build
```

For the runtime host on Apple Silicon macOS:

```sh
cd roomsd/runtime-host-go
go build ./...
go test ./...
go vet ./...
```

Pull requests run the TypeScript checks on Linux and Apple Silicon macOS. CI
runs the Go build, tests, and vet natively on macOS, cross-builds the supported
`darwin-arm64` binary from Linux, and builds an unpublished local-proof release
with an official SEA-enabled Node distribution. The Go runtime host does not
yet have a Linux PTY adapter.

## Changes to the protocol

Update the protobuf and [PROTOCOL.md](PROTOCOL.md) together. Preserve existing
field numbers and reserve removed fields. Add tests for authority, ordering,
replay, and failure behavior when the change touches those rules.

Start protocol changes with the
[protocol design form](.github/ISSUE_TEMPLATE/3-protocol-design.yml). State the
authority that commits the change, concurrency and idempotency rules, cursor or
ordering effects, failure semantics, compatibility plan, and test evidence.

## Pull requests

Keep one change focused. Explain the user-visible result, the boundary it
changes, and the exact checks you ran. Update public docs in the same change
when behavior, authority, security, failure, or protocol semantics change.
Never include a real state directory, credential, machine identity, transcript,
provider token, or private host detail in code, tests, logs, or screenshots.

## Contributions and license

By submitting a contribution, you agree that it is licensed under Apache-2.0,
the license used by this project. Mark third-party code and generated files
clearly and include their source and license.

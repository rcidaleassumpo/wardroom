# Install Wardroom

Wardroom currently supports Apple Silicon macOS. The GitHub archive and
Homebrew formula contain the same complete release: the `rooms` CLI, the
`roomsd` daemon, the Go runtime host, and their checksum-bound manifest.

The first community build is ad-hoc signed, not signed with an Apple Developer
ID, and not notarized. Its manifest reports `LOCAL_PROOF_ONLY` and must never
claim otherwise.

## GitHub release

```sh
curl -LO https://github.com/rcidaleassumpo/wardroom/releases/download/v0.2.1/wardroom-0.2.1-darwin-arm64.tar.gz
mkdir wardroom-0.2.1 && tar -xzf wardroom-0.2.1-darwin-arm64.tar.gz -C wardroom-0.2.1
./wardroom-0.2.1/rooms install --release-dir ./wardroom-0.2.1
rooms setup
rooms provider discover
rooms service install
rooms doctor
```

## Homebrew

The first public release uses the project tap:

```sh
brew install rcidaleassumpo/tap/wardroom
rooms install
rooms setup
rooms provider discover
rooms service install
rooms doctor
```

`rooms install` copies the checksum-verified release into Wardroom's versioned
per-user release store. It does not require an Apple Developer Program account.
Because the executables use ad-hoc signatures, macOS may ask for App Management
access again after an upgrade.

Use `rooms upgrade` after npm or Homebrew installs a newer package. Wardroom
drains the daemon, checks schema compatibility, activates the new release, and
restores the prior release if service installation fails.

## Platform scope

The live PTY runtime currently supports Apple Silicon macOS. The TypeScript
protocol and daemon checks also run on Linux, but the public package does not
claim Linux live-runtime support yet.

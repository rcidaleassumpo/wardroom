# Install Wardroom

Wardroom currently supports Apple Silicon macOS. The npm package and Homebrew
formula contain the same complete release: the `rooms` CLI, the `roomsd`
daemon, the Go runtime host, and their checksum-bound manifest.

## npm

```sh
npm install --global wardroom
rooms install
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

`rooms install` resolves the complete release stored beside the package
manager's executable and copies it into Wardroom's versioned per-user release
store. It does not require an Apple Developer Program account. The release is
verified by its manifest and file checksums before activation.

Use `rooms upgrade` after npm or Homebrew installs a newer package. Wardroom
drains the daemon, checks schema compatibility, activates the new release, and
restores the prior release if service installation fails.

## Platform scope

The live PTY runtime currently supports Apple Silicon macOS. The TypeScript
protocol and daemon checks also run on Linux, but the public package does not
claim Linux live-runtime support yet.

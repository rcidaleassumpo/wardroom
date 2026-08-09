# Wardroom

Wardroom is a local-first coordination service for AI agents. Unlike
agent-to-agent (A2A) protocols built around request and response RPC, it stores
channels, sessions, membership, messages, recipients, and cursors as durable
events, then delivers messages into live terminal sessions. Its communication
model is closer to Matrix-style rooms and history than to an RPC mesh.

The daemon is the authority for identity, membership, ordering, history, and
delivery. Provider processes remain ordinary Codex, Claude, or Grok sessions;
they do not become message brokers or share transcript formats.

## Install

Wardroom supports Apple Silicon macOS. Install the complete release with
Homebrew:

```sh
brew install rcidaleassumpo/tap/wardroom
rooms install
```

Or install the same release from npm:

```sh
npm install --global wardroom
rooms install
```

Then initialize the per-user authority and daemon:

```sh
rooms setup
rooms provider discover
rooms service install
rooms doctor
```

See [DISTRIBUTION.md](DISTRIBUTION.md) for upgrades and platform scope.

## See two agents talk

This demo uses one machine, zsh, and authenticated Claude and Codex CLIs.
After installation, create one durable channel:

```sh
rooms channel create demo
```

`rooms service install` loads and starts the daemon, then keeps it available
through launchd. A separate `rooms service start` is not needed after install.

In each of two zsh terminals, select that channel and load temporary provider
functions into the current shell:

```sh
export ROOMS_CHANNEL_ID=demo
eval "$(rooms shellenv)"
```

Then start the providers with their normal commands:

| Terminal A | Terminal B |
| --- | --- |
| `claude` | `codex` |

Wardroom creates a durable session and a managed PTY runtime for each process. It
also gives each agent its session identity, channel, roster, and the commands
for sending through Wardroom. After Codex starts, ask it:

Use `rooms session inspect <session-id>` when a client needs the canonical
channel membership and current runtime/provider context for one session.

> Use Wardroom to send a direct hello to the other session and ask it to reply.

The hello should render in Claude, and Claude's reply should render in Codex.
That two-way provider-visible result is the proof. A send receipt or a message
history row alone proves durable acceptance, not that an agent received and
acted on the message.

`rooms shellenv status` reports installation state. Bare `rooms shellenv` does not edit shell startup files. For a persistent zsh
integration, use `rooms shellenv install`; remove only that managed integration
with `rooms shellenv uninstall`.

## What exists today

- Protocol v4 in `roomsd/proto/rooms/v1/rooms.proto`, with plain-language
  semantics in [PROTOCOL.md](PROTOCOL.md).
- A TypeScript daemon and CLI backed by SQLite.
- Durable channels, sessions, memberships, messages, recipient records,
  queries, cursors, snapshots, and watch streams.
- Delivery into provider PTYs through a dependency-free Go runtime host on
  Apple Silicon macOS.
- A loopback-only Docker shape for the daemon. Docker does not include the
  macOS runtime host.

Wardroom v0.1 is single-machine only. Federation is omitted from this public
cut and needs a separate security review before a later release.

Portable live delivery across every agent provider is not claimed. The live
runtime path and Codex driver exist; MCP support and broader headless driver
coverage remain later work.

## Build from source

You need Node.js 22 or newer. From the repository root:

```sh
cd roomsd
npm ci
npm run typecheck
npm test
npm run build
node dist/src/cli/main.js --help
```

The source CLI can open and migrate Wardroom state. Never point a working-tree
build at an installed `~/.rooms` directory. Use a separate state directory for
development commands.

The runtime host needs the Go version declared in
`roomsd/runtime-host-go/go.mod` and Apple Silicon macOS:

```sh
cd roomsd/runtime-host-go
go build ./...
go test ./...
go vet ./...
```

CI runs the TypeScript checks on Linux and Apple Silicon macOS. It runs
the Go checks on macOS and cross-builds the supported `darwin-arm64` host from
Linux without claiming a Linux PTY adapter. CI also builds the complete Apple
Silicon release with an official Node distribution that contains the Single
Executable Application fuse.

## Docker

The Docker setup runs the TypeScript daemon on port 43170 and publishes it only
on loopback:

```sh
cd roomsd
docker compose up --build
```

## Project status

Wardroom v0.1 is an Apple Silicon macOS release. Linux runs the protocol, daemon,
and source checks but does not yet provide the live PTY runtime host. Portable
MCP delivery and cross-machine federation remain future work.

See [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change and
[SECURITY.md](SECURITY.md) before reporting a security issue.

## Learn more

- [Quick start and how-to](guide/README.md)
- [Architecture](guide/ARCHITECTURE.md)
- [Short demo videos](guide/videos/README.md)
- [Open design issues](design/0001-atomic-channel-claim.md)

## License

Wardroom is licensed under [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for
the copyright notice.

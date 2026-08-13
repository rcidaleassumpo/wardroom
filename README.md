# Wardroom

Wardroom is a local-first coordination service for AI agents. It differs from
agent-to-agent (A2A) protocols that use request and response RPC. Wardroom
stores channels, sessions, membership, messages, recipients, and cursors as
durable events. It then delivers messages into live terminal sessions. The
communication model provides Matrix-style channels and shared history. It does
not provide an RPC mesh.

The daemon is the authority for identity, membership, ordering, history, and
delivery. Provider processes remain ordinary Codex, Claude, or Grok sessions;
they do not become message brokers or share transcript formats.

## See two agents talk

This demo uses one machine, a locally built Wardroom checkout, zsh,
and authenticated Claude and Codex CLIs. No public package is available yet.
Set up the local authority, discover the provider executables, install the
per-user daemon service, and create one durable channel:

```sh
rooms setup
rooms provider discover
rooms service install
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
for sending through Rooms. After Codex starts, ask it:

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
- A provider-neutral MCP server over stdio for joining channels, reading
  rosters and inboxes, and sending direct or broadcast messages.
- Delivery into provider PTYs through a dependency-free Go runtime host on
  Apple Silicon macOS.
- A loopback-only Docker shape for the daemon. Docker does not include the
  macOS runtime host.

The source tree also contains an SSH-stdio federation implementation. Its
presence in source is not a commitment to include federation in the first
public release. This README demonstrates only the single-machine path. A future
direct or Tailscale transport would need a new security review.

Portable runtime delivery across every agent provider is not claimed. MCP
clients can take part through stdio, but the MCP server does not wake a stopped
provider runtime. Broader headless driver coverage remains later work.

## Connect an MCP client

Build Rooms, start the daemon against the intended Rooms state, and configure a
generic stdio MCP client with this entry:

```json
{
  "command": "rooms",
  "args": ["mcp", "serve"],
  "env": {
    "ROOMS_SESSION_ID": "stable-client-session-id"
  }
}
```

The separate `rooms-mcp` binary starts the same server. The server exposes four
tools:

| Tool | Canonical Rooms operation |
| --- | --- |
| `join` | Register a log-delivered session in an existing channel. |
| `roster` | Read active membership for one channel. |
| `send` | Commit one direct message or channel broadcast. |
| `inbox` | Read session messages after a durable cursor. |

Each tool delegates to the daemon-backed Rooms CLI layer. The MCP process does
not own a second channel, session, message, or cursor store. `join` creates a
log-delivered session because a generic MCP client asks for its own messages;
it does not create or wake a provider runtime. A blocking wait tool is not part
of this checkpoint.

## Build Wardroom from source

You need Node.js 22 or newer. From the repository root:

```sh
cd roomsd
npm ci
npm run typecheck
npm test
npm run build
node dist/src/cli/main.js --help
```

The source CLI can open and migrate Rooms state. Never point a working-tree
build at an installed `~/.rooms` directory. Use a separate state directory for
development commands.

The runtime host needs the Go version declared in
`roomsd/runtime-host-go/go.mod`. Its PTY host supports Apple Silicon macOS and
Linux on amd64 or arm64:

```sh
cd roomsd/runtime-host-go
go build ./...
go test ./...
go vet ./...
```

Public CI runs the TypeScript and native Go host checks on Linux and Apple
Silicon macOS. Linux proof covers the PTY, process-group, and same-user Unix
credential adapter. CI also builds an unpublished,
ad-hoc-signed local-proof release with an official Node distribution that
contains the Single Executable Application fuse.

The toolchain-free release, installer, doctor, and managed service remain
Apple Silicon macOS only. Linux currently supports building and running the Go
runtime host from source; Rooms does not yet ship Linux executables or a
systemd/user-service lifecycle.

## Docker

The Docker setup runs the TypeScript daemon on port 43170 and publishes it only
on loopback:

```sh
cd roomsd
docker compose up --build
```

## Project status

This is a pre-release Wardroom source checkpoint. There is no public package,
signed binary, or approved public distribution yet. Native release scope,
signing, and distribution remain publication gates.

See [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change and
[SECURITY.md](SECURITY.md) before reporting a security issue.

## Learn more

- [Quick start and how-to](guide/README.md)
- [Architecture](guide/ARCHITECTURE.md)
- [Short demo videos](guide/videos/README.md)
- [Open design issues](design/0001-atomic-channel-claim.md)

## License

Wardroom uses the [Apache License 2.0](LICENSE). [NOTICE](NOTICE) names the
copyright holder. TypeScript daemon sources, Go runtime-host sources, and the
protobuf contract start with the machine-readable
`SPDX-License-Identifier: Apache-2.0` header. Generated source keeps the same
header because it ships as part of this project.

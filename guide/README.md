# Wardroom quick start

This guide builds Wardroom from source and uses a separate temporary state
directory. It does not touch an installed `~/.rooms` service.

## 1. Build the CLI and daemon

Requirements: Node.js 22 or newer, npm, Go as declared in
`roomsd/runtime-host-go/go.mod`, and Apple Silicon macOS for the published
runtime host.

```sh
git clone https://github.com/rcidaleassumpo/wardroom.git
cd wardroom/roomsd
npm ci
npm run build
cd runtime-host-go
./build.sh
cd ../..
```

The examples below use the source entrypoint through a small shell function:

```sh
rooms() { node "$PWD/roomsd/dist/src/cli/main.js" "$@"; }
export ROOMS_STATE_DIR="$(mktemp -d /tmp/rooms-guide.XXXXXX)"
export ROOMS_RUNTIME_HOST_BIN="$PWD/roomsd/runtime-host-go/dist/rooms-runtime-host-darwin-arm64"
```

## 2. Set up one local authority

```sh
rooms setup
export ROOMS_OPERATOR_CREDENTIAL=operator
```

`rooms setup` creates owner-only state, a machine identity, the SQLite store,
and one stable local operator session. Repeating setup is safe.

Start the daemon in a second terminal with the same two environment variables:

```sh
node roomsd/dist/src/runtime/native/standalone.js
```

## 3. Create a channel and register sessions

```sh
rooms channel create release-room
rooms session register --channel release-room --name alice --role worker
rooms session register --channel release-room --name bob --role worker
rooms channel members release-room
```

Registration creates durable identities and memberships. It does not claim
that a provider is live.

## 4. Prove live delivery without a provider account

Create a real PTY runtime for Bob. `/bin/cat` is used only as a visible local
delivery target for this proof.

```sh
rooms runtime create \
  --credential operator \
  --session bob \
  --runtime-id bob-runtime \
  --channel release-room \
  --command-json '["/bin/cat"]'

ROOMS_SESSION_ID=alice ROOMS_CHANNEL_ID=release-room \
  rooms session send bob --body "Please verify the release"

ROOMS_SESSION_ID=bob ROOMS_CHANNEL_ID=release-room \
  rooms message list --session bob --channel release-room --json
```

The send receipt names Bob in `deliveredRecipientSessionIds`. That proves
Wardroom accepted the message through Bob's live runtime. It does not prove that a
provider model read or acted on the message.

Clean up the proof runtime:

```sh
rooms runtime terminate bob-runtime --credential operator --generation 1
```

## 5. Launch a real provider

Discover provider executables, then launch one through Wardroom:

```sh
rooms provider discover
rooms provider list
rooms session launch \
  --credential operator \
  --channel release-room \
  --name codex-worker \
  --agent codex \
  --role worker \
  --prompt "Inspect the release and report findings"
```

Claude and Grok profiles may also be registered. Codex and Claude support
managed conversation resume. Grok supports managed launch but not conversation
resume; see the provider matrix in the protocol guide.

## Next reading

- [Architecture](ARCHITECTURE.md)
- [Demo videos](videos/README.md)
- [Protocol semantics](../PROTOCOL.md)
- [Security policy](../SECURITY.md)

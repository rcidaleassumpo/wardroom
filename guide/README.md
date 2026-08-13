# Wardroom quick start

This guide builds Wardroom from source and uses a separate temporary state
directory. It does not touch an installed `~/.rooms` service.

## 1. Build the CLI and daemon

Requirements: Node.js 22 or newer, npm, Go as declared in
`roomsd/runtime-host-go/go.mod`, and Apple Silicon macOS for the runtime host.

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
node roomsd/dist/src/federation/standalone-daemon.js
```

## 3. Create a channel and register sessions

```sh
rooms channel create release-room --goal "Verify the release"
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
Rooms accepted the message through Bob's live runtime. It does not prove that a
provider model read or acted on the message.

Clean up the proof runtime:

```sh
rooms runtime terminate bob-runtime --credential operator --generation 1
```

## 5. Launch a real provider

Discover provider executables, then launch one through Rooms:

```sh
rooms provider discover
rooms provider list
rooms run codex \
  --credential operator \
  --channel release-room \
  --name codex-worker \
  --prompt "Inspect the release and report findings"
```

Claude and Grok profiles may also be registered. Portable headless delivery is
not yet proved across every provider; see the project status in the README.

## 6. Federation

Read [the security policy](../SECURITY.md) first. Peer enrollment authenticates
the remote Rooms authority but does not grant blanket channel or runtime
access. A channel owner must admit the peer to each shared channel. Remote
terminal attach also needs a short-lived capability issued by the runtime's
home authority.

On each machine, run `rooms setup` and exchange only over SSH destinations you
control. The initiating command is:

```sh
rooms federation peer connect \
  --transport ssh \
  --ssh-host user@trusted-host \
  --local-state-dir "$ROOMS_STATE_DIR"
```

Inspect and revoke trust with:

```sh
rooms federation peer list --state-dir "$ROOMS_STATE_DIR"
rooms federation peer show --authority-id <authority-id> --state-dir "$ROOMS_STATE_DIR"
rooms federation peer revoke --authority-id <authority-id> --reason "access ended" --state-dir "$ROOMS_STATE_DIR"
```

After enrollment, the local channel owner can grant one peer access to one
channel:

```sh
rooms federation channel admit \
  --credential operator \
  --peer-authority-id <authority-id> \
  --channel release-room \
  --state-dir "$ROOMS_STATE_DIR"
```

Remote terminal access has a separate grant. On the runtime's home machine,
the runtime owner or an operator issues a one-use capability for the peer:

```sh
rooms federation capability issue \
  --credential operator \
  --session bob \
  --peer-authority-id <authority-id> \
  --out ./bob.capability.json \
  --mode observe \
  --state-dir "$ROOMS_STATE_DIR"
```

Transfer that owner-only capability file to the named peer over a secure path;
do not commit it or reuse it. Do not enroll a shared, untrusted, or third-party
machine.

## Next reading

- [Architecture](ARCHITECTURE.md)
- [Demo videos](videos/README.md)
- [Protocol semantics](../PROTOCOL.md)
- [Security policy](../SECURITY.md)

# Wardroom Go runtime host

This directory is the production packaging boundary for the per-session Go
runtime host. The benchmark host under `benchmarks/runtime-host-language` is a
separate research artifact and is not used as the installed binary.

The shipped host is a standalone Apple Silicon macOS binary built with cgo
disabled and no third-party modules. It accepts only the inherited enrollment
socketpair (fd 3); it never binds a network listener. Runtime state is created
under an owner-only directory and the control socket is mode 0600.

## Build

From this directory, run:

```sh
./build.sh
```

The output is `dist/rooms-runtime-host-darwin-arm64`, with a SHA-256 sidecar
and a machine-readable install manifest. The build refuses non-darwin-arm64
targets unless explicitly overridden for source inspection.

## Provision

`install.sh <destination>` installs the binary and manifest without touching
existing files. Provisioning, signing, notarization, and quarantine approval
are deployment-owned steps; this package does not silently claim them.

The operator-facing validation sequence is in [MANUAL-QA.md](MANUAL-QA.md).

## Launch and reconnect contract (v1)

roomsd sends exactly one `enroll` frame over the inherited fd-3 enrollment
channel (created as the child-owned local stream; it is not a listener). Its payload is
strict JSON (unknown fields and trailing data are rejected):

```json
{"version":1,"sessionId":"...","runtimeId":"...","homeAuthorityId":"...","generation":7,"protocolVersion":1,"expiresAt":0,"reconnectSecret":"base64url","statePath":"...","socketPath":"...","ringBytes":262144}
```

The non-empty secret is accepted only from fd 3. It is never read from
argv/environment and is not written to logs, output, events, or diagnostics.
The host creates the 0700 parent and atomically creates a 0600 state file and
0600 Unix socket. State contains the launch binding, expiry, correlation,
secret hash, and the plaintext reconnect material needed by the host; Wardroom
durable storage receives only hash/correlation metadata. The in-memory launch
copy is wiped after state creation and the active secret is wiped on `wipe`.

Each HELLO is strict JSON and binds issuer `roomsd`, audience, session/runtime/
home authority, generation, expiry, nonce/id, cursor, secret, and actions.
IDs are single-use, expired or stale generations fail closed, and comparisons
are constant-time. Supported actions are `attach`, `observe`, `controller`,
`input`, `resize`, `signal`, `terminate`, and `deliverMessage`; same-uid Unix
peer credentials remain mandatory.

`deliverMessage` is a separately authorized `0x0c` transaction. It carries a
canonical message id, at most 64 ordered byte frames (each at most 64 KiB),
and bounded delays (at most 5 seconds). It is legal while a controller is
attached, deduplicated within the generation, and acknowledged only after all
bytes have been written to the PTY fd. No message log or raw PTY persistence
is created. `0x0d` is the delivery acknowledgement. Ready/exit metadata keeps
generation, host pid, child pid, and exit code; pid values are advisory
liveness only.

Source-level QA fixtures for this unit are the strict JSON decoder, duplicate
and unknown-action rejection, capability expiry checks, bounded delivery
validation, and the `TSignal`/`TTerminate` paths. Operator-owned runtime QA
must still exercise lock-freedom under a producing PTY, partial-write
uncertainty, reconnect, and filesystem attack races; the worker does not run
behavioral tests.

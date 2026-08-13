# Rooms protocol v4

Status: implementation-derived specification for the protocol declared by
`roomsd/release-contract.json` at protocol version 4.

The machine-readable neutral API is
`roomsd/proto/rooms/v1/rooms.proto`. This document states behavior supported by
the current source. It does not turn unfinished or private code into a public
guarantee. The protobuf package `rooms.v1` and release protocol version 4 are
separate version spaces.

## 1. Scope and ownership

Rooms owns channels, sessions, memberships, messages, recipients, credentials,
runtime bindings, lifecycle, and federation routes. Provider adapters translate
Rooms records to provider processes and transports. They do not replace Rooms
identity, storage, authority, or delivery records.

The checked-in protobuf contains 28 RPCs. Local Unix requests, generated
TypeScript interfaces, runtime-host frames, and federation frames are related
implementation surfaces, but not all are represented by that protobuf. Known
differences are listed in section 12.

Protocol v4 does not require one wire transport. Current transports include
local Unix, named-pipe, and loopback TCP adapters. A client must not assume that
every implementation method is available on every listener.

## 2. Versions and compatibility

The current release contract uses these version spaces:

- Release protocol `4` is the current Rooms release contract.
- Store schema `21` is an internal SQLite version, not a network protocol.
- Protobuf package `rooms.v1` and generated marker `1` name API types.
- Runtime-host protocol `1` covers local host enrollment and frames.
- Federation protocol `1` covers peer enrollment and command envelopes.
- Federation relay protocol `3` covers its handshake and frames.

Every typed request must carry `RequestContext.protocol_version`. The same
context can carry an opaque credential and a request ID. The local transport
accepts protocol version 4 only. Legacy envelopes must also declare version 4
at the envelope level.
Missing, invalid, older, and newer versions fail before handler dispatch with
the typed code `protocolVersionMismatch` and a message that names the supported
range. The daemon client adds the current version to all typed requests,
including credential setup and interactive attach.

The enforced supported range is `[4, 4]`. This exact-version check prevents an
untested client and daemon pair from treating wire compatibility as proved.
Backward or forward support requires an intentional range change and
cross-version proof before release.

For future protobuf changes, preserve field numbers, reserve removed numbers,
and do not change the meaning of existing fields. That is maintenance guidance,
not a claim that current transports negotiate new fields or enum values.

## 3. Identity and credentials

Channel, session, runtime, generation, machine authority, event, and credential
IDs are distinct. Clients must treat them as opaque. A provider thread ID is
metadata on a Rooms session; it is not a Rooms session ID.

Credentials are opaque bearer tokens issued for a Rooms session. The credential
store persists a SHA-256 hash, not the token. Authentication fails for a blank,
unknown, malformed, or revoked credential, and when the actor session is ended
or has no role. Authentication resolves the actor session and role from Rooms.
Caller-supplied sender, role, registrar, or `authorized_by_session_id` fields do
not override that identity.

Current domain roles are `operator`, `planner`, `worker`, and `reviewer`. The
protobuf keeps role as a string, but the current service applies these rules:

- an operator creates and owns a channel;
- the owning operator, with named legacy active-operator allowances, controls
  channel closure, labels, broadcast policy, and role changes;
- an active planner may add workers to its channel;
- only an operator may add non-workers;
- an actor may leave or end itself; an operator may act on another session only
  where that command permits it;
- a channel allows at most one active planner and one active reviewer.

Private local composition may derive an actor from trusted process context
instead of a token. It must still use the same Rooms identity and domain rules.

## 4. Records, cursors, and replay

`Channel` records registration time, owner, active/closed state, optional close
time, label, and broadcast policy. `Session` records registration/end time,
display name, role, and optional provider thread ID. Membership history keeps
join, leave, session-end, and role facts; leaving does not erase history.

The store assigns ordered cursors to changes. Cursors are opaque strings to
clients. The current store encodes non-negative decimal integers. Clients must
persist and return the string. They must not derive one from an event ID,
timestamp, or local count.

`GetSnapshot` returns a folded channel view and cursor. `GetEvents` returns
message events after an opaque cursor or a legacy event ID. When both are
present, the cursor wins. An exact event ID returns that one message. An exact
reply-to event ID returns only messages whose correlation names that parent.
These two exact filters cannot be combined.

Optional session and limit fields select a bounded, session-relevant page. The
response includes its oldest cursor and whether more relevant messages remain.
`Watch` starts with state needed to establish a view or continues after a
cursor. It then emits deltas and lifecycle status. Apply items in delivered
cursor order.

The current subscription closes if a client
acknowledges a cursor beyond what that subscription delivered. Protocol v4 does
not promise indefinite retention or lossless replay outside retained data.

The current SQLite authority retains committed changes for the lifetime of the
store; it has no time-based pruning job. Replay is exclusive: an item at the
supplied cursor is not returned again. An invalid cursor fails instead of
falling back to a snapshot. A client must still treat retention as an authority
capability. Copying, replacing, or migrating a store can change the oldest
available cursor. Protocol v4 has no replay-gap discovery RPC.

`GetEvents` session paging returns the newest relevant page in cursor order.
Its default is 50 and the maximum is 500. `Search` applies the same default and
maximum, requires either channel or all scope, and returns the newest matching
event first. `ListChannels`, `GetSessions`, `GetRoster`, and
`GetMembershipHistory` have no paging fields and return their full stored result
in the order stated by the implementation. Clients must not use those methods
as unbounded event feeds.

`Watch` has a fail-closed slow-consumer bound of 128 pending deltas. If the
consumer does not drain before another delta crosses that bound, Rooms closes
the stream with a backpressure error. Reconnect with the last delivered cursor;
do not assume the stream kept later deltas after it closed.

## 5. RPC surface

### Channels, sessions, and membership

- `CreateChannel` creates an active channel and records its owning operator.
- `ShowChannel` returns one channel by ID.
- `ListChannels` returns known channels. The proto has no paging fields.
- `UpdateChannelLabel` sets or clears the label under operator authority.
- `UpdateChannelBroadcastPolicy` sets the `all` or `privileged` policy.
- `CloseChannel` closes the channel. A closed channel is not joinable.
- `RegisterSession` registers a session and optional display or role metadata.
- `Join` adds a live session under the current role authority rules.
- `Leave` ends an active membership without ending the session.
- `EndSession` ends the session. Its credential cannot authenticate a live actor.
- `ReplaceSession` replaces one member with another under operator authority.

### Messages and credentials

- `Send` commits a message, resolves recipients, and attempts delivery. It
  returns the canonical event and deduplication result.
- `Authenticate` resolves an opaque credential to its live actor session.
- `IssueCredential` issues a credential through the authorized local path.
- `GetRecipients` returns recipients persisted as delivered for an event.

### Queries and streams

- `GetSessions` returns registered sessions.
- `GetRoster` returns active channel members.
- `GetMembershipHistory` returns joined, left, and ended membership history.
- `GetSnapshot` returns a folded channel snapshot and cursor.
- `GetEvents` returns events after a cursor or legacy event boundary. It can
  also show one exact event or list messages correlated to one exact parent.
  Optional session and limit fields provide bounded session-relevant paging.
- `Search` searches one channel or all stored messages with a caller limit.
- `Watch` streams snapshot, delta, and lifecycle values for one channel.
- `Status` returns observed service lifecycle state.

### Suspend and resume

- `Suspend` changes suspend state and captures a blueprint. It reports each
  member result.
- `Resume` resumes a channel or blueprint with an idempotency key. It returns
  available channel and runtime references.

Suspend reasons are requested, maintenance, and transport loss. Lifecycle states
are running, suspending, suspended, resuming, and degraded. Blueprint state is
ready, partial, or failed; partial and failed outcomes are not ready. Reuse the
same resume idempotency key only for a retry of the same attempt.

## 6. Targets, correlation, and deduplication

Targets are `here`, `direct`, an explicit session set, or a legacy unknown
shape. A channel broadcast resolves current eligible recipients. A direct
message may be channel-less and globally addressed to a Rooms session. The
target remains routing metadata; a visible sender prefix does not name the
recipient.

`SendRequest.reply_to_event_id` is the canonical reply input. A committed
reply stores `Message.reply_to_event_id` and the derived
`Message.thread_root_event_id`. The parent must exist in the same channel. A
reply to a root uses the parent event ID as its thread root; a nested reply uses
the parent's canonical thread root. Root messages have neither value.

`Correlation.reply_to_event_id` remains a compatibility input and mirror. A
sender can use either location. When both are present, they must match exactly.
New writes mirror the canonical reply ID into correlation for older readers,
but derive the thread only from canonical parent fields. Store schema 18
backfills legacy correlation links in cursor order. It stops on a missing,
cross-channel, or out-of-order parent instead of assigning a guessed thread.

Store schema 19 keeps canonical thread lifecycle state under the root Rooms
event ID. `GetThreadLifecycle`, `ResolveThread`, and `ReopenThread` expose that
state. Rooms rejects a reply to a resolved root until a caller reopens it.
These thread operations do not create, launch, suspend, or end a runtime.

Correlation can also carry request ID, deduplication key, purpose, expected
handling, terminal status, origin channel/session, and target session. When the
store recognizes a prior deduplication key, `Send` returns that canonical event
with `was_deduplicated = true`; it does not append a second message.

A local reply stores its parent in `correlation.replyToEventId`. The parent
must exist in the same canonical channel, including the channel-less case.
Rooms rejects a missing or cross-channel parent as `staleReply`. The CLI exposes
this through `--reply-to`, `message show`, `message replies`, and the
`--reply-to` filter on `message list`. It does not encode reply identity in the
message body.

A federated channel send can use the same metadata. The channel's home
authority stores both events. Federated direct replies are not supported
because different authorities would store the parent and reply. The CLI rejects
that case instead of writing a link that the receiving authority cannot verify.

Expected handling (`complete` or `blocker`) and terminal status (`pending`,
`completed`, or `blocked`) are data. The proto does not define a scheduler,
timeout, or automatic completion rule for them.

## 7. Delivery receipts

A message event is the canonical stored message. Delivery fields describe the
recipient acceptance known to Rooms in the represented folded state:

- `delivered_recipient_session_ids` lists recipients whose current status is
  delivered;
- `recipient_statuses` records `delivered`, `queued`, or `undeliverable` for
  each recipient;
- `GetRecipients` returns durable delivered-recipient rows;
- a later `message.delivery` change can update the folded message after runtime
  delivery succeeds or fails.

For a log-delivered participant, committing to the canonical log is delivery.
For a runtime-delivered participant, Rooms attempts the live runtime and records
the outcome. A missing runtime can be queued when a route accepts later delivery
or undeliverable when none exists. A direct send with no accepted recipient
fails; a broadcast with no accepted recipient also fails.

A successful send receipt proves canonical acceptance and the listed recipient
outcomes. It does not prove that a provider interpreted the text, completed the
request, or replied. Provider-visible outbound text and a distinct reply are
stronger end-to-end evidence.

Runtime-host delivery acknowledgements are `written`, `duplicate`, or
`uncertain`. `written` means bytes reached the runtime-host boundary;
`duplicate` means that delivery ID was already accepted there; `uncertain` is
not success and is recorded as rejected/uncertain runtime delivery.

## 8. Session bootstrap and provider paths

Rooms creates or attaches a durable session/runtime and injects a Rooms-authored
briefing. The briefing supplies:

- exact session ID, channel ID, assigned role, and launch roster;
- the operator-supplied goal when `rooms run` received one;
- trust that launch identity;
- use `rooms whoami` only when identity is missing or conflicting;
- refresh the roster only when needed;
- direct/channel messaging rules, including locate-before-federated-send;
- the rule that Rooms owns channel, session, runtime, and delivery authority.

The briefing does not grant more authority than the canonical live session.
Provider-native thread IDs remain adapter metadata and must be preserved when a
runtime resumes.

Current support is capability-based rather than fixed in the proto:

| Path | Rooms contract |
| --- | --- |
| Runtime | Durable runtime, generation, binding, attachment, replay cursor, and delivery acknowledgement. |
| Provider driver | Starts or resumes a provider and maps provider process/thread state to the Rooms runtime. |
| MCP/tool call | Calls Rooms commands when installed and authenticated; it is not another identity or delivery authority. |

The normative provider matrix is the tested source
`roomsd/src/providers/capability-matrix.ts`. Publish that table; do not invent
support claims by hand.

| Provider id | Runtime | Provider driver | MCP / tool skill |
| --- | --- | --- | --- |
| `codex` | yes | yes | yes |
| `claude` | yes | yes | yes |
| `grok` | yes | yes | yes |

Detail flags in the same module record resume limits. Codex and Claude support
conversation and runtime-command resume. Grok supports launch, thread
discovery, and the Rooms skill, but not those resume adapters yet.

## 9. Runtime lifecycle

Runtime methods are not part of the 28-RPC proto. Current generated TypeScript
and local handlers expose create, list, status, attach, detach, input, resize,
signal, terminate, recover, delivery, and runtime-event queries.

A runtime belongs to a home authority and session and has a fenced generation.
Attachments are observers or one controller. Controller-only operations require
the controller lease. Output and events use replay cursors/sequences; a retained
replay gap is reported instead of filled with invented output. Exit is terminal
for one generation; recovery or replacement must use authorized current
identity and generation.

Runtime capabilities are scoped to runtime, generation, session, optional
channel, allowed actions, and expiry. Reconnect secrets are stored as hashes.
Runtime-host protocol 1 is private and local; release protocol v4 does not imply
runtime-host frame compatibility.

## 10. Federation trust and routing

Federation is a separate, authority-qualified boundary. Source presence does
not mean every release includes or enables it.

Each machine authority ID derives from its Ed25519 public-key fingerprint. Peer
trust records pin the public key, fingerprint, authority ID, and closed
transport policy. Private keys, operator credentials, and reconnect secrets do
not enter trust records. A peer becomes active only through signed,
replay-resistant enrollment. Pending, confirming, and revoked peers cannot
route. Revocation is terminal for that authority record.

The relay authenticates both active peers before application frames. Channel
federation separately requires admission by the channel's owning operator. Peer
trust alone grants no channel access. The channel home stays canonical for
membership, messages, cursors, and delivery decisions.

Remote sessions use the exact authority-qualified target returned by Rooms
discovery, currently shaped like
`federation:<authority-id>:<session-id>`. Treat it as opaque; do not construct,
shorten, or infer it. Federated direct delivery is channel-less. Federated
channel delivery follows the admitted channel route.

Federation protocol 1 and relay protocol 3 require exact versions; they do not
negotiate a range. Enrollment artifacts and relay frames are bounded and
strictly decoded. Discovery, peer connection, relay handshake, or a send
receipt alone does not prove that a remote provider received and answered.

## 11. Service-boundary evidence

- RPCs and fields: `roomsd/proto/rooms/v1/rooms.proto`
- Release and schema versions: `roomsd/release-contract.json`,
  `src/provisioning/release.ts`, and `src/storage/migrations.ts`
- Credential identity: `src/auth/authenticator.ts` and
  `src/credentials/credential-repository.ts`
- Role authority: `src/domain/application.ts` and `src/domain/contracts.ts`
- Cursors, messages, and recipients: `src/storage/repository.ts` and
  `src/api/subscriptions/subscription.ts`
- Delivery and runtime lifecycle: `src/runtime/service.ts`,
  `src/runtime/contracts.ts`, and `src/runtime/host/codec.ts`
- Birth briefing: `src/cli/agent-briefing.ts` and
  `test/agent-briefing.test.ts`
- Provider capability matrix: `src/providers/capability-matrix.ts` and
  `test/provider-capability-matrix.test.ts`
- Federation: `src/federation/contracts.ts`, `peer-trust.ts`,
  `relay-protocol.ts`, and `channel-home-handler.ts`
- Product boundary: `roomsd/docs/product-boundary.md` and
  `docs/rooms-runtime-design.md`

## 12. Contract boundary and known gaps

The settled local extension boundary is:

The checked-in protobuf remains the public 28-RPC contract. The TypeScript
service surface names those methods in `RoomsProtoService`. It keeps 39 private
local methods in `RoomsLocalServiceExtensions`. These methods cover role and
control changes, bulk queries, channel and session lifecycle, and message
delivery. They also cover provider access, rotation, runtime resolution,
streaming, control, and quota.
Contract tests pin both sets, the `GetEvents` request and response field tags,
and the reply fields on `SendRequest` and `Message`.

The local methods require an authenticated session on the same owner-only
socket. Operator-only methods also derive the actor role and channel ownership
from Rooms state; request ids and role fields never grant authority. The
`runtimeAttachStream` extension is long-lived: it yields a hello with the
attachment and replay cursors, then ordered output, exit, and error items.
Closing that socket detaches the view without ending the runtime.

The current contract status is:

1. Protocol v4 has an enforced local supported range of `[4, 4]`. No wider
   compatibility matrix is promised.
2. Closed: protobuf `Message.recipientStatuses` carries typed per-recipient
   delivery state. `RoomsErrorCode` supplies stable transport categories while
   `RoomsError.domain_code` preserves a more specific implementation code.
3. Closed for the three public paths: `roomsd/src/providers/capability-matrix.ts`
   is the tested matrix. Resume sub-capabilities still differ by provider.
4. Protocol v4 has no replay-gap discovery RPC and no general message-size
   limit. Section 4 defines current query ordering, paging, retention, and Watch
   backpressure. Narrower runtime and federation protocols define their own
   frame and queue limits.
5. Federation release inclusion and public support remain release decisions.

Until these gaps close, external clients should target the 28 checked-in RPCs.
They should preserve opaque IDs, cursors, and targets. They should not treat
local extension methods as protobuf RPCs and should verify the release's actual
transport.

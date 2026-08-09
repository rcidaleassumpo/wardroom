# Wardroom protocol v4

This document states the public semantics of
`roomsd/proto/rooms/v1/rooms.proto`. The protobuf file is the machine-readable
contract. This document explains the rules that are not clear from field names
alone.

## Scope

Wardroom v4 defines one authority for channels, sessions, memberships, messages,
recipients, cursors, lifecycle state, and queries. Provider process details,
terminal process IDs, environment variables, workflow tasks, and review policy
do not belong in the protocol.

The protocol defines one durable authority. The reference implementation can
route requests between enrolled authorities over its separate SSH-stdio relay
protocol without changing the protobuf rules. Federation release scope, MCP
tools, and a portable promise of live delivery into every provider remain
separate decisions.

## Versioning

Clients identify the protocol in `RequestContext.protocol_version`. The v0.1
release contract uses protocol version 4. A server must reject a request it
cannot interpret; it must not guess at newer field semantics.

Protobuf field numbers are permanent. Removed fields stay reserved. Compatible
changes may add optional fields, enum values, RPCs, or response data. A change
that alters an existing field's meaning, ordering, authority, or failure rule
requires a new protocol version.

## Identity and authority

- Channel and session IDs are opaque strings. Clients must not infer provider,
  machine, or process identity from them.
- A credential resolves to a server-owned session identity and authority.
  `RequestContext` does not let callers claim an authenticated sender or role.
  A command may request role metadata, but the server decides whether the
  authenticated caller may set it.
- A role is optional consumer metadata. The protocol does not define a planner,
  worker, reviewer, or other workflow model.
- The server checks command preconditions and authority in the same transaction
  as each durable change.

## Channels and sessions

A channel has an active or closed lifecycle. A session may exist outside a
channel and may join or leave channels over time. Current membership and
membership history are separate views: leaving a channel or ending a session
must not erase prior membership.

`ReplaceSession` changes the active session for a channel while keeping the
replacement explicit. Clients must not emulate replacement by racing separate
leave, register, and join calls.

## Messages and recipients

Every committed message has one sender, a body, a target, an occurrence time,
and a stable event ID. A target is one of the kinds declared by
`MessageTargetKind`; clients must not infer a target from an empty field.

`delivered_recipient_session_ids` records the recipients accepted by the
canonical delivery path. It is a receipt from Wardroom, not proof that a provider
model read or acted on the text. `GetRecipients` exposes durable recipient
records for an event.

When `Correlation.deduplication_key` is present, retries with the same key refer
to the first committed message. `MessageResponse.was_deduplicated` tells the
caller that Wardroom returned that prior result.

## Cursors, replay, and watch

Cursors are opaque strings. Clients may store and return them but must not
parse, increment, compare, or sort them as numbers.

`GetEvents.after_cursor` and `Watch.after_cursor` are exclusive: replay starts
after the supplied cursor. A watch begins with the state needed to establish a
view, then yields committed deltas in cursor order. Reconnects resume from the
last durable cursor and may replay events; consumers must use event IDs and
cursors to avoid applying a change twice.

`Watch.acknowledged_cursor` reports consumer progress. It does not let a client
rewrite server history. A server may close a slow watch when its bounded queue
fills; the client then reconnects from its last durable cursor.

## Snapshots and queries

A snapshot groups one channel with its current roster, sessions, memberships,
membership history, and cursor. Search and history results are point-in-time
queries. Clients that need a live view must follow the snapshot with `Watch`.

## Lifecycle

`Suspend` and `Resume` are durable operations, not process hints. Their results
name the lifecycle state and any partial member result. `Resume.idempotency_key`
identifies one resume attempt so a retry does not create a second runtime.

Lifecycle state can be running, suspending, suspended, resuming, or degraded.
Clients must handle unknown enum values as unsupported state, not as running.

## Transport

The protobuf service is transport-neutral. A transport adapter must preserve
authenticated identity, request and response fields, cursor order, stream
completion, and errors. Transport-only connection objects must never appear in
public responses.

The reference implementation offers local Unix, named-pipe, and loopback TCP
adapters. Their framing is an implementation detail and does not replace the
protobuf contract.

## Open design issue

Protocol v4 has no atomic channel claim or compare-and-set membership
operation. Clients that need one winner under concurrent channel creation
cannot safely build that authority from separate register and join calls.
[Design issue 1](design/0001-atomic-channel-claim.md) records the required
winner, loser, retry, and test semantics for a future protocol change.

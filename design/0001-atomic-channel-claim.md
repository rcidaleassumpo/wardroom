# Design issue 1: atomic channel claim

Status: open

Protocol v4 exposes channel registration, session registration, and membership
changes as separate operations. Two clients that try to create and own the
same logical channel at the same time cannot use those calls to choose one
winner without adding a second authority outside Wardroom.

## Required contract

A future protocol version should add either an idempotent channel claim or a
compare-and-set membership operation. The server must decide the result in the
same transaction as the durable state change.

The operation must define:

- the claim key and claimant identity;
- one deterministic winner when requests overlap;
- the winner returned to losing and retried requests;
- idempotent retry behavior;
- the version or cursor attached to the decision; and
- authorization and lifecycle errors.

## Acceptance

Automated tests must submit concurrent claims for the same channel and prove
that exactly one claimant wins, every loser observes that winner, retries do
not change the decision, and restart preserves the result.

Until that contract exists, clients must not emulate a channel claim by racing
separate register and join calls.

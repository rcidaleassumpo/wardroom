# Wardroom security policy

## Supported scope

Security fixes target the latest v0.1 source on the default branch. There is no
public binary or package release yet.

The source includes federation and remote terminal control between mutually
enrolled machines over SSH stdio. Enrollment authenticates the peer machine;
it does not grant operator authority over local runtimes. A channel owner must
admit each peer to a channel. Remote terminal attach requires a home-issued,
Ed25519-signed, one-use capability bound to one peer, session, runtime
generation, action set, and expiry.

The current security review covers only the implemented SSH-stdio transport.
A direct or Tailscale transport would remove SSH shell access as a precondition
and needs a fresh transport and application-authority review before release.

## Reporting a vulnerability

Open the repository's [Security page](https://github.com/rcidaleassumpo/wardroom/security),
choose **Advisories**, and use **Report a vulnerability**. This sends the report
privately to the maintainers. Do not open a public issue with credentials,
exploit code, private channel data, or a working attack.

If private reporting is not enabled, open a public issue containing only the
words "private security contact requested". A maintainer will provide a private
route. Keep all technical detail out of that issue.

Include the affected commit, operating system, expected boundary, observed
behavior, and the smallest safe reproduction you can provide. Remove tokens,
message bodies, state databases, transcripts, and machine identity files.

Maintainers will acknowledge a report before discussing disclosure timing.
Fixes stay private until affected users have a safe update path. The advisory
will credit the reporter unless they ask not to be named.

## Threat model

Rooms protects durable coordination and runtime authority from unauthenticated
clients, stale credentials, unenrolled or revoked peers, replayed capabilities,
and cross-channel or cross-runtime confusion. It treats the operating-system
user, an explicit channel owner, and an issued operator credential as local
trust roots.

Rooms does not protect against root, a compromised operating-system account, or
a provider process launched under that account. It is not a sandbox. SSH host
trust and account policy remain outside Rooms, and an admitted federation peer
is a trusted message sender for that channel. A delivery receipt proves Rooms
accepted a delivery, not that a model read or obeyed it.

## Security boundaries

- Rooms state and credentials belong to one operating-system user.
- Local state directories must be owner-only; credentials and identity files
  must not be shared or committed.
- The daemon is local by default. Docker publishes its TCP port on loopback.
- Peer enrollment authenticates a machine. Channel access still requires an
  owner-granted admission, and remote runtime access requires a signed
  capability. Revoke a peer (`rooms federation peer revoke`) as soon as you
  stop controlling it.
- The relay admits one authenticated inbound session per peer. It also caps
  sessions that have not finished the handshake. SSH account and host limits
  remain an additional boundary.
- Federated message bodies reach provider terminals without stripping control
  sequences or embedded newlines. Treat admitted peers as trusted message
  senders and do not admit an untrusted machine to a channel.
- Before relay authentication completes, Rooms sends a fixed rejection instead
  of local state paths, signing-key errors, or other setup detail.
- A delivery receipt does not prove that a provider read or acted on a message.
- Development builds must use a separate state directory. A newer source build
  may migrate state that an installed daemon cannot read.
- Provider processes run with the current user's authority. Rooms is not a
  sandbox for provider code or shell commands.

Never attach a real Rooms database, runtime state directory, transcript, SSH
configuration, private key, or provider credential to a report.

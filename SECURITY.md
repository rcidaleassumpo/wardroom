# Security policy

## Supported scope

Security fixes target the latest Wardroom v0.1 source and package release.
Public v0.1 is a single-machine release. It omits federation and remote terminal
control; any cross-machine transport needs a separate security review before a
later release.

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

Wardroom protects durable coordination and runtime authority from
unauthenticated clients, stale credentials, and cross-channel or cross-runtime
confusion. It treats the operating-system user, an explicit channel owner, and
an issued operator credential as local trust roots.

Wardroom does not protect against root, a compromised operating-system account, or
a provider process launched under that account. It is not a sandbox. SSH host
trust and account policy remain outside Wardroom. A delivery receipt proves
Wardroom accepted a delivery, not that a model read or obeyed it.

## Security boundaries

- Wardroom state and credentials belong to one operating-system user.
- Local state directories must be owner-only; credentials and identity files
  must not be shared or committed.
- The daemon is local by default. Docker publishes its TCP port on loopback.
- A delivery receipt does not prove that a provider read or acted on a message.
- Development builds must use a separate state directory. A newer source build
  may migrate state that an installed daemon cannot read.
- Provider processes run with the current user's authority. Wardroom is not a
  sandbox for provider code or shell commands.

Never attach a real Wardroom database, runtime state directory, transcript, SSH
configuration, private key, or provider credential to a report.

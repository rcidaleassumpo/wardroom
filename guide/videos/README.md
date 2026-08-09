# Wardroom demo videos

These short recordings are generated from the checked-in VHS tapes. They use
real `rooms` commands against temporary state.

- [Local quick start](local-quickstart.mp4): setup, channel/session creation,
  live PTY delivery, and message history.
- [Architecture](architecture.mp4): daemon, store, runtime host, and provider
  boundaries.

Regenerate all recordings from the repository root:

```sh
./guide/recordings/render.sh
```

The renderer validates the tapes and fails if an output exceeds the public
export's 5 MiB per-file limit.

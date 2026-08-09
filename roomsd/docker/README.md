# Docker runtime

`compose.yml` runs one `roomsd` service and mounts one named volume at `/data`.
The service and SQLite database therefore restart together, while the database
file survives container replacement. The published port is bound to loopback
only.

The image expects the TypeScript service build to produce
`dist/runtime/native/main.js` and to expose `GET /healthz` on `ROOMS_PORT`. The health URL can be overridden for
an adapter-specific transport with `ROOMS_HEALTH_URL`; a failed request makes
the container unhealthy.

Run locally from `roomsd`:

```sh
docker compose up --build
docker compose ps
```

Do not use `network_mode: host` or replace `roomsd-data` with an ephemeral
container path: both weaken the localhost and persistence guarantees.

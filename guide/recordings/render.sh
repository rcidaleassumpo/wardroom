#!/bin/zsh

set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

command -v vhs >/dev/null || { print -u2 "install VHS first: brew install vhs"; exit 1; }
command -v jq >/dev/null || { print -u2 "jq is required"; exit 1; }

[[ -f roomsd/dist/src/cli/main.js ]] || { print -u2 "build TypeScript first: cd roomsd && npm ci && npm run build"; exit 1; }
[[ -x roomsd/runtime-host-go/dist/rooms-runtime-host-darwin-arm64 ]] || { print -u2 "build the Go host first: cd roomsd/runtime-host-go && ./build.sh"; exit 1; }

mkdir -p guide/videos
for tape in guide/recordings/local-quickstart.tape guide/recordings/architecture.tape guide/recordings/federation-safety.tape; do
  vhs validate "$tape"
  vhs "$tape"
done

node - <<'NODE'
const { readdirSync, statSync } = require("node:fs");
for (const name of readdirSync("guide/videos")) {
  if (!name.endsWith(".mp4")) continue;
  const bytes = statSync(`guide/videos/${name}`).size;
  if (bytes > 5 * 1024 * 1024) throw new Error(`${name} exceeds the 5 MiB public export limit`);
  process.stdout.write(`${name}: ${bytes} bytes\n`);
}
NODE

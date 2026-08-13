#!/bin/zsh

set -euo pipefail

ROOMS_DEMO_ROOT="$(git rev-parse --show-toplevel)"
ROOMS_DEMO_STATE="$(mktemp -d /tmp/rooms-video.XXXXXX)"
ROOMS_DEMO_DAEMON_PID=""

export ROOMS_STATE_DIR="$ROOMS_DEMO_STATE"
export ROOMS_RUNTIME_HOST_BIN="$ROOMS_DEMO_ROOT/roomsd/runtime-host-go/dist/rooms-runtime-host-darwin-arm64"
export ROOMS_OPERATOR_CREDENTIAL=operator
export ROOMS_DEMO_COMMAND_JSON='["/bin/cat"]'

rooms() {
  node "$ROOMS_DEMO_ROOT/roomsd/dist/src/cli/main.js" "$@"
}

start_rooms_demo_daemon() {
  node "$ROOMS_DEMO_ROOT/roomsd/dist/src/federation/standalone-daemon.js" >"$ROOMS_DEMO_STATE/daemon.log" 2>&1 &
  ROOMS_DEMO_DAEMON_PID=$!
  for _attempt in {1..50}; do
    [[ -S "$ROOMS_DEMO_STATE/roomsd.sock" ]] && return
    sleep 0.1
  done
  print -u2 "roomsd did not create its socket"
  return 1
}

cleanup_rooms_demo() {
  if [[ -n "$ROOMS_DEMO_DAEMON_PID" ]]; then
    kill "$ROOMS_DEMO_DAEMON_PID" 2>/dev/null || true
    wait "$ROOMS_DEMO_DAEMON_PID" 2>/dev/null || true
    ROOMS_DEMO_DAEMON_PID=""
  fi
  node -e 'require("node:fs").rmSync(process.argv[1], { recursive: true, force: true })' "$ROOMS_DEMO_STATE"
}

trap cleanup_rooms_demo EXIT

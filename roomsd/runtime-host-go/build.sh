#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
out=${ROOMS_GO_HOST_OUT:-"$root/dist"}
mkdir -p "$out"
cd "$root"

os=${GOOS:-darwin}
arch=${GOARCH:-arm64}
if [ "$os" != darwin ] || [ "$arch" != arm64 ]; then
  if [ "${ROOMS_GO_HOST_ALLOW_UNSUPPORTED:-}" != 1 ]; then
    echo "rooms Go host requires GOOS=darwin GOARCH=arm64" >&2
    exit 2
  fi
fi

bin="$out/rooms-runtime-host-${os}-${arch}"
CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags='-s -w' -o "$bin" .
shasum -a 256 "$bin" > "$bin.sha256"
printf '{"binary":"%s","goos":"%s","goarch":"%s","cgo":"disabled","thirdPartyModules":false}\n' \
  "$(basename "$bin")" "$os" "$arch" > "$out/install-manifest.json"

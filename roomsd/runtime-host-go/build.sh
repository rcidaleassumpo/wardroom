#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
out=${ROOMS_GO_HOST_OUT:-"$root/dist"}
mkdir -p "$out"
cd "$root"

os=${GOOS:-$(go env GOOS)}
arch=${GOARCH:-$(go env GOARCH)}
case "$os-$arch" in
  darwin-arm64|linux-amd64|linux-arm64) ;;
  *)
    echo "rooms Go host supports darwin-arm64, linux-amd64, and linux-arm64" >&2
    exit 2
    ;;
esac

bin="$out/rooms-runtime-host-${os}-${arch}"
CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags='-s -w' -o "$bin" .
shasum -a 256 "$bin" > "$bin.sha256"
printf '{"binary":"%s","goos":"%s","goarch":"%s","cgo":"disabled","thirdPartyModules":false}\n' \
  "$(basename "$bin")" "$os" "$arch" > "$out/install-manifest.json"

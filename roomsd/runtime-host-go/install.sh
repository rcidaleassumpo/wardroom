#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: install.sh DESTINATION" >&2
  exit 2
fi
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
os=${GOOS:-$(go env GOOS)}
arch=${GOARCH:-$(go env GOARCH)}
src="$root/dist/rooms-runtime-host-${os}-${arch}"
manifest="$root/dist/install-manifest.json"
[ -f "$src" ] || { echo "build the host first" >&2; exit 1; }
[ -f "$manifest" ] || { echo "missing install manifest" >&2; exit 1; }
dest=$1
if [ -e "$dest" ]; then
  echo "refusing to overwrite existing destination: $dest" >&2
  exit 1
fi
install -m 0755 "$src" "$dest"
install -m 0644 "$manifest" "$dest.manifest.json"

#!/usr/bin/env bash
# Rebuild the bundled WARP helper from a pinned usque release plus the local
# patch in resources/warp/usque.patch. This is a maintainer script: the built
# binaries are committed so users do not need Go.
set -euo pipefail
cd "$(dirname "$0")/.."

USQUE_VERSION=${USQUE_VERSION:-v4.2.1}
OUT=${OUT:-resources/warp}
PATCH="$PWD/resources/warp/usque.patch"
command -v go >/dev/null || { echo 'build-warp-helper.sh needs Go 1.26.3 or newer on PATH.' >&2; exit 1; }
[ -f "$PATCH" ] || { echo "Missing $PATCH" >&2; exit 1; }
go_version=$(go env GOVERSION | sed 's/^go//')
if [ "$(printf '%s\n' 1.26.3 "$go_version" | sort -V | head -n1)" != 1.26.3 ]; then
  echo "Go 1.26.3 or newer is required (found $go_version)." >&2; exit 1
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/polygate-usque.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
git clone --depth 1 --branch "$USQUE_VERSION" -q https://github.com/Diniboy1123/usque "$work/usque"
git -C "$work/usque" apply "$PATCH"

mkdir -p "$OUT"
build() { # output, GOOS, GOARCH
  ( cd "$work/usque" && CGO_ENABLED=0 GOOS="$2" GOARCH="$3" \
      go build -trimpath -ldflags='-s -w' -o "$OUT/$1" . )
}
build usque-windows-amd64.exe windows amd64
build usque-linux-amd64 linux amd64
build usque-linux-arm64 linux arm64
chmod 0755 "$OUT"/usque-linux-* "$OUT"/usque-windows-amd64.exe
cp "$work/usque/LICENSE.md" "$OUT/LICENSE"
# The patch is already in the tree; keep it next to the binaries for provenance.

if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$OUT" && sha256sum usque-* > sha256.txt )
else
  ( cd "$OUT" && shasum -a 256 usque-* > sha256.txt )
fi
echo "Built WARP helper in $OUT"

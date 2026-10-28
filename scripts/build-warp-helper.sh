#!/usr/bin/env bash
# Rebuild the bundled WARP helper from a pinned usque release plus the local
# patch in resources/warp/usque.patch. This is a maintainer script: the built
# binaries are committed so users do not need Go.
set -euo pipefail
cd "$(dirname "$0")/.."

USQUE_VERSION=${USQUE_VERSION:-v4.2.1}
USQUE_COMMIT=${USQUE_COMMIT:-6aa03fc97d12848dce34eedbd187fb1077b5d1ea}
OUT=${OUT:-resources/warp}
# go build runs inside the temporary clone below, so a relative -o path would land in the clone and be deleted by the trap.
case "$OUT" in
  /*|[A-Za-z]:[\\/]*) ;;
  *) OUT="$PWD/$OUT" ;;
esac
PATCH="$PWD/resources/warp/usque.patch"
command -v go >/dev/null || { echo 'build-warp-helper.sh needs Go 1.26.3 or newer on PATH.' >&2; exit 1; }
[ -f "$PATCH" ] || { echo "Missing $PATCH" >&2; exit 1; }
go_version=$(go env GOVERSION | sed 's/^go//')
# sort -V is GNU-only (absent on macOS); compare the three numeric parts with POSIX awk instead.
if ! awk -v have="$go_version" -v need='1.26.3' 'BEGIN {
  split(have, h, "."); split(need, n, ".")
  for (i = 1; i <= 3; i++) {
    if ((h[i] + 0) > (n[i] + 0)) exit 0
    if ((h[i] + 0) < (n[i] + 0)) exit 1
  }
  exit 0
}'; then
  echo "Go 1.26.3 or newer is required (found $go_version)." >&2; exit 1
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/polygate-usque.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
git clone --depth 1 --branch "$USQUE_VERSION" -q https://github.com/Diniboy1123/usque "$work/usque"
actual=$(git -C "$work/usque" rev-parse HEAD)
if [ "$actual" != "$USQUE_COMMIT" ]; then
  echo "usque $USQUE_VERSION resolved to $actual, expected $USQUE_COMMIT. Refusing to build from a moved tag." >&2; exit 1
fi
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

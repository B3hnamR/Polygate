#!/usr/bin/env bash
# Rebuild the bundled WARP helper from a pinned usque release plus the local
# patch in resources/warp/usque.patch. Comparison never replaces supplied files.
set -euo pipefail
cd "$(dirname "$0")/.."

USQUE_VERSION=v4.2.1
USQUE_COMMIT=6aa03fc97d12848dce34eedbd187fb1077b5d1ea
MODE=${1:---compare}
case "$MODE" in --compare|--write) ;; *) echo 'Usage: build-warp-helper.sh [--compare|--write]' >&2; exit 2;; esac
# Comparison is the default and never replaces supplied binaries or their manifest.
OUT=${OUT:-build/warp-reproduction}
# go build runs inside the temporary clone below, so a relative -o path would land in the clone and be deleted by the trap.
case "$OUT" in
  /*|[A-Za-z]:[\\/]*) ;;
  *) OUT="$PWD/$OUT" ;;
esac
PATCH="$PWD/resources/warp/usque.patch"
MANIFEST="$PWD/resources/warp/sha256.txt"
command -v go >/dev/null || { echo 'build-warp-helper.sh needs Go on PATH.' >&2; exit 1; }
[ -f "$PATCH" ] || { echo "Missing $PATCH" >&2; exit 1; }
# Do not silently download a toolchain or inherit workspace/user build flags.
export GOTOOLCHAIN=local GOENV=off GOFLAGS= GOWORK=off
export LC_ALL=C TZ=UTC CGO_ENABLED=0 GOAMD64=v1 GOARM64=v8.0 GOEXPERIMENT=
unset GOOS GOARCH
export GOPROXY=${GOPROXY:-off} GOSUMDB=${GOSUMDB:-off}
GO_VERSION=${GO_VERSION:-1.27.2}
go_version=$(go env GOVERSION | sed 's/^go//')
if [ "$go_version" != "$GO_VERSION" ]; then
  echo "Go $GO_VERSION is required for this build recipe (found $go_version). Supply it on PATH; automatic toolchain downloads are disabled." >&2; exit 1
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/polygate-usque.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
# Supply an already acquired checkout for offline verification. Never modify it.
if [ -n "${USQUE_SOURCE:-}" ]; then
  git -c core.autocrlf=false clone --no-hardlinks -q "$USQUE_SOURCE" "$work/usque"
  git -C "$work/usque" checkout --detach -q "$USQUE_COMMIT"
else
  git -c core.autocrlf=false clone --depth 1 --branch "$USQUE_VERSION" -q https://github.com/Diniboy1123/usque "$work/usque"
fi
actual=$(git -C "$work/usque" rev-parse HEAD)
if [ "$actual" != "$USQUE_COMMIT" ]; then
  echo "usque $USQUE_VERSION resolved to $actual, expected $USQUE_COMMIT. Refusing to build from a moved tag." >&2; exit 1
fi
export SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git -C "$work/usque" show -s --format=%ct HEAD)}
[[ "$SOURCE_DATE_EPOCH" =~ ^[0-9]+$ ]] || { echo 'Invalid SOURCE_DATE_EPOCH.' >&2; exit 1; }
source_tree=$(git -C "$work/usque" rev-parse 'HEAD^{tree}')
hash() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi
}
patch_sha=$(hash "$PATCH" | cut -d ' ' -f 1)
source_sha=$(git -C "$work/usque" archive --format=tar HEAD | { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; } | cut -d ' ' -f 1)
script_sha=$(hash "$PWD/scripts/build-warp-helper.sh" | cut -d ' ' -f 1)
git -C "$work/usque" apply "$PATCH"

mkdir -p "$work/output" "$OUT"
OUT=$(cd "$OUT" && pwd -P)
if [ "$MODE" = --compare ] && [ "$OUT" = "$(cd resources/warp && pwd -P)" ]; then
  echo 'Comparison OUT must not be resources/warp.' >&2; exit 1
fi
for file in usque-linux-amd64 usque-linux-arm64 usque-windows-amd64.exe sha256.txt build-provenance.txt LICENSE usque.patch; do
  [ ! -L "$OUT/$file" ] || { echo "Refusing symlink output: $OUT/$file" >&2; exit 1; }
  if [ "$MODE" = --compare ]; then
    for supplied in resources/warp/*; do
      if [ "$OUT/$file" -ef "$supplied" ]; then
        echo "Comparison output aliases a supplied file: $OUT/$file" >&2; exit 1
      fi
    done
  fi
done
build() { # output, GOOS, GOARCH
  ( cd "$work/usque" && CGO_ENABLED=0 GOOS="$2" GOARCH="$3" \
      go build -mod=readonly -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o "$work/output/$1" . )
}
build usque-windows-amd64.exe windows amd64
build usque-linux-amd64 linux amd64
build usque-linux-arm64 linux arm64
files=(usque-linux-amd64 usque-linux-arm64 usque-windows-amd64.exe)
for file in "${files[@]}"; do chmod 0755 "$work/output/$file"; done
result=not-compared
status=0
if [ "$MODE" = --compare ]; then
  # Compare exact filenames and hashes, not paths supplied by an untrusted manifest.
  result=matched
  for file in "${files[@]}"; do
    expected=$(awk -v file="$file" '$2 == file {print $1}' "$MANIFEST")
    actual=$(hash "$work/output/$file" | cut -d ' ' -f 1)
    if [[ ! "$expected" =~ ^[a-f0-9]{64}$ ]] || [ "$actual" != "$expected" ]; then
      echo "Mismatch: $file expected=$expected actual=$actual" >&2
      result=mismatched; status=1
    fi
  done
fi
# Record evidence even when comparison fails; this is not an attestation for old files.
{
  printf 'schema=1\nsource=https://github.com/Diniboy1123/usque\ntag=%s\ncommit=%s\ntree=%s\nsource_archive_sha256=%s\npatch_sha256=%s\nscript_sha256=%s\n' "$USQUE_VERSION" "$USQUE_COMMIT" "$source_tree" "$source_sha" "$patch_sha" "$script_sha"
  printf 'source_date_epoch=%s\ncomparison=%s\nflags=-mod=readonly -trimpath -buildvcs=false -ldflags="-s -w -buildid="\n' "$SOURCE_DATE_EPOCH" "$result"
  go version
  git --version
  printf 'bash=%s\n' "$BASH_VERSION"
  go env GOVERSION GOHOSTOS GOHOSTARCH CGO_ENABLED GOAMD64 GOARM64 GOEXPERIMENT GOTOOLCHAIN GOPROXY GOSUMDB
  printf 'go_mod_sha256=%s\ngo_sum_sha256=%s\n' "$(hash "$work/usque/go.mod" | cut -d ' ' -f 1)" "$(hash "$work/usque/go.sum" | cut -d ' ' -f 1)"
  (cd "$work/usque" && go list -m -mod=readonly all)
} > "$work/output/build-provenance.txt"
for file in "${files[@]}"; do
  go version -m "$work/output/$file" >> "$work/output/build-provenance.txt"
done
(cd "$work/output" && for file in "${files[@]}"; do hash "$file"; done > sha256.txt)
cp "$work/usque/LICENSE.md" "$work/output/LICENSE"
cp "$PATCH" "$work/output/usque.patch"
cp "$work/output/"* "$OUT/"
echo "Built WARP helper in $OUT; comparison=$result"
exit "$status"

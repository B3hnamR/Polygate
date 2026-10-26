#!/usr/bin/env bash
# Build a release without changing the installation or publishing anything.
set -euo pipefail
cd "$(dirname "$0")/.."
ARCH=${1:-amd64}
BUN_VERSION=${BUN_VERSION:-1.4.4}
case "$ARCH" in amd64) target=x64;; arm64) target=aarch64;; *) echo 'Usage: build-linux.sh amd64|arm64' >&2; exit 2;; esac
[[ "$BUN_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid Bun version.' >&2; exit 1; }
for tool in bun python3; do command -v "$tool" >/dev/null || { echo "build-linux.sh needs $tool on PATH." >&2; exit 1; }; done
mkdir -p release build
work=$(mktemp -d "${TMPDIR:-/tmp}/polygate-package.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
pkg="$work/polygate"
mkdir -p "$pkg/bin" "$pkg/build"
if [ "${POLYGATE_SKIP_UI_BUILD:-0}" != 1 ]; then bun run build:ui; fi
bun build backend/main.ts --target bun --outfile "$pkg/build/gateway.js"
bun build backend/manage.ts --target bun --outfile "$pkg/build/manage.js"
asset="bun-linux-$target"
curl -fLsS --retry 3 "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/$asset.zip" -o "$work/bun.zip"
curl -fLsS --retry 3 "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/SHASUMS256.txt" -o "$work/bun.sha256"
python3 - "$work" "$asset" "$pkg" <<'PY'
import hashlib,pathlib,sys,zipfile
work,asset,pkg=pathlib.Path(sys.argv[1]),sys.argv[2],pathlib.Path(sys.argv[3])
matches=[line.split()[0] for line in (work/'bun.sha256').read_text().splitlines() if line.split()[-1].lstrip('*./')==asset+'.zip']
if len(matches)!=1 or hashlib.file_digest((work/'bun.zip').open('rb'),'sha256').hexdigest()!=matches[0]:raise SystemExit('Bun checksum mismatch')
with zipfile.ZipFile(work/'bun.zip') as z:
 (pkg/'bin/bun').write_bytes(z.read(asset+'/bun'))
PY
chmod 0755 "$pkg/bin/bun"
cp -R dist install scripts relays "$pkg/"
cp install.sh package.json README.md THIRD_PARTY_NOTICES.md "$pkg/"
mkdir -p "$pkg/vendor/bridge" "$pkg/vendor/protocols"
cp -R vendor/licenses "$pkg/vendor/licenses"
cp vendor/bridge/LICENSE "$pkg/vendor/bridge/"
cp vendor/protocols/LICENSE "$pkg/vendor/protocols/"
python3 - "$pkg" "$ARCH" "$BUN_VERSION" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]);(p/'release.json').write_text(json.dumps({'version':json.loads((p/'package.json').read_text())['version'],'architecture':sys.argv[2],'bun':sys.argv[3]},indent=2)+'\n')
for cache in p.rglob('__pycache__'):
 import shutil;shutil.rmtree(cache)
PY
tar --owner=0 --group=0 --numeric-owner -czf "release/polygate-linux-$ARCH.tar.gz" -C "$work" polygate
(cd release && sha256sum "polygate-linux-$ARCH.tar.gz" > "polygate-linux-$ARCH.tar.gz.sha256")
echo "Created release/polygate-linux-$ARCH.tar.gz (runtime checksum verified)."

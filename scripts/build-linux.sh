#!/usr/bin/env bash
# Build a release without changing the installation or publishing anything.
set -euo pipefail
cd "$(dirname "$0")/.."
ARCH=${1:-amd64}
BUN_VERSION=${BUN_VERSION:-1.4.4}
case "$ARCH" in amd64) target=x64;; arm64) target=aarch64;; *) echo 'Usage: build-linux.sh amd64|arm64' >&2; exit 2;; esac
[[ "$BUN_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid Bun version.' >&2; exit 1; }
[ "$BUN_VERSION" = 1.4.4 ] || { echo 'Retained runtime notices cover Bun 1.4.4 only; review and update them before changing Bun.' >&2; exit 1; }
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
if [ -n "${POLYGATE_BUN_RUNTIME:-}" ]; then
  [[ "${POLYGATE_BUN_RUNTIME_SHA256:-}" =~ ^[a-fA-F0-9]{64}$ ]] || { echo 'An offline runtime requires POLYGATE_BUN_RUNTIME_SHA256.' >&2; exit 1; }
  python3 - "$POLYGATE_BUN_RUNTIME" "$POLYGATE_BUN_RUNTIME_SHA256" "$ARCH" "$pkg/bin/bun" <<'PY'
import hashlib,pathlib,struct,sys
source,expected,arch,dest=pathlib.Path(sys.argv[1]),sys.argv[2].lower(),sys.argv[3],pathlib.Path(sys.argv[4])
if not source.is_file() or source.is_symlink():raise SystemExit('Offline Bun runtime must be a regular file, not a symlink')
data=source.read_bytes()
if hashlib.sha256(data).hexdigest()!=expected:raise SystemExit('Offline Bun runtime checksum mismatch')
if len(data)<64 or data[:6]!=b'\x7fELF\x02\x01' or struct.unpack_from('<H',data,18)[0]!={'amd64':62,'arm64':183}[arch]:raise SystemExit('Offline Bun runtime architecture does not match the Linux package')
dest.write_bytes(data)
PY
else
  [ -z "${POLYGATE_BUN_RUNTIME_SHA256:-}" ] || { echo 'POLYGATE_BUN_RUNTIME is required with its checksum.' >&2; exit 1; }
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
fi
chmod 0755 "$pkg/bin/bun"
if { [ "$ARCH" = amd64 ] && [ "$(uname -m)" = x86_64 ]; } || { [ "$ARCH" = arm64 ] && [ "$(uname -m)" = aarch64 ]; }; then
  [ "$("$pkg/bin/bun" --version)" = "$BUN_VERSION" ] || { echo 'Bundled Bun runtime version does not match the pinned version.' >&2; exit 1; }
fi
cp -R dist install scripts relays "$pkg/"
mkdir -p "$pkg/warp"
cp "resources/warp/usque-linux-$ARCH" "$pkg/warp/"
cp resources/warp/LICENSE resources/warp/README.md resources/warp/usque.patch resources/warp/sha256.txt "$pkg/warp/"
if [ -f resources/warp/build-provenance.txt ]; then cp resources/warp/build-provenance.txt "$pkg/warp/"; fi
chmod 0755 "$pkg/warp/usque-linux-$ARCH"
# Psiphon has an official client for Linux x86-64 only (resources/psiphon/README.md).
if [ "$ARCH" = amd64 ]; then
  mkdir -p "$pkg/psiphon"
  cp resources/psiphon/psiphon-tunnel-core-linux-amd64 resources/psiphon/psiphon.json resources/psiphon/server-list.dat resources/psiphon/LICENSE resources/psiphon/README.md "$pkg/psiphon/"
  # Only the files this package carries, so `sha256sum -c sha256.txt` passes on a server (the Windows client is not here).
  grep -v 'windows' resources/psiphon/sha256.txt > "$pkg/psiphon/sha256.txt"
  chmod 0755 "$pkg/psiphon/psiphon-tunnel-core-linux-amd64"
fi
cp install.sh package.json README.md LICENSE THIRD_PARTY_NOTICES.md "$pkg/"
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

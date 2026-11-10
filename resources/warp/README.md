# WARP helper

Polygate runs Cloudflare WARP as a userspace MASQUE tunnel over HTTP/2. The
helper is a locally patched build of [usque](https://github.com/Diniboy1123/usque)
at tag `v4.2.1` (commit `6aa03fc97d12848dce34eedbd187fb1077b5d1ea`), used as a
separate process. Polygate talks to it over a loopback SOCKS5 port, the same way
it talks to any other proxy, so the gateway itself stays MIT-licensed.

## Local patches

The upstream source is MIT-licensed; the full patch is in `usque.patch`.

1. `internal/consts.go`: the registration API host is
   `api.devices.cloudflare.com`. The old `api.cloudflareclient.com` hostname is
   filtered on some networks and its TLS handshake times out.
2. `api/fragment.go` (new): splits the first 2 KiB of the TLS ClientHello into
   64-byte segments with a 2 ms pause. Networks that drop a ClientHello carrying
   the MASQUE SNI complete the handshake with this fragmentation. It is opt-in
   through `USQUE_FRAGMENT=64:2:2048`, which Polygate sets for the helper.
3. `api/masque.go`: wraps the TCP connection with the fragmenter, and sets
   `ReadIdleTimeout`/`PingTimeout` on the HTTP/2 transport so an idle tunnel is
   kept alive instead of being closed by the server.

## Binaries

| File | Target |
|---|---|
| `usque-windows-amd64.exe` | Windows x64 |
| `usque-linux-amd64` | Linux x64 |
| `usque-linux-arm64` | Linux arm64 |

From a source checkout, build into a separate directory and compare against the
supplied manifest without replacing any supplied helper:

```sh
USQUE_SOURCE=/path/to/already-acquired/usque ./scripts/build-warp-helper.sh --compare
```

The recipe requires Go 1.27.2 on PATH by default (`GO_VERSION` permits an
explicit alternative experiment). This toolchain pin is a recipe input, not
independent evidence of which compiler made the existing binaries. The upstream
`go.mod` at the pinned commit requires Go 1.26.3 and fixes its module versions.
Automatic toolchain downloads are disabled. `GOPROXY=off` and `GOSUMDB=off` are
the defaults, so offline builds need the pinned checkout and already populated,
trusted module cache. A missing module is a prerequisite failure, not permission
to fetch arbitrary dependencies. To deliberately acquire upstream source online,
omit `USQUE_SOURCE`; the script clones `v4.2.1` and checks the exact commit.
Network-enabled dependency acquisition requires an explicit `GOPROXY` policy.

The default output is `build/warp-reproduction` (`OUT` overrides it). Comparison
fails nonzero for any differing helper while preserving candidates and evidence.
Only an explicit `OUT=resources/warp ./scripts/build-warp-helper.sh --write`
replaces the supplied binaries and manifest; review the differences first.
No generated helper is executed. The recipe sets `SOURCE_DATE_EPOCH` from the
pinned commit timestamp unless explicitly supplied, fixes CPU levels and disables
CGO, user Go flags/workspaces and VCS stamping, and builds with
`-mod=readonly -trimpath -buildvcs=false -ldflags='-s -w -buildid='`.

`build-provenance.txt` records the upstream commit/tree and SHA256 of the
unmodified source `git archive`, local patch, recipe, `go.mod` and `go.sum`, plus
the selected epoch, flags, compiler/host settings, Git/Bash versions, module list,
embedded Go build information and comparison result. `sha256.txt` hashes exactly
the three named outputs, never the patch via an `usque-*` glob. Archive hash
comparison also requires the recorded Git version. These controls improve future
repeatability; they do not prove historical byte equivalence.

On 9 November 2026 all three supplied files matched `sha256.txt`; no patched
source rebuild or match was demonstrated. In particular the new build flags may
produce different bytes from the supplied helpers. Do not replace that manifest
merely to make a reproduction check pass. The exact public source inspected was
https://github.com/Diniboy1123/usque/tree/6aa03fc97d12848dce34eedbd187fb1077b5d1ea
and its module declaration was read at
https://raw.githubusercontent.com/Diniboy1123/usque/6aa03fc97d12848dce34eedbd187fb1077b5d1ea/go.mod.

Packaged builds ship the binaries, license, patch, manifest and this README;
future rebuild provenance should accompany the corresponding new binaries only.
The rebuild
command is a maintainer tool that expects a source checkout (`resources/warp/`);
an installed package does not have that layout, even where `scripts/` is present.
`usque` is copyright (c) 2025 github.com/Diniboy1123 and is distributed under
the MIT license in `LICENSE`.

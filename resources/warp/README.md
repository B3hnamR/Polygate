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

From a source checkout, rebuild them with:

```sh
GOPROXY=https://proxy.golang.org,direct ./scripts/build-warp-helper.sh
```

The script needs Go 1.26.3 or newer and replaces the binaries and `sha256.txt`.
It clones tag `v4.2.1`, then refuses to build unless `HEAD` is the commit above,
so a moved or re-tagged release cannot silently change the bundled binaries.
Packaged builds ship the binaries, license, patch, and this README. The rebuild
command is a maintainer tool that expects a source checkout (`resources/warp/`);
an installed package does not have that layout, even where `scripts/` is present.
`usque` is copyright (c) 2025 github.com/Diniboy1123 and is distributed under
the MIT license in `LICENSE`.

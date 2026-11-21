# WireGuard (imported configs) client

Polygate's WireGuard route runs **wireproxy-awg** v1.0.18, unmodified, once per imported configuration. wireproxy-awg is a fork of
wireproxy that adds AmneziaWG 1.0–3.1 support while keeping wireproxy's userspace design: the tunnel lives inside the process and is
offered as a local SOCKS5 port on 127.0.0.1. It adds no network adapter and changes no route, DNS or firewall rule, so only the gateway's
own requests use it.

- Source: https://github.com/artem-russkikh/wireproxy-awg (release v1.0.18)
- Licence: ISC (see LICENSE)
- Files: `wireproxy-awg-windows-amd64.exe`, `wireproxy-awg-linux-amd64`, `wireproxy-awg-linux-arm64`, each the `wireproxy.exe` or `wireproxy`
  binary from that release's `wireproxy_<os>_<arch>.tar.gz`, checked against the release's `checksums.txt`. `sha256.txt` lists the files as shipped.

Polygate writes each imported config and a small wrapper (`WGConfig = <config>`, `[Socks5] BindAddress = 127.0.0.1:<port>`) to its own
data folder only while the client starts, and deletes them once the tunnel is up. The wrapper leaves the imported `[Interface]` and
`[Peer]` sections untouched, so AmneziaWG fields (`Jc`, `Jmin`, `Jmax`, `S1`–`S4`, `H1`–`H4`, `I1`–`I5`, `HeaderProtectionKey`) are
passed through exactly as written.

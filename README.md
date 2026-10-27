<p align="center"><img src="assets/logo.svg" alt="Polygate" width="112"></p>

<h1 align="center">Polygate</h1>

<p align="center"><b>One gateway for free AI models.</b><br>
Point any OpenAI- or Anthropic-compatible tool at Polygate and it picks a working free model for you,<br>
switches when one is busy, and can send its traffic through WARP, proxies or relays when a provider limits an address.</p>

---

## What it is

Polygate runs on your computer (Windows app) or on a server (Linux service or Docker) and gives you **one local endpoint** that speaks three
protocols: OpenAI Chat Completions, OpenAI Responses and Anthropic Messages. Behind that endpoint it uses free model providers, tracks which models
are working, and keeps going when one is rate-limited.

- **Free providers built in:** **OpenCode Free** and **Kilo Free** (about 16 free chat models). You can add any OpenAI-compatible API, or a real OpenCode server.
- **It picks for you.** Ask for `auto`, `auto:smart` or `auto:fast`, or name an exact model. A model that fails rests for a while and the next one takes over.
- **Several ways out to the internet.** Direct, HTTP/SOCKS proxies, built-in Cloudflare WARP, a proxy pool that is tested with real requests, and one-click relays on Vercel, Netlify and Cloudflare.
- **Per-key control.** Give each client its own API key with its own concurrency, requests-per-minute, tokens-per-minute, token budget, expiry and model allow-list.
- **A dashboard** to see what is happening: models, providers, routes, a Playground, and a request log that never stores what you typed.
- **HTTPS built in** on a server: automatic certificates for a domain or for the server's IP address, or your own certificate. No nginx or Caddy needed.

> Free tiers change and have limits. Polygate shows you what each provider is doing; it does not make a limit go away. Please follow each provider's terms.

## Contents

[Install](#install) · [Use it](#use-it) · [Providers](#providers) · [Network routes and relays](#network-routes-and-relays) · [HTTPS and domains](#https-and-domains) ·
[Managing a server](#managing-a-server) · [Settings](#settings) · [Security](#security) · [Troubleshooting](#troubleshooting) · [Development](#development)

---

## Install

### Windows

1. Download `Polygate-<version>-Windows-x64.exe` from the [Releases](../../releases) page (and check it against the `.sha256` file next to it).
2. Run it. It is a portable app, so nothing is installed. Windows may show a SmartScreen warning because the app is not code-signed yet: choose *More info → Run anyway*.
3. The dashboard opens inside the app. Your data is kept in `%LOCALAPPDATA%\Polygate`.

### Linux server (Ubuntu, Debian, Fedora, RHEL family, Arch, openSUSE; x86-64 or ARM64)

```bash
curl -fsSL https://raw.githubusercontent.com/B3hnamR/Polygate/main/install.sh -o install.sh
sudo bash install.sh --check      # optional: looks at the machine, changes nothing
sudo bash install.sh              # guided install
```

The installer opens with the Polygate banner and waits for you to press Enter. Then it checks the machine and installs what is missing in one quiet step (details go to `/var/log/polygate-install.log`; only problems are shown), asks how you want to open the dashboard, shows a short summary and asks once more before it installs. It needs systemd and glibc (Alpine and containers without systemd should use Docker). When it finishes, run `polygate` any time to open the manager.

**What it checks:** your Linux version and CPU, free disk space and memory, the clock, internet access, which tools are missing (it installs only those, and nothing is upgraded), whether ports 80 and 443 are already used and by which program, and whether anything on the machine would clash with the names it uses.

**It does not disturb your other services.** It never stops, restarts or edits another service, and it never changes your firewall. It only creates `/opt/polygate`, `/etc/polygate`, `/var/lib/polygate`, a `polygate` system user, `polygate.service` and the `polygate` command. If any of those names already belong to something else, it stops and changes nothing.

**It asks how you want to open the dashboard:**

| Choice | What you get | Needs |
|---|---|---|
| A domain name, with automatic HTTPS | `https://your.domain/polygate/` with a free Let's Encrypt certificate that renews itself | the domain points at the server; ports 80 and 443 free |
| The server's IP address, with automatic HTTPS | `https://1.2.3.4/polygate/` with a free short-lived certificate that renews itself | a public IPv4 address; ports 80 and 443 free |
| Behind the web server I already run | Polygate listens on `127.0.0.1` only; a ready-made nginx and Caddy snippet is shown | your own web server |
| My own certificate files | HTTPS with your certificate, on port 443 or another port you choose | certificate and key (PEM) |
| No HTTPS | listens on `127.0.0.1` only; open it through an SSH tunnel | nothing |

Automatic HTTPS needs ports 80 and 443 for good (80 for renewals and the redirect, 443 for the dashboard). If another program already holds them,
the installer says which one and shows the command to stop it permanently, or you pick *behind the web server I already run* and nothing is stopped.
If a firewall is active it only prints the commands you may want to run; open the same ports in your hosting provider's panel if it has its own firewall.

**Without questions** (for scripts), anything you do not give takes the safe default (local only):

```bash
sudo bash install.sh --yes --https domain --domain panel.example.com --email you@example.com
sudo bash install.sh --yes --https ip
sudo bash install.sh --yes --https proxy --domain panel.example.com
sudo bash install.sh --yes --https custom --cert fullchain.pem --key privkey.pem --https-port 8443
sudo bash install.sh --update      # newer release, keeps your data, settings and certificates
```

`bash install.sh --help` lists every option. The dashboard is served at `/polygate/` (set `POLYGATE_DASHBOARD_PATH` to another path, or to an empty value for the root), so on a shared domain only that one path belongs to Polygate. The password is shown once at the end and kept in `/var/lib/polygate/admin-password.txt`.

### Docker

```bash
docker compose up -d                                                  # dashboard on 127.0.0.1:4317 only
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d   # also publishes 80 and 443 for built-in HTTPS
```

By default only `127.0.0.1:4317` is published, so it cannot clash with a web server on the host. Set `POLYGATE_ADMIN_PASSWORD` in your environment to choose the dashboard password.

### From source

```bash
npm install
bun run dev          # dashboard with live reload
bun run dist         # Windows portable app (needs the pinned Bun runtime, see scripts/fetch-bun.py)
bash scripts/build-linux.sh amd64   # Linux package (or arm64)
```

---

## Use it

Open the dashboard, copy the **address** and an **API key** from the Overview page, and give them to your tool.

| | |
|---|---|
| Base URL | `http://127.0.0.1:<port>/v1` on your computer, or `https://your.domain/polygate/v1` on a server (`/v1` also works at the root) |
| API key | one of the keys on the Overview page (they start with `pg_`) |
| OpenAI Chat | `POST /v1/chat/completions` |
| OpenAI Responses | `POST /v1/responses` |
| Anthropic Messages | `POST /v1/messages` (send the key as `x-api-key` or as a Bearer token) |
| Model list | `GET /v1/models` |

```bash
curl http://127.0.0.1:4317/v1/chat/completions \
  -H "Authorization: Bearer pg_your_key" -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Say hello"}],"stream":true}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:4317/v1", api_key="pg_your_key")
print(client.chat.completions.create(model="auto", messages=[{"role": "user", "content": "Hi"}]).choices[0].message.content)
```

**Choosing a model**

| `model` | Meaning |
|---|---|
| `auto` | the best working model right now, with automatic fallback to the next two |
| `auto:smart` | prefers reasoning and larger models |
| `auto:fast` | prefers the models that answered fastest |
| `kilo/kilo-auto/free`, `opencode/<name>` | an exact model: the provider, then its model id (see `/v1/models`) |

Your client's key is never sent to a provider, tool calls and streaming work as the client expects, and each key can be limited on the Overview page.

---

## Providers

| Provider | What it is | Good to know |
|---|---|---|
| **OpenCode Free** | built in | OpenCode limits each network address per day. When an address is used up, Polygate moves to another exit if you have one, and says when the limit resets. |
| **Kilo Free** | built in; every model Kilo marks free, no account needed | Kilo limits anonymous use per network address. When that happens all Kilo models rest for 30 minutes (the answer says so and carries `Retry-After`). A single busy model rests for 2 minutes while the others keep working. You can save a Kilo API key on its row. Kilo models rank behind OpenCode's in `auto` and take over when OpenCode's are resting. |
| **OpenAI-compatible** | add any endpoint that has `/v1/chat/completions` | needs a base URL and, usually, a key |
| **OpenCode server** | add your own OpenCode server | text conversation only |

Built-in providers can be switched off but not deleted. A model's priority and score can be changed on the Models page. Models are not probed in the
background by default (a probe is a real request that uses up allowance); press *Check* on a model to test it.

## Network routes and relays

A *route* is the path a request takes to the provider. Pick one on the Routing page, and give a provider its own route if it needs one.

- **Direct**: your own connection.
- **HTTP / SOCKS proxy**: your own proxy, or the **verified proxy pool**: Polygate downloads public lists, tests them with real model requests, and keeps the ones that work.
- **Cloudflare WARP**: a built-in WireGuard tunnel (it downloads `wireproxy` on request and checks its checksum). It changes nothing on the machine: no network interface, route, DNS or firewall rule, only a local SOCKS port on `127.0.0.1` that Polygate's own requests use. If another program already uses that port (Cloudflare's own `warp-cli` and some xray setups use 40000), Polygate picks the next free one and never touches the other program. It needs outbound UDP to Cloudflare; some hosting networks block it.
- **Relays**: one click on the Relays page deploys a small forwarding function to your own Vercel, Netlify or Cloudflare account. The platform token is used once and is not stored.

| Relay | OpenCode Free | Kilo |
|---|---|---|
| Vercel (Bun runtime) | yes, streams | yes |
| Netlify | yes, answers arrive in one piece (30 s limit) | yes |
| Cloudflare Worker | no (OpenCode refuses its TLS handshake) | yes, streams |

Every relay has its own access token and forwards only to the hosts it is allowed to (`opencode.ai`, `models.opencode.ai`, `api.kilo.ai`; the Cloudflare one only Kilo).
Press **Test** on any route to send a real request through it with the provider of your choice.
When a route's exit is used up, Polygate moves to another healthy exit if you allow it. Rotation is off by default.

---

## HTTPS and domains

On a server Polygate can serve HTTPS itself. The Linux installer sets it up, or later run:

```bash
sudo polygate https domain panel.example.com you@example.com   # certificate for a domain
sudo polygate https ip                                          # short-lived certificate for the server's IP
sudo polygate https custom fullchain.pem privkey.pem            # your own certificate
sudo polygate https status
```

Certificates come from Let's Encrypt, renew by themselves, and need the validation request to reach **port 80**. Polygate keeps ports 80 and 443 while this is on,
so use *behind my web server* (`POLYGATE_TRUST_PROXY=1`, `POLYGATE_COOKIE_SECURE=1`, `POLYGATE_ALLOWED_HOSTS=your.domain`) if something else needs them.
The installer writes a ready nginx and Caddy snippet to `/etc/polygate/proxy-example.conf`.

## Managing a server

Run **`polygate`** for the manager: the banner, whether the service is running, the dashboard address, and a menu.

```text
 1  Dashboard address and password      6  HTTPS and certificate (domain, IP address, your own files, renew, off)
 2  Health check                        7  Change the dashboard password
 3  Live logs                           8  Update Polygate
 4  Restart (or Start)                  9  Uninstall (keep my data, or remove everything; you type "delete")
 5  Stop                                0  Exit
```

Every menu action is also a command, for scripts:

```text
sudo polygate info | status | doctor | version | start | stop | restart | logs
sudo polygate password [--stdin]       # new dashboard password (random unless --stdin)
sudo polygate https status | domain NAME [EMAIL] | ip [ADDRESS] [EMAIL] | custom CERT KEY | renew | disable
sudo polygate update                   # newer release, data kept
sudo polygate uninstall --yes [--purge]   # removes the program; --purge also removes data and the user
```

`polygate doctor` explains in plain words whether the service, HTTPS and the catalog are healthy. Files: program in `/opt/polygate`, settings in
`/etc/polygate/polygate.env`, data in `/var/lib/polygate`, installer log in `/var/log/polygate-install.log`.

## Settings

Most things are changed in the dashboard. A server reads these environment variables (the installer writes them to `/etc/polygate/polygate.env`):

| Variable | Meaning | Default |
|---|---|---|
| `POLYGATE_PORT` | dashboard and API port | `4317` (the installer picks a free random one) |
| `POLYGATE_HOST` | address to listen on | `127.0.0.1` |
| `POLYGATE_DASHBOARD_PATH` | serve the dashboard and the API under this path, e.g. `/polygate`, so a reverse proxy can forward just that path (the root only redirects to it) | empty (the root); the Linux installer sets `/polygate` |
| `POLYGATE_STATE` | where data is kept | per user (`%LOCALAPPDATA%\Polygate\state`, `~/.local/state/polygate`) |
| `POLYGATE_ADMIN_PASSWORD` | dashboard password, 12 or more characters (only used the first time) | a random one is generated |
| `POLYGATE_ALLOWED_HOSTS` | names the dashboard answers to, comma separated (`*` for any) | loopback names and the certificate's name |
| `POLYGATE_TRUST_PROXY` | how many reverse proxies sit in front (reads the client address from `X-Forwarded-For`) | `0` |
| `POLYGATE_COOKIE_SECURE` | `1`, `0` or `auto` | `auto` |
| `POLYGATE_HTTP_PORT`, `POLYGATE_HTTPS_PORT` | ports for built-in HTTPS | `80`, `443` |
| `POLYGATE_HTTPS_STAGING` | `1` uses Let's Encrypt's test servers while you experiment | off |

## Security

- Settings, provider keys and relay tokens are stored encrypted on disk; the key file is private to the service user. Client API keys are never forwarded to a provider.
- The request log records sizes, status and timing, not what you typed or what came back.
- The dashboard needs a password and locks out guessing; API keys can be limited per key and expire.
- The Linux service runs as an unprivileged user with systemd hardening (no new privileges, read-only system, private temp folder) and is a polite neighbour (low priority, task limit).
- Releases are verified with SHA-256 before they are unpacked, and the installer refuses archives with unsafe paths or links.
- Report security problems privately to the repository owner rather than in a public issue.

## Troubleshooting

| You see | What it means and what to do |
|---|---|
| `Unrecognized Host header` | the dashboard was opened with a name it does not know. Set `POLYGATE_ALLOWED_HOSTS` to that name, or use the HTTPS name. |
| A model says *paused* or answers 429 | the provider limited it. The message says when it comes back. Use `auto`, or add another route. |
| OpenCode: *daily allowance used up* | that network address has used OpenCode's daily allowance (it resets at 00:00 UTC). Add WARP, a proxy or a relay on the Routing page. |
| Kilo: *stopped answering from this network address* | Kilo's anonymous limit for the address. All Kilo models rest for 30 minutes and then try again. A Kilo key on its row removes the anonymous limit. |
| WARP: *none of the Cloudflare WARP addresses answered* | this network drops the traffic WARP needs (outbound UDP to Cloudflare; some hosting providers block it). Try another network, or use a proxy or relay route instead. |
| HTTPS fails at the certificate step | check that the domain points at the server, that ports 80 and 443 reach it (also in your hosting provider's firewall), and that nothing else uses them. Run `sudo polygate https status` for the exact reason. |
| The Linux installer stops with *problems to fix* | it lists them and changed nothing. Fix them and run it again, or use `--check` to look first. |
| Nothing works after an update | `polygate doctor`, then `polygate logs`. A failed update puts the previous release back by itself. |

## Development

```bash
npm install
bun run check        # type check
bun test tests       # the test suite
bun run dev          # dashboard + gateway with live reload
```

`backend/` is the gateway (Bun, no framework), `src/` the dashboard (React), `desktop/` the Windows app (Electron), `relays/` the relay templates,
`install.sh` and `install/` the Linux installer and the `polygate` command, `vendor/` code reused from other open projects (see below).
Releases are built by GitHub Actions: pushing a `v*` tag builds the Windows app and the Linux packages and prepares a draft release.

## License

MIT, see [LICENSE](LICENSE). Third-party components keep their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

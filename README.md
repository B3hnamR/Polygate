# Polygate

A Windows desktop and Linux/VPS model gateway with an adaptive OpenCode Free provider, Chat/Responses/Anthropic compatibility, built-in WARP tunnels, and a proxy pool that is checked with real requests.

The gateway separates provider execution, protocol conversion, admission, model state and network routes. Direct, HTTP/SOCKS, WARP and header-contract relays are supported. Rotation is explicit and off by default. Xray and managed Tor are excluded.

```powershell
npm.cmd install
bun run dev
```

Windows packaging: `bun run dist`. The packaged app includes the gateway bundle, the dashboard and the Bun runtime that runs the gateway. Copy the live URL/key from Overview into a compatible coding client, refresh the model catalog, and choose a model or `auto`.

Linux/VPS: `install.sh` installs the service, and `polygate` is the management CLI (`polygate status | start | stop | restart | logs | password | settings | https | update`). Docker: `docker compose up -d`. Release packaging: `bash scripts/build-linux.sh amd64` or `arm64`.

Model quotas and upstream availability still apply. Live provider/relay/WARP acceptance is distinct from local functional tests.

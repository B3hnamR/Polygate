# Polygate

A Windows desktop and Linux/VPS model gateway with built-in OpenCode Free and Kilo free-model providers, Chat/Responses/Anthropic compatibility, built-in WARP tunnels, and a proxy pool that is checked with real requests.

The gateway separates provider execution, protocol conversion, admission, model state and network routes. Direct, HTTP/SOCKS, WARP and header-contract relays are supported. Rotation is explicit and off by default. Xray and managed Tor are excluded.

```powershell
npm.cmd install
bun run dev
```

**Kilo free models.** Kilo is a built-in provider next to OpenCode Free: it lists Kilo Gateway's free chat models (those the catalog marks `isFree`), needs no account, and ranks behind OpenCode Free in `auto`. Kilo limits anonymous use per network address; when that limit is reached, Polygate rests all Kilo models for 30 minutes and answers with a clear message and `Retry-After`. A Kilo API key can be saved on the provider's row. A single busy model rests for a short time while the others keep working.

Windows packaging: `bun run dist`. The packaged app includes the gateway bundle, the dashboard and the Bun runtime that runs the gateway. Copy the live URL/key from Overview into a compatible coding client, refresh the model catalog, and choose a model or `auto`.

Linux/VPS: `install.sh` installs the service, and `polygate` is the management CLI (`polygate status | start | stop | restart | logs | password | settings | https | update`). Docker: `docker compose up -d`. Release packaging: `bash scripts/build-linux.sh amd64` or `arm64`.

Model quotas and upstream availability still apply. Live provider/relay/WARP acceptance is distinct from local functional tests.

## License

MIT, see LICENSE. Third-party components keep their own licenses; see THIRD_PARTY_NOTICES.md.

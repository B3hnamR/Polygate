# Relay templates

Vercel and Netlify relays are offered. A relay is the TLS client OpenCode Free sees, and the Free tier accepts a client only if its handshake lists Bun's 17 cipher suites in Bun's order. `vercel-bun/` runs on Bun and has that handshake by default; the same file also runs on Vercel's Node runtime (the Runtime choice in the dialog, or leave `bunVersion` out of `vercel.json`), where it sets the list itself and still streams (tested: a 48 s, 15,633-character answer). `netlify-relay.js` runs on Node and sets the list itself (`https.request({ ciphers })`). A function that cannot set its cipher list cannot work: a Cloudflare Worker was refused (429) and Deno Deploy has no such control, so their deployers and templates were removed on 26 October 2026. The Netlify relay passed real chat requests from a deployed Netlify site; Netlify stops a function after 30 seconds, so an answer that takes longer fails.

**Netlify relay (`netlify-relay.js`).** Reports `x-relay-runtime: node-bun-ciphers <version>`, which Polygate trusts like `bun`. Answers are buffered (Lambda response model), so streamed replies arrive in one piece and a function is stopped after 30 seconds; there is no instance rotation or control header. Environment: `POLYGATE_RELAY_TOKEN` (required), `POLYGATE_ALLOWED_HOSTS` (defaults to the OpenCode hosts).

**Deploying from Polygate:** the Relays page deploys to Vercel or Netlify. Pick the platform and paste its API token. For Vercel, Polygate deploys `vercel-bun/` on the Bun runtime (or Node, a choice in the dialog); for Netlify, it deploys `netlify-relay.js` on Node. It generates the relay's access token, verifies the relay and adds it as a route. The platform token is used for that one call and is not stored. For Vercel, the dialog can read the account plan and offers further regions one at a time; each region is its own Vercel project.

Headers: `x-relay-target` is the original origin, `x-relay-path` is the original path/query, and `x-relay-key` is the relay's access token. Status and body must survive forwarding, including SSE errors. A reachability test does not prove that an upstream provider accepts the relay's runtime/TLS identity, which is why Polygate's Test button also sends a chat request.

## Header hygiene (added 25 October 2026)

The hosting platform adds headers about the real caller (their IP, city and coordinates, TLS fingerprint, even a Vercel account token). A relay that
forwards everything passes those to the provider. The templates here drop them (the `IDENTITY` pattern at the top of each file) and keep the headers the
provider needs. Relays deployed from earlier versions keep forwarding them until you redeploy from these files.

## Bun relay for Vercel (`vercel-bun/`)

`vercel-bun/` runs as a Vercel Function on the Bun runtime (`bunVersion` in `vercel.json`), forwards only to `opencode.ai` and `models.opencode.ai`,
requires the `x-relay-key` token, and answers with `x-relay-runtime: bun <version>`, which Polygate uses to judge a 429 from it like a direct connection.

```bash
cd relays/vercel-bun
vercel deploy --prod --env POLYGATE_RELAY_TOKEN=<a long random value> --regions fra1
```

Enter the deployment URL and the same value as the Relay access token in Polygate. Change `--regions` for a different outbound address.


// Polygate relay for Netlify Functions (Node runtime). Deployed by the Relays page; also usable by hand.
// OpenCode Free accepts a TLS client only if its ClientHello lists Bun's 17 cipher suites in Bun's order.
// Node's default list is refused, so this relay calls node:https with that exact list instead of fetch. Nothing else in the handshake matters.
// Needs the environment variable POLYGATE_RELAY_TOKEN. POLYGATE_ALLOWED_HOSTS (comma separated) defaults to the OpenCode and Kilo hosts.
const crypto = require("node:crypto");
const https = require("node:https");

const BUN_CIPHERS = "TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-ECDSA-AES128-SHA:ECDHE-RSA-AES128-SHA:ECDHE-ECDSA-AES256-SHA:ECDHE-RSA-AES256-SHA:AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA:AES256-SHA";
// Polygate trusts a 429 from a relay that says this, the same as a direct Bun connection (backend/exhaustion.ts, backend/transport.ts).
const RUNTIME = "node-bun-ciphers " + process.versions.node;

// Headers the hosting platform adds about the caller. Left in, they tell the provider who is really calling: the caller's IP (Forwarded,
// X-Forwarded-For, Cf-Connecting-Ip, X-Vercel-Proxied-For), city and coordinates (X-Vercel-Ip-*), TLS fingerprint (X-Vercel-Ja4-Digest) and
// even a Vercel account token (X-Vercel-Oidc-Token). A relay exists to move the address, so these are dropped.
const IDENTITY = /^(forwarded|x-forwarded-.*|x-real-ip|true-client-ip|client-ip|cf-.*|cdn-loop|x-vercel-.*|x-nf-.*|x-amzn-.*|x-middleware-subrequest|x-invocation-id|logs-url|via|x-envoy-.*|fly-.*|x-country|x-azure-.*)$/i;
const DROP = /^(x-relay-.*|host|content-length|accept-encoding|connection|transfer-encoding)$/i;
const json = (statusCode, body) => ({ statusCode, headers: { "content-type": "application/json", "x-relay-runtime": RUNTIME }, body: JSON.stringify(body) });
// Both keys are hashed first, so the comparison takes the same time whatever their length or common prefix.
const sameKey = (given, required) => crypto.timingSafeEqual(crypto.createHash("sha256").update(String(given ?? "")).digest(), crypto.createHash("sha256").update(required).digest());

exports.handler = async (event) => {
  const headers = {};
  for (const [k, v] of Object.entries(event.headers || {})) headers[k.toLowerCase()] = v;
  // POLYGATE_RELAY_TOKEN is required; x-relay-key is never forwarded upstream.
  const required = process.env.POLYGATE_RELAY_TOKEN;
  if (!required) return json(503, { error: "Set POLYGATE_RELAY_TOKEN on the function" });
  if (!sameKey(headers["x-relay-key"], required)) return json(401, { error: "Unauthorized relay request" });
  const target = headers["x-relay-target"];
  const relayPath = headers["x-relay-path"] || "/";
  if (!target) return json(400, { error: "Missing x-relay-target header" });
  const allowed = (process.env.POLYGATE_ALLOWED_HOSTS || "opencode.ai,models.opencode.ai,api.kilo.ai").split(",").map((x) => x.trim());
  let url;
  try {
    const origin = new URL(target);
    if (origin.protocol !== "https:" || origin.username || origin.password || !relayPath.startsWith("/") || relayPath.startsWith("//") || !allowed.includes(origin.hostname)) throw new Error();
    url = new URL(origin.origin + relayPath);
  } catch {
    return json(403, { error: "Target is not in the HTTPS host allowlist" });
  }
  const forward = {};
  for (const [k, v] of Object.entries(headers)) if (!DROP.test(k) && !IDENTITY.test(k)) forward[k] = v;
  const hasBody = event.httpMethod !== "GET" && event.httpMethod !== "HEAD" && event.body;
  const body = hasBody ? (event.isBase64Encoded ? Buffer.from(event.body, "base64") : Buffer.from(event.body)) : undefined;
  if (body) forward["content-length"] = String(body.length);

  return new Promise((resolve) => {
    const req = https.request({ host: url.hostname, port: url.port || 443, path: url.pathname + url.search, method: event.httpMethod, headers: { host: url.host, ...forward }, ciphers: BUN_CIPHERS, agent: false, timeout: 25000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("error", (e) => resolve(json(502, { error: e.message || "Relay upstream read failed" })));
      res.on("end", () => {
        const out = { "x-relay-runtime": RUNTIME };
        for (const [k, v] of Object.entries(res.headers)) if (!DROP.test(k) && k !== "content-encoding") out[k] = Array.isArray(v) ? v.join(", ") : v;
        const type = String(res.headers["content-type"] || "");
        const isText = /^(text\/|[^;]*json|[^;]*event-stream|[^;]*javascript|[^;]*xml|[^;]*urlencoded)/i.test(type);
        const raw = Buffer.concat(chunks);
        resolve({ statusCode: res.statusCode, headers: out, body: isText ? raw.toString("utf8") : raw.toString("base64"), isBase64Encoded: !isText });
      });
    });
    req.on("timeout", () => req.destroy(new Error("Relay upstream timed out")));
    req.on("error", (e) => resolve(json(502, { error: e.message || "Relay upstream failed" })));
    req.end(body);
  });
};

// Polygate relay for Cloudflare Workers. Deployed by the Relays page; also usable by hand (wrangler deploy, with the secret RELAY_TOKEN).
// Kilo Gateway does not look at the caller's TLS handshake, so a Worker can carry its requests. OpenCode Free does, and refused a Worker, so Polygate never sends it OpenCode Free
// traffic through one. Any public HTTPS host can be reached (the variable POLYGATE_ALLOWED_HOSTS, comma separated, can narrow that).
// RELAY_TOKEN is required, so this is not an open proxy.
const DEFAULT_HOSTS = '*';
// Addresses and local names are never allowed, so the Worker cannot be pointed at a private network; "*.example.com" matches subdomains.
const hostAllowed = (allowed, h) => !(/^[\d.]+$/.test(h) || h.includes(':') || h === 'localhost' || /\.(localhost|local|internal|lan)$/.test(h))
  && allowed.some((a) => a === '*' || a === h || (a.startsWith('*.') && h.endsWith(a.slice(1))));
// Headers the platform adds about the caller (their address, location, Cloudflare ray) and the relay's own control headers: none of them
// reach the provider.
const IDENTITY = /^(forwarded|x-forwarded-.*|x-real-ip|true-client-ip|client-ip|cf-.*|cdn-loop|x-vercel-.*|x-nf-.*|x-amzn-.*|x-middleware-subrequest|x-invocation-id|logs-url|via|x-envoy-.*|fly-.*|x-country|x-azure-.*)$/i;
const DROP = /^(x-relay-.*|host|content-length|connection|transfer-encoding)$/i;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-relay-runtime': 'cloudflare-worker' } });
// Both keys are hashed first, so the comparison takes the same time whatever their length or common prefix.
async function sameKey(given, required) {
  const digest = async (v) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(v ?? ''))));
  const [a, b] = await Promise.all([digest(given), digest(required)]);
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]; return diff === 0;
}
export default {
  async fetch(req, env) {
    const required = env.RELAY_TOKEN;
    if (!required || !(await sameKey(req.headers.get('x-relay-key'), required))) return json(401, { error: 'Unauthorized relay request' });
    // ping answers with the address this Worker sends from, without calling any provider.
    if (req.headers.get('x-relay-control') === 'ping') {
      const trace = await fetch('https://www.cloudflare.com/cdn-cgi/trace').then((r) => r.text()).catch(() => '');
      return json(200, { egress: (trace.match(/^ip=(.+)$/m) || [])[1] || '', runtime: 'cloudflare-worker' });
    }
    const target = req.headers.get('x-relay-target'); const path = req.headers.get('x-relay-path') || '/';
    if (!target) return json(400, { error: 'Missing x-relay-target header' });
    const allowed = String(env.POLYGATE_ALLOWED_HOSTS || DEFAULT_HOSTS).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    let url;
    try {
      const origin = new URL(target);
      if (origin.protocol !== 'https:' || origin.username || origin.password || !path.startsWith('/') || path.startsWith('//') || !hostAllowed(allowed, origin.hostname.toLowerCase())) throw new Error();
      url = new URL(origin.origin + path);
    } catch { return json(403, { error: 'Target host not allowed' }); }
    const headers = new Headers();
    for (const [k, v] of req.headers) if (!DROP.test(k) && !IDENTITY.test(k)) headers.set(k, v);
    let upstream;
    try { upstream = await fetch(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body, redirect: 'manual' }); }
    catch (e) { return json(502, { error: String((e && e.message) || e) }); }
    // The body streams through untouched; the platform recompresses it, so the upstream's encoding and length no longer apply.
    const out = new Headers(upstream.headers); out.delete('content-encoding'); out.delete('content-length'); out.set('x-relay-runtime', 'cloudflare-worker');
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};

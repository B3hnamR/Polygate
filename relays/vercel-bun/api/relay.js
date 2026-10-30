// Polygate relay for Vercel Functions. The OpenCode Free tier checks the TLS ClientHello of whoever connects: it accepts a client whose cipher-suite
// list is Bun's, in Bun's order. On the Bun runtime (vercel.json: bunVersion) fetch already sends that list. On
// Node the call is made with node:https and that list set explicitly, and the answer still streams. Any public HTTPS host can be reached (POLYGATE_ALLOWED_HOSTS can
// narrow that) and POLYGATE_RELAY_TOKEN is required, so this is not an open proxy.
import crypto from 'node:crypto';
import https from 'node:https';
import { Readable } from 'node:stream';
const BUN_CIPHERS = 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-ECDSA-AES128-SHA:ECDHE-RSA-AES128-SHA:ECDHE-ECDSA-AES256-SHA:ECDHE-RSA-AES256-SHA:AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA:AES256-SHA';
const isBun = typeof Bun !== 'undefined';
// The Node path of the outbound call: same arguments and result shape as fetch, but with the cipher list set and the body streamed both ways.
const nodeSend = (url, { method, headers, body }) => new Promise((resolve, reject) => {
  const h = {}; for (const [k, v] of headers) if (!/^(host|connection|accept-encoding|transfer-encoding)$/i.test(k)) h[k] = v;
  const out = https.request({ host: url.hostname, port: url.port || 443, path: url.pathname + url.search, method, headers: { host: url.host, ...h }, ciphers: BUN_CIPHERS, agent: false }, res => {
    const rh = new Headers(); for (const [k, v] of Object.entries(res.headers)) { if (Array.isArray(v)) v.forEach(x => rh.append(k, x)); else if (v != null) rh.set(k, String(v)); }
    resolve(new Response([101, 204, 205, 304].includes(res.statusCode) ? null : Readable.toWeb(res), { status: res.statusCode, headers: rh }));
  });
  out.on('error', reject);
  if (body) Readable.fromWeb(body).on('error', e => out.destroy(e)).pipe(out); else out.end();
});
const send = (url, init) => isBun ? fetch(url, init) : nodeSend(url, init);
const ALLOWED = (process.env.POLYGATE_ALLOWED_HOSTS || '*').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
// Any public HTTPS host is allowed unless POLYGATE_ALLOWED_HOSTS narrows it (comma separated; "*.example.com" matches its subdomains).
// Addresses and local names never are, so the relay cannot be pointed at a private network.
const hostAllowed = (h) => !(/^[\d.]+$/.test(h) || h.includes(':') || h === 'localhost' || /\.(localhost|local|internal|lan)$/.test(h))
  && ALLOWED.some((a) => a === '*' || a === h || (a.startsWith('*.') && h.endsWith(a.slice(1))));
// Headers the platform adds about the caller; dropping them keeps the caller's address, location and account token away from the provider.
const IDENTITY = /^(forwarded|x-forwarded-.*|x-real-ip|true-client-ip|client-ip|cf-.*|cdn-loop|x-vercel-.*|x-nf-.*|x-amzn-.*|x-middleware-subrequest|x-invocation-id|logs-url|via|x-envoy-.*|fly-.*|x-country|x-azure-.*|x-relay-.*|host|connection|content-length)$/i;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// Both keys are hashed first, so the comparison takes the same time whatever their length or common prefix.
const sameKey = (given, required) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(given ?? '')).digest(), crypto.createHash('sha256').update(required).digest());
// Polygate trusts a 429 from a relay that reports one of these like a direct Bun connection (backend/transport.ts).
const runtime = () => isBun ? 'bun ' + Bun.version : 'node-bun-ciphers ' + process.versions.node;
// A function instance sends from one address, and concurrent requests are served by different instances with different addresses. Each answer
// says which address served it (x-relay-egress), so Polygate can tell when the address in use is used up and ask for another instance.
const instance = Math.random().toString(36).slice(2, 8);
let egress;
const egressIp = () => egress ||= fetch('https://opencode.ai/cdn-cgi/trace', { signal: AbortSignal.timeout(5000) }).then(r => r.text()).then(t => { const ip = (t.match(/^ip=(.+)$/m) || [])[1] || ''; if (!ip) egress = undefined; return ip; }).catch(() => { egress = undefined; return ''; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
// recycle ends this instance once the requests it is serving have finished (or after 15 s), so the next request starts a new instance with a new address.
let inflight = 0, recycling = false, backstop, leaving;
// One exit path: whichever fires first (idle or the 15 s backstop) cancels the other, so a stale timer never ends a later process.
// recycling is cleared after the call: on a platform process.exit does not return, and where it does (a test) no later request exits.
const leave = () => { clearTimeout(backstop); clearTimeout(leaving); backstop = leaving = undefined; process.exit(0); recycling = false; };
const finish = () => { inflight = Math.max(0, inflight - 1); leaveIfIdle(); };
const leaveIfIdle = () => { if (recycling && inflight === 0 && !leaving) leaving = setTimeout(leave, 150); };
export default {
  async fetch(req) {
    const required = process.env.POLYGATE_RELAY_TOKEN;
    if (!required || !sameKey(req.headers.get('x-relay-key'), required)) return json(401, { error: 'Unauthorized relay request' });
    // Controls: ping reports the instance; recycle answers and then ends this instance (after its running requests), so the next request
    // starts a new one; hold only keeps this instance busy.
    const control = req.headers.get('x-relay-control');
    if (control === 'ping' || control === 'hold' || control === 'recycle') {
      if (control === 'hold') await sleep(Math.min(Math.max(Number(req.headers.get('x-relay-hold')) || 3000, 0), 10000));
      const body = { instance, egress: await egressIp(), runtime: runtime(), control };
      if (control === 'recycle') { if (!recycling) { recycling = true; backstop = setTimeout(leave, 15000); } leaveIfIdle(); }
      return json(200, body);
    }
    // Polygate lists the addresses it knows are used up; an instance on one of them answers at once, without calling OpenCode.
    const avoid = (req.headers.get('x-relay-avoid') || '').split(',').map(x => x.trim()).filter(Boolean);
    if (avoid.length && avoid.includes(await egressIp())) return new Response(JSON.stringify({ error: 'The address of this instance is used up', egress: await egressIp() }), { status: 409, headers: { 'content-type': 'application/json', 'x-relay-rotate': '1', 'x-relay-instance': instance, 'x-relay-egress': await egressIp(), 'x-relay-runtime': runtime() } });
    const target = req.headers.get('x-relay-target'); const path = req.headers.get('x-relay-path') || '/';
    if (!target) return json(400, { error: 'Missing x-relay-target header' });
    let url; try { url = new URL(target.replace(/\/$/, '') + path); } catch { return json(400, { error: 'Bad target' }); }
    if (url.protocol !== 'https:' || !hostAllowed(url.hostname.toLowerCase())) return json(403, { error: 'Target host not allowed' });
    const headers = new Headers(); for (const [k, v] of req.headers) if (!IDENTITY.test(k)) headers.set(k, v);
    inflight++; let handedOver = false;
    try {
      const r = await send(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body, duplex: 'half', redirect: 'manual' });
      const out = new Headers(r.headers); for (const h of ['content-encoding', 'content-length', 'transfer-encoding', 'connection']) out.delete(h);
      out.set('x-relay-runtime', runtime()); out.set('x-relay-instance', instance); out.set('x-relay-egress', await egressIp());
      if (!r.body) return new Response(null, { status: r.status, headers: out });
      handedOver = true; const reader = r.body.getReader(); let ended = false; const end = () => { if (!ended) { ended = true; finish(); } };
      return new Response(new ReadableStream({ async pull(c) { try { const { done, value } = await reader.read(); if (done) { c.close(); end(); } else c.enqueue(value); } catch (e) { end(); c.error(e); } }, cancel(why) { end(); return reader.cancel(why); } }), { status: r.status, headers: out });
    } catch (e) { return json(502, { error: String(e && e.message || e) }); }
    finally { if (!handedOver) finish(); }
  },
};

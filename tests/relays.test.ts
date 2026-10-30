import { afterEach, expect, test } from 'bun:test';
// The relay templates move the request's source address to the hosting platform's. Platforms add headers about the real caller; a relay
// that forwards them tells the provider who is calling. These tests run each template against a captured fetch.
const realFetch = globalThis.fetch; afterEach(() => { globalThis.fetch = realFetch; delete (globalThis as any).Deno; delete process.env.POLYGATE_RELAY_TOKEN; });
const KEEP = { authorization: 'Bearer public', 'content-type': 'application/json', accept: '*/*', 'user-agent': 'opencode/latest/2.1.4/cli', 'x-opencode-client': 'cli', 'x-opencode-session': 'ses_abc', 'x-session-id': 'ses_abc', traceparent: '00-aa-bb-01', b3: 'aa-bb-1-cc' };
const PLATFORM = { forwarded: 'for=198.51.100.10;host=r.example;proto=https', 'x-forwarded-for': '198.51.100.10', 'x-forwarded-host': 'r.example', 'x-real-ip': '198.51.100.10', 'cf-connecting-ip': '198.51.100.10', 'cf-ray': 'abc-FRA', 'cdn-loop': 'cloudflare; loops=1', 'x-vercel-proxied-for': '198.51.100.10', 'x-vercel-ip-city': 'Frankfurt', 'x-vercel-ip-latitude': '50.1', 'x-vercel-ja4-digest': 't13d', 'x-vercel-oidc-token': 'eyJ.secret.jwt', 'x-vercel-id': 'lhr1::x', 'x-nf-client-connection-ip': '198.51.100.10', 'x-amzn-trace-id': 'Root=1-x', 'x-middleware-subrequest': 'x', 'logs-url': 'http://logger.vercel', 'x-invocation-id': 'i', 'true-client-ip': '198.51.100.10', 'client-ip': '198.51.100.10', via: '1.1 vercel' };
const RELAY = { 'x-relay-target': 'https://opencode.ai', 'x-relay-path': '/inference/openai/v1/chat/completions', 'x-relay-key': 'secret' };
let seen: { url: string; headers: Headers } | undefined;
const capture = () => { seen = undefined; globalThis.fetch = (async (url: any, init: any) => { seen = { url: String(url), headers: new Headers(init?.headers) }; return new Response('ok'); }) as any; };
const check = () => {
  expect(seen!.url).toBe('https://opencode.ai/inference/openai/v1/chat/completions');
  for (const [k, v] of Object.entries(KEEP)) expect(seen!.headers.get(k)).toBe(v);
  for (const k of Object.keys(PLATFORM)) expect(seen!.headers.has(k)).toBe(false);
  for (const k of Object.keys(RELAY)) expect(seen!.headers.has(k)).toBe(false);
  expect(seen!.headers.has('host')).toBe(false);
};
const request = () => new Request('https://relay.example/', { method: 'POST', headers: { ...KEEP, ...PLATFORM, ...RELAY }, body: '{}' });

test('A header that only looks similar is not dropped', async () => {
  seen = undefined; const req = new Request('https://relay.example/', { method: 'POST', headers: { ...KEEP, ...RELAY, 'x-opencode-project': 'global', 'x-forwarding-note': 'keep', 'cfg-mode': 'keep' }, body: '{}' });
  globalThis.fetch = (async (url: any, init: any) => { if (String(url).endsWith('/cdn-cgi/trace')) return new Response('ip=203.0.113.7'); seen = { url: String(url), headers: new Headers(init?.headers) }; return new Response('ok'); }) as any;
  process.env.POLYGATE_RELAY_TOKEN = 'secret'; await (await (await import('../relays/vercel-bun/api/relay.js')).default.fetch(req)).text();
  expect(seen!.headers.get('x-opencode-project')).toBe('global'); expect(seen!.headers.get('x-forwarding-note')).toBe('keep'); expect(seen!.headers.get('cfg-mode')).toBe('keep');
});
test('The Vercel Bun template needs the token, reaches any public HTTPS host but nothing local, drops identity headers and reports its runtime', async () => {
  process.env.POLYGATE_RELAY_TOKEN = 'secret'; const { default: relay } = await import('../relays/vercel-bun/api/relay.js');
  expect((await relay.fetch(new Request('https://relay.example/', { method: 'POST', headers: { ...RELAY, 'x-relay-key': 'wrong' }, body: '{}' }))).status).toBe(401);
  expect((await relay.fetch(new Request('https://relay.example/', { method: 'POST', headers: { ...RELAY, 'x-relay-target': 'http://example.com' }, body: '{}' }))).status).toBe(403);
  // The relay looks up its own outbound address once (opencode.ai/cdn-cgi/trace) and reports it on every answer.
  globalThis.fetch = (async (url: any, init: any) => { if (String(url).endsWith('/cdn-cgi/trace')) return new Response(['fl=1', 'ip=203.0.113.7', 'loc=DE', ''].join(String.fromCharCode(10))); seen ={ url: String(url), headers: new Headers(init?.headers) }; return new Response('ok'); }) as any;
  const r = await relay.fetch(request()); check(); expect(r.headers.get('x-relay-runtime')).toMatch(/^bun /);
  await r.text(); // the instance counts a request as running until its answer has been read
  expect(r.headers.get('x-relay-egress')).toBe('203.0.113.7'); expect(r.headers.get('x-relay-instance')).toMatch(/^[a-z0-9]+$/);
  // Controls need the token, never reach OpenCode, and report the instance; recycle ends the instance after answering.
  const control = (name: string, key = 'secret') => relay.fetch(new Request('https://relay.example/', { headers: { 'x-relay-key': key, 'x-relay-control': name } }));
  expect((await control('ping', 'wrong')).status).toBe(401);
  seen = undefined; const ping: any = await (await control('ping')).json(); expect(ping).toMatchObject({ egress: '203.0.113.7', control: 'ping' }); expect(seen).toBeUndefined();
  // An instance on an address Polygate knows is used up answers 409 at once, without calling OpenCode.
  seen = undefined; const avoided = await relay.fetch(new Request('https://relay.example/', { method: 'POST', headers: { ...RELAY, 'x-relay-key': 'secret', 'x-relay-avoid': '198.51.100.1, 203.0.113.7' }, body: '{}' }));
  expect(avoided.status).toBe(409); expect(avoided.headers.get('x-relay-rotate')).toBe('1'); expect(avoided.headers.get('x-relay-egress')).toBe('203.0.113.7'); expect(seen).toBeUndefined();
  const realExit = process.exit; let exited = 0; (process as any).exit = () => { exited++; };
  try {
    expect(((await (await control('recycle')).json()) as any).control).toBe('recycle'); await new Promise(r => setTimeout(r, 250)); expect(exited).toBe(1);
    // The instance ends once: a later request must not schedule another exit, and the 15 s backstop is cancelled.
    await control('ping'); await (await relay.fetch(request())).text(); await new Promise(r => setTimeout(r, 250)); expect(exited).toBe(1);
  } finally { process.exit = realExit; }
});
test('The Netlify relay calls OpenCode over Node with Bun\'s cipher list, drops identity headers, keeps the answer intact and reports its runtime', async () => {
  process.env.POLYGATE_RELAY_TOKEN = 'secret';
  const https = (await import('node:https')).default as any; const { EventEmitter } = await import('node:events'); const real = https.request; let opts: any; let sent: any; let calls = 0;
  https.request = (o: any, cb: any) => { calls++; opts = o; const req: any = new EventEmitter(); req.destroy = () => {}; req.end = (b: any) => { sent = b; const res: any = new EventEmitter(); res.statusCode = 200; res.headers = { 'content-type': 'text/event-stream', 'content-encoding': 'gzip', 'x-up': '1' }; cb(res); res.emit('data', Buffer.from('data: hi\n\n')); res.emit('end'); }; return req; };
  try {
    const { handler } = (await import('node:module')).createRequire(import.meta.url)('../relays/netlify-relay.js?cjs');
    const event = (key: string, extra: Record<string, string> = {}) => ({ httpMethod: 'POST', body: '{}', isBase64Encoded: false, headers: { ...KEEP, ...PLATFORM, ...RELAY, 'accept-encoding': 'gzip', 'x-relay-key': key, ...extra } });
    const ok = await handler(event('secret'));
    expect(ok.statusCode).toBe(200); expect(ok.body).toBe('data: hi\n\n'); expect(ok.headers['x-relay-runtime']).toMatch(/^node-bun-ciphers \d/); expect(ok.headers['content-encoding']).toBeUndefined(); expect(ok.headers['x-up']).toBe('1');
    const suites = opts.ciphers.split(':'); expect(suites.length).toBe(17); expect(suites[0]).toBe('TLS_AES_128_GCM_SHA256'); expect(suites[3]).toBe('ECDHE-ECDSA-AES128-GCM-SHA256'); expect(suites.at(-1)).toBe('AES256-SHA');
    expect(opts.host).toBe('opencode.ai'); expect(opts.path).toBe('/inference/openai/v1/chat/completions'); expect(opts.headers.host).toBe('opencode.ai'); expect(String(sent)).toBe('{}'); expect(opts.headers['content-length']).toBe('2');
    for (const [k, v] of Object.entries(KEEP)) expect(opts.headers[k]).toBe(v);
    for (const k of [...Object.keys(PLATFORM), ...Object.keys(RELAY), 'accept-encoding']) expect(k in opts.headers).toBe(false);
    calls = 0; expect((await handler(event('wrong'))).statusCode).toBe(401); expect((await handler(event('secret', { 'x-relay-target': 'http://example.com' }))).statusCode).toBe(403); expect(calls).toBe(0);
  } finally { https.request = real; }
});

// The access key is compared as two SHA-256 digests with timingSafeEqual: the comparison time reveals neither a matching prefix nor the key's length.
const BAD_KEYS = ['wrong', 'x', 'secre', 'secrex', 'secret'.repeat(500), ''];
const spyOnCompare = async (run: () => Promise<void>) => {
  const crypto = (await import('node:crypto')).default as any; const real = crypto.timingSafeEqual; const sizes: number[][] = [];
  crypto.timingSafeEqual = (a: any, b: any) => { sizes.push([a.length, b.length]); return real(a, b); };
  try { await run(); } finally { crypto.timingSafeEqual = real; }
  return sizes;
};
test('The Vercel relay compares the access key as equal-length digests: a wrong, short, long or missing key is a plain 401, the right key passes', async () => {
  process.env.POLYGATE_RELAY_TOKEN = 'secret'; const { default: relay } = await import('../relays/vercel-bun/api/relay.js');
  globalThis.fetch = (async () => new Response('ip=203.0.113.7')) as any;
  const call = (headers: Record<string, string>) => relay.fetch(new Request('https://relay.example/', { headers: { 'x-relay-control': 'ping', ...headers } }));
  const sizes = await spyOnCompare(async () => {
    for (const key of BAD_KEYS) expect((await call({ 'x-relay-key': key })).status).toBe(401);
    expect((await call({})).status).toBe(401);
    expect((await call({ 'x-relay-key': 'secret' })).status).toBe(200);
  });
  expect(sizes.length).toBe(BAD_KEYS.length + 2); for (const s of sizes) expect(s).toEqual([32, 32]);
});
test('The Vercel relay does not forward any x-relay-* header, only look-alikes', async () => {
  process.env.POLYGATE_RELAY_TOKEN = 'secret'; const { default: relay } = await import('../relays/vercel-bun/api/relay.js');
  globalThis.fetch = (async (url: any, init: any) => { if (String(url).endsWith('/cdn-cgi/trace')) return new Response('ip=203.0.113.7'); seen = { url: String(url), headers: new Headers(init?.headers) }; return new Response('ok'); }) as any;
  seen = undefined; await (await relay.fetch(new Request('https://relay.example/', { method: 'POST', headers: { ...KEEP, ...RELAY, 'x-relay-avoid': '198.51.100.1', 'x-relay-hold': '10', 'x-relay-future': '1', 'x-relayed-by': 'keep' }, body: '{}' }))).text();
  for (const k of ['x-relay-avoid', 'x-relay-hold', 'x-relay-future']) expect(seen!.headers.has(k)).toBe(false);
  expect(seen!.headers.get('x-relayed-by')).toBe('keep');
});
test('The Netlify relay compares the access key as equal-length digests and never forwards an x-relay-* header', async () => {
  process.env.POLYGATE_RELAY_TOKEN = 'secret';
  const https = (await import('node:https')).default as any; const { EventEmitter } = await import('node:events'); const real = https.request; let opts: any; let calls = 0;
  https.request = (o: any, cb: any) => { calls++; opts = o; const req: any = new EventEmitter(); req.destroy = () => {}; req.end = () => { const res: any = new EventEmitter(); res.statusCode = 200; res.headers = { 'content-type': 'text/plain', 'x-relay-spoofed': 'upstream' }; cb(res); res.emit('data', Buffer.from('ok')); res.emit('end'); }; return req; };
  try {
    const { handler } = (await import('node:module')).createRequire(import.meta.url)('../relays/netlify-relay.js?cjs');
    const event = (key: string | undefined, extra: Record<string, string> = {}) => ({ httpMethod: 'POST', body: '{}', isBase64Encoded: false, headers: { ...KEEP, ...RELAY, ...(key === undefined ? { 'x-relay-key': undefined } : { 'x-relay-key': key }), ...extra } });
    const sizes = await spyOnCompare(async () => {
      for (const key of [...BAD_KEYS, undefined]) expect((await handler(event(key as any))).statusCode).toBe(401);
      expect(calls).toBe(0);
      const ok = await handler(event('secret', { 'x-relay-avoid': '198.51.100.1', 'x-relay-control': 'recycle', 'x-relay-hold': '10', 'x-relayed-by': 'keep' }));
      expect(ok.statusCode).toBe(200); expect(calls).toBe(1);
      expect(ok.headers['x-relay-spoofed']).toBeUndefined(); expect(ok.headers['x-relay-runtime']).toMatch(/^node-bun-ciphers \d/);
    });
    expect(sizes.length).toBe(BAD_KEYS.length + 2); for (const s of sizes) expect(s).toEqual([32, 32]);
    for (const k of ['x-relay-avoid', 'x-relay-control', 'x-relay-hold']) expect(k in opts.headers).toBe(false);
    expect(opts.headers['x-relayed-by']).toBe('keep');
  } finally { https.request = real; }
});
test('Both templates forward to Kilo\'s gateway, and refuse plain http, addresses and local names', async () => {
  process.env.POLYGATE_RELAY_TOKEN = 'secret';
  const kilo = { 'x-relay-target': 'https://api.kilo.ai', 'x-relay-path': '/api/gateway/chat/completions', 'x-relay-key': 'secret' };
  const { default: relay } = await import('../relays/vercel-bun/api/relay.js');
  globalThis.fetch = (async (url: any, init: any) => { seen = { url: String(url), headers: new Headers(init?.headers) }; return new Response('ok'); }) as any;
  seen = undefined; expect((await relay.fetch(new Request('https://relay.example/', { method: 'POST', headers: kilo, body: '{}' }))).status).toBe(200);
  expect(seen!.url).toBe('https://api.kilo.ai/api/gateway/chat/completions');
  const refused = ['http://api.kilo.ai', 'https://127.0.0.1', 'https://10.0.0.5', 'https://[::1]', 'https://localhost', 'https://db.internal', 'https://printer.local'];
  for (const host of refused) expect((await relay.fetch(new Request('https://relay.example/', { method: 'POST', headers: { ...kilo, 'x-relay-target': host }, body: '{}' }))).status).toBe(403);
  const { handler } = (await import('node:module')).createRequire(import.meta.url)('../relays/netlify-relay.js?kilo');
  const event = (target: string) => ({ httpMethod: 'POST', body: '{}', isBase64Encoded: false, headers: { ...kilo, 'x-relay-target': target } });
  for (const host of refused) expect((await handler(event(host))).statusCode).toBe(403);
  seen = undefined; expect((await relay.fetch(new Request('https://relay.example/', { method: 'POST', headers: { ...kilo, 'x-relay-target': 'https://models.example.org' }, body: '{}' }))).status).toBe(200); expect(seen!.url).toBe('https://models.example.org/api/gateway/chat/completions'); // any other public host is carried too
  const https = (await import('node:https')).default as any; const { EventEmitter } = await import('node:events'); const real = https.request; let opts: any;
  https.request = (o: any, cb: any) => { opts = o; const req: any = new EventEmitter(); req.destroy = () => {}; req.end = () => { const res: any = new EventEmitter(); res.statusCode = 200; res.headers = { 'content-type': 'application/json' }; cb(res); res.emit('data', Buffer.from('{}')); res.emit('end'); }; return req; };
  try { expect((await handler(event('https://api.kilo.ai'))).statusCode).toBe(200); expect(opts.host).toBe('api.kilo.ai'); expect(opts.path).toBe('/api/gateway/chat/completions'); } finally { https.request = real; }
});

test('The Cloudflare Worker needs the token, reaches any public HTTPS host, drops identity headers and streams the answer', async () => {
  const { default: worker } = await import('../relays/cloudflare-worker.js');
  const env = { RELAY_TOKEN: 'secret' }; const kilo = { 'x-relay-target': 'https://api.kilo.ai', 'x-relay-path': '/api/gateway/chat/completions?x=1', 'x-relay-key': 'secret' };
  const call = (headers: Record<string, string>, e: any = env) => worker.fetch(new Request('https://relay.example/', { method: 'POST', headers, body: '{}' }), e);
  let seen: { url: string; headers: Headers } | undefined;
  globalThis.fetch = (async (url: any, init: any) => { seen = { url: String(url), headers: new Headers(init?.headers) }; return new Response('data: hi\n\n', { status: 200, headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip', 'content-length': '999', 'x-up': '1' } }); }) as any;
  expect((await call({ ...kilo, 'x-relay-key': 'wrong' })).status).toBe(401); expect((await call(kilo, {})).status).toBe(401); expect((await call({ ...kilo, 'x-relay-key': '' })).status).toBe(401);
  for (const target of ['http://api.kilo.ai', 'https://user:pw@api.kilo.ai', 'https://127.0.0.1', 'https://localhost', 'https://db.internal']) expect((await call({ ...kilo, 'x-relay-target': target })).status).toBe(403);
  expect((await call({ ...kilo, 'x-relay-path': '//evil.example/x' })).status).toBe(403);
  expect(seen).toBeUndefined(); // nothing was forwarded for any refused request
  const other = { ...kilo, 'x-relay-target': 'https://example.com' };
  expect((await call(other)).status).toBe(200); // any public host by default
  expect((await call(other, { ...env, POLYGATE_ALLOWED_HOSTS: 'api.kilo.ai' })).status).toBe(403); // narrowed by the variable
  expect((await call({ ...other, 'x-relay-target': 'https://a.example.org' }, { ...env, POLYGATE_ALLOWED_HOSTS: 'api.kilo.ai, *.example.org' })).status).toBe(200); // a suffix pattern matches subdomains
  expect((await call({ ...other, 'x-relay-target': 'https://example.org' }, { ...env, POLYGATE_ALLOWED_HOSTS: '*.example.org' })).status).toBe(403);
  seen = undefined;
  const r = await call({ ...kilo, ...PLATFORM, 'content-type': 'application/json', 'x-session-id': 'ses_abc' });
  expect(r.status).toBe(200); expect(await r.text()).toBe('data: hi\n\n'); expect(r.headers.get('x-relay-runtime')).toBe('cloudflare-worker'); expect(r.headers.get('x-up')).toBe('1'); expect(r.headers.has('content-encoding')).toBe(false); expect(r.headers.has('content-length')).toBe(false);
  expect(seen!.url).toBe('https://api.kilo.ai/api/gateway/chat/completions?x=1'); expect(seen!.headers.get('content-type')).toBe('application/json'); expect(seen!.headers.get('x-session-id')).toBe('ses_abc');
  for (const k of [...Object.keys(PLATFORM), 'x-relay-key', 'x-relay-target', 'x-relay-path']) expect(seen!.headers.has(k)).toBe(false);
  globalThis.fetch = (async () => new Response('ip=203.0.113.9\nloc=DE\n')) as any;
  const ping = await worker.fetch(new Request('https://relay.example/', { headers: { 'x-relay-key': 'secret', 'x-relay-control': 'ping' } }), env); expect(await ping.json()).toEqual({ egress: '203.0.113.9', runtime: 'cloudflare-worker' });
  globalThis.fetch = (async () => { throw new Error('connect failed'); }) as any;
  const down = await call(kilo); expect(down.status).toBe(502); expect(((await down.json()) as any).error).toContain('connect failed');
});

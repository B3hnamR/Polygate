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
test('The Vercel Bun template needs the token, allows only OpenCode hosts, drops identity headers and reports its runtime', async () => {
  process.env.POLYGATE_RELAY_TOKEN = 'secret'; const { default: relay } = await import('../relays/vercel-bun/api/relay.js');
  expect((await relay.fetch(new Request('https://relay.example/', { method: 'POST', headers: { ...RELAY, 'x-relay-key': 'wrong' }, body: '{}' }))).status).toBe(401);
  expect((await relay.fetch(new Request('https://relay.example/', { method: 'POST', headers: { ...RELAY, 'x-relay-target': 'https://example.com' }, body: '{}' }))).status).toBe(403);
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
  try { expect(((await (await control('recycle')).json()) as any).control).toBe('recycle'); await new Promise(r => setTimeout(r, 250)); expect(exited).toBe(1); } finally { process.exit = realExit; }
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
    calls = 0; expect((await handler(event('wrong'))).statusCode).toBe(401); expect((await handler(event('secret', { 'x-relay-target': 'https://example.com' }))).statusCode).toBe(403); expect(calls).toBe(0);
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

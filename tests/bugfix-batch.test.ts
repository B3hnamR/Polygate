import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
process.env.POLYGATE_ADMIN_TOKEN = 'bugfix-batch-secret';
const { startGateway } = await import('../backend/main');
const { settings, saveModel, writeFileAtomic } = await import('../backend/state');
const { pickPoolProxy, __setPoolEntries, __poolHealth } = await import('../backend/pool');
const { socksBridge, bridgeCount, closeSocksBridges } = await import('../backend/socks-bridge');
const { fetchList } = await import('../backend/proxy-engine');
const { queryEvents, logEvent } = await import('../backend/logbook');
let gateway: Awaited<ReturnType<typeof startGateway>>, base = '';
const saved = { providers: settings.providers, timeoutMs: settings.timeoutMs, routes: settings.routes.slice(), cooldowns: settings.cooldowns, strategy: settings.strategy };
const admin = { authorization: 'Bearer bugfix-batch-secret', 'content-type': 'application/json' };
const call = async (p: string, body: unknown) => { const r = await fetch(base + p, { method: 'POST', headers: admin, body: JSON.stringify(body) }); return { status: r.status, body: (await r.json().catch(() => ({}))) as any }; };
const ask = (model: string, stream = false) => fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + settings.keys[0].value, 'content-type': 'application/json' }, body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'hi' }] }) });
const chunk = (content: string, finish: string | null = null) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: content ? { role: 'assistant', content } : {}, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}) }) + '\n\n';
const sse = (body: BodyInit) => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
const upstream = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  const b = await req.json() as any;
  if (b.model === 'gone') return Response.json({ error: { message: 'model not found' } }, { status: 404 });
  if (b.model === 'drip') return sse(new ReadableStream({ async start(c) { for (let i = 0; i < 6; i++) { c.enqueue(new TextEncoder().encode(chunk('part ' + i))); await Bun.sleep(150); } c.enqueue(new TextEncoder().encode(chunk('', 'stop') + 'data: [DONE]\n\n')); c.close(); } }));
  if (b.model === 'stall') return sse(new ReadableStream({ async start(c) { c.enqueue(new TextEncoder().encode(chunk('first'))); await Bun.sleep(1600); try { c.enqueue(new TextEncoder().encode(chunk('', 'stop') + 'data: [DONE]\n\n')); c.close(); } catch { /* the gateway already hung up */ } } }));
  return sse(chunk('from ' + b.model) + chunk('', 'stop') + 'data: [DONE]\n\n');
} });
const fresh = (id: string, priority: number) => saveModel({ id: 'bf/' + id, upstreamId: id, providerId: 'bf', name: id, context: 0, output: 0, tools: true, reasoning: false, state: 'unchecked', latency: 0, score: 50, priority, failCount: 0, cooldownUntil: 0, checkedAt: 0, error: '' });
beforeAll(async () => {
  settings.warp = { engine: 'disabled', autoStart: false, pool: 1, rotateMinutes: 0, helperPath: '', endpoint: '' };
  settings.providers = [{ id: 'bf', name: 'Batch upstream', kind: 'openai', enabled: true, baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: '', models: [], routeId: 'direct' }];
  gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`;
});
afterAll(async () => { settings.providers = saved.providers; settings.timeoutMs = saved.timeoutMs; settings.strategy = saved.strategy; await gateway?.close(); upstream.stop(true); closeSocksBridges(); });

test('a long answer that keeps arriving is not cut off by the request deadline, but one that goes silent is', async () => {
  fresh('drip', 1); fresh('stall', 2); settings.timeoutMs = 450;
  const long = await ask('bf/drip'); // about 900 ms in total, twice the deadline, but a piece arrives every 150 ms
  expect(long.status).toBe(200); expect(JSON.stringify(await long.json())).toContain('part 5');
  const silent = await ask('bf/stall'); // one piece, then nothing for 1.6 s
  expect(silent.status).toBe(504);
  settings.timeoutMs = saved.timeoutMs;
});

test('auto moves on from a model the provider says is gone', async () => {
  fresh('gone', -2); fresh('fine', -1); // ahead of the models from the other tests
  const r = await ask('auto'); expect(r.status).toBe(200); expect(JSON.stringify(await r.json())).toContain('from fine');
});

test('a retry through the pool never goes back to a proxy that just failed', async () => {
  const entry = (n: number) => ({ url: `http://203.0.113.${n}:8080`, proxy: `http://203.0.113.${n}:8080`, proto: 'http' as const, host: `203.0.113.${n}`, port: 8080, https: true, latencyMs: 100 });
  __setPoolEntries([entry(1), entry(2)]);
  for (const n of [1, 2]) __poolHealth.set(entry(n).url, { url: entry(n).url, status: 'ready', latency: 100, checkedAt: Date.now(), deep: true, error: '', failures: 0, successes: 1, coolUntil: 0, opened: 0 } as any);
  settings.strategy = 'single';
  const route: any = { id: 'proxy-pool', name: 'Pool', kind: 'proxy', url: '', enabled: true, models: [] };
  const first = (await pickPoolProxy(route))!; const again = (await pickPoolProxy(route))!; expect(again.url).toBe(first.url); // sticky without a failure
  const next = (await pickPoolProxy(route, new Set([first.url])))!; expect(next.url).not.toBe(first.url);
  expect(await pickPoolProxy(route, new Set([entry(1).url, entry(2).url]))).toBeNull();
  __poolHealth.clear();
});

test('SOCKS bridges are capped, so thousands of proxies cannot open thousands of listeners', async () => {
  for (let i = 0; i < 80; i++) await socksBridge({ version: 5, host: '203.0.113.9', port: 20000 + i } as any);
  expect(bridgeCount()).toBeLessThanOrEqual(64); expect(bridgeCount()).toBeGreaterThan(0);
  closeSocksBridges(); expect(bridgeCount()).toBe(0);
});

test('settings that cannot be opened are kept aside and the app starts with defaults, with a clear message', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'polygate-vault-'));
  try {
    writeFileSync(path.join(dir, 'vault.key'), Buffer.alloc(32, 7)); writeFileSync(path.join(dir, 'settings.vault'), Buffer.alloc(120, 1));
    const run = Bun.spawnSync([process.execPath, '-e', "const m = await import('./backend/state.ts'); console.log('providers:' + m.settings.providers.length);"], { cwd: path.resolve(import.meta.dir, '..'), env: { ...process.env, POLYGATE_STATE: dir, POLYGATE_READ_ONLY_STATE: '1' } });
    expect(run.exitCode).toBe(0); expect(run.stdout.toString()).toContain('providers:');
    expect(run.stderr.toString()).toContain('could not open its saved settings');
    expect(readdirSync(dir).some(f => f.startsWith('settings.vault.unreadable-'))).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an atomic write leaves the whole new file and no temporary file behind', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'polygate-atomic-'));
  try { const f = path.join(dir, 'a.json'); writeFileAtomic(f, '{"a":1}'); writeFileAtomic(f, '{"a":2}'); expect(readFileSync(f, 'utf8')).toBe('{"a":2}'); expect(readdirSync(dir)).toEqual(['a.json']); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a provider cannot change type, and a relay on another machine must use https', async () => {
  const made = await call('/admin/providers', { name: 'Typed', kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1', idPrefix: 'typed', routeId: 'direct' });
  expect(made.status).toBe(200);
  const other = await call('/admin/providers', { id: made.body.id, name: 'Typed', kind: 'kilo', baseUrl: 'http://127.0.0.1:9/v1' });
  expect(other.status).toBe(400); expect(other.body.error.message).toContain('type cannot be changed');
  settings.providers.push({ id: 'opencode', name: 'OpenCode Free', kind: 'free', enabled: true, baseUrl: '', apiKey: '', models: [], routeId: '' });
  const builtIn = await call('/admin/providers', { id: 'opencode', name: 'OpenCode Free', kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1' });
  expect(builtIn.status).toBe(400); settings.providers = settings.providers.filter(p => p.id !== 'opencode');
  const plain = await call('/admin/routes', { kind: 'relay', name: 'Plain', url: 'http://relay.example.com/', token: 't' });
  expect(plain.status).toBe(400); expect(plain.body.error.message).toContain('https');
  const local = await call('/admin/routes', { kind: 'relay', name: 'Local', url: 'http://127.0.0.1:9/', token: 't' });
  expect(local.status).toBe(200);
  settings.routes = saved.routes.slice();
});

test('a malformed MCP address is a 400, not a server error', async () => {
  const r = await fetch(base + '/mcp/%E0%A4%A', { method: 'POST', headers: { authorization: 'Bearer ' + settings.keys[0].value, 'content-type': 'application/json' }, body: '{}' });
  expect(r.status).toBe(400);
});

test('the live log view reads a burst bigger than one page in order instead of skipping the gap', () => {
  const baseline = queryEvents({ limit: 1 }).entries[0]?.id || 0;
  for (let i = 0; i < 6; i++) logEvent('info', 'batch', 'burst ' + i);
  const everything = queryEvents({ after: baseline, limit: 500 }).entries.map(e => e.id).sort((a, b) => a - b);
  const first = queryEvents({ after: baseline, limit: 2 }).entries.map(e => e.id);
  expect(first).toEqual([everything[1], everything[0]]); // the two oldest new rows, newest first
  const next = queryEvents({ after: first[0], limit: 2 }).entries.map(e => e.id);
  expect(next).toEqual([everything[3], everything[2]]); // the poll after it continues, with nothing skipped
});

test('a list download refuses a redirect to a private address', async () => {
  const real = globalThis.fetch; let calls = 0;
  (globalThis as any).fetch = async (u: any) => { calls++; return new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/secret' } }); };
  try { const r = await fetchList('http://8.8.8.8/proxies.txt', 'all'); expect(r.found).toEqual([]); expect(r.error).toContain('public'); expect(calls).toBe(1); }
  finally { globalThis.fetch = real; }
});

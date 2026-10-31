import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
process.env.POLYGATE_ADMIN_TOKEN = 'integration-secret';
const { startGateway } = await import('../backend/main');
const { settings, saveModel, models } = await import('../backend/state');
const { readiness } = await import('../backend/gateway');
let gateway: Awaited<ReturnType<typeof startGateway>>, base = '';
let hits = 0;
const enc = new TextEncoder();
const chunk = (o: any) => JSON.stringify(o);
const choice = (index: number, text: string, finish: string | null = null) => chunk({ id: 'c', object: 'chat.completion.chunk', model: 'm', choices: [{ index, delta: text ? { content: text } : {}, finish_reason: finish }] });
// What the fake upstream sends depends on the path: `cr` frames events with a lone CR, `cut` stops after one of two choices finished, anything else answers normally.
const up = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  const u = new URL(req.url); if (u.pathname.endsWith('/models')) return Response.json({ data: [] });
  hits++;
  const send = (frames: string[], eol: string, done: boolean) => new Response(enc.encode(frames.map(f => 'data: ' + f + eol).join('') + (done ? 'data: [DONE]' + eol : '')), { headers: { 'content-type': 'text/event-stream' } });
  if (u.pathname.startsWith('/cr')) return send([choice(0, 'Hello '), choice(0, 'world'), choice(0, '', 'stop')], '\r\r', true);
  if (u.pathname.startsWith('/cut')) return send([choice(0, 'A'), choice(1, 'partial B'), choice(0, '', 'stop')], '\n\n', false); // choice 1 never finishes, and no [DONE]
  return send([choice(0, 'ok'), choice(0, '', 'stop')], '\n\n', true);
} });
const model = (id: string, providerId: string, priority: number, extra: Partial<any> = {}) => saveModel({ id, upstreamId: id.split('/')[1], providerId, name: id, context: 0, output: 0, tools: true, reasoning: false, state: 'available', latency: 0, score: 50, priority, failCount: 0, cooldownUntil: 0, checkedAt: 0, error: '', ...extra } as any);
const prov = (id: string, path: string, extra: any = {}) => ({ id, name: id.toUpperCase(), kind: 'openai', enabled: true, baseUrl: `http://127.0.0.1:${up.port}/${path}/v1`, apiKey: '', models: [], routeId: 'direct', ...extra });
const saved: any = {};
beforeAll(async () => {
  Object.assign(saved, { providers: settings.providers, routes: settings.routes.slice(), retries: settings.retries, fallback: settings.fallback, chains: settings.chains });
  settings.retries = 0; settings.fallback = true; settings.chains = [];
  settings.routes.push({ id: 'ri-cool', name: 'Cooling route', kind: 'proxy', url: 'socks5://127.0.0.1:1', enabled: true, models: [], cooldownUntil: Date.now() + 600000 } as any);
  gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`;
});
afterEach(() => { for (const id of [...models.keys()]) if (/^(ri|ra|rb|rc|rd)\//.test(id)) models.delete(id); });
afterAll(async () => { await gateway?.close(); up.stop(true); settings.providers = saved.providers; settings.routes.length = 0; settings.routes.push(...saved.routes); settings.retries = saved.retries; settings.fallback = saved.fallback; settings.chains = saved.chains; });
const ask = async (body: any) => { const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + settings.keys[0].value, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], ...body }) }); const text = await r.text(); let json: any; try { json = JSON.parse(text); } catch { /* a stream */ } return { status: r.status, text, json, model: r.headers.get('x-polygate-model'), skipped: decodeURIComponent(r.headers.get('x-polygate-skipped') || '') }; };
const preview = async (body: any) => (await fetch(base + '/admin/route-preview', { method: 'POST', headers: { authorization: 'Bearer integration-secret', 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<any>;
const tool = { type: 'function', function: { name: 'read_file', description: 'x', parameters: { type: 'object', properties: {} } } };

// ---- 1. the installer's first password
test('first-install password: the installer bootstraps with the password on stdin and the environment override removed, and that works; a later reset with the override set is refused', () => {
  const installer = readFileSync(path.join(import.meta.dir, '..', 'install.sh'), 'utf8');
  const line = installer.split('\n').find(l => l.includes('manage.js') && l.includes('password --stdin'))!;
  expect(line).toContain('env -u POLYGATE_ADMIN_PASSWORD'); // the override is not passed to the bootstrap, so the guard against resets does not apply to it
  const run = (env: Record<string, string>, stdin: string) => {
    const state = mkdtempSync(path.join(os.tmpdir(), 'pg-pw-'));
    try {
      const clean: Record<string, string> = { ...process.env as any, POLYGATE_STATE: state, POLYGATE_PORT: '1', POLYGATE_NO_DISCOVERY: '1' }; delete clean.POLYGATE_ADMIN_PASSWORD; delete clean.POLYGATE_ADMIN_TOKEN;
      const r = Bun.spawnSync([process.execPath, path.join(import.meta.dir, '..', 'backend', 'manage.ts'), 'password', '--stdin'], { env: { ...clean, ...env }, stdin: new TextEncoder().encode(stdin), stderr: 'pipe', stdout: 'pipe' });
      return { code: r.exitCode, err: r.stderr.toString(), wrote: existsSync(path.join(state, 'admin-password.txt')) };
    } finally { rmSync(state, { recursive: true, force: true }); }
  };
  const bootstrap = run({}, 'supplied-password-123'); expect(bootstrap).toMatchObject({ code: 0, wrote: true });
  const reset = run({ POLYGATE_ADMIN_PASSWORD: 'supplied-password-123' }, 'another-password-456'); expect(reset.code).not.toBe(0); expect(reset.err).toContain('POLYGATE_ADMIN_PASSWORD');
});

// ---- 2. several completions: one finishing is not all finishing
test('n > 1 where one choice finishes and the other is cut is an error, not a complete answer', async () => {
  settings.providers = [prov('ri', 'cut')] as any; model('ri/m', 'ri', 1);
  const plain = await ask({ model: 'ri/m', n: 2, stream: false });
  expect(plain.status).toBe(502); expect(plain.text).toContain('ended before a terminal event');
  const streamed = await ask({ model: 'ri/m', n: 2, stream: true });
  expect(streamed.text).toContain('partial B'); expect(streamed.text).toContain('"error"'); // the missing completion is reported
});

// ---- 3. lone-CR framing through the whole gateway
test('an event stream framed with lone CRs is answered in full by the gateway, not rejected', async () => {
  settings.providers = [prov('ri', 'cr')] as any; model('ri/m', 'ri', 1);
  const plain = await ask({ model: 'ri/m', stream: false });
  expect(plain.status).toBe(200); expect(plain.json.choices[0].message.content).toBe('Hello world');
  const streamed = await ask({ model: 'ri/m', stream: true });
  expect(streamed.status).toBe(200); expect(streamed.text).toContain('world'); expect(streamed.text).not.toContain('mid-reply');
});

// ---- 5. Ready when every model is resting
test('when every known model is resting, the gateway is not ready and says when the first is back', async () => {
  settings.providers = [prov('ri', 'ok')] as any; model('ri/m', 'ri', 1, { cooldownUntil: Date.now() + 5 * 60000 });
  const r = readiness(); expect(r.state).toBe('attention'); expect(r.issues.map(i => i.code)).toContain('models_resting'); expect(r.issues.find(i => i.code === 'models_resting')!.message).toMatch(/back at/);
  expect((await ask({ model: 'auto', stream: false })).status).toBe(503); // what the checklist predicted
  model('ri/m', 'ri', 1); expect(readiness().state).toBe('ready');
});

// ---- 4. the preview follows the same rules as a real request
test('preview and a real request agree when every model is listed without tool support', async () => {
  settings.providers = [prov('ri', 'ok')] as any; model('ri/a', 'ri', 1, { tools: false }); model('ri/b', 'ri', 2, { tools: false });
  const p = await preview({ model: 'auto', tools: true });
  const real = await ask({ model: 'auto', stream: false, tools: [tool] });
  expect(real.status).toBe(200); expect(real.model).toBe('ri/a'); // tried anyway, because the listing may be wrong
  expect(p.steps.find((s: any) => s.status === 'try')?.model).toBe('ri/a'); expect(p.summary).toContain('ri/a');
});
test('preview and a real request agree when the first models have no usable route: the fourth is reached', async () => {
  settings.providers = [prov('ra', 'ok', { routeId: 'ri-cool', routes: { ids: ['ri-cool'] } }), prov('rb', 'ok', { routeId: 'ri-cool', routes: { ids: ['ri-cool'] } }), prov('rc', 'ok', { routeId: 'ri-cool', routes: { ids: ['ri-cool'] } }), prov('rd', 'ok')] as any;
  model('ra/m', 'ra', 1); model('rb/m', 'rb', 2); model('rc/m', 'rc', 3); model('rd/m', 'rd', 4);
  const p = await preview({ model: 'auto' });
  const real = await ask({ model: 'auto', stream: false });
  expect(p.steps.find((s: any) => s.status === 'try').model).toBe('rd/m');
  expect(real.status).toBe(200); expect(real.model).toBe('rd/m');
  expect(real.skipped).toContain('ra/m'); // and the models passed over are named
});

// ---- 6. the Playground's preview is about the request it would send
test('a composed request is previewed by what it contains and with its own key, in any protocol', async () => {
  settings.providers = [prov('ra', 'ok'), prov('rb', 'ok')] as any; model('ra/m', 'ra', 1); model('rb/m', 'rb', 2);
  const keys = settings.keys; settings.keys = [...keys, { id: 'k-only-b', name: 'Only B', value: 'pg_only_b_key_value', enabled: true, limit: 4, models: ['rb/m'] } as any];
  try {
    const chat = await preview({ model: 'auto', keyId: 'k-only-b', protocol: 'chat', request: { model: 'auto', messages: [{ role: 'user', content: 'x'.repeat(8000) }], tools: [tool] } });
    expect(chat.needs).toMatchObject({ tools: true }); expect(chat.needs.tokens).toBeGreaterThan(1900);
    expect(chat.steps.find((s: any) => s.model === 'ra/m')).toMatchObject({ status: 'skip', reason: 'this client key does not allow that model' }); expect(chat.summary).toContain('rb/m');
    const anthropic = await preview({ model: 'auto', protocol: 'anthropic', request: { model: 'auto', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'x', description: 'x', input_schema: { type: 'object', properties: {} } }] } });
    expect(anthropic.needs.tools).toBe(true);
    expect((await fetch(base + '/admin/route-preview', { method: 'POST', headers: { authorization: 'Bearer integration-secret', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'auto', request: { nothing: true } }) })).status).toBe(400); // not a request
  } finally { settings.keys = keys; }
});

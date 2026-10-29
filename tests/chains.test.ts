import { test, expect, beforeAll, afterAll } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
process.env.POLYGATE_ADMIN_TOKEN = 'chains-test-secret';
const { startGateway } = await import('../backend/main');
const { settings, saveModel } = await import('../backend/state');
const { queryEvents } = await import('../backend/logbook');
let gateway: Awaited<ReturnType<typeof startGateway>>, base = ''; let savedProviders: typeof settings.providers; let savedChains: typeof settings.chains;
const admin = { authorization: 'Bearer chains-test-secret', 'content-type': 'application/json' };
const adminCall = async (p: string, body: unknown) => { const r = await fetch(base + p, { method: 'POST', headers: admin, body: JSON.stringify(body) }); return { status: r.status, body: (await r.json()) as any }; };
const ask = (model: string, key = settings.keys[0].value) => fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hello' }], stream: false }) });
// An upstream whose models each fail in a different way, and a record of which were actually asked.
let asked: string[] = [];
const upstream = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  const body = await req.json() as any; asked.push(body.model);
  if (body.model === 'gone') return Response.json({ error: { message: 'model not found' } }, { status: 404 });
  if (body.model === 'blocked') return Response.json({ error: { message: 'forbidden' } }, { status: 403 });
  if (body.model === 'busy') return Response.json({ error: { message: 'Model capacity exhausted' } }, { status: 429, headers: { 'retry-after': '60' } });
  if (body.model === 'badrequest') return Response.json({ error: { message: 'messages are invalid' } }, { status: 400 });
  const data = [{ choices: [{ index: 0, delta: { role: 'assistant', content: 'from ' + body.model }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }];
  return new Response(data.map(x => 'data: ' + JSON.stringify(x) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
} });
const fresh = (id: string, over: Partial<{ cooldownUntil: number; state: 'unchecked' | 'cooldown' | 'unavailable' }> = {}) => saveModel({ id: 'chain/' + id, upstreamId: id, providerId: 'chain', name: id, context: 0, output: 0, tools: true, reasoning: false, state: 'unchecked', latency: 0, score: 50, priority: 100, failCount: 0, cooldownUntil: 0, checkedAt: 0, error: '', ...over });
const reset = () => { asked = []; for (const id of ['gone', 'blocked', 'busy', 'badrequest', 'fine', 'second']) fresh(id); };
beforeAll(async () => {
  savedProviders = settings.providers; savedChains = settings.chains;
  settings.warp = { engine: 'disabled', autoStart: false, pool: 1, rotateMinutes: 0, helperPath: '', endpoint: '' };
  settings.providers = [{ id: 'chain', name: 'Chain upstream', kind: 'openai', enabled: true, baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: '', models: [], routeId: 'direct' }];
  settings.chains = [];
  settings.cooldowns = true; // chains skip paused models; the pause is off by default, so switch it on here
  gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`;
});
afterAll(async () => { settings.providers = savedProviders; settings.chains = savedChains; await gateway?.close(); upstream.stop(true); });
const save = (body: any) => adminCall('/admin/chains/save', body);
// Chain names are prefixed tc- so they cannot match a model another test file left in the shared state.
const made = async (body: any) => { const r = await save(body); expect(r.status).toBe(200); return r.body.chain; };
const listed = async () => (await (await fetch(base + '/v1/models', { headers: { authorization: 'Bearer ' + settings.keys[0].value } })).json() as any).data as { id: string; owned_by: string }[];

test('a chain is validated before it is saved', async () => {
  reset();
  expect((await save({ name: 'Bad Name!', models: ['chain/fine'] })).status).toBe(400);
  expect((await save({ name: 'auto', models: ['chain/fine'] })).body.error.message).toContain('built in');
  expect((await save({ name: 'chain/fine', models: ['chain/fine'] })).status).toBe(400);
  expect((await save({ name: 'fine', models: ['chain/fine'] })).body.error.message).toContain('already called');
  expect((await save({ name: 'empty', models: [] })).status).toBe(400);
  expect((await save({ name: 'typo', models: ['chain/nothing'] })).body.error.message).toContain('not a model Polygate knows');
  expect((await save({ name: 'twice', models: ['chain/fine', 'chain/fine'] })).body.error.message).toContain('twice');
  expect((await save({ name: 'toolong', models: Array.from({ length: 9 }, (_, i) => 'chain/m' + i) })).status).toBe(400);
  expect(settings.chains).toEqual([]);
});

test('a saved chain is listed as a model, edited in place, and removed', async () => {
  reset();
  const made = await save({ name: 'My-Coding', description: 'blocked first', models: ['chain/blocked', 'auto:fast'] });
  expect(made.status).toBe(200); expect(made.body.chain.name).toBe('my-coding');
  expect((await save({ name: 'my-coding', models: ['chain/fine'] })).status).toBe(400); // another chain's name
  const again = await save({ id: made.body.chain.id, name: 'my-coding', models: ['chain/blocked', 'chain/fine'], enabled: true });
  expect(again.status).toBe(200); expect(settings.chains!.length).toBe(1); expect(settings.chains![0].models).toEqual(['chain/blocked', 'chain/fine']);
  expect((await listed()).find(m => m.id === 'my-coding')?.owned_by).toBe('polygate-chain');
  expect((await adminCall('/admin/chains/delete', { id: made.body.chain.id })).status).toBe(200);
  expect(settings.chains).toEqual([]);
  expect((await adminCall('/admin/chains/delete', { id: made.body.chain.id })).status).toBe(404);
});

test('a chain moves past a refused, missing or busy model to the next one', async () => {
  reset();
  const c = await made({ name: 'tc-walk', models: ['chain/blocked', 'chain/gone', 'chain/busy', 'chain/fine'] });
  const r = await ask('tc-walk'); const x = await r.json() as any;
  expect(r.status).toBe(200); expect(x.choices[0].message.content).toBe('from fine');
  expect(asked).toEqual(['blocked', 'gone', 'busy', 'fine']);
  expect(r.headers.get('x-polygate-chain')).toBe('tc-walk'); expect(r.headers.get('x-polygate-model')).toBe('chain/fine');
  expect(decodeURIComponent(r.headers.get('x-polygate-skipped')!)).toBe('chain/blocked (403), chain/gone (404), chain/busy (429)');
  expect(queryEvents({ q: 'tc-walk' }).entries.some(e => e.message.includes('skipped'))).toBe(true);
  await adminCall('/admin/chains/delete', { id: c.id });
});

test('models that are resting are skipped without being asked, and the first ready one answers', async () => {
  reset(); fresh('busy', { state: 'cooldown', cooldownUntil: Date.now() + 600000 });
  const c = await made({ name: 'tc-rest', models: ['chain/busy', 'chain/second', 'chain/fine'] });
  const r = await ask('tc-rest'); expect(r.status).toBe(200);
  expect(asked).toEqual(['second']); expect(r.headers.get('x-polygate-skipped')).toBeNull();
  await adminCall('/admin/chains/delete', { id: c.id });
});

test('a request the client got wrong stops the chain instead of trying every model', async () => {
  reset();
  const c = await made({ name: 'tc-wrong', models: ['chain/badrequest', 'chain/fine'] });
  const r = await ask('tc-wrong'); expect(r.status).toBe(400); expect(asked).toEqual(['badrequest']);
  await adminCall('/admin/chains/delete', { id: c.id });
});

test('when every step fails the last failure is the answer; when none is ready the client is told why', async () => {
  reset();
  const c = await made({ name: 'tc-allbad', models: ['chain/gone', 'chain/blocked'] });
  const r = await ask('tc-allbad'); expect(r.status).toBe(403); expect(asked).toEqual(['gone', 'blocked']);
  // both are now unavailable or resting, so a second request is refused before anything is sent
  asked = []; const again = await ask('tc-allbad'); expect(again.status).toBeGreaterThanOrEqual(429); expect(asked).toEqual([]);
  const body = await again.json() as any; expect(body.error.message).toContain('allbad');
  await adminCall('/admin/chains/delete', { id: c.id });
});

test('a switched-off chain is not offered or answered, and an auto step expands to ready models', async () => {
  reset(); for (const id of ['blocked', 'busy', 'badrequest']) fresh(id, { state: 'unavailable' });
  const c = await made({ name: 'tc-pause', models: ['chain/gone', 'auto'], enabled: false });
  expect((await ask('tc-pause')).status).toBe(404);
  expect((await listed()).some(m => m.id === 'tc-pause')).toBe(false);
  await save({ id: c.id, name: 'tc-pause', models: ['chain/gone', 'auto'], enabled: true });
  const r = await ask('tc-pause'); expect(r.status).toBe(200); expect(asked[0]).toBe('gone'); expect(decodeURIComponent(r.headers.get('x-polygate-skipped')!)).toContain('chain/gone (404)');
  await adminCall('/admin/chains/delete', { id: c.id });
});

test('a key limited to some models can use a chain, but only reaches the models it may use', async () => {
  reset();
  const c = await made({ name: 'tc-limited', models: ['chain/blocked', 'chain/fine'] });
  const key = { id: 'k-limited', name: 'Limited', value: 'pg_limited_test_key', enabled: true, limit: 2, models: ['chain/fine'] };
  settings.keys.push(key);
  try { const r = await ask('tc-limited', key.value); expect(r.status).toBe(200); expect(asked).toEqual(['fine']); }
  finally { settings.keys = settings.keys.filter(k => k.id !== key.id); }
  await adminCall('/admin/chains/delete', { id: c.id });
});

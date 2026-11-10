import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
// Z.ai's coding plan (backend/zai.ts): account import and sharing in AutoZCoder's format, the messages translation both ways, and what happens
// on quota, block, token and overload errors. A stand-in for zcode.z.ai answers the way AutoZCoder's captures describe.
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
process.env.POLYGATE_ADMIN_TOKEN = 'test-admin-secret';
const { startGateway } = await import('../backend/main');
const { settings, models, removeModels, publicSettings, redactError, ZAI_ID } = await import('../backend/state');
const zai = await import('../backend/zai');
const fixture = JSON.parse(readFileSync(path.join(import.meta.dir, 'fixtures', 'zcode-stream.json'), 'utf8'));

const jwt = (claims: any) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
const A = '11111111-2222-4333-8444-555555555555', B = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const tokenA = jwt({ user_id: A, exp: 0 }), tokenB = jwt({ sub: B, exp: Math.floor(Date.now() / 1000) + 86400 });
const copyA = JSON.stringify({ format: 'autozcoder-account', version: 1, account_id: A, email: 'a@example.test', name: 'First', device_mid: 'device-a', access_token: tokenA, expires_at_ms: 0 });
const now = () => Date.now() / 1000;
const balanceData = (remaining = 1000) => ({ plans: [{ user_plan_id: 'p1', plan_id: 'start', name: 'Start Plan', status: 'active', starts_at: now() - 60, ends_at: now() + 30 * 86400 }],
  balances: [{ user_plan_id: 'p1', show_name: 'GLM-5.3', available_units: remaining, total_units: 5000, used_units: 5000 - remaining, period_end: now() + 3600 },
    { user_plan_id: 'p1', show_name: 'glm-5.3-flash', available_units: 9000, total_units: 9000, used_units: 0, period_end: now() + 7200 }] });

// The stand-in: per token, how its messages requests are answered.
const modes = new Map<string, string>(); let overloads = 0;
const sent: { token: string; body: any; headers: Record<string, string> }[] = []; const billing: Record<string, string>[] = [];
const stream = () => new Response(fixture.events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const zcode = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  const url = new URL(req.url), token = (req.headers.get('authorization') || '').replace(/^Bearer /, ''), headers = Object.fromEntries(req.headers);
  if (url.pathname.endsWith('/zcode-plan/billing/balance')) {
    billing.push(headers);
    if (![tokenA, tokenB].includes(token) || modes.get(token) === 'dead') return new Response('{"error":"unauthorized"}', { status: 401 });
    return Response.json({ code: 0, data: balanceData(modes.get(token) === 'quota' ? 0 : 1000) });
  }
  if (!url.pathname.endsWith('/zcode-plan/anthropic/v1/messages')) return new Response('not found', { status: 404 });
  sent.push({ token, body: await req.json(), headers });
  const mode = modes.get(token) || 'ok';
  if (mode === 'dead') return new Response('{"error":{"message":"invalid token"}}', { status: 401, headers: { 'content-type': 'application/json' } });
  if (mode === 'quota') return Response.json({ error: { code: '11113', message: 'Insufficient balance' } });
  if (mode === 'block') return Response.json({ error: { code: '3012', message: 'request has been blocked due to unusual activity.' } }, { status: 405 });
  if (mode === 'overload' && overloads-- > 0) return Response.json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { status: 529 });
  if (mode === 'truncated') return new Response(fixture.events.slice(0, 20).map((e: any) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  return stream();
} });

let gateway: Awaited<ReturnType<typeof startGateway>>, base = '';
const admin = async (p: string, body?: any) => { const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer test-admin-secret', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, text: await r.clone().text(), body: await r.json().catch(() => ({})) as any }; };
const chat = (model = 'zai/GLM-5.3', extra: any = {}) => fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + settings.keys[0].value, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }], stream: false, ...extra }) });
const reset = () => { for (const m of models.values()) if (m.providerId === ZAI_ID) { m.state = 'unchecked'; m.cooldownUntil = 0; m.failCount = 0; } };
const saved = { providers: settings.providers, zai: settings.zai, cooldowns: settings.cooldowns, wait: zai.timing.wait };
beforeAll(async () => {
  settings.warp = { engine: 'disabled', autoStart: false, pool: 1, rotateMinutes: 0, helperPath: '', endpoint: '' } as any;
  settings.providers = [{ id: ZAI_ID, name: 'Z.ai (ZCode)', kind: 'zai', enabled: true, baseUrl: `http://127.0.0.1:${zcode.port}/api/v1`, apiKey: '', models: [], routeId: '' }];
  settings.zai = { active: '', accounts: [] }; settings.cooldowns = true; removeModels(ZAI_ID);
  zai.timing.wait = async () => {};
  gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`;
});
afterEach(() => { modes.clear(); reset(); });
afterAll(async () => { removeModels(ZAI_ID); Object.assign(settings, { providers: saved.providers, zai: saved.zai, cooldowns: saved.cooldowns }); zai.timing.wait = saved.wait; await gateway?.close(); zcode.stop(true); });

test('an AutoZCoder account copy or a bare token is read; anything else is refused before Z.ai is asked', () => {
  expect(zai.parseImport(copyA)).toEqual({ id: A, token: tokenA, expiresAt: 0, email: 'a@example.test', name: 'First', deviceMid: 'device-a' });
  expect(zai.parseImport('Bearer ' + tokenB)).toMatchObject({ id: B, token: tokenB, deviceMid: '' });
  expect(() => zai.parseImport(JSON.stringify({ format: 'other', version: 1, access_token: tokenA }))).toThrow(/AutoZCoder account copy/);
  expect(() => zai.parseImport(JSON.stringify({ format: 'autozcoder-account', version: 1, account_id: B, access_token: tokenA }))).toThrow(/does not match/);
  expect(() => zai.parseImport(jwt({ user_id: A, exp: 1000 }))).toThrow(/expired/);
  expect(() => zai.parseImport(jwt({ user_id: 'not-a-uuid' }))).toThrow(/account ID/);
  expect(() => zai.parseImport(jwt({ user_id: A, sub: B }))).toThrow(/two different/);
  expect(() => zai.parseImport('two words')).toThrow(/one JWT/);
});

test('the billing balance gives each model its live quota and reset; later and expired buckets do not count', () => {
  const data = balanceData(700);
  data.balances.push({ user_plan_id: 'p1', show_name: 'GLM-5.3', available_units: 99999, total_units: 99999, used_units: 0, period_start: now() + 3600, period_end: now() + 7200 } as any);
  data.balances.push({ user_plan_id: 'p1', show_name: 'GLM-5.3', available_units: 5, total_units: 5, used_units: 0, period_end: now() - 10 } as any);
  data.balances.push({ user_plan_id: 'old', show_name: 'GLM-5.3', available_units: 5, total_units: 5, used_units: 0 } as any);
  const { plans, quotas } = zai.parseBalance(data);
  expect(plans[0]).toMatchObject({ name: 'Start Plan', status: 'active' });
  expect(quotas['GLM-5.3']).toMatchObject({ remaining: 700, total: 5000 });
  expect(quotas['GLM-5.3'].resetsAt).toBeGreaterThan(Date.now());
  expect(quotas['GLM-5.3-Flash'].remaining).toBe(9000);
});

test('the request keeps ZCode\'s system context first, turns tools and images into blocks, and maps reasoning effort', () => {
  const body = zai.zaiBody({ messages: [
    { role: 'system', content: 'Be brief.' }, { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'file text' }, { role: 'user', content: 'and?' },
  ], tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }], reasoning_effort: 'medium', max_tokens: 900000 }, 'GLM-5.3', 'device-a', 'session-1');
  expect(body.system.map((b: any) => b.text.slice(0, 20))).toEqual([zai.ZCODE_IDENTITY.slice(0, 20), zai.ZCODE_HARNESS.slice(0, 20), 'Be brief.']);
  expect(body.messages.map((m: any) => [m.role, m.content.map((b: any) => b.type)])).toEqual([['user', ['text', 'image']], ['assistant', ['tool_use']], ['user', ['tool_result', 'text']]]);
  expect(body.messages[0].content[1].source).toEqual({ type: 'base64', media_type: 'image/png', data: 'AAAA' });
  expect(body.tools).toEqual([{ name: 'read', description: '', input_schema: { type: 'object' } }]);
  expect(body).toMatchObject({ thinking: { type: 'enabled' }, output_config: { effort: 'high' }, max_tokens: 128000, stream: true });
  expect(JSON.parse(body.metadata.user_id)).toEqual({ device_id: 'device-a', account_uuid: '', session_id: 'session-1' });
  expect(zai.effort({ reasoning_effort: 'none' })).toBe('low'); expect(zai.effort({ reasoning_effort: 'xhigh' })).toBe('max');
  expect(() => zai.zaiBody({ messages: [{ role: 'user', content: 'x' }], response_format: { type: 'json_object' } }, 'GLM-5.3', 'd', 's')).toThrow(/response_format/);
});

test('the answer stream becomes OpenAI chunks with reasoning, text, finish and usage; a cut stream is an error', async () => {
  const read = async (events: any[]) => new Response(zai.toOpenAI(new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')).body!, 'GLM-5.3-Flash')).text();
  const out = await read(fixture.events);
  const chunks = out.split('\n\n').filter(Boolean).map(l => l.slice(6)).filter(l => l !== '[DONE]').map(l => JSON.parse(l));
  expect(chunks.map(c => c.choices[0]?.delta?.reasoning_content || '').join('')).toContain('think');
  expect(chunks.map(c => c.choices[0]?.delta?.content || '').join('')).toBe('hello'.repeat(10));
  expect(chunks.find(c => c.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe('stop');
  expect(chunks.at(-1).usage).toMatchObject({ prompt_tokens: 29852, completion_tokens: 47 });
  expect(out.endsWith('data: [DONE]\n\n')).toBe(true);
  const tool = await read([{ type: 'message_start', message: { id: 'm', usage: {} } }, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'read', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":1}' } }, { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }, { type: 'message_stop' }]);
  expect(tool).toContain('"tool_calls":[{"index":0,"id":"t1","type":"function","function":{"name":"read","arguments":""}}]');
  expect(tool).toContain('"finish_reason":"tool_calls"');
  await expect(read(fixture.events.slice(0, 20))).rejects.toThrow(/ended before it was complete/);
});

test('import checks the account with Z.ai, keeps the token out of every listing, and makes the first account the one in use', async () => {
  expect((await admin('/admin/zai/import', { text: jwt({ user_id: '99999999-9999-4999-8999-999999999999' }) })).status).toBe(401);
  const first = await admin('/admin/zai/import', { text: copyA }); expect(first.status).toBe(200);
  expect(billing.at(-1)).toMatchObject({ 'x-device-mid': 'device-a', 'x-zcode-app-version': '3.16.3', 'x-api-key': tokenA });
  const second = await admin('/admin/zai/import', { text: tokenB }); expect(second.status).toBe(200);
  const list = await admin('/admin/zai');
  expect(list.body.active).toBe(A);
  expect(list.body.accounts.map((a: any) => [a.id, a.name, a.active])).toEqual([[A, 'First', true], [B, '', false]]);
  expect(list.body.accounts[0].quotas['GLM-5.3'].remaining).toBe(1000);
  for (const text of [list.text, JSON.stringify(publicSettings()), (await admin('/admin/state')).text]) { expect(text).not.toContain(tokenA); expect(text).not.toContain(tokenB); }
  expect(redactError('failed with ' + tokenA)).not.toContain(tokenA);
  expect(settings.zai!.accounts[1].deviceMid).toMatch(/^[0-9a-f-]{36}$/);
  // The copy for sharing is AutoZCoder's format and imports back as the same account.
  const copy = (await admin('/admin/zai/export', { id: A })).body;
  expect(copy).toEqual({ format: 'autozcoder-account', version: 1, account_id: A, email: 'a@example.test', name: 'First', device_mid: 'device-a', access_token: tokenA, expires_at_ms: 0 });
  expect(zai.parseImport(JSON.stringify(copy))).toMatchObject({ id: A, token: tokenA, deviceMid: 'device-a' });
  expect((await admin('/admin/zai/import', { text: JSON.stringify(copy) })).body.updated).toBe(true);
  expect(settings.zai!.accounts).toHaveLength(2);
  // The built-in provider cannot be added again or deleted, and its models appear once an account is on.
  expect((await admin('/admin/providers/delete', { id: ZAI_ID })).status).toBe(400);
  await admin('/admin/discover', {});
  expect(['zai/GLM-5.3', 'zai/GLM-5.3-Flash'].every(id => models.has(id))).toBe(true);
});

test('a chat goes out as the ZCode app with the account\'s token and device, and comes back as an OpenAI answer', async () => {
  const r = await chat(); const body: any = await r.json();
  expect(r.status).toBe(200); expect(body.choices[0].message.content).toBe('hello'.repeat(10));
  const out = sent.at(-1)!;
  expect(out.token).toBe(tokenA);
  expect(out.headers).toMatchObject({ 'user-agent': expect.stringMatching(/^ZCode\/3\.16\.3 /), 'x-zcode-agent': 'glm', 'anthropic-version': '2023-06-01', 'x-title': 'Z Code@electron' });
  expect(out.headers['x-device-mid']).toBeUndefined();
  expect(JSON.parse(out.body.metadata.user_id).device_id).toBe('device-a');
  expect(out.body.system[0].text).toBe(zai.ZCODE_IDENTITY); expect(out.body.system.at(-1).text).toBe('Be brief.');
});

test('quota running out pauses that model on that account and says so; Polygate does not move to another Z.ai account', async () => {
  modes.set(tokenA, 'quota'); const before = sent.length;
  const r = await chat(); const body: any = await r.json();
  expect(r.status).toBe(429); expect(body.error.message).toMatch(/no GLM-5\.3 quota left.*does not switch Z\.ai accounts/s);
  expect(sent.slice(before).map(s => s.token)).toEqual([tokenA]);
  expect(settings.zai!.accounts[0].exhausted!['GLM-5.3']).toBeGreaterThan(Date.now());
  // Asking again sends nothing: the pause is known.
  await chat(); expect(sent.slice(before).map(s => s.token)).toEqual([tokenA]);
  // A check reads the same refusal as this model's own allowance, so a run over Z.ai goes on to the next model. Nothing is sent for it.
  const { probeResult } = await import('../backend/gateway'); const glm = models.get('zai/GLM-5.3')!; glm.cooldownUntil = 0;
  expect(await probeResult('zai/GLM-5.3')).toMatchObject({ status: 429, scope: 'model' }); expect(sent.slice(before).map(s => s.token)).toEqual([tokenA]);
  glm.cooldownUntil = 0; glm.state = 'unchecked';
  // The user chooses the other account: the pause from the first one no longer holds the model back.
  expect((await admin('/admin/zai/account', { id: B, active: true })).body.active).toBe(B);
  const ok = await chat(); expect(ok.status).toBe(200); expect(sent.at(-1)!.token).toBe(tokenB);
  await admin('/admin/zai/account', { id: A, active: true }); delete settings.zai!.accounts[0].exhausted!['GLM-5.3'];
});

test('a block for unusual activity stops that account for that model until cleared, with no other account tried', async () => {
  modes.set(tokenA, 'block'); const before = sent.length;
  const r = await chat(); const body: any = await r.json();
  expect(r.status).toBe(503); expect(body.error.message).toMatch(/blocked account "First" for GLM-5\.3.*does not switch to another account/s);
  expect(sent.slice(before).map(s => s.token)).toEqual([tokenA]);
  expect(settings.zai!.accounts[0].blocked!['GLM-5.3'].message).toMatch(/unusual activity/);
  // Flash on the same account is still served.
  modes.delete(tokenA); expect((await chat('zai/GLM-5.3-Flash')).status).toBe(200);
  reset(); expect((await chat()).status).toBe(503); expect(sent.slice(before).filter(s => s.body.model === 'GLM-5.3')).toHaveLength(1);
  await admin('/admin/zai/account', { id: A, clearBlock: 'GLM-5.3' });
  expect((await chat()).status).toBe(200);
});

test('a rejected token marks the account; an overload is retried like the ZCode app; a cut stream is not a success', async () => {
  overloads = 2; modes.set(tokenA, 'overload'); const before = sent.length;
  expect((await chat()).status).toBe(200); expect(sent.length - before).toBe(3);
  modes.set(tokenA, 'truncated'); expect((await chat()).status).not.toBe(200);
  modes.set(tokenA, 'dead'); reset();
  const r = await chat(); expect(r.status).toBe(503); expect(((await r.json()) as any).error.message).toMatch(/"First".*rejected (the|its) token/);
  expect(settings.zai!.accounts[0].problem).toMatch(/401/);
  // A good token imported again clears it.
  modes.delete(tokenA); expect((await admin('/admin/zai/import', { text: copyA })).status).toBe(200); expect(settings.zai!.accounts[0].problem).toBeUndefined();
  expect(zai.overloadDelay(1, 5000)).toBe(5000); expect(zai.overloadDelay(10)).toBeLessThanOrEqual(60000); expect(zai.overloadDelay(1)).toBeGreaterThanOrEqual(1000);
});

test('switching an account off takes it out of use, and removing it deletes its token', async () => {
  await admin('/admin/zai/account', { id: A, enabled: false });
  expect((await admin('/admin/zai')).body.active).toBe('');
  expect(((await (await chat()).json()) as any).error.message).toMatch(/No Z\.ai account is active/);
  expect((await admin('/admin/zai/account', { id: A, active: true })).status).toBe(400);
  await admin('/admin/zai/remove', { id: B });
  expect(settings.zai!.accounts.map(a => a.id)).toEqual([A]); expect(JSON.stringify(settings.zai)).not.toContain(tokenB);
});

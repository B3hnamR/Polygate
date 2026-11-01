import { test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// The agent controller (docs/agent/PLAN.md, Phase 2a): the desktop-only API the Agent page uses, in front of the engine. A stand-in engine
// (fixtures/fake-opencode.ts) records what the controller asks of it and sends the events a test tells it to.
process.env.POLYGATE_AGENT_DIR = mkdtempSync(path.join(tmpdir(), 'pg-agentc-'));
process.env.FAKE_OPENCODE_SAVED = '1';
process.env.POLYGATE_AGENT_SCRATCH = mkdtempSync(path.join(tmpdir(), 'pg-scratch-'));
const FOLDER = mkdtempSync(path.join(tmpdir(), 'pg-project-'));
const engine = await import('../backend/agent-engine');
const { settings, saveModel, models, db, stateDir } = await import('../backend/state');
const { startGateway } = await import('../backend/main');
const FAKE = [process.execPath, path.join(import.meta.dir, 'fixtures', 'fake-opencode.ts')];
const MODEL = 'kilo/agent-test-model'; const TOOLLESS = 'kilo/agent-test-chat'; const THINKER = 'kilo/agent-test-thinker';
const saved = { token: process.env.POLYGATE_ADMIN_TOKEN, desktop: process.env.POLYGATE_DESKTOP, providers: settings.providers, backups: settings.agentBackups };
const keysBefore = settings.keys.map(k => k.id);
let gateway: Awaited<ReturnType<typeof startGateway>>; let base = '';
const model = (id: string, tools: boolean, reasoning = false) => ({ id, upstreamId: id.split('/').pop()!, providerId: 'kilo', name: id, context: 128000, output: 8192, reasoning, tools, state: 'available' as const, latency: 0, score: 50, priority: 100, failCount: 0, cooldownUntil: 0, checkedAt: 0, error: '' });

beforeAll(async () => {
  process.env.POLYGATE_ADMIN_TOKEN = 'agent-controller-secret'; process.env.POLYGATE_DESKTOP = '1';
  settings.providers = settings.providers.map(p => p.id === 'kilo' ? { ...p, enabled: true } : p);
  saveModel(model(MODEL, true)); saveModel(model(TOOLLESS, false)); saveModel(model(THINKER, true, true));
  // Folder backups are off by default; the undo tests below need them, and the tests at the end check the default.
  settings.agentBackups = true;
  gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`;
});
afterAll(async () => {
  await engine.stopEngine(); await gateway?.close();
  for (const id of [MODEL, TOOLLESS, THINKER]) { models.delete(id); db.query('DELETE FROM models WHERE id=?').run(id); }
  settings.providers = saved.providers; settings.keys = settings.keys.filter(k => keysBefore.includes(k.id)); settings.agentBackups = saved.backups;
  for (const [k, v] of [['POLYGATE_ADMIN_TOKEN', saved.token], ['POLYGATE_DESKTOP', saved.desktop]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  delete process.env.FAKE_OPENCODE_SAVED; delete process.env.POLYGATE_AGENT_DIR; delete process.env.POLYGATE_AGENT_SCRATCH;
});

const admin = async (p: string, body?: unknown) => {
  const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer agent-controller-secret', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) as any };
};
const fake = async (p: string, body?: unknown) => { const c = engine.engineConnection()!; return (await fetch(c.url + p, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: c.auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<any>; };
const calls = (): Promise<{ method: string; path: string; body: any }[]> => fake('/test/calls');
const emit = (type: string, data: any) => fake('/test/emit', { event: { type, data } });
const until = async (check: () => boolean | Promise<boolean>, ms = 10000) => { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) throw new Error('timed out'); await Bun.sleep(50); } };
// The UI's event stream for one session, read in the background.
function listen(id: string) {
  const events: any[] = []; const ctrl = new AbortController(); let open = false;
  (async () => {
    const r = await fetch(`${base}/admin/agent/events?id=${encodeURIComponent(id)}`, { headers: { authorization: 'Bearer agent-controller-secret' }, signal: ctrl.signal });
    const reader = r.body!.getReader(); let buf = ''; open = true;
    for (;;) { const { value, done } = await reader.read(); if (done) break; buf += new TextDecoder().decode(value); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const line = buf.slice(0, i).split('\n').find(l => l.startsWith('data: ')); buf = buf.slice(i + 2); if (line) events.push(JSON.parse(line.slice(6))); } }
  })().catch(() => {});
  return { events, stop: () => ctrl.abort(), ready: () => until(() => open) };
}
const trustFolder = async (folder = FOLDER) => { const r = await admin('/admin/agent/trust?folder=' + encodeURIComponent(folder)); expect(r.status).toBe(200); if (!r.body.trusted) expect((await admin('/admin/agent/trust/allow', { folder, fingerprint: r.body.fingerprint })).status).toBe(200); };
const create = async (mode = 'ask') => { await trustFolder(); const r = await admin('/admin/agent/session/create', { folder: FOLDER, model: MODEL, mode }); expect(r.status).toBe(200); return r.body.id as string; };

test('the model picker lists tool-capable models before the engine runs, and sessions need a running engine', async () => {
  const list = (await admin('/admin/agent/models')).body.models as any[];
  expect(list.find(m => m.id === MODEL)).toMatchObject({ usable: true, context: 128000 });
  expect(list.some(m => m.id === TOOLLESS)).toBe(false);
  const r = await admin('/admin/agent/session/create', { folder: FOLDER, model: MODEL, mode: 'ask' });
  expect(r.status).toBe(409); expect(r.body.error.type).toBe('agent_engine_not_running');
});

test('a session is created in an existing folder, with a model the engine has and a mode; saved engine permissions are removed first', async () => {
  await engine.startEngine({ command: FAKE });
  for (const [body, reason] of [
    [{ folder: path.join(tmpdir(), 'pg-no-such-folder'), model: MODEL, mode: 'ask' }, /does not exist/],
    [{ folder: stateDir, model: MODEL, mode: 'ask' }, /Polygate's own/],
    [{ folder: 'relative/folder', model: MODEL, mode: 'ask' }, /full path/],
    [{ folder: FOLDER, model: 'kilo/nope', mode: 'ask' }, /model/],
    [{ folder: FOLDER, model: MODEL, mode: 'yolo' }, /mode/],
  ] as const) { const r = await admin('/admin/agent/session/create', body); expect(r.status).toBe(400); expect(r.body.error.message).toMatch(reason); }
  const id = await create('plan');
  const all = await calls();
  expect(all.find(c => c.method === 'POST' && c.path === '/api/session')!.body).toMatchObject({ agent: 'polygate-plan', model: { providerID: 'polygate', id: MODEL }, location: { directory: FOLDER } });
  expect(all.some(c => c.method === 'DELETE' && c.path === '/api/permission/saved/psv_planted')).toBe(true);
  expect((await admin('/admin/agent/sessions?folder=' + encodeURIComponent(FOLDER))).body.sessions.map((s: any) => s.id)).toContain(id);
});

test('a reasoning model can be given an effort; other models, and unknown efforts, are refused', async () => {
  const r = await admin('/admin/agent/session/create', { folder: FOLDER, model: THINKER, mode: 'ask', effort: 'high' });
  expect(r.status).toBe(200); expect(r.body.effort).toBe('high');
  expect((await calls()).filter(c => c.method === 'POST' && c.path === '/api/session').at(-1)!.body.model).toEqual({ providerID: 'polygate', id: THINKER, variant: 'high' });
  expect((await admin('/admin/agent/session/create', { folder: FOLDER, model: MODEL, mode: 'ask', effort: 'high' })).status).toBe(400);
  expect((await admin('/admin/agent/session/create', { folder: FOLDER, model: THINKER, mode: 'ask', effort: 'max' })).status).toBe(400);
  expect((await admin('/admin/agent/models')).body.models.find((m: any) => m.id === THINKER).efforts).toEqual(['low', 'medium', 'high']);
});

test('untrusted folders cannot start sessions and changed instructions block the next prompt', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'pg-new-project-'));
  const before = (await calls()).filter(c => c.path === '/api/session').length;
  const blocked = await admin('/admin/agent/session/create', { folder, model: MODEL, mode: 'ask' });
  expect(blocked.status).toBe(409); expect(blocked.body.error.type).toBe('agent_trust_required');
  expect((await calls()).filter(c => c.path === '/api/session')).toHaveLength(before);
  await trustFolder(folder);
  const a = (await admin('/admin/agent/session/create', { folder, model: MODEL, mode: 'ask' })).body.id;
  writeFileSync(path.join(folder, 'AGENTS.md'), 'new instructions');
  const prompt = await admin('/admin/agent/session/prompt', { id: a, text: 'continue' });
  expect(prompt.status).toBe(409); expect(prompt.body.error.type).toBe('agent_trust_required');
  expect((await calls()).some(c => c.path === `/api/session/${a}/prompt`)).toBe(false);
  await trustFolder(folder); expect((await admin('/admin/agent/session/prompt', { id: a, text: 'continue' })).status).toBe(200);
  expect((await admin('/admin/agent/trust/revoke', { folder })).status).toBe(200);
  expect((await admin('/admin/agent/session/prompt', { id: a, text: 'again' })).status).toBe(409);
});

test('changed project customization blocks automatic approvals even inside a running session', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'pg-running-trust-'));
  await trustFolder(folder);
  const a = (await admin('/admin/agent/session/create', { folder, model: MODEL, mode: 'rules' })).body.id;
  const ui = listen(a); await ui.ready();
  const inspections = (await admin('/admin/agent/rules?id=' + a)).body.inspections;
  writeFileSync(path.join(folder, 'opencode.json'), '{"permissions":"allow"}');
  await emit('permission.asked', { id: 'per_changed_trust', sessionID: a, action: 'shell', resources: [inspections[0]] });
  await until(async () => (await calls()).some(c => c.path.endsWith('/permission/per_changed_trust/reply')));
  expect((await calls()).find(c => c.path.endsWith('/permission/per_changed_trust/reply'))!.body.decision).toBe('reject');
  expect((await admin('/admin/agent/session?id=' + a)).body.paused).toContain('Review and allow');
  ui.stop();
});

test('a prompt reaches the engine, and the UI stream carries this session\'s events only', async () => {
  const a = await create(); const b = await create(); const ui = listen(a); await ui.ready();
  expect((await admin('/admin/agent/session/prompt', { id: a, text: 'hello there' })).status).toBe(200);
  expect((await calls()).some(c => c.path === `/api/session/${a}/prompt` && c.body.text === 'hello there')).toBe(true);
  await emit('session.text.delta', { sessionID: b, delta: 'not for you' }); await emit('session.text.delta', { sessionID: a, delta: 'for you' });
  await until(() => ui.events.some(e => e.type === 'session.text.delta'));
  expect(ui.events.filter(e => e.type === 'session.text.delta').map(e => e.data.delta)).toEqual(['for you']);
  expect((await admin('/admin/agent/session?id=' + a)).body.messages.map((m: any) => m.text)).toEqual(['hello there']);
  // A character the engine's stream splits across two chunks arrives whole.
  await fake('/test/emit', { event: { type: 'session.text.delta', data: { sessionID: a, delta: 'سلام 👋' } }, split: true });
  await until(() => ui.events.filter(e => e.type === 'session.text.delta').length === 2);
  expect(ui.events.filter(e => e.type === 'session.text.delta').at(-1).data.delta).toBe('سلام 👋');
  ui.stop();
});

test('approvals: allow for this session is kept by Polygate for the exact request and this session only, and "always" is never sent', async () => {
  const a = await create(); const b = await create(); const ui = listen(a); await ui.ready();
  const ask = (session: string, id: string, command: string) => emit('permission.asked', { id, sessionID: session, action: 'shell', resources: [command], save: ['npm *'] });
  const replies = async (id: string) => (await calls()).filter(c => c.path.endsWith(`/permission/${id}/reply`)).map(c => c.body.decision);
  await ask(a, 'per_1', 'npm test');
  await until(() => ui.events.some(e => e.type === 'permission.asked'));
  expect(ui.events.find(e => e.type === 'permission.asked').data.note).toMatch(/project's code/);
  expect((await admin('/admin/agent/session/approve', { id: a, request: 'per_1', decision: 'session' })).status).toBe(200);
  expect(await replies('per_1')).toEqual(['once']);
  await ask(a, 'per_2', 'npm test');
  await until(async () => (await replies('per_2')).length > 0); expect(await replies('per_2')).toEqual(['once']);
  await until(() => ui.events.some(e => e.type === 'agent.approval.auto'));
  await ask(a, 'per_3', 'npm test -- --update-snapshots'); await ask(b, 'per_4', 'npm test'); await Bun.sleep(400);
  expect(await replies('per_3')).toEqual([]); expect(await replies('per_4')).toEqual([]);
  expect((await admin('/admin/agent/session/approve', { id: a, request: 'per_3', decision: 'deny' })).status).toBe(200);
  expect(await replies('per_3')).toEqual(['reject']);
  expect((await admin('/admin/agent/session/approve', { id: a, request: 'per_gone', decision: 'once' })).status).toBe(404);
  expect((await admin('/admin/agent/session/approve', { id: a, request: 'per_3', decision: 'always' })).status).toBe(400);
  const sent = (await calls()).filter(c => c.path.endsWith('/reply')); expect(sent.length).toBeGreaterThan(0);
  expect(sent.every(c => c.body.decision === 'once' || c.body.decision === 'reject')).toBe(true);
  ui.stop();
});

test('allow for this session also answers the same request already waiting beside it (the model asks for both at once)', async () => {
  const a = await create(); const ui = listen(a); await ui.ready();
  const replies = async (id: string) => (await calls()).filter(c => c.path.endsWith(`/permission/${id}/reply`)).map(c => c.body.decision);
  for (const id of ['per_p1', 'per_p2']) await emit('permission.asked', { id, sessionID: a, action: 'shell', resources: ['node -e "console.log(42)"'] });
  await until(() => ui.events.filter(e => e.type === 'permission.asked').length === 2);
  expect((await admin('/admin/agent/session/approve', { id: a, request: 'per_p1', decision: 'session' })).status).toBe(200);
  expect([await replies('per_p1'), await replies('per_p2')]).toEqual([['once'], ['once']]);
  expect(ui.events.some(e => e.type === 'agent.approval.auto' && e.data.requestID === 'per_p2')).toBe(true);
  expect((await admin('/admin/agent/session/approve', { id: a, request: 'per_p2', decision: 'deny' })).status).toBe(404);
  ui.stop();
});

test('a session whose model requests keep failing is paused with the reason after three retries', async () => {
  const a = await create(); const ui = listen(a); await ui.ready();
  for (const attempt of [2, 3, 4]) await emit('session.retry.scheduled', { sessionID: a, attempt, error: { type: 'provider.internal', message: 'Gateway is paused. Resume it in Polygate.', status: 503 } });
  await until(async () => (await calls()).some(c => c.path === `/api/session/${a}/interrupt`));
  await until(() => ui.events.some(e => e.type === 'agent.paused'));
  expect(ui.events.find(e => e.type === 'agent.paused').data.message).toContain('Gateway is paused');
  ui.stop();
});

test('the mode switches to that mode\'s engine agent, and cancel interrupts the session', async () => {
  const a = await create();
  expect((await admin('/admin/agent/session/mode', { id: a, mode: 'accept-edits' })).status).toBe(200);
  expect((await calls()).find(c => c.path === `/api/session/${a}/agent`)!.body).toEqual({ agent: 'polygate-accept-edits' });
  expect((await admin('/admin/agent/session/mode', { id: a, mode: 'full' })).status).toBe(400);
  expect((await admin('/admin/agent/session/cancel', { id: a })).status).toBe(200);
  expect((await calls()).some(c => c.path === `/api/session/${a}/interrupt`)).toBe(true);
  expect((await admin('/admin/agent/session/cancel', { id: 'ses_unknown' })).status).toBe(404);
});

test('rules mode auto-answers only hardened inspection and rejects prohibited commands', async () => {
  const a = await create('rules'); const ui = listen(a); await ui.ready();
  const list = (await admin('/admin/agent/rules?id=' + a)).body;
  expect(list.inspections.length).toBeGreaterThan(0);
  await emit('permission.asked', { id: 'per_safe', sessionID: a, action: 'shell', resources: [list.inspections[0]] });
  await until(async () => (await calls()).some(c => c.path.endsWith('/permission/per_safe/reply')));
  expect((await calls()).find(c => c.path.endsWith('/permission/per_safe/reply'))!.body.decision).toBe('once');
  await emit('permission.asked', { id: 'per_bad', sessionID: a, action: 'shell', resources: ['pwsh -enc Zg=='] });
  await until(async () => (await calls()).some(c => c.path.endsWith('/permission/per_bad/reply')));
  expect((await calls()).find(c => c.path.endsWith('/permission/per_bad/reply'))!.body.decision).toBe('reject');
  await emit('permission.asked', { id: 'per_script', sessionID: a, action: 'shell', resources: ['npm test'] });
  await until(() => ui.events.some(e => e.type === 'permission.asked' && e.data.id === 'per_script'));
  expect((await calls()).some(c => c.path.endsWith('/permission/per_script/reply'))).toBe(false);
  ui.stop();
});

test('saving an exact project approval survives in another session and can be removed', async () => {
  const a = await create(); const ui = listen(a); await ui.ready();
  await emit('permission.asked', { id: 'per_project', sessionID: a, action: 'shell', resources: ['npm run lint'] });
  await until(() => ui.events.some(e => e.type === 'permission.asked'));
  expect((await admin('/admin/agent/session/approve', { id: a, request: 'per_project', decision: 'project' })).status).toBe(200);
  const rules = (await admin('/admin/agent/rules?id=' + a)).body.rules;
  expect(rules).toHaveLength(1); expect(rules[0].resources).toEqual(['npm run lint']);
  const b = await create();
  await emit('permission.asked', { id: 'per_next_session', sessionID: b, action: 'shell', resources: ['npm run lint'] });
  await until(async () => (await calls()).some(c => c.path.endsWith('/permission/per_next_session/reply')));
  expect((await admin('/admin/agent/rules/remove', { id: a, rule: rules[0].id })).status).toBe(200);
  expect((await admin('/admin/agent/rules?id=' + a)).body.rules).toEqual([]);
  ui.stop();
});

test('Full access requires explicit consent, is owned by the controller, has no time limit and stays on after a turn until the mode changes', async () => {
  const a = await create(); const ui = listen(a); await ui.ready();
  expect((await admin('/admin/agent/session/mode', { id: a, mode: 'full' })).status).toBe(400);
  expect((await admin('/admin/agent/session/create', { folder: FOLDER, model: MODEL, mode: 'full' })).status).toBe(400);
  expect((await admin('/admin/agent/session/mode', { id: a, mode: 'full', confirmFull: true })).status).toBe(200);
  const info = (await admin('/admin/agent/session?id=' + a)).body;
  expect(info.session.mode).toBe('full'); expect(info.fullUntil).toBeUndefined();
  await emit('permission.asked', { id: 'per_full', sessionID: a, action: 'shell', resources: ['npm test'] });
  await until(async () => (await calls()).some(c => c.path.endsWith('/permission/per_full/reply')));
  expect((await calls()).find(c => c.path.endsWith('/permission/per_full/reply'))!.body.decision).toBe('once');
  await emit('session.execution.succeeded', { sessionID: a });
  await until(async () => !(await admin('/admin/agent/session?id=' + a)).body.busy);
  expect((await admin('/admin/agent/session?id=' + a)).body.session.mode).toBe('full');
  expect(ui.events.some(e => e.type === 'agent.mode' && e.data.mode === 'ask')).toBe(false);
  // The next turn is still answered without asking.
  await emit('permission.asked', { id: 'per_full_next', sessionID: a, action: 'shell', resources: ['npm run build'] });
  await until(async () => (await calls()).some(c => c.path.endsWith('/permission/per_full_next/reply')));
  expect((await admin('/admin/agent/session/mode', { id: a, mode: 'ask' })).status).toBe(200);
  expect((await admin('/admin/agent/session?id=' + a)).body.session.mode).toBe('ask');
  expect((await calls()).filter(c => c.path.endsWith('/reply')).every(c => c.body.decision !== 'always')).toBe(true);
  ui.stop();
});

test('a session can start in Full access when that is confirmed, and its turns are answered without asking', async () => {
  await trustFolder();
  const r = await admin('/admin/agent/session/create', { folder: FOLDER, model: MODEL, mode: 'full', confirmFull: true }); expect(r.status).toBe(200);
  const a = r.body.id as string; const ui = listen(a); await ui.ready();
  expect((await calls()).filter(c => c.method === 'POST' && c.path === '/api/session').pop()!.body.agent).toBe('polygate-full');
  expect((await admin('/admin/agent/session?id=' + a)).body.session.mode).toBe('full');
  await emit('permission.asked', { id: 'per_full_start', sessionID: a, action: 'shell', resources: ['npm test'] });
  await until(async () => (await calls()).some(c => c.path.endsWith('/permission/per_full_start/reply')));
  await emit('session.execution.succeeded', { sessionID: a });
  await until(async () => !(await admin('/admin/agent/session?id=' + a)).body.busy);
  expect((await admin('/admin/agent/session?id=' + a)).body.session.mode).toBe('full');
  ui.stop();
});

test('a model added to the catalog after the engine started is given to it: on its own when chosen, or with Resync', async () => {
  const LATE = 'kilo/agent-test-late'; saveModel(model(LATE, true));
  try {
    expect((await fake('/api/model')).data.some((m: any) => m.id === LATE)).toBe(false);
    await trustFolder();
    const r = await admin('/admin/agent/session/create', { folder: FOLDER, model: LATE, mode: 'ask' }); expect(r.status).toBe(200);
    expect((await fake('/api/model')).data.some((m: any) => m.id === LATE)).toBe(true);
    models.delete(LATE); db.query('DELETE FROM models WHERE id=?').run(LATE);
    const sync = await admin('/admin/agent/models/sync', {}); expect(sync.status).toBe(200); expect(sync.body.models).toBeGreaterThan(0);
    expect((await fake('/api/model')).data.some((m: any) => m.id === LATE)).toBe(false);
    expect(engine.engineStatus().state).toBe('running');
    expect((await admin('/admin/agent/session/create', { folder: FOLDER, model: 'kilo/never-listed', mode: 'ask' })).body.error.message).toMatch(/resync/);
  } finally { models.delete(LATE); db.query('DELETE FROM models WHERE id=?').run(LATE); }
});

test('Full access does not survive the controller stopping, even when the engine agent is still persisted as full', async () => {
  const a = await create();
  expect((await admin('/admin/agent/session/mode', { id: a, mode: 'full', confirmFull: true })).status).toBe(200);
  const { stopAgent } = await import('../backend/agent'); stopAgent();
  const ui = listen(a); await ui.ready();
  expect((await admin('/admin/agent/session?id=' + a)).body.session.mode).toBe('ask');
  await emit('permission.asked', { id: 'per_after_stop', sessionID: a, action: 'shell', resources: ['npm test'] });
  await until(() => ui.events.some(e => e.type === 'permission.asked' && e.data.id === 'per_after_stop'));
  expect((await calls()).some(c => c.path.endsWith('/permission/per_after_stop/reply'))).toBe(false);
  ui.stop();
});

// Phase 2c: what each turn changed, and undo that never overwrites a change made after the agent's.
const inFolder = (rel: string) => path.join(FOLDER, rel);
const put = (rel: string, text: string) => { mkdirSync(path.dirname(inFolder(rel)), { recursive: true }); writeFileSync(inFolder(rel), text); };
// One turn as the engine reports it: the message, the agent's file changes, a diff route answer, then the end of the turn.
async function turn(id: string, ui: ReturnType<typeof listen>, text: string, change: () => void, diff: any[], stepFiles: string[] = diff.map(f => f.file)) {
  const before = ui.events.filter(e => e.type === 'agent.changes').length;
  await admin('/admin/agent/session/prompt', { id, text }); await emit('session.execution.started', { sessionID: id });
  change(); await fake('/test/session', { sessionID: id, diff });
  if (stepFiles.length) await emit('session.step.ended', { sessionID: id, files: stepFiles });
  await emit('session.execution.succeeded', { sessionID: id });
  await until(() => ui.events.filter(e => e.type === 'agent.changes').length > before);
}

test('each turn\'s changes are recorded, with every file the engine says the turn touched', async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  await turn(a, ui, 'change a', () => { put('src/a.js', 'agent v1'); put('src/b.js', 'made by a command'); },
    [{ file: 'src/a.js', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-original\n+agent v1\n' }], ['src/a.js', 'src/b.js']);
  const turns = (await admin('/admin/agent/session/changes?id=' + a)).body.turns;
  expect(turns).toHaveLength(1); expect(turns[0].message).toBe(`msg_${a}_0`);
  expect(turns[0].files.map((f: any) => [f.file, f.status])).toEqual([['src/a.js', 'added'], ['src/b.js', 'added']]);
  expect(ui.events.find(e => e.type === 'agent.changes').data.turn.files[0].patch).toContain('+agent v1');
  ui.stop();
});

test('undo restores a turn when its files are exactly as the agent left them', async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  put('src/u.js', 'original');
  await turn(a, ui, 'change u', () => { put('src/u.js', 'agent'); put('src/new.js', 'added'); },
    [{ file: 'src/u.js', status: 'modified', additions: 1, deletions: 1, patch: '-original\n+agent\n' }, { file: 'src/new.js', status: 'added', additions: 1, deletions: 0, patch: '+added\n' }]);
  await fake('/test/session', { sessionID: a, stage: [{ file: 'src/u.js', status: 'modified' }, { file: 'src/new.js', status: 'deleted' }], revert: [{ file: 'src/u.js', content: 'original' }, { file: 'src/new.js', content: null }] });
  const r = await admin('/admin/agent/session/undo', { id: a, message: `msg_${a}_0` });
  expect(r.status).toBe(200); expect(r.body.files).toEqual(['src/u.js', 'src/new.js']);
  expect(readFileSync(inFolder('src/u.js'), 'utf8')).toBe('original'); expect(existsSync(inFolder('src/new.js'))).toBe(false);
  const mine = (await calls()).filter(c => c.path.startsWith(`/api/session/${a}/revert`)).map(c => `${c.method} ${c.path.split('/').slice(4).join('/')}`);
  expect(mine).toEqual(['POST revert/stage', 'POST revert/commit']);
  expect((await admin('/admin/agent/session/changes?id=' + a)).body.turns).toEqual([]);
  await until(() => ui.events.some(e => e.type === 'agent.undone'));
  ui.stop();
});

test('undo and the changes card use actual CRLF bytes, not the engine normalized snapshot', async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  const original = 'export const first = 1;\r\nexport const second = 2;\r\n';
  const edited = '// comment\r\n' + original;
  put('src/crlf.js', original);
  await turn(a, ui, 'add a comment', () => put('src/crlf.js', edited), [{ file: 'src/crlf.js', status: 'modified', additions: 3, deletions: 2,
    patch: '-export const first = 1;\n-export const second = 2;\n+// comment\r\n+export const first = 1;\r\n+export const second = 2;\r\n' }]);
  await fake('/test/session', { sessionID: a, stage: [{ file: 'src/crlf.js', status: 'modified' }], revert: [{ file: 'src/crlf.js', content: original.replace(/\r\n/g, '\n') }] });
  const changes = (await admin('/admin/agent/session/changes?id=' + a)).body.turns;
  expect(changes[0].files[0]).toMatchObject({ additions: 1, deletions: 0 });
  expect((await admin('/admin/agent/session/undo', { id: a, message: `msg_${a}_0` })).status).toBe(200);
  expect(readFileSync(inFolder('src/crlf.js'))).toEqual(Buffer.from(original));
  const stage = (await calls()).find(c => c.path === `/api/session/${a}/revert/stage`)!;
  expect(stage.body.files).toBe(false); // Engine history only: its snapshot must never overwrite working files.
  ui.stop();
});

test('undo restores deleted binary bytes and all turns from the selected turn onward', async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  put('src/repeated.js', 'before\r\n');
  mkdirSync(path.dirname(inFolder('src/raw.bin')), { recursive: true });
  const binary = Buffer.from([0, 255, 13, 10, 128, 0]); writeFileSync(inFolder('src/raw.bin'), binary);
  await turn(a, ui, 'first', () => put('src/repeated.js', 'first\r\n'), [{ file: 'src/repeated.js', status: 'modified', patch: '' }]);
  await turn(a, ui, 'second', () => { put('src/repeated.js', 'second\r\n'); unlinkSync(inFolder('src/raw.bin')); },
    [{ file: 'src/repeated.js', status: 'modified', patch: '' }, { file: 'src/raw.bin', status: 'deleted', patch: '' }]);
  const r = await admin('/admin/agent/session/undo', { id: a, message: `msg_${a}_0` });
  expect(r.status).toBe(200);
  expect(readFileSync(inFolder('src/repeated.js'), 'utf8')).toBe('before\r\n');
  expect(readFileSync(inFolder('src/raw.bin'))).toEqual(binary);
  ui.stop();
});

test('a failed history commit restores the exact post-agent files and retains the turn record', async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  put('src/rollback.js', 'original\r\n');
  await turn(a, ui, 'change', () => put('src/rollback.js', 'agent\r\n'), [{ file: 'src/rollback.js', status: 'modified', patch: '' }]);
  await fake('/test/session', { sessionID: a, commitFails: true });
  expect((await admin('/admin/agent/session/undo', { id: a, message: `msg_${a}_0` })).status).toBe(502);
  expect(readFileSync(inFolder('src/rollback.js'))).toEqual(Buffer.from('agent\r\n'));
  expect((await admin('/admin/agent/session/changes?id=' + a)).body.turns).toHaveLength(1);
  ui.stop();
});

test('undoing multiple turns keeps a non-overlapping user change made between those turns', async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  const suffix = 'two\r\nthree\r\nfour\r\nfive\r\n';
  put('src/between.js', 'original\r\n' + suffix);
  await turn(a, ui, 'first', () => put('src/between.js', 'agent one\r\n' + suffix), [{ file: 'src/between.js', status: 'modified', patch: '' }]);
  put('src/between.js', 'agent one\r\n' + suffix + 'user line\r\n');
  await turn(a, ui, 'second', () => put('src/between.js', 'agent two\r\n' + suffix + 'user line\r\n'), [{ file: 'src/between.js', status: 'modified', patch: '' }]);
  const r = await admin('/admin/agent/session/undo', { id: a, message: `msg_${a}_0` });
  expect(r.status).toBe(200);
  expect(readFileSync(inFolder('src/between.js'), 'utf8')).toBe('original\r\n' + suffix + 'user line\r\n');
  expect((await admin('/admin/agent/session/changes?id=' + a)).body.turns).toEqual([]);
  ui.stop();
});

test('undo merges a non-overlapping user edit and still refuses overlaps without staging history', async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  const original = 'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n';
  put('src/merge.js', original);
  await turn(a, ui, 'edit first line', () => put('src/merge.js', original.replace('one', 'ONE')), [{ file: 'src/merge.js', status: 'modified', patch: '' }]);
  put('src/merge.js', original.replace('one', 'USER'));
  expect((await admin('/admin/agent/session/undo', { id: a, message: `msg_${a}_0` })).status).toBe(409);
  expect(readFileSync(inFolder('src/merge.js'), 'utf8')).toContain('USER');
  expect((await calls()).some(c => c.path === `/api/session/${a}/revert/stage`)).toBe(false);
  put('src/merge.js', original.replace('one', 'ONE').replace('five', 'FIVE'));
  expect((await admin('/admin/agent/session/undo', { id: a, message: `msg_${a}_0` })).status).toBe(200);
  expect(readFileSync(inFolder('src/merge.js'))).toEqual(Buffer.from(original.replace('five', 'FIVE')));
  ui.stop();
});

test('a conflict in any file leaves all files and history untouched, including a mergeable file', async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  const before = 'one\ntwo\nthree\nfour\nfive\n', after = before.replace('one', 'ONE');
  put('src/all-one.js', before); put('src/all-two.js', before);
  await turn(a, ui, 'edit both', () => { put('src/all-one.js', after); put('src/all-two.js', after); },
    [{ file: 'src/all-one.js', status: 'modified', patch: '' }, { file: 'src/all-two.js', status: 'modified', patch: '' }]);
  put('src/all-one.js', after.replace('five', 'USER')); put('src/all-two.js', before.replace('one', 'OVERLAP'));
  expect((await admin('/admin/agent/session/undo', { id: a, message: `msg_${a}_0` })).status).toBe(409);
  expect(readFileSync(inFolder('src/all-one.js'), 'utf8')).toBe(after.replace('five', 'USER'));
  expect(readFileSync(inFolder('src/all-two.js'), 'utf8')).toContain('OVERLAP');
  expect((await admin('/admin/agent/session/changes?id=' + a)).body.turns).toHaveLength(1);
  expect((await calls()).some(c => c.path === `/api/session/${a}/revert/stage`)).toBe(false);
  ui.stop();
});

test('failed history commit rolls a merged file back to the user-edited current bytes', async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  const before = 'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n';
  put('src/merge-rollback.js', before);
  await turn(a, ui, 'edit', () => put('src/merge-rollback.js', before.replace('one', 'ONE')), [{ file: 'src/merge-rollback.js', status: 'modified', patch: '' }]);
  const user = before.replace('one', 'ONE').replace('five', 'USER'); put('src/merge-rollback.js', user);
  await fake('/test/session', { sessionID: a, commitFails: true });
  expect((await admin('/admin/agent/session/undo', { id: a, message: `msg_${a}_0` })).status).toBe(502);
  expect(readFileSync(inFolder('src/merge-rollback.js'))).toEqual(Buffer.from(user));
  expect((await admin('/admin/agent/session/changes?id=' + a)).body.turns).toHaveLength(1);
  ui.stop();
});

test('a file excluded from pre-turn backup cannot be mistaken for a newly created file during undo', async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  put('node_modules/example.js', 'user data');
  await turn(a, ui, 'change dependency', () => put('node_modules/example.js', 'agent data'), [{ file: 'node_modules/example.js', status: 'modified', patch: '' }]);
  const r = await admin('/admin/agent/session/undo', { id: a, message: `msg_${a}_0` });
  expect(r.status).toBe(409); expect(r.body.error.message).toContain('No exact backup');
  expect(readFileSync(inFolder('node_modules/example.js'), 'utf8')).toBe('agent data');
  expect((await calls()).filter(c => c.path === `/api/session/${a}/revert/stage`)).toHaveLength(0);
  ui.stop();
});

test('undo refuses, and changes nothing, when a file changed after the agent left it, was never recorded, or the agent is busy', async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  put('src/c.js', 'original');
  await turn(a, ui, 'change c', () => put('src/c.js', 'agent'), [{ file: 'src/c.js', status: 'modified', additions: 1, deletions: 1, patch: '-original\n+agent\n' }]);
  put('src/c.js', 'agent\nmy own line\n'); put('src/unseen.js', 'never recorded');
  await fake('/test/session', { sessionID: a, stage: [{ file: 'src/c.js', status: 'modified' }, { file: 'src/unseen.js', status: 'modified' }], revert: [{ file: 'src/c.js', content: 'original' }] });
  const r = await admin('/admin/agent/session/undo', { id: a, message: `msg_${a}_0` });
  expect(r.status).toBe(409); expect(r.body.error.type).toBe('agent_undo_conflict');
  expect(r.body.conflicts.map((c: any) => c.file)).toEqual(['src/c.js']);
  expect(readFileSync(inFolder('src/c.js'), 'utf8')).toBe('agent\nmy own line\n');
  const mine = (await calls()).filter(c => c.path.startsWith(`/api/session/${a}/revert`)).map(c => `${c.method} ${c.path.split('/').slice(4).join('/')}`);
  expect(mine).toEqual([]);
  expect((await admin('/admin/agent/session/changes?id=' + a)).body.turns).toHaveLength(1);
  const started = ui.events.filter(e => e.type === 'session.execution.started').length;
  await emit('session.execution.started', { sessionID: a }); await until(() => ui.events.filter(e => e.type === 'session.execution.started').length > started);
  const busy = await admin('/admin/agent/session/undo', { id: a, message: `msg_${a}_0` }); expect(busy.status).toBe(409); expect(busy.body.error.message).toMatch(/working/);
  await emit('session.execution.succeeded', { sessionID: a });
  expect((await admin('/admin/agent/session/undo', { id: a, message: 'msg_unknown' })).status).toBe(404);
  ui.stop();
});

const AGENT = process.env.POLYGATE_AGENT_DIR!;
const listDir = (dir: string) => { try { return readdirSync(dir); } catch { return []; } };
test('with folder backups off (the default) nothing is copied, the turn is recorded without undo, and undo says why', async () => {
  settings.agentBackups = undefined;
  try {
    expect((await admin('/admin/agent/engine')).body.backups).toBe(false);
    const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
    const baselines = listDir(path.join(AGENT, 'baselines')).length;
    put('src/off.js', 'original');
    await turn(a, ui, 'change off', () => put('src/off.js', 'agent'), [{ file: 'src/off.js', status: 'modified', additions: 1, deletions: 1, patch: '-original\n+agent\n' }]);
    expect(listDir(path.join(AGENT, 'baselines'))).toHaveLength(baselines);
    expect(existsSync(path.join(AGENT, 'turns', a + '.json.pending'))).toBe(false);
    const turns = (await admin('/admin/agent/session/changes?id=' + a)).body.turns;
    expect(turns).toHaveLength(1); expect(turns[0]).toMatchObject({ undoable: false }); expect(turns[0].why).toMatch(/backups were off/);
    expect(turns[0].files[0]).toMatchObject({ file: 'src/off.js', patch: '-original\n+agent\n' });
    const r = await admin('/admin/agent/session/undo', { id: a, message: 'msg_' + a + '_0' });
    expect(r.status).toBe(409); expect(r.body.error.type).toBe('agent_undo_unavailable'); expect(r.body.error.message).toMatch(/Folder backups were off.*Agent settings/);
    expect(readFileSync(inFolder('src/off.js'), 'utf8')).toBe('agent');
    expect((await calls()).some(c => c.path === '/api/session/' + a + '/revert/stage')).toBe(false);
    ui.stop();
  } finally { settings.agentBackups = true; }
});

test('a turn whose message was queued while the agent worked has no backup of its own, and an earlier turn cannot be undone through it', async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  put('src/q.js', 'original');
  await turn(a, ui, 'first', () => put('src/q.js', 'first'), [{ file: 'src/q.js', status: 'modified', patch: '' }]);
  await emit('session.execution.started', { sessionID: a }); await until(() => ui.events.filter(e => e.type === 'session.execution.started').length >= 2);
  await turn(a, ui, 'queued', () => put('src/q.js', 'second'), [{ file: 'src/q.js', status: 'modified', patch: '' }]);
  const turns = (await admin('/admin/agent/session/changes?id=' + a)).body.turns;
  expect(turns.map((t: any) => t.undoable)).toEqual([true, false]); expect(turns[1].why).toMatch(/still working/);
  const r = await admin('/admin/agent/session/undo', { id: a, message: 'msg_' + a + '_0' });
  expect(r.status).toBe(409); expect(r.body.error.message).toMatch(/later turn/);
  expect(readFileSync(inFolder('src/q.js'), 'utf8')).toBe('second');
  ui.stop();
});

test('folder backups are switched in settings; switching them off removes the folder baselines', async () => {
  try {
    expect((await admin('/admin/settings', { agentBackups: 'yes' })).status).toBe(400);
    expect((await admin('/admin/settings', { agentBackups: true })).status).toBe(200);
    expect((await admin('/admin/agent/engine')).body.backups).toBe(true);
    const a = await create(); await admin('/admin/agent/session/prompt', { id: a, text: 'back up first' });
    expect(listDir(path.join(AGENT, 'baselines')).length).toBeGreaterThan(0);
    await emit('session.execution.succeeded', { sessionID: a });
    expect((await admin('/admin/settings', { agentBackups: false })).status).toBe(200);
    expect((await admin('/admin/agent/engine')).body.backups).toBe(false);
    await until(() => listDir(path.join(AGENT, 'baselines')).length === 0);
  } finally { settings.agentBackups = true; }
});

test("deleting a session removes it from the engine and Polygate's own records of it", async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  put('src/gone.js', 'original');
  await turn(a, ui, 'change gone', () => put('src/gone.js', 'agent'), [{ file: 'src/gone.js', status: 'modified', patch: '' }]);
  expect(existsSync(path.join(AGENT, 'turns', a + '.json'))).toBe(true);
  await emit('session.execution.started', { sessionID: a }); await until(() => ui.events.filter(e => e.type === 'session.execution.started').length >= 2);
  expect((await admin('/admin/agent/session/delete', { id: a })).status).toBe(409);
  await emit('session.execution.succeeded', { sessionID: a }); await until(async () => !(await admin('/admin/agent/session?id=' + a)).body.busy);
  expect((await admin('/admin/agent/session/delete', { id: a })).status).toBe(200);
  expect((await calls()).some(c => c.method === 'DELETE' && c.path === '/api/session/' + a)).toBe(true);
  expect(existsSync(path.join(AGENT, 'turns', a + '.json'))).toBe(false);
  await until(() => ui.events.some(e => e.type === 'agent.deleted'));
  expect((await admin('/admin/agent/session?id=' + a)).status).toBe(404);
  expect((await admin('/admin/agent/sessions')).body.sessions.some((s: any) => s.id === a)).toBe(false);
  ui.stop();
});

test("every folder's sessions are listed together, each with its folder, and the folders with their consent", async () => {
  const other = mkdtempSync(path.join(tmpdir(), 'pg-project-two-'));
  await trustFolder(other);
  const r = await admin('/admin/agent/session/create', { folder: other, model: MODEL, mode: 'ask', title: 'In the other folder' }); expect(r.status).toBe(200);
  const mine = await create();
  const all = (await admin('/admin/agent/sessions')).body.sessions as any[];
  expect(all.find(s => s.id === r.body.id)).toMatchObject({ folder: other, title: 'In the other folder' });
  expect(all.find(s => s.id === mine)).toMatchObject({ folder: FOLDER });
  expect((await admin('/admin/agent/sessions?folder=' + encodeURIComponent(other))).body.sessions.map((s: any) => s.id)).toEqual([r.body.id]);
  const folders = (await admin('/admin/agent/folders')).body.folders as any[];
  expect(folders.find(f => f.folder === other)).toEqual({ folder: other, trusted: true });
  expect(folders.find(f => f.folder === FOLDER)).toEqual({ folder: FOLDER, trusted: true });
  await admin('/admin/agent/trust/revoke', { folder: other });
  expect((await admin('/admin/agent/folders')).body.folders.find((f: any) => f.folder === other)).toEqual({ folder: other, trusted: false });
});

test('"No folder" starts a session in an empty folder of its own, allowed at once and kept out of the recent folders', async () => {
  const r = await admin('/admin/agent/session/create', { noFolder: true, model: MODEL, mode: 'ask', title: 'Just a question' }); expect(r.status).toBe(200);
  const folder = r.body.folder as string;
  expect(path.dirname(folder)).toBe(path.resolve(process.env.POLYGATE_AGENT_SCRATCH!)); expect(readdirSync(folder)).toEqual([]);
  expect((await admin('/admin/agent/trust?folder=' + encodeURIComponent(folder))).body.trusted).toBe(true);
  const listed = (await admin('/admin/agent/folders')).body;
  expect(listed.scratch).toBe(process.env.POLYGATE_AGENT_SCRATCH); expect(listed.folders.some((f: any) => f.folder === folder)).toBe(false);
  expect((await admin('/admin/agent/sessions')).body.sessions.find((s: any) => s.id === r.body.id)).toMatchObject({ folder, title: 'Just a question' });
  const again = await admin('/admin/agent/session/create', { noFolder: true, model: MODEL, mode: 'ask' }); expect(again.body.folder).not.toBe(folder);
  expect((await admin('/admin/agent/session/create', { noFolder: true, model: MODEL, mode: 'full' })).status).toBe(400);
});

test('a message sent while the agent works steers it by default, or waits in the queue when asked to', async () => {
  const a = await create(); const ui = listen(a); await ui.ready();
  await admin('/admin/agent/session/prompt', { id: a, text: 'start' }); await emit('session.execution.started', { sessionID: a });
  await until(() => ui.events.some(e => e.type === 'session.execution.started'));
  expect((await admin('/admin/agent/session/prompt', { id: a, text: 'use tabs, not spaces' })).status).toBe(200);
  expect((await admin('/admin/agent/session/prompt', { id: a, text: 'then write the changelog', delivery: 'queue' })).status).toBe(200);
  const sent = (await calls()).filter(c => c.method === 'POST' && c.path === `/api/session/${a}/prompt`).map(c => [c.body.text, c.body.delivery]);
  expect(sent).toEqual([['start', 'steer'], ['use tabs, not spaces', 'steer'], ['then write the changelog', 'queue']]);
  await emit('session.execution.succeeded', { sessionID: a }); ui.stop();
});

test('a session can switch to another usable model (with its effort), and can be renamed', async () => {
  const a = await create();
  expect((await admin('/admin/agent/session/model', { id: a, model: THINKER, effort: 'low' })).status).toBe(200);
  expect((await calls()).find(c => c.path === `/api/session/${a}/model`)!.body).toEqual({ model: { providerID: 'polygate', id: THINKER, variant: 'low' } });
  for (const bad of [{ model: TOOLLESS }, { model: 'kilo/nope' }, { model: MODEL, effort: 'high' }]) expect((await admin('/admin/agent/session/model', { id: a, ...bad })).status).toBe(400);
  expect((await admin('/admin/agent/session/rename', { id: a, title: '  Fix the failing test  ' })).status).toBe(200);
  expect((await calls()).find(c => c.method === 'PATCH' && c.path === `/api/session/${a}`)!.body).toEqual({ title: 'Fix the failing test' });
  expect((await admin('/admin/agent/session/rename', { id: a, title: '   ' })).status).toBe(400);
});

test('the agent routes answer in the desktop app only', async () => {
  delete process.env.POLYGATE_DESKTOP;
  try { expect((await admin('/admin/agent/models')).status).toBe(404); } finally { process.env.POLYGATE_DESKTOP = '1'; }
});

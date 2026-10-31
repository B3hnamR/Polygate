import { test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// The agent controller (docs/agent/PLAN.md, Phase 2a): the desktop-only API the Agent page uses, in front of the engine. A stand-in engine
// (fixtures/fake-opencode.ts) records what the controller asks of it and sends the events a test tells it to.
process.env.POLYGATE_AGENT_DIR = mkdtempSync(path.join(tmpdir(), 'pg-agentc-'));
process.env.FAKE_OPENCODE_SAVED = '1';
const FOLDER = mkdtempSync(path.join(tmpdir(), 'pg-project-'));
const engine = await import('../backend/agent-engine');
const { settings, saveModel, models, db, stateDir } = await import('../backend/state');
const { startGateway } = await import('../backend/main');
const FAKE = [process.execPath, path.join(import.meta.dir, 'fixtures', 'fake-opencode.ts')];
const MODEL = 'kilo/agent-test-model'; const TOOLLESS = 'kilo/agent-test-chat'; const THINKER = 'kilo/agent-test-thinker';
const saved = { token: process.env.POLYGATE_ADMIN_TOKEN, desktop: process.env.POLYGATE_DESKTOP, providers: settings.providers };
const keysBefore = settings.keys.map(k => k.id);
let gateway: Awaited<ReturnType<typeof startGateway>>; let base = '';
const model = (id: string, tools: boolean, reasoning = false) => ({ id, upstreamId: id.split('/').pop()!, providerId: 'kilo', name: id, context: 128000, output: 8192, reasoning, tools, state: 'available' as const, latency: 0, score: 50, priority: 100, failCount: 0, cooldownUntil: 0, checkedAt: 0, error: '' });

beforeAll(async () => {
  process.env.POLYGATE_ADMIN_TOKEN = 'agent-controller-secret'; process.env.POLYGATE_DESKTOP = '1';
  settings.providers = settings.providers.map(p => p.id === 'kilo' ? { ...p, enabled: true } : p);
  saveModel(model(MODEL, true)); saveModel(model(TOOLLESS, false)); saveModel(model(THINKER, true, true));
  gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`;
});
afterAll(async () => {
  await engine.stopEngine(); await gateway?.close();
  for (const id of [MODEL, TOOLLESS, THINKER]) { models.delete(id); db.query('DELETE FROM models WHERE id=?').run(id); }
  settings.providers = saved.providers; settings.keys = settings.keys.filter(k => keysBefore.includes(k.id));
  for (const [k, v] of [['POLYGATE_ADMIN_TOKEN', saved.token], ['POLYGATE_DESKTOP', saved.desktop]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  delete process.env.FAKE_OPENCODE_SAVED; delete process.env.POLYGATE_AGENT_DIR;
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
const create = async (mode = 'ask') => { const r = await admin('/admin/agent/session/create', { folder: FOLDER, model: MODEL, mode }); expect(r.status).toBe(200); return r.body.id as string; };

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

test('a prompt reaches the engine, and the UI stream carries this session\'s events only', async () => {
  const a = await create(); const b = await create(); const ui = listen(a); await ui.ready();
  expect((await admin('/admin/agent/session/prompt', { id: a, text: 'hello there' })).status).toBe(200);
  expect((await calls()).some(c => c.path === `/api/session/${a}/prompt` && c.body.text === 'hello there')).toBe(true);
  await emit('session.text.delta', { sessionID: b, delta: 'not for you' }); await emit('session.text.delta', { sessionID: a, delta: 'for you' });
  await until(() => ui.events.some(e => e.type === 'session.text.delta'));
  expect(ui.events.filter(e => e.type === 'session.text.delta').map(e => e.data.delta)).toEqual(['for you']);
  expect((await admin('/admin/agent/session?id=' + a)).body.messages.map((m: any) => m.text)).toEqual(['hello there']);
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
  expect(turns[0].files.map((f: any) => [f.file, f.status])).toEqual([['src/a.js', 'modified'], ['src/b.js', 'modified']]);
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

test('undo refuses, and changes nothing, when a file changed after the agent left it, was never recorded, or the agent is busy', async () => {
  const a = await create('accept-edits'); const ui = listen(a); await ui.ready();
  put('src/c.js', 'original');
  await turn(a, ui, 'change c', () => put('src/c.js', 'agent'), [{ file: 'src/c.js', status: 'modified', additions: 1, deletions: 1, patch: '-original\n+agent\n' }]);
  put('src/c.js', 'agent\nmy own line\n'); put('src/unseen.js', 'never recorded');
  await fake('/test/session', { sessionID: a, stage: [{ file: 'src/c.js', status: 'modified' }, { file: 'src/unseen.js', status: 'modified' }], revert: [{ file: 'src/c.js', content: 'original' }] });
  const r = await admin('/admin/agent/session/undo', { id: a, message: `msg_${a}_0` });
  expect(r.status).toBe(409); expect(r.body.error.type).toBe('agent_undo_conflict');
  expect(r.body.conflicts.map((c: any) => c.file)).toEqual(['src/c.js', 'src/unseen.js']);
  expect(readFileSync(inFolder('src/c.js'), 'utf8')).toBe('agent\nmy own line\n');
  const mine = (await calls()).filter(c => c.path.startsWith(`/api/session/${a}/revert`)).map(c => `${c.method} ${c.path.split('/').slice(4).join('/')}`);
  expect(mine).toEqual(['POST revert/stage', 'DELETE revert']);
  expect((await admin('/admin/agent/session/changes?id=' + a)).body.turns).toHaveLength(1);
  const started = ui.events.filter(e => e.type === 'session.execution.started').length;
  await emit('session.execution.started', { sessionID: a }); await until(() => ui.events.filter(e => e.type === 'session.execution.started').length > started);
  const busy = await admin('/admin/agent/session/undo', { id: a, message: `msg_${a}_0` }); expect(busy.status).toBe(409); expect(busy.body.error.message).toMatch(/working/);
  await emit('session.execution.succeeded', { sessionID: a });
  expect((await admin('/admin/agent/session/undo', { id: a, message: 'msg_unknown' })).status).toBe(404);
  ui.stop();
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

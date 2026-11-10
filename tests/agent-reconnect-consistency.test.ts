import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyEvent, fromHistory, reconnectConsistency, snapshotRepair, type Item, type SnapshotBoundary } from '../src/agent-logic';

const boundary = (before = 0, after = before, epoch = 'controller'): SnapshotBoundary => ({ epoch, before, after, stream: 1, connected: true, interrupted: false });
const event = (seq: number, type: string, data: any = {}, epoch = 'controller') => ({ type, data: { assistantMessageID: 'reply', ordinal: 0, ...data }, controller: { epoch, seq } });
const text = (value: string): Item[] => fromHistory([{ id: 'reply', type: 'assistant', content: [{ type: 'text', text: value }] }]);

test('snapshot-covered deltas remain ambiguous after the response, and full endings replace rather than append', () => {
  const sync = reconnectConsistency(), request = sync.begin();
  sync.receive(event(1, 'session.text.delta', { delta: 'already projected' }));
  const snapshot = text('Hello');
  const installed = sync.install(request, snapshot, boundary(0, 1))!;
  expect(installed.refresh).toBe(true); expect(installed.events).toEqual([]);
  // The engine can project a delta before its volatile stream reaches the controller.
  expect(sync.receive(event(2, 'session.text.delta', { delta: 'Hello' }))).toEqual({ refresh: true });
  const ended = sync.receive(event(3, 'session.text.ended', { text: 'Hello world' }));
  const result = applyEvent(snapshot, ended.event);
  expect(result).toEqual(text('Hello world'));
  expect(sync.receive(event(3, 'session.text.ended', { text: 'Hello world' }))).toEqual({ refresh: false });
  expect(sync.receive(event(4, 'session.text.delta', { delta: ' late duplicate' }))).toEqual({ refresh: true });
});

test('live arrivals during slow history only replay provably later deltas and authoritative endings', () => {
  const sync = reconnectConsistency(), request = sync.begin();
  sync.receive(event(2, 'session.text.delta', { assistantMessageID: 'new', delta: 'uncertain' }));
  sync.receive(event(3, 'session.text.ended', { text: 'Complete' }));
  sync.receive(event(4, 'session.text.started', { assistantMessageID: 'later' }));
  sync.receive(event(5, 'session.text.delta', { assistantMessageID: 'later', delta: 'Later' }));
  const installed = sync.install(request, text('Partial'), boundary(1, 3))!;
  expect(installed.refresh).toBe(true);
  expect(installed.events.map(e => e.controller.seq)).toEqual([3, 4, 5]);
  expect(sync.receive(event(6, 'session.text.delta', { assistantMessageID: 'new', delta: 'still ambiguous' })).refresh).toBe(true);
  const items = installed.events.reduce(applyEvent, text('Partial'));
  expect(items).toEqual([...text('Complete'), { kind: 'text', key: 'later:t0', text: 'Later' }]);
});

test('multiple reconnects reject stale responses and controller restarts reject old epoch buffers', () => {
  const sync = reconnectConsistency(), stale = sync.begin();
  sync.receive(event(9, 'session.text.delta', { delta: 'old' }));
  sync.invalidate(); const current = sync.begin();
  expect(sync.install(stale, text('stale'), boundary(0, 9))).toBeNull();
  sync.receive(event(1, 'session.text.ended', { text: 'Restarted' }, 'restarted'));
  const installed = sync.install(current, text('Restart'), boundary(0, 1, 'restarted'))!;
  expect(installed.events).toHaveLength(1);
  expect(installed.events.reduce(applyEvent, text('Restart'))).toEqual(text('Restarted'));
  expect(sync.receive(event(1, 'session.text.ended', { text: 'Restarted' }, 'restarted')).event).toBeUndefined();
});

test('empty projected parts and reasoning use the same persistent barrier', () => {
  const sync = reconnectConsistency(), request = sync.begin();
  const snapshot = fromHistory([{ id: 'reply', type: 'assistant', content: [{ type: 'text', text: '' }, { type: 'reasoning', text: '' }] }]);
  sync.install(request, snapshot, boundary());
  expect(sync.receive(event(1, 'session.text.delta', { delta: 'x' })).refresh).toBe(true);
  expect(sync.receive(event(2, 'session.reasoning.delta', { delta: 'thought' })).refresh).toBe(true);
  const ended = sync.receive(event(3, 'session.reasoning.ended', { text: 'thought' }));
  expect(applyEvent(snapshot, ended.event).find(i => i.kind === 'reasoning')).toMatchObject({ text: 'thought', done: true });
});

test('replayed full endings captured before history starts still reconcile a lagging projection', () => {
  const sync = reconnectConsistency(), request = sync.begin();
  sync.receive(event(10, 'session.text.ended', { text: 'Final value' }));
  const installed = sync.install(request, text('Partial'), boundary(10, 10))!;
  expect(installed.events.reduce(applyEvent, text('Partial'))).toEqual(text('Final value'));
  sync.receive(event(11, 'session.text.ended', { text: 'Removed by Undo' }));
  sync.invalidate(true); const undo = sync.begin();
  const removed = sync.install(undo, [], boundary(11, 11))!;
  expect(removed.events).toEqual([]); expect(removed.refresh).toBe(false);
});

test('delayed tool input and progress cannot regress an authoritative completed snapshot', () => {
  const snapshot = fromHistory([{ id: 'reply', type: 'assistant', content: [{ type: 'tool', id: 'tool', name: 'read', state: { status: 'completed', input: { path: 'a' }, metadata: { final: true }, content: [{ text: 'done' }] } }] }]);
  const called = applyEvent(snapshot, { type: 'session.tool.called', data: { id: 'tool', input: { path: 'old' } } });
  const progress = applyEvent(called, { type: 'session.tool.progress', data: { id: 'tool', metadata: { partial: true } } });
  expect(progress).toEqual(snapshot);
});

test('a later lagging repair snapshot cannot overwrite an already applied full ending', () => {
  const sync = reconnectConsistency(), first = sync.begin();
  sync.install(first, text('Partial'), boundary());
  const ended = sync.receive(event(1, 'session.text.ended', { text: 'Final' }));
  expect(applyEvent(text('Partial'), ended.event)).toEqual(text('Final'));
  const repair = sync.begin(), installed = sync.install(repair, text('Partial'), boundary(1, 1))!;
  expect(installed.events.reduce(applyEvent, text('Partial'))).toEqual(text('Final'));
  const absent = sync.begin(); expect(sync.install(absent, [], boundary(1, 1))!.events.reduce(applyEvent, [])).toEqual(text('Final'));
  sync.invalidate(true); const undo = sync.begin();
  expect(sync.install(undo, [], boundary(1, 1))!.events).toEqual([]);
});

test('continuous text or tool activity postpones repair instead of creating a periodic request storm', () => {
  let now = 0, next = 0, requests = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const repair = snapshotRepair(() => { requests++; repair.begin(); }, {
    now: () => now, set: (fn, delay) => { timers.set(++next, { at: now + delay, fn }); return next; }, clear: id => { timers.delete(id as number); },
  });
  const advance = (ms: number) => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } };
  repair.begin(); repair.complete(true);
  for (let i = 0; i < 200; i++) { repair.delta(); advance(100); }
  expect(requests).toBe(0);
  advance(500); expect(requests).toBe(1);
  repair.complete(false); advance(10000); expect(requests).toBe(1);
  repair.request(true); advance(0); expect(requests).toBe(2); repair.dispose();
  const source = readFileSync(new URL('../src/agent.tsx', import.meta.url), 'utf8');
  expect(source).toContain("if(!/^session\\.execution\\.(succeeded|failed|interrupted)$/.test(e.type))repair.delta()");
});

const savedEnv = { dir: process.env.POLYGATE_AGENT_DIR, token: process.env.POLYGATE_ADMIN_TOKEN, desktop: process.env.POLYGATE_DESKTOP, prefix: process.env.FAKE_OPENCODE_SESSION_PREFIX };
process.env.POLYGATE_AGENT_DIR = mkdtempSync(path.join(tmpdir(), 'pg-reconnect-engine-'));
const folder = mkdtempSync(path.join(tmpdir(), 'pg-reconnect-project-'));
const engine = await import('../backend/agent-engine');
const { settings, saveModel, models, db } = await import('../backend/state');
const { startGateway } = await import('../backend/main');
const modelID = 'kilo/reconnect-consistency';
const providersBefore = settings.providers, keysBefore = settings.keys.map(k => k.id);
let gateway: Awaited<ReturnType<typeof startGateway>>, base = '', sid = '';
const headers = { authorization: 'Bearer reconnect-consistency-secret', 'content-type': 'application/json' };
const admin = async (route: string, body?: unknown) => {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(response.ok).toBe(true); return response.json() as Promise<any>;
};
const fake = async (route: string, body?: unknown) => {
  const connection = engine.engineConnection()!;
  return (await fetch(connection.url + route, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: connection.auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<any>;
};
const until = async (check: () => boolean | Promise<boolean>) => { const end = Date.now() + 10000; while (!await check()) { if (Date.now() > end) throw new Error('Reconnect test timed out'); await Bun.sleep(20); } };
function listen(last = '') {
  const events: any[] = [], abort = new AbortController(); let ready = false;
  void (async () => {
    const response = await fetch(`${base}/admin/agent/events?id=${sid}`, { headers: { ...headers, ...(last ? { 'last-event-id': last } : {}) }, signal: abort.signal });
    const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true });
      let at: number; while ((at = buffer.indexOf('\n\n')) >= 0) {
        const lines = buffer.slice(0, at).split('\n'); buffer = buffer.slice(at + 2);
        const data = lines.find(line => line.startsWith('data: '));
        if (data) events.push({ ...JSON.parse(data.slice(6)), sseID: lines.find(line => line.startsWith('id: '))?.slice(4) });
        ready = true;
      }
    }
  })().catch(() => {});
  return { events, stop: () => abort.abort(), ready: () => until(() => ready) };
}
beforeAll(async () => {
  process.env.POLYGATE_ADMIN_TOKEN = 'reconnect-consistency-secret'; process.env.POLYGATE_DESKTOP = '1';
  process.env.FAKE_OPENCODE_SESSION_PREFIX = 'ses_reconnect_';
  settings.providers = settings.providers.map(p => p.id === 'kilo' ? { ...p, enabled: true } : p);
  saveModel({ id: modelID, upstreamId: 'reconnect-consistency', providerId: 'kilo', name: 'Reconnect test', context: 128000, output: 8192, reasoning: false, tools: true, state: 'available', latency: 0, score: 50, priority: 100, failCount: 0, cooldownUntil: 0, checkedAt: 0, error: '' });
  gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`;
  await engine.startEngine({ command: [process.execPath, path.join(import.meta.dir, 'fixtures', 'fake-opencode.ts')] });
  const trust = await admin('/admin/agent/trust?folder=' + encodeURIComponent(folder));
  await admin('/admin/agent/trust/allow', { folder, fingerprint: trust.fingerprint });
  sid = (await admin('/admin/agent/session/create', { folder, model: modelID, mode: 'ask' })).id;
});
afterAll(async () => {
  await engine.stopEngine(); await gateway?.close();
  models.delete(modelID); db.query('DELETE FROM models WHERE id=?').run(modelID);
  settings.providers = providersBefore; settings.keys = settings.keys.filter(k => keysBefore.includes(k.id));
  for (const [key, value] of [['POLYGATE_AGENT_DIR', savedEnv.dir], ['POLYGATE_ADMIN_TOKEN', savedEnv.token], ['POLYGATE_DESKTOP', savedEnv.desktop], ['FAKE_OPENCODE_SESSION_PREFIX', savedEnv.prefix]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

test('controller brackets slow history and replays disconnected events exactly once in capture order', async () => {
  const first = listen(); await first.ready();
  await fake('/test/session', { sessionID: sid, messages: [{ id: 'reply', type: 'assistant', content: [{ type: 'text', text: 'Hello' }] }], historyDelay: 350 });
  const callsBefore = (await fake('/test/calls')).filter((c: any) => c.path === `/api/session/${sid}/message`).length;
  const snapshotPromise = admin('/admin/agent/session?id=' + sid);
  await until(async () => (await fake('/test/calls')).filter((c: any) => c.path === `/api/session/${sid}/message`).length > callsBefore);
  await fake('/test/emit', { event: { type: 'session.text.delta', data: { sessionID: sid, assistantMessageID: 'reply', ordinal: 0, delta: ' world' } } });
  await until(() => first.events.some(e => e.type === 'session.text.delta'));
  const snapshot = await snapshotPromise, delta = first.events.find(e => e.type === 'session.text.delta');
  expect(snapshot.reconnect.before).toBeLessThan(delta.controller.seq);
  expect(snapshot.reconnect.after).toBeGreaterThanOrEqual(delta.controller.seq);
  expect(snapshot.messages[0].content[0].text).toBe('Hello');
  expect(delta.sseID).toBe(`${snapshot.reconnect.epoch}:${delta.controller.seq}`);
  first.stop();
  await fake('/test/emit', { event: { type: 'session.text.ended', data: { sessionID: sid, assistantMessageID: 'reply', ordinal: 0, text: 'Hello world' } } });
  // Snapshot's after sequence confirms the controller captured the event while no page was connected.
  await until(async () => (await admin('/admin/agent/session?id=' + sid)).reconnect.after > delta.controller.seq);
  const second = listen(delta.sseID); await second.ready();
  await until(() => second.events.some(e => e.type === 'session.text.ended'));
  expect(second.events.filter(e => e.type === 'session.text.delta')).toHaveLength(0);
  expect(second.events.filter(e => e.type === 'session.text.ended')).toHaveLength(1);
  const ended = second.events.find(e => e.type === 'session.text.ended'); second.stop();
  const third = listen(ended.sseID); await third.ready();
  expect(third.events.filter(e => e.controller)).toHaveLength(0); third.stop();
  const restarted = listen('previous-controller:42'); await restarted.ready();
  expect(restarted.events.find(e => e.type === 'agent.replay')?.data.reset).toBe(true); restarted.stop();
  await fake('/test/session', { sessionID: sid, historyDelay: 0 });
});

test('engine event stream restart is visible and forces a new snapshot generation', async () => {
  const ui = listen(); await ui.ready();
  await fake('/test/disconnect-events', {});
  await until(() => ui.events.some(e => e.type === 'agent.stream' && !e.data.connected));
  await until(() => ui.events.some(e => e.type === 'agent.stream' && e.data.connected));
  const gap = ui.events.find(e => e.type === 'agent.stream' && !e.data.connected);
  const restored = ui.events.find(e => e.type === 'agent.stream' && e.data.connected);
  expect(restored.data.generation).toBeGreaterThan(gap.data.generation);
  const snapshot = await admin('/admin/agent/session?id=' + sid);
  expect(snapshot.reconnect.connected).toBe(true); expect(snapshot.reconnect.stream).toBe(restored.data.generation);
  ui.stop();
});

test('a cursor evicted from the bounded journal receives an explicit replay reset', async () => {
  const ui = listen(); await ui.ready();
  await fake('/test/emit', { event: { type: 'session.text.started', data: { sessionID: sid, assistantMessageID: 'evicted', ordinal: 0 } } });
  await until(() => ui.events.some(e => e.type === 'session.text.started'));
  const old = ui.events.find(e => e.type === 'session.text.started').sseID; ui.stop();
  // A single oversized event proves byte-bound eviction without 2048 network requests.
  await fake('/test/emit', { event: { type: 'session.text.ended', data: { sessionID: sid, assistantMessageID: 'evicted', ordinal: 0, text: 'x'.repeat(1024 * 1024 + 1) } } });
  const seq = Number(old.split(':').at(-1));
  await until(async () => (await admin('/admin/agent/session?id=' + sid)).reconnect.after > seq);
  const reconnect = listen(old); await reconnect.ready();
  expect(reconnect.events.find(e => e.type === 'agent.replay')?.data.reset).toBe(true); reconnect.stop();
});

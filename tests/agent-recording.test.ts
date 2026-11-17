import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as engine from '../backend/agent-engine';
import * as backup from '../backend/agent-backup';
import * as state from '../backend/state';
import * as terminal from '../backend/agent-terminal';
import { agentApi, pruneAgentBackups, stopAgent } from '../backend/agent';
import { foldersOverlap } from '../backend/agent-paths';
import { grantTrust } from '../backend/agent-trust';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};
let root: string, folder: string, agentDir: string, sid: string;
let oldDir: string | undefined, oldBackups: boolean | undefined;
let infos: Map<string, any>, streams: Map<string, ReadableStreamDefaultController<Uint8Array>>;
let active: Record<string, boolean>, messages: any[], calls: { method: string; route: string; body: any }[];
let contextGate: ReturnType<typeof deferred> | undefined, contextReached: ReturnType<typeof deferred>;
let diffGate: ReturnType<typeof deferred> | undefined, diffReached: ReturnType<typeof deferred>;
let activeGate: ReturnType<typeof deferred> | undefined, activeReached: ReturnType<typeof deferred>, holdActiveAfter: number;
let diffFails: boolean, contextFails: boolean;
let spies: { mockRestore(): void }[], closeObservers: (() => void)[];
const events = new EventEmitter(), encoder = new TextEncoder();
const originalWrite = state.writeFileAtomic;
const turnsFile = (id = sid) => path.join(agentDir, 'turns', id + '.json');
const pendingFile = (id = sid) => turnsFile(id) + '.pending';
const readPending = () => JSON.parse(readFileSync(pendingFile(), 'utf8'));
const readTurns = () => JSON.parse(readFileSync(turnsFile(), 'utf8'));
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const blobs = () => existsSync(path.join(agentDir, 'backups')) ? readdirSync(path.join(agentDir, 'backups')).sort() : [];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'pg-recording-'));
  folder = path.join(root, 'project'); agentDir = path.join(root, 'agent');
  mkdirSync(folder); mkdirSync(agentDir);
  oldDir = process.env.POLYGATE_AGENT_DIR; process.env.POLYGATE_AGENT_DIR = agentDir;
  oldBackups = state.settings.agentBackups; state.settings.agentBackups = true;
  sid = path.basename(root).replace(/[^A-Za-z0-9_-]/g, '');
  infos = new Map([[sid, { id: sid, title: 'User title', agent: 'polygate-ask', location: { directory: folder } }]]);
  streams = new Map(); active = {}; messages = [{ id: 'message_' + sid, type: 'user' }]; calls = [];
  contextGate = undefined; contextReached = deferred(); diffGate = undefined; diffReached = deferred(); diffFails = false; contextFails = false; closeObservers = []; spies = [];
  activeGate = undefined; activeReached = deferred(); holdActiveAfter = 0;
  spies.push(spyOn(engine, 'engineConnection').mockReturnValue({ url: 'http://engine.invalid', auth: 'fixture' }));
  spies.push(spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: RequestInit) => {
    const url = new URL(String(input)), route = url.pathname, method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, route, body });
    if (route === '/api/event') return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      streams.set(url.searchParams.get('directory')!, controller);
      controller.enqueue(encoder.encode('data: {"type":"server.heartbeat"}\n\n'));
      init?.signal?.addEventListener('abort', () => controller.close(), { once: true });
    } }));
    if (route === '/api/session/active') {
      const snapshot = { ...active };
      if (activeGate && --holdActiveAfter === 0) { activeReached.resolve(); await activeGate.promise; }
      return Response.json(snapshot);
    }
    if (route === '/api/session') return Response.json([...infos.values()].filter(s => s.location.directory === url.searchParams.get('directory')));
    if (route.endsWith('/permission')) return Response.json([]);
    if (route.endsWith('/context')) { contextReached.resolve(); await contextGate?.promise; return contextFails ? new Response('context unavailable', { status: 500 }) : Response.json(messages); }
    if (route.endsWith('/diff')) { diffReached.resolve(); await diffGate?.promise; return diffFails ? new Response('optional diff unavailable', { status: 500 }) : Response.json([]); }
    if (route.endsWith('/message')) return Response.json({ data: messages });
    if (route.endsWith('/prompt')) return Response.json({ id: 'sent_' + sid });
    if (route.includes('/instructions/')) return new Response(null, { status: 204 });
    const id = route.split('/')[3];
    if (method === 'PATCH' && infos.has(id)) infos.get(id).title = body.title;
    return Response.json(infos.get(id) || {});
  }) as typeof fetch));
});
afterEach(() => {
  for (const close of closeObservers) close();
  stopAgent();
  for (const spy of spies.reverse()) spy.mockRestore();
  events.removeAllListeners();
  if (oldDir === undefined) delete process.env.POLYGATE_AGENT_DIR; else process.env.POLYGATE_AGENT_DIR = oldDir;
  state.settings.agentBackups = oldBackups;
  rmSync(root, { recursive: true, force: true });
});
async function api(route: string, body?: unknown) {
  let result: any;
  await agentApi({ method: body === undefined ? 'GET' : 'POST', url: route } as any, {} as any,
    route.split('?')[0], async () => body, (_res, status, value) => { result = { status, body: value }; });
  return result;
}
const changes = (id = sid) => api('/admin/agent/session/changes?id=' + id);
async function observe(id = sid) {
  const req = new EventEmitter() as any;
  req.method = 'GET'; req.url = '/admin/agent/events?id=' + id; req.headers = {};
  const res = { writeHead() {}, write(text: string) {
    const data = text.split('\n').find(line => line.startsWith('data: '));
    if (data) { const event = JSON.parse(data.slice(6)); events.emit(id + ':' + event.type, event); }
  } };
  await agentApi(req, res as any, '/admin/agent/events', async () => ({}), () => {});
  closeObservers.push(() => req.emit('close'));
}
async function emit(type: string, data: any = {}, id = sid) {
  const acknowledged = new Promise<void>(resolve => events.once(id + ':' + type, () => resolve()));
  if (type === 'session.execution.started') active[id] = true;
  if (/session.execution.(succeeded|failed|interrupted)/.test(type)) delete active[id];
  streams.get(infos.get(id).location.directory)!.enqueue(encoder.encode(`data: ${JSON.stringify({ type, data: { sessionID: id, ...data } })}\n\n`));
  await acknowledged;
}
function seedBackup() {
  writeFileSync(path.join(folder, 'a.txt'), 'before\n');
  const saved = { files: { 'a.txt': { hash: backup.saveBytes(Buffer.from('before\n')), mode: statSync(path.join(folder, 'a.txt')).mode & 0o777 } }, excluded: [] };
  mkdirSync(path.dirname(pendingFile()), { recursive: true });
  writeFileSync(pendingFile(), JSON.stringify(saved));
  return saved;
}
function seedCompletion(id = 'completion', message: string | undefined = messages[0].id, after = 'agent\n') {
  const saved = seedBackup();
  const completion = { id, at: 123, message, files: [{ file: 'a.txt', before: saved.files['a.txt'], after: backup.saveBytes(Buffer.from(after)), status: 'modified', additions: 0, deletions: 0, patch: '' }] };
  writeFileSync(pendingFile(), JSON.stringify({ version: 1, completions: [completion] }));
  return completion;
}

test('legacy backup becomes a durable post-image before context awaits; external edits are not recaptured', async () => {
  seedBackup(); await observe(); contextGate = deferred();
  writeFileSync(path.join(folder, 'a.txt'), 'agent\n');
  await emit('session.step.ended', { files: ['a.txt'] });
  await emit('session.execution.succeeded'); await contextReached.promise;
  const captured = readPending().completions[0];
  expect(backup.backupBytes({ hash: captured.files[0].after, mode: 0o600 }).toString()).toBe('agent\n');
  writeFileSync(path.join(folder, 'a.txt'), 'agent\nexternal edit\n');
  contextGate.resolve();
  expect((await changes()).body.turns[0].undoable).toBe(true);
  expect(readTurns()[0].files[0].after).toBe(captured.files[0].after);
  expect(readFileSync(path.join(folder, 'a.txt'), 'utf8')).toContain('external edit');
  expect(existsSync(pendingFile())).toBe(false);
});

test('recording locks block overlapping sibling terminal and prompt, then release', async () => {
  seedBackup(); await observe();
  const child = path.join(folder, 'child'); mkdirSync(child);
  const other = sid + '_other'; infos.set(other, { id: other, agent: 'polygate-ask', location: { directory: child } });
  grantTrust(child); contextGate = deferred();
  writeFileSync(path.join(folder, 'a.txt'), 'agent');
  await emit('session.step.ended', { files: ['a.txt'] }); await emit('session.execution.succeeded'); await contextReached.promise;
  const start = spyOn(terminal, 'startTerminal').mockReturnValue(null); spies.push(start);
  await expect(api('/admin/agent/session/terminal/run', { id: other, command: 'inert', confirm: true })).rejects.toMatchObject({ type: 'agent_busy' });
  await expect(api('/admin/agent/session/prompt', { id: other, text: 'later' })).rejects.toMatchObject({ type: 'agent_busy' });
  expect(start).not.toHaveBeenCalled();
  contextGate.resolve(); await changes();
  expect((await api('/admin/agent/session/terminal/run', { id: other, command: 'inert', confirm: true })).status).toBe(200);
  expect(start).toHaveBeenCalledTimes(1);
});

test('history write failure retains completion and retry uses captured bytes, not current files', async () => {
  const completion = seedCompletion(); let fail = true;
  spies.push(spyOn(state, 'writeFileAtomic').mockImplementation((file, data, mode) => {
    if (file === turnsFile() && fail) throw new Error('synthetic history write failure');
    originalWrite(file, data, mode);
  }));
  await expect(changes()).rejects.toThrow('synthetic history write failure');
  expect(existsSync(turnsFile())).toBe(false); expect(readPending().completions).toHaveLength(1);
  writeFileSync(path.join(folder, 'a.txt'), 'later user bytes'); fail = false;
  expect((await changes()).body.turns).toHaveLength(1);
  expect(readTurns()[0].files[0].after).toBe(completion.files[0].after);
  expect(readTurns()[0].at).toBe(123); expect(existsSync(pendingFile())).toBe(false);
});

test('context failure retains the captured completion for retry and releases its recording lock', async () => {
  seedBackup(); await observe(); contextFails = true;
  writeFileSync(path.join(folder, 'a.txt'), 'agent');
  await emit('session.step.ended', { files: ['a.txt'] }); await emit('session.execution.succeeded');
  await expect(changes()).rejects.toMatchObject({ type: 'agent_engine_error' });
  const captured = readPending().completions[0];
  writeFileSync(path.join(folder, 'a.txt'), 'later edit'); contextFails = false;
  expect((await changes()).body.turns).toHaveLength(1);
  expect(readTurns()[0].files[0].after).toBe(captured.files[0].after);
  expect(existsSync(pendingFile())).toBe(false);
});

test('reconnect recognizes committed completion before draining the next run for the same message', async () => {
  const first = seedCompletion('first');
  const second = { ...first, id: 'second', at: 456, files: first.files.map(f => ({ ...f, before: { hash: f.after, mode: f.before.mode }, after: backup.saveBytes(Buffer.from('second\n')) })) };
  writeFileSync(turnsFile(), JSON.stringify([{ message: first.message, at: first.at, files: first.files, completionID: first.id }]));
  writeFileSync(pendingFile(), JSON.stringify({ version: 1, completions: [first, second] }));
  writeFileSync(path.join(folder, 'a.txt'), 'unrelated current bytes');
  expect((await changes()).body.turns).toHaveLength(1);
  const turn = readTurns()[0];
  expect(turn.completionID).toBe('second'); expect(turn.files[0].before).toEqual(first.files[0].before);
  expect(turn.files[0].patch).toContain('-before'); expect(turn.files[0].patch).toContain('+second');
  expect(existsSync(pendingFile())).toBe(false);
});

test('FIFO drains two live known runs when the first optional metadata request is delayed', async () => {
  state.settings.agentBackups = false; await observe(); diffGate = deferred();
  const save = spyOn(backup, 'saveBytes'); spies.push(save);
  await emit('session.execution.started'); await emit('session.inbox.delivered', { inboxID: 'first' });
  writeFileSync(path.join(folder, 'a.txt'), 'first bytes');
  await emit('session.step.ended', { files: ['a.txt'] }); await emit('session.execution.succeeded'); await diffReached.promise;
  await emit('session.execution.started'); await emit('session.inbox.delivered', { inboxID: 'second' });
  writeFileSync(path.join(folder, 'a.txt'), 'second bytes');
  await emit('session.step.ended', { files: ['a.txt'] }); await emit('session.execution.succeeded');
  const pending = readPending().completions;
  expect(pending.map((c: any) => c.message)).toEqual(['first', 'second']);
  writeFileSync(path.join(folder, 'a.txt'), 'external bytes'); diffGate.resolve(); await changes();
  expect(readTurns().map((t: any) => t.message)).toEqual(['first', 'second']);
  expect(readTurns().map((t: any) => t.files[0].after)).toEqual(pending.map((c: any) => c.files[0].after));
  expect(readTurns().map((t: any) => t.files[0].after)).toEqual([hash('first bytes'), hash('second bytes')]);
  expect(save).not.toHaveBeenCalled(); expect(blobs()).toEqual([]);
  expect(existsSync(pendingFile())).toBe(false);
});

test('failed pending acknowledgement replays a committed completion without duplicate history', async () => {
  const completion = seedCompletion();
  const remaining = { files: {}, excluded: [] };
  writeFileSync(pendingFile(), JSON.stringify({ version: 1, backup: remaining, completions: [completion] }));
  let fail = true;
  spies.push(spyOn(state, 'writeFileAtomic').mockImplementation((file, data, mode) => {
    if (file === pendingFile() && fail && JSON.parse(String(data)).completions.length === 0) throw new Error('synthetic acknowledgement failure');
    originalWrite(file, data, mode);
  }));
  await expect(changes()).rejects.toThrow('synthetic acknowledgement failure');
  expect(readTurns()).toHaveLength(1); expect(readPending().completions).toHaveLength(1);
  fail = false; await changes();
  expect(readTurns()).toHaveLength(1); expect(readTurns()[0].completionID).toBe(completion.id);
  expect(readPending().completions).toEqual([]); expect(readPending().backup).toEqual(remaining);
});

test('a later run prevents missing identity from being guessed and preserves both FIFO captures', async () => {
  seedBackup(); await observe(); contextGate = deferred();
  writeFileSync(path.join(folder, 'a.txt'), 'first'); await emit('session.step.ended', { files: ['a.txt'] });
  await emit('session.execution.succeeded'); await contextReached.promise;
  await emit('session.execution.started'); await emit('session.inbox.delivered', { inboxID: 'later' });
  writeFileSync(path.join(folder, 'a.txt'), 'second'); await emit('session.step.ended', { files: ['a.txt'] }); await emit('session.execution.succeeded');
  messages = [{ id: 'later', type: 'user' }]; contextGate.resolve();
  await expect(changes()).rejects.toMatchObject({ type: 'agent_recording_pending' });
  const pending = readPending(); expect(pending.completions).toHaveLength(2);
  expect(pending.completions[0].message).toBeUndefined(); expect(pending.completions[1].message).toBe('later');
  expect(backup.backupBytes({ hash: pending.completions[0].files[0].after, mode: 0o600 }).toString()).toBe('first');
  expect(pending.completions[1].files[0]).toMatchObject({ after: hash('second'), hashOnly: true });
  expect(existsSync(path.join(agentDir, 'backups', hash('second')))).toBe(false);
});

test('optional diff failure does not prevent recording a known message with backups off', async () => {
  state.settings.agentBackups = false; await observe(); diffFails = true;
  await emit('session.inbox.delivered', { inboxID: messages[0].id });
  writeFileSync(path.join(folder, 'a.txt'), 'unbacked');
  await emit('session.step.ended', { files: ['a.txt'] }); await emit('session.execution.succeeded');
  const turns = (await changes()).body.turns;
  expect(turns).toHaveLength(1); expect(turns[0].undoable).toBe(false); expect(turns[0].why).toContain('backups were off');
  expect(existsSync(pendingFile())).toBe(false);
});

test('excluded files retain identity without copying raw bytes or reading a nonexistent post blob', async () => {
  const saved = seedBackup();
  writeFileSync(pendingFile(), JSON.stringify({ ...saved, files: {}, excluded: ['a.txt'] }));
  await observe(); const beforeBlobs = blobs();
  const save = spyOn(backup, 'saveBytes'), read = spyOn(backup, 'backupBytes'); spies.push(save, read);
  await emit('session.inbox.delivered', { inboxID: messages[0].id });
  writeFileSync(path.join(folder, 'a.txt'), 'excluded content');
  await emit('session.step.ended', { files: ['a.txt'] }); await emit('session.execution.succeeded');
  expect((await changes()).body.turns[0].undoable).toBe(false);
  expect(readTurns()[0].files[0]).toMatchObject({ after: hash('excluded content'), hashOnly: true });
  expect(save).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(blobs()).toEqual(beforeBlobs);
});

test('an unsafe run with a preimage still uses hash-only completion capture', async () => {
  seedBackup(); await observe(); const beforeBlobs = blobs();
  const save = spyOn(backup, 'saveBytes'), read = spyOn(backup, 'backupBytes'); spies.push(save, read);
  await emit('session.inbox.delivered', { inboxID: 'first' });
  await emit('session.inbox.delivered', { inboxID: 'steering' });
  writeFileSync(path.join(folder, 'a.txt'), 'combined');
  await emit('session.step.ended', { files: ['a.txt'] }); await emit('session.execution.succeeded');
  expect((await changes()).body.turns[0].undoable).toBe(false);
  expect(readTurns()[0]).toMatchObject({ noBackup: 'busy', files: [{ after: hash('combined'), hashOnly: true }] });
  expect(save).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(blobs()).toEqual(beforeBlobs);
});

for (const reason of ['off', 'excluded'] as const) test(`a ${reason} hash-only rerun cannot inherit a safe turn post-image or Undo eligibility`, async () => {
  const first = seedCompletion('first');
  writeFileSync(turnsFile(), JSON.stringify([{ message: first.message, at: first.at, files: first.files, completionID: first.id }]));
  const next = { ...first, id: reason, ...(reason === 'off' ? { noBackup: 'off' } : {}), files: first.files.map(f => ({ ...f, before: undefined, after: hash('not retained'), hashOnly: true })) };
  writeFileSync(pendingFile(), JSON.stringify({ version: 1, completions: [next] }));
  const read = spyOn(backup, 'backupBytes'); spies.push(read);
  expect((await changes()).body.turns[0]).toMatchObject({ undoable: false, why: expect.stringContaining(reason === 'off' ? 'backups were off' : 'not in the backup') });
  expect(readTurns()[0].files[0]).toMatchObject({ before: first.files[0].before, after: hash('not retained'), hashOnly: true });
  expect(read).not.toHaveBeenCalled();
});

for (const metadata of ['diff', 'context'] as const) test(`safe reads and cancellation do not await held ${metadata} while a later run is active`, async () => {
  if (metadata === 'context') seedBackup(); else state.settings.agentBackups = false;
  await observe();
  const gate = deferred();
  if (metadata === 'context') contextGate = gate;
  else { diffGate = gate; await emit('session.inbox.delivered', { inboxID: 'first' }); }
  writeFileSync(path.join(folder, 'a.txt'), 'first');
  await emit('session.step.ended', { files: ['a.txt'] }); await emit('session.execution.succeeded');
  await (metadata === 'context' ? contextReached.promise : diffReached.promise);
  await emit('session.execution.started'); await emit('session.inbox.delivered', { inboxID: 'second' });
  const stop = spyOn(terminal, 'stopTerminal').mockReturnValue(null); spies.push(stop);
  try {
    expect((await api('/admin/agent/session/cancel', { id: sid })).status).toBe(200);
    expect(calls.some(c => c.route.endsWith('/interrupt'))).toBe(true);
    expect((await api('/admin/agent/session/inbox/cancel', { id: sid, inbox: 'queued' })).status).toBe(200);
    expect((await api('/admin/agent/session/form', { id: sid, form: 'frm_pending', cancel: true })).status).toBe(200);
    expect((await api('/admin/agent/session/forms?id=' + sid)).status).toBe(200);
    expect((await api('/admin/agent/session/terminal/stop', { id: sid })).status).toBe(200);
    expect(stop).toHaveBeenCalledTimes(1);
    expect((await api('/admin/agent/session?id=' + sid)).body.busy).toBe(true);
    expect(readPending().completions).toHaveLength(1);
  } finally { gate.resolve(); }
  if (metadata === 'context') await expect(changes()).rejects.toMatchObject({ type: 'agent_recording_pending' });
  else await changes();
  await emit('session.execution.succeeded');
});

for (const action of ['terminal', 'undo'] as const) test(`stale idle inventory cannot erase a live start during ${action}`, async () => {
  const completion = seedCompletion(); await changes(); await observe(); grantTrust(folder);
  const start = spyOn(terminal, 'startTerminal').mockReturnValue(null), restore = spyOn(backup, 'restoreFile'); spies.push(start, restore);
  activeGate = deferred(); holdActiveAfter = 2;
  const request = action === 'undo' ? api('/admin/agent/session/undo', { id: sid, message: completion.message }) : api('/admin/agent/session/terminal/run', { id: sid, command: 'inert', confirm: true });
  const settled = request.then(() => undefined, error => error);
  await activeReached.promise; await emit('session.execution.started'); activeGate.resolve();
  expect(await settled).toMatchObject({ type: 'agent_busy' });
  expect(start).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled();
  await emit('session.execution.succeeded'); await changes();
});

test('known refresh preserves an execution start newer than its active snapshot', async () => {
  await observe(); activeGate = deferred(); holdActiveAfter = 1;
  const stateEvent = new Promise<any>(resolve => events.once(sid + ':agent.state', resolve));
  const opening = observe();
  await activeReached.promise; await emit('session.execution.started'); activeGate.resolve();
  await opening; expect((await stateEvent).data.busy).toBe(true);
  await emit('session.execution.succeeded'); await changes();
});

test('trust revoked during backup preparation prevents dispatch and preserves the pause', async () => {
  grantTrust(folder); await observe();
  const entered = deferred(), gate = deferred();
  spies.push(spyOn(backup, 'captureBackup').mockImplementation(async () => { entered.resolve(); await gate.promise; return { files: {}, excluded: [] }; }));
  const sending = api('/admin/agent/session/prompt', { id: sid, text: 'work' });
  await entered.promise;
  await api('/admin/agent/trust/revoke', { folder });
  gate.resolve();
  await expect(sending).rejects.toMatchObject({ type: 'agent_trust_required' });
  expect(calls.some(c => c.route.endsWith('/prompt'))).toBe(false);
  expect((await api('/admin/agent/session?id=' + sid)).body.paused).toContain('revoked');
  grantTrust(folder);
  expect((await api('/admin/agent/session/prompt', { id: sid, text: 'retry' })).status).toBe(200);
});

test('no changed paths and exact no-op settle without stale diff or empty turns', async () => {
  seedBackup(); await observe();
  await emit('session.execution.succeeded'); await changes();
  expect(existsSync(pendingFile())).toBe(false); expect(existsSync(turnsFile())).toBe(false);
  expect(calls.some(c => c.route.endsWith('/diff'))).toBe(false);
});

test('reported unchanged bytes need no message or metadata and release the preimage', async () => {
  seedBackup(); await observe();
  await emit('session.step.ended', { files: ['a.txt'] }); await emit('session.execution.succeeded');
  expect((await changes()).body.turns).toEqual([]);
  expect(existsSync(pendingFile())).toBe(false);
  expect(calls.some(c => c.route.endsWith('/context') || c.route.endsWith('/diff'))).toBe(false);
});

test('unknown persisted identity is retained rather than assigned to current context', async () => {
  const completion = seedCompletion(); delete (completion as any).message;
  writeFileSync(pendingFile(), JSON.stringify({ version: 1, completions: [completion] }));
  await expect(changes()).rejects.toMatchObject({ type: 'agent_recording_pending' });
  expect(readPending().completions[0].message).toBeUndefined();
  expect(calls.some(c => c.route.endsWith('/context'))).toBe(false);
  expect((await api('/admin/agent/session/cancel', { id: sid })).status).toBe(200);
});

test('pruning retains legacy, captured pre/post, and active envelope hashes', () => {
  const completion = seedCompletion();
  const legacy = { files: { keep: { hash: 'a'.repeat(64), mode: 0o644 } }, excluded: [] };
  writeFileSync(pendingFile(sid + '_legacy'), JSON.stringify(legacy));
  writeFileSync(pendingFile(), JSON.stringify({ version: 1, backup: legacy, completions: [completion] }));
  const pruneSpy = spyOn(backup, 'pruneBackups').mockResolvedValue(0); spies.push(pruneSpy);
  pruneAgentBackups(true);
  const refs = pruneSpy.mock.calls[0][0]!;
  expect(refs.has(legacy.files.keep.hash)).toBe(true);
  expect(refs.has(completion.files[0].before.hash)).toBe(true);
  expect(refs.has(completion.files[0].after)).toBe(true);
});

test('hash-only identities are not treated as retained post-image blobs by pruning', () => {
  const completion = seedCompletion();
  const digest = hash('not retained');
  writeFileSync(pendingFile(), JSON.stringify({ version: 1, completions: [{ ...completion, files: [{ ...completion.files[0], after: digest, hashOnly: true }] }] }));
  const pruneSpy = spyOn(backup, 'pruneBackups').mockResolvedValue(0); spies.push(pruneSpy);
  pruneAgentBackups(true);
  expect(pruneSpy.mock.calls[0][0]!.has(digest)).toBe(false);
  expect(pruneSpy.mock.calls[0][0]!.has(completion.files[0].before.hash)).toBe(true);
});

test('nested active execution invalidates the parent preimage durably', async () => {
  seedBackup(); await observe(); await emit('session.execution.started');
  const childFolder = path.join(folder, 'child'); mkdirSync(childFolder);
  const child = sid + '_child'; infos.set(child, { id: child, agent: 'polygate-ask', location: { directory: childFolder } });
  await observe(child); await emit('session.execution.started', {}, child);
  expect(readPending().unsafeTurn).toBe('busy');
  writeFileSync(path.join(folder, 'a.txt'), 'combined');
  await emit('session.inbox.delivered', { inboxID: messages[0].id });
  await emit('session.step.ended', { files: ['a.txt'] }); await emit('session.execution.succeeded');
  expect((await changes()).body.turns[0].undoable).toBe(false);
  await emit('session.execution.succeeded', {}, child);
});

test('unknown active child folder blocks parent Undo before any file restoration', async () => {
  const completion = seedCompletion(); await changes();
  const childFolder = path.join(folder, 'child'); mkdirSync(childFolder);
  const child = sid + '_unknown'; infos.set(child, { id: child, agent: 'polygate-ask', location: { directory: childFolder } }); active[child] = true;
  const restore = spyOn(backup, 'restoreFile'); spies.push(restore);
  await expect(api('/admin/agent/session/undo', { id: sid, message: completion.message })).rejects.toMatchObject({ type: 'agent_busy' });
  expect(restore).not.toHaveBeenCalled();
});

test('unavailable post-image does not become deletion or inherit Undo availability on rerun', async () => {
  const first = seedCompletion('first');
  writeFileSync(turnsFile(), JSON.stringify([{ message: first.message, at: first.at, files: first.files, completionID: first.id }]));
  const next = { ...first, id: 'unavailable', files: first.files.map(({ after, ...f }) => f) };
  writeFileSync(pendingFile(), JSON.stringify({ version: 1, completions: [next] }));
  const result = (await changes()).body.turns[0];
  expect(result.undoable).toBe(false); expect(result.why).toContain('post-turn');
  expect(readTurns()[0].files[0].after).toBeUndefined();
});

test('known turn returning to its original bytes replaces the stale post-image and patch', async () => {
  const first = seedCompletion('first');
  writeFileSync(turnsFile(), JSON.stringify([{ message: first.message, at: first.at, files: first.files, completionID: first.id }]));
  const next = { ...first, id: 'returned', files: first.files.map(f => ({ ...f, before: { hash: f.after, mode: f.before.mode }, after: f.before.hash })) };
  writeFileSync(pendingFile(), JSON.stringify({ version: 1, completions: [next] }));
  await changes();
  expect(readTurns()[0].files[0].after).toBe(first.files[0].before.hash);
  expect(readTurns()[0].files[0].patch).toBe('');
  expect(readTurns()[0].files[0].before).toEqual(first.files[0].before);
});

test('canonical overlap is symmetric, component-aware, and resolves folder aliases', () => {
  const child = path.join(folder, '..hidden'); mkdirSync(child);
  const sibling = path.join(root, 'project-other'); mkdirSync(sibling);
  const alias = path.join(root, 'alias'); symlinkSync(folder, alias, process.platform === 'win32' ? 'junction' : 'dir');
  expect(foldersOverlap(folder, child)).toBe(true); expect(foldersOverlap(child, folder)).toBe(true);
  expect(foldersOverlap(folder, sibling)).toBe(false); expect(foldersOverlap(alias, child)).toBe(true);
  if (process.platform === 'win32') expect(foldersOverlap(folder.toUpperCase(), child)).toBe(true);
});

test('recording never overwrites user title edits', async () => {
  seedCompletion(); await changes();
  await api('/admin/agent/session/rename', { id: sid, title: 'My edited title' });
  await changes();
  expect(infos.get(sid).title).toBe('My edited title');
  expect(calls.filter(c => c.method === 'PATCH')).toHaveLength(1);
});

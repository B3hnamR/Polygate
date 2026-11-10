import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as engine from '../backend/agent-engine';
import * as backup from '../backend/agent-backup';
import * as terminal from '../backend/agent-terminal';
import { agentApi, stopAgent } from '../backend/agent';
import { grantTrust, inspectTrust } from '../backend/agent-trust';

// In-memory engine transport: no gateway, child process, shell command, or network is needed.
let root: string, folder: string, sid: string, agentDir: string;
let oldAgentDir: string | undefined;
let messages: any[], revert: { messageID: string } | undefined;
let cancelFails: boolean, commitFails: boolean;
let activeSessions: Record<string, boolean>, folderSessionIDs: string[];
let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
let calls: { method: string; route: string }[];
let transport: typeof fetch;
let connectionSpy: { mockRestore(): void }, fetchSpy: { mockRestore(): void };
let restoreSpy: { mockRestore(): void } | undefined;
let terminalSpy: { mockRestore(): void } | undefined;
const originalRestore = backup.restoreFile;
const encoder = new TextEncoder();
const turnsPath = () => path.join(agentDir, 'turns', sid + '.json');
const journalPath = () => turnsPath() + '.undo';
const message = () => 'msg_' + sid;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'pg-integrity-'));
  folder = path.join(root, 'project'); agentDir = path.join(root, 'agent');
  mkdirSync(folder); mkdirSync(agentDir);
  oldAgentDir = process.env.POLYGATE_AGENT_DIR; process.env.POLYGATE_AGENT_DIR = agentDir;
  sid = 'integrity_' + path.basename(root).replace(/[^A-Za-z0-9_-]/g, '');
  messages = [{ id: message(), type: 'user' }, { id: 'assistant_' + sid, type: 'assistant' }];
  revert = undefined; cancelFails = false; commitFails = false; stream = undefined; calls = [];
  activeSessions = {}; folderSessionIDs = [sid];
  connectionSpy = spyOn(engine, 'engineConnection').mockReturnValue({ url: 'http://engine.invalid', auth: 'fixture' });
  transport = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input)), route = url.pathname, method = init?.method || 'GET';
    calls.push({ method, route });
    if (route === '/api/event') {
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller;
        controller.enqueue(encoder.encode('data: {"type":"server.heartbeat"}\n\n'));
        init?.signal?.addEventListener('abort', () => controller.close(), { once: true });
      } });
      return new Response(body);
    }
    if (route.endsWith('/revert/stage')) { revert = { messageID: message() }; return Response.json({}); }
    if (route.endsWith('/revert/commit')) {
      if (commitFails) return new Response('synthetic commit failure', { status: 500 });
      messages = messages.slice(0, 1); revert = undefined; return Response.json({});
    }
    if (route.endsWith('/revert') && method === 'DELETE') {
      if (cancelFails) return new Response('synthetic cancel failure', { status: 500 });
      revert = undefined; return Response.json({});
    }
    if (route === '/api/session/active') return Response.json(activeSessions);
    if (route === '/api/session') return Response.json(folderSessionIDs.map(id => ({ id })));
    if (route.endsWith('/permission') || route.endsWith('/diff')) return Response.json([]);
    if (route.endsWith('/message')) return Response.json({ data: messages });
    if (route.endsWith('/context')) return Response.json(messages);
    return Response.json({ id: sid, agent: 'polygate-ask', location: { directory: folder }, ...(revert ? { revert } : {}) });
  }) as typeof fetch;
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(transport);
});

afterEach(() => {
  restoreSpy?.mockRestore(); restoreSpy = undefined;
  terminalSpy?.mockRestore(); terminalSpy = undefined;
  stopAgent(); fetchSpy.mockRestore(); connectionSpy.mockRestore();
  if (oldAgentDir === undefined) delete process.env.POLYGATE_AGENT_DIR; else process.env.POLYGATE_AGENT_DIR = oldAgentDir;
  rmSync(root, { recursive: true, force: true });
});

async function api(route: string, body?: unknown) {
  let result: any;
  await agentApi({ method: body === undefined ? 'GET' : 'POST', url: route } as IncomingMessage, {} as ServerResponse,
    route.split('?')[0], async () => body, (_res, status, value) => { result = { status, body: value }; });
  return result;
}
const changes = () => api('/admin/agent/session/changes?id=' + sid);
const undo = () => api('/admin/agent/session/undo', { id: sid, message: message() });
const emit = (type: string, data: any) => stream!.enqueue(encoder.encode(`data: ${JSON.stringify({ type, data: { sessionID: sid, ...data } })}\n\n`));

function seedTurn(files = ['a.txt', 'b.txt', 'c.txt']) {
  const recorded = files.map(file => {
    const full = path.join(folder, file); mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, 'before ' + file);
    const before = { hash: backup.saveBytes(readFileSync(full)), mode: statSync(full).mode & 0o777 };
    writeFileSync(full, 'after ' + file);
    return { file, before, after: backup.saveBytes(readFileSync(full)), status: 'modified', additions: 1, deletions: 1, patch: '' };
  });
  mkdirSync(path.dirname(turnsPath()), { recursive: true });
  writeFileSync(turnsPath(), JSON.stringify([{ message: message(), at: Date.now(), files: recorded }]));
  return recorded;
}

function seedRecovery() {
  const files = seedTurn(['a.txt']);
  for (const file of files) originalRestore(folder, file.file, file.before);
  revert = { messageID: message() };
  writeFileSync(journalPath(), JSON.stringify({ message: message(), phase: 'restoring',
    rollback: files.map(f => [f.file, { hash: f.after, mode: f.before.mode }]),
    target: files.map(f => [f.file, f.before]), history: messages.map(m => m.id), remaining: [] }));
}

test('parallel session and changes GETs join one recovery and cancel staged history only once', async () => {
  seedRecovery();
  let reached!: () => void, release!: () => void, secondKnown!: () => void;
  const recovering = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const joined = new Promise<void>(resolve => { secondKnown = resolve; });
  let permissions = 0, histories = 0;
  fetchSpy.mockRestore();
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: RequestInit) => {
    const route = new URL(String(input)).pathname;
    if (route.endsWith('/message') && ++histories === 1) { reached(); await gate; }
    if (route.endsWith('/permission') && ++permissions === 2) secondKnown();
    return transport(input, init);
  }) as typeof fetch);
  restoreSpy = spyOn(backup, 'restoreFile').mockImplementation(originalRestore);
  const session = api('/admin/agent/session?id=' + sid);
  let changed: Promise<any> | undefined;
  let changedSettled = false;
  try {
    await recovering;
    changed = changes().finally(() => { changedSettled = true; });
    await joined;
    await Bun.sleep(0);
    expect(changedSettled).toBe(false);
    expect(histories).toBe(1);
  } finally { release(); }
  const results = await Promise.all([session, changed!]);
  expect(results.map(r => r.status)).toEqual([200, 200]);
  expect(calls.filter(c => c.method === 'DELETE' && c.route.endsWith('/revert'))).toHaveLength(1);
  expect(backup.restoreFile).toHaveBeenCalledTimes(1);
  expect(existsSync(journalPath())).toBe(false);
  expect(readFileSync(path.join(folder, 'a.txt'), 'utf8')).toBe('after a.txt');
  expect((await undo()).status).toBe(200); // The recovery lock was released.
});

test('a running sibling terminal blocks recovery without writes or journal removal and permits retry after stopping', async () => {
  seedRecovery();
  terminalSpy = spyOn(terminal, 'terminalInFolder').mockImplementation(dir => dir === folder);
  restoreSpy = spyOn(backup, 'restoreFile').mockImplementation(originalRestore);
  await expect(changes()).rejects.toMatchObject({ type: 'agent_busy' });
  expect(backup.restoreFile).not.toHaveBeenCalled();
  expect(existsSync(journalPath())).toBe(true);
  expect(readFileSync(path.join(folder, 'a.txt'), 'utf8')).toBe('before a.txt');
  expect(calls.some(c => c.method === 'DELETE' && c.route.endsWith('/revert'))).toBe(false);
  terminalSpy.mockRestore(); terminalSpy = undefined;
  expect((await changes()).status).toBe(200);
  expect(existsSync(journalPath())).toBe(false);
});

test('an engine-active sibling unknown to the controller blocks recovery and retains its journal', async () => {
  seedRecovery();
  const sibling = 'sibling_' + sid; folderSessionIDs.push(sibling); activeSessions[sibling] = true;
  restoreSpy = spyOn(backup, 'restoreFile').mockImplementation(originalRestore);
  await expect(changes()).rejects.toMatchObject({ type: 'agent_busy' });
  expect(backup.restoreFile).not.toHaveBeenCalled();
  expect(existsSync(journalPath())).toBe(true);
  expect(readFileSync(path.join(folder, 'a.txt'), 'utf8')).toBe('before a.txt');
  activeSessions = {};
  expect((await changes()).status).toBe(200);
});

test('commit reconciliation reuses its owning Undo lock without deadlocking and releases it for retry', async () => {
  seedTurn(['a.txt']); commitFails = true;
  await expect(undo()).rejects.toMatchObject({ type: 'agent_engine_error' });
  expect(existsSync(journalPath())).toBe(false);
  expect(readFileSync(path.join(folder, 'a.txt'), 'utf8')).toBe('after a.txt');
  commitFails = false;
  expect((await undo()).status).toBe(200);
  expect(readFileSync(path.join(folder, 'a.txt'), 'utf8')).toBe('before a.txt');
});

test('restore failure after replacement still enrolls that file and attempts all rollbacks after an independent failure', async () => {
  const files = seedTurn(); const attempts: string[] = [];
  restoreSpy = spyOn(backup, 'restoreFile').mockImplementation((dir, file, saved, bytes) => {
    const change = files.find(f => f.file === file)!;
    const rollingBack = saved?.hash === change.after;
    attempts.push((rollingBack ? 'rollback:' : 'restore:') + file);
    if (rollingBack && file === 'c.txt') throw new Error('synthetic rollback failure');
    originalRestore(dir, file, saved, bytes);
    if (!rollingBack && file === 'c.txt') throw new Error('synthetic chmod failure after replacement');
  });
  await expect(undo()).rejects.toMatchObject({ type: 'agent_undo_recovery' });
  expect(attempts).toEqual(['restore:a.txt', 'restore:b.txt', 'restore:c.txt', 'rollback:c.txt', 'rollback:b.txt', 'rollback:a.txt']);
  expect(readFileSync(path.join(folder, 'a.txt'), 'utf8')).toBe('after a.txt');
  expect(readFileSync(path.join(folder, 'b.txt'), 'utf8')).toBe('after b.txt');
  expect(existsSync(journalPath())).toBe(true);
  expect(JSON.parse(readFileSync(journalPath(), 'utf8')).rollback).toHaveLength(3);
  expect(JSON.parse(readFileSync(turnsPath(), 'utf8'))).toHaveLength(1);
  restoreSpy.mockRestore(); restoreSpy = undefined;
  expect((await changes()).body.turns).toHaveLength(1);
  expect(readFileSync(path.join(folder, 'c.txt'), 'utf8')).toBe('after c.txt');
  expect(existsSync(journalPath())).toBe(false);
});

test('a silently incomplete rollback fails verification and retains recovery state', async () => {
  const files = seedTurn(['a.txt', 'b.txt']);
  restoreSpy = spyOn(backup, 'restoreFile').mockImplementation((dir, file, saved, bytes) => {
    if (file === 'a.txt' && saved?.hash === files[0].after) return;
    originalRestore(dir, file, saved, bytes);
    if (file === 'b.txt' && saved?.hash === files[1].before.hash) throw new Error('synthetic restore failure');
  });
  await expect(undo()).rejects.toMatchObject({ type: 'agent_undo_recovery' });
  expect(existsSync(journalPath())).toBe(true);
  expect(readFileSync(path.join(folder, 'a.txt'), 'utf8')).toBe('before a.txt');
});

test('verified rollback may discard its journal only after staged history cancellation succeeds', async () => {
  const files = seedTurn(['a.txt']); cancelFails = true;
  restoreSpy = spyOn(backup, 'restoreFile').mockImplementation((dir, file, saved, bytes) => {
    originalRestore(dir, file, saved, bytes);
    if (saved?.hash === files[0].before.hash) throw new Error('synthetic post-write failure');
  });
  await expect(undo()).rejects.toMatchObject({ type: 'agent_undo_recovery' });
  expect(readFileSync(path.join(folder, 'a.txt'), 'utf8')).toBe('after a.txt');
  expect(existsSync(journalPath())).toBe(true); expect(revert).toBeDefined();
  restoreSpy.mockRestore(); restoreSpy = undefined;
  await expect(changes()).rejects.toMatchObject({ type: 'agent_undo_recovery' });
  expect(existsSync(journalPath())).toBe(true);
  cancelFails = false;
  expect((await changes()).body.turns).toHaveLength(1);
  expect(existsSync(journalPath())).toBe(false); expect(revert).toBeUndefined();
});

test('successful verified rollback removes the journal and preserves the original failure', async () => {
  const files = seedTurn(['a.txt']);
  restoreSpy = spyOn(backup, 'restoreFile').mockImplementation((dir, file, saved, bytes) => {
    originalRestore(dir, file, saved, bytes);
    if (saved?.hash === files[0].before.hash) throw new Error('synthetic post-write failure');
  });
  await expect(undo()).rejects.toThrow('synthetic post-write failure');
  expect(existsSync(journalPath())).toBe(false);
  expect(readFileSync(path.join(folder, 'a.txt'), 'utf8')).toBe('after a.txt');
});

test('history cancellation cannot change a rolled-back file unnoticed before journal removal', async () => {
  const files = seedTurn(['a.txt']);
  restoreSpy = spyOn(backup, 'restoreFile').mockImplementation((dir, file, saved, bytes) => {
    originalRestore(dir, file, saved, bytes);
    if (saved?.hash === files[0].before.hash) throw new Error('synthetic post-write failure');
  });
  fetchSpy.mockRestore();
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: RequestInit) => {
    const response = await transport(input, init);
    if (init?.method === 'DELETE' && new URL(String(input)).pathname.endsWith('/revert')) writeFileSync(path.join(folder, 'a.txt'), 'changed during cancellation');
    return response;
  }) as typeof fetch);
  await expect(undo()).rejects.toMatchObject({ type: 'agent_undo_recovery' });
  expect(existsSync(journalPath())).toBe(true);
  expect(readFileSync(path.join(folder, 'a.txt'), 'utf8')).toBe('changed during cancellation');
});

test('commit recovery also attempts every rollback independently and retains an uncertain journal', async () => {
  const files = seedTurn(); commitFails = true; const attempted: string[] = [];
  restoreSpy = spyOn(backup, 'restoreFile').mockImplementation((dir, file, saved, bytes) => {
    if (saved?.hash === files.find(f => f.file === file)!.after) {
      attempted.push(file); if (file === 'a.txt') throw new Error('synthetic recovery failure');
    }
    originalRestore(dir, file, saved, bytes);
  });
  await expect(undo()).rejects.toMatchObject({ type: 'agent_undo_recovery' });
  expect(attempted).toEqual(['a.txt', 'b.txt', 'c.txt']);
  expect(readFileSync(path.join(folder, 'b.txt'), 'utf8')).toBe('after b.txt');
  expect(existsSync(journalPath())).toBe(true);
});

test.skipIf(process.platform !== 'win32')('alternate-case backup paths and exclusions never turn an existing Windows file into an addition', async () => {
  mkdirSync(path.join(folder, 'Src')); writeFileSync(path.join(folder, 'Src', 'Keep.txt'), 'original\r\n');
  mkdirSync(path.join(folder, 'NODE_MODULES')); writeFileSync(path.join(folder, 'NODE_MODULES', 'keep.txt'), 'excluded');
  const saved = await backup.captureBackup(folder);
  expect(backup.beforeFile(saved, 'SRC/KEEP.TXT')).toEqual(saved.files['Src/Keep.txt']);
  expect(backup.beforeFile(saved, 'node_modules/keep.txt')).toBeUndefined();
  expect(backup.beforeFile({ files: {}, excluded: ['Skipped'] }, 'SKIPPED/keep.txt')).toBeUndefined();
  mkdirSync(path.dirname(turnsPath()), { recursive: true });
  writeFileSync(turnsPath() + '.pending', JSON.stringify(saved));
  await changes();
  writeFileSync(path.join(folder, 'Src', 'Keep.txt'), 'agent\r\n');
  emit('session.step.ended', { files: ['SRC/KEEP.TXT', 'Src/Keep.txt'] });
  emit('session.execution.succeeded', {});
  const end = Date.now() + 3000;
  while (!existsSync(turnsPath())) { if (Date.now() > end) throw new Error('turn was not recorded'); await Bun.sleep(1); }
  const recorded = (await changes()).body.turns;
  expect(recorded[0].files).toHaveLength(1);
  expect(recorded[0].files[0]).toMatchObject({ file: 'Src/Keep.txt', status: 'modified' });
  expect((await undo()).status).toBe(200);
  expect(readFileSync(path.join(folder, 'Src', 'Keep.txt'), 'utf8')).toBe('original\r\n');
});

test.skipIf(process.platform === 'win32')('POSIX identities and backup exclusions preserve case-distinct paths', async () => {
  // The identity contract is case-sensitive even on a POSIX host whose volume happens to fold case.
  expect(backup.fileKey('Src/Keep.txt')).not.toBe(backup.fileKey('src/keep.txt'));
  const saved = { files: { 'Src/Keep.txt': { hash: 'a'.repeat(64), mode: 0o644 } }, excluded: ['Skipped'] };
  expect(backup.beforeFile(saved, 'Src/Keep.txt')).toEqual(saved.files['Src/Keep.txt']);
  expect(backup.beforeFile(saved, 'src/keep.txt')).toBeNull();
  expect(backup.beforeFile(saved, 'skipped/new.txt')).toBeNull();
  expect(backup.beforeFile(saved, 'Skipped/new.txt')).toBeUndefined();
});

test.skipIf(process.platform !== 'win32')('Undo coalesces alternate-case identities across persisted Windows turns', async () => {
  const [first] = seedTurn(['a.txt']);
  const secondBefore = { hash: first.after, mode: first.before.mode };
  writeFileSync(path.join(folder, 'a.txt'), 'second edit');
  const secondAfter = backup.saveBytes(readFileSync(path.join(folder, 'a.txt')));
  writeFileSync(turnsPath(), JSON.stringify([
    { message: message(), at: 1, files: [first] },
    { message: 'later_' + sid, at: 2, files: [{ ...first, file: 'A.TXT', before: secondBefore, after: secondAfter }] },
  ]));
  const result = await undo();
  expect(result.status).toBe(200); expect(result.body.files).toHaveLength(1);
  expect(readFileSync(path.join(folder, 'a.txt'), 'utf8')).toBe('before a.txt');
});

test('revoking via a real folder interrupts a session opened through a directory alias and deduplicates recents', async () => {
  const realFolder = folder, alias = path.join(root, 'alias');
  symlinkSync(realFolder, alias, process.platform === 'win32' ? 'junction' : 'dir');
  grantTrust(realFolder); folder = alias;
  await changes();
  writeFileSync(path.join(agentDir, 'folders.json'), JSON.stringify([alias, realFolder]));
  const listed = (await api('/admin/agent/folders')).body.folders;
  expect(listed).toHaveLength(1); expect(listed[0].folder).toBe(alias);
  expect((await api('/admin/agent/trust/revoke', { folder: realFolder })).status).toBe(200);
  expect(calls.some(c => c.method === 'POST' && c.route === `/api/session/${sid}/interrupt`)).toBe(true);
  expect(inspectTrust(alias).trusted).toBe(false);
});

import { test, expect } from 'bun:test';
import { fromHistory, applyEvent, approvalTitle, toolSubject, withChanges, undoBlocked, blocks, stepsSummary, latestTodos, modelProviders, matchModels, folderName, type Item } from '../src/agent-logic';
// The Agent page's transcript, from a session's history and its live events (shapes as OpenCode 2.0.32 sends them).

test('history becomes the transcript: messages, reasoning, tools with their result, and stops', () => {
  const items = fromHistory([
    { id: 'msg_u', type: 'user', text: 'Fix the failing test' },
    { id: 'msg_a', type: 'assistant', content: [
      { type: 'reasoning', text: 'The bug is in text.js.' },
      { type: 'tool', id: 'call_1', name: 'shell', state: { status: 'completed', input: { command: 'npm test' }, content: [{ type: 'text', text: '# pass 3\n' }] } },
      { type: 'tool', id: 'call_2', name: 'edit', state: { status: 'error', input: { path: 'src/text.js' }, error: { message: 'Permission denied: edit' } } },
      { type: 'text', text: 'Done.' },
    ] },
    { id: 'msg_i', type: 'idle', outcome: 'interrupted' }, { id: 'msg_ok', type: 'idle', outcome: 'succeeded' },
    { id: 'msg_s', type: 'agent-switched', agent: 'polygate-plan' }, { id: 'msg_sys', type: 'system' },
  ]);
  expect(items.map(i => i.kind)).toEqual(['user', 'reasoning', 'tool', 'tool', 'text', 'note', 'note']);
  expect(items[2]).toMatchObject({ name: 'shell', status: 'done', output: '# pass 3\n', input: { command: 'npm test' } });
  expect(items[3]).toMatchObject({ status: 'failed', error: 'Permission denied: edit' });
  expect(items.slice(5).map(i => (i as any).text)).toEqual(['Stopped.', 'Mode: Plan']);
});

test('live events stream text and reasoning into one item each, and follow a tool from start to result', () => {
  const ev = (type: string, data: any) => ({ type, data: { sessionID: 's', assistantMessageID: 'm1', ...data } });
  let items: Item[] = [];
  for (const e of [
    { type: 'session.inbox.enqueued', data: { inboxID: 'msg_u', item: { type: 'user', payload: { text: 'hello' } } } },
    { type: 'session.inbox.enqueued', data: { inboxID: 'msg_u', item: { type: 'user', payload: { text: 'hello' } } } },
    ev('session.reasoning.started', { ordinal: 0 }), ev('session.reasoning.delta', { ordinal: 0, delta: 'Think' }), ev('session.reasoning.delta', { ordinal: 0, delta: 'ing' }), ev('session.reasoning.ended', { ordinal: 0, text: 'Thinking' }),
    ev('session.text.started', { ordinal: 0 }), ev('session.text.delta', { ordinal: 0, delta: 'Hel' }), ev('session.text.delta', { ordinal: 0, delta: 'lo' }),
    ev('session.tool.input.started', { id: 'call_1', name: 'shell' }), ev('session.tool.called', { id: 'call_1', input: { command: 'npm test' } }),
    ev('session.tool.success', { id: 'call_1', content: [{ type: 'text', text: 'ok' }] }),
    ev('session.text.ended', { ordinal: 0, text: 'Hello.' }),
  ]) items = applyEvent(items, e);
  expect(items.map(i => i.kind)).toEqual(['user', 'reasoning', 'text', 'tool']);
  expect(items[1]).toMatchObject({ text: 'Thinking', done: true }); expect((items[2] as any).text).toBe('Hello.');
  expect(items[3]).toMatchObject({ name: 'shell', status: 'done', input: { command: 'npm test' }, output: 'ok' });
});

test('retries keep one note that a new turn clears; stops, failures, auto-approvals and mode changes are noted', () => {
  let items: Item[] = [];
  for (const attempt of [2, 3]) items = applyEvent(items, { type: 'session.retry.scheduled', data: { attempt, error: { message: 'Gateway is paused.' } } });
  expect(items).toHaveLength(1); expect((items[0] as any).text).toContain('attempt 3');
  items = applyEvent(items, { type: 'session.execution.started', data: {} }); expect(items).toHaveLength(0);
  items = applyEvent(items, { type: 'agent.approval.auto', data: { requestID: 'per_1', resources: ['npm test'] } });
  items = applyEvent(items, { id: 'e1', type: 'session.execution.failed', data: { error: { message: 'boom' } } });
  items = applyEvent(items, { id: 'e2', type: 'session.execution.interrupted', data: {} });
  // A mode change is noted once: Polygate's agent.mode, not also the engine's session.agent.selected that follows it.
  items = applyEvent(items, { id: 'pg_1', type: 'agent.mode', data: { mode: 'full', fullUntil: 1 } });
  expect(applyEvent(items, { id: 'e3', type: 'session.agent.selected', data: { agent: 'polygate-full' } })).toBe(items);
  items = applyEvent(items, { id: 'pg_2', type: 'agent.mode', data: { mode: 'ask', reason: 'Full access ended. Ask for approval is active.' } });
  expect(items.map(i => (i as any).text)).toEqual(['Allowed for this session: npm test', 'This turn failed: boom', 'Stopped.', 'Mode: Full access', 'Full access ended. Ask for approval is active.']);
  expect(new Set(items.map(i => i.key)).size).toBe(items.length);
  expect(applyEvent(items, { type: 'server.heartbeat', data: {} })).toBe(items);
});

test('each turn\'s changed files sit at the end of that turn, from history and live', () => {
  const items = fromHistory([
    { id: 'u1', type: 'user', text: 'first' }, { id: 'a1', type: 'assistant', content: [{ type: 'text', text: 'did one' }] },
    { id: 'u2', type: 'user', text: 'second' }, { id: 'a2', type: 'assistant', content: [{ type: 'text', text: 'did two' }] },
  ]);
  const files = (file: string) => [{ file, status: 'modified', additions: 1, deletions: 0, patch: '+x' }];
  const merged = withChanges(items, [{ message: 'u1', at: 1, files: files('a.js') }, { message: 'u2', at: 2, files: files('b.js') }, { message: 'gone', at: 3, files: files('c.js') }]);
  expect(merged.map(i => i.kind === 'changes' ? `changes:${(i as any).files[0].file}` : (i as any).text)).toEqual(['first', 'did one', 'changes:a.js', 'second', 'did two', 'changes:b.js', 'changes:c.js']);
  expect(withChanges(merged, []).some(i => i.kind === 'changes')).toBe(false);
  let live: Item[] = [{ kind: 'user', key: 'u3', text: 'third' }];
  live = applyEvent(live, { type: 'agent.changes', data: { turn: { message: 'u3', files: files('d.js') } } });
  live = applyEvent(live, { type: 'agent.changes', data: { turn: { message: 'u3', files: [...files('d.js'), ...files('e.js')] } } });
  expect(live.filter(i => i.kind === 'changes').map(i => (i as any).files.length)).toEqual([2]);
});

test('approval cards and tool lines say what a request is about', () => {
  expect(approvalTitle('shell')).toBe('Run a command'); expect(approvalTitle('external_directory')).toBe('Use a folder outside the working folder'); expect(approvalTitle('odd')).toBe('Use odd');
  expect(toolSubject('shell', { command: 'npm test' })).toBe('npm test'); expect(toolSubject('read', { path: 'src/a.ts' })).toBe('src/a.ts'); expect(toolSubject('x', undefined)).toBe('');
  // OpenCode mixes separators (C:\\work\\app/src/text.js); paths inside the working folder are shown from it, others in full.
  const folder = 'C:\\Users\\me\\پروژه test\\app';
  expect(toolSubject('read', { path: 'C:\\Users\\me\\پروژه test\\app/src/text.js' }, folder)).toBe('src/text.js');
  expect(toolSubject('read', { path: 'c:\\users\\me\\پروژه test\\app' }, folder)).toBe('.');
  expect(toolSubject('read', { path: 'C:\\Users\\me\\other\\x.js' }, folder)).toBe('C:\\Users\\me\\other\\x.js');
  expect(toolSubject('shell', { command: 'C:\\Users\\me\\پروژه test\\app\\run.cmd' }, folder)).toBe('C:\\Users\\me\\پروژه test\\app\\run.cmd');
});

test('the transcript distinguishes saved rules, blocks, and Full access from session approvals', () => {
  let items = applyEvent([], { type: 'agent.approval.auto', data: { requestID: 'r', reason: 'Permission rule', resources: ['npm test'] } });
  items = applyEvent(items, { type: 'agent.approval.blocked', data: { requestID: 'b', resources: ['pwsh -enc x'] } });
  items = applyEvent(items, { type: 'agent.mode', data: { mode: 'full' } });
  expect(items.map(i => (i as any).text)).toEqual(['Permission rule: npm test', 'Blocked by permission rules: pwsh -enc x', 'Mode: Full access']);
  expect(items[2]).toMatchObject({ tone: 'warn' });
});

test('a turn can be undone only when it and every later turn have a backup, and the card says why not', () => {
  const card = (message: string, undoable: boolean, why?: string): Item => ({ kind: 'changes', key: `changes:${message}`, message, files: [], undoable, ...(why ? { why } : {}) });
  const blocked = undoBlocked([card('m1', true), { kind: 'user', key: 'u', text: 'next' }, card('m2', false, 'Folder backups were off.'), card('m3', true)]);
  expect(blocked.get('m3')).toBeUndefined();
  expect(blocked.get('m2')).toBe('Folder backups were off.');
  expect(blocked.get('m1')).toMatch(/later turn/);
  const fromRecord = withChanges([{ kind: 'user', key: 'msg_1', text: 'go' }], [{ message: 'msg_1', at: 1, files: [], undoable: false, why: 'Off.' }]);
  expect(fromRecord[1]).toMatchObject({ kind: 'changes', undoable: false, why: 'Off.' });
  expect(applyEvent([], { type: 'agent.changes', data: { turn: { message: 'msg_2', files: [] } } })[0]).toMatchObject({ undoable: true });
});

test('the model picker: providers with their counts, and a search over name, id and provider with usable models first', () => {
  const models = [
    { id: 'a/gpt-5', name: 'GPT-5', provider: 'Alpha', usable: true },
    { id: 'b/free-gpt', name: 'Free GPT', provider: 'OpenCode Free', usable: false },
    { id: 'b/qwen-coder', name: 'Qwen Coder', provider: 'OpenCode Free', usable: true },
    { id: 'a/claude', name: 'Sonnet', provider: 'Alpha', usable: true },
  ];
  expect(modelProviders(models)).toEqual([{ name: 'Alpha', count: 2, usable: 2 }, { name: 'OpenCode Free', count: 2, usable: 1 }]);
  expect(matchModels(models, '', 'gpt').map(m => m.id)).toEqual(['a/gpt-5', 'b/free-gpt']);
  expect(matchModels(models, 'OpenCode Free', '').map(m => m.id)).toEqual(['b/qwen-coder', 'b/free-gpt']);
  expect(matchModels(models, '', '  free   coder ').map(m => m.id)).toEqual(['b/qwen-coder']);
  expect(matchModels(models, 'Alpha', 'qwen')).toEqual([]);
  expect(folderName('D:\\JB\\project\\')).toBe('project'); expect(folderName('/home/me/app')).toBe('app'); expect(folderName('D:\\')).toBe('D:');
});

test('runs of tool calls fold into one line of steps, said the way a person would', () => {
  const tool = (key: string, name: string, input: any = {}, status: any = 'done'): Item => ({ kind: 'tool', key, name, input, status });
  const items: Item[] = [{ kind: 'user', key: 'u', text: 'go' }, tool('t1', 'read', { filePath: 'C:\\p\\src\\a.ts' }), tool('t2', 'bash', { command: 'npm test' }), tool('t3', 'bash', { command: 'git status' }, 'failed'),
    { kind: 'text', key: 'x', text: 'Done.' }, tool('t4', 'edit', { filePath: 'src/a.ts' }), tool('t5', 'edit', { filePath: 'src/b.ts' }), tool('t6', 'grep', { pattern: 'x' })];
  const b = blocks(items);
  expect(b.map(x => x.kind)).toEqual(['user', 'steps', 'text', 'steps']);
  expect(stepsSummary((b[1] as any).tools)).toBe('Read a.ts, ran 2 commands (1 failed)');
  expect(stepsSummary((b[3] as any).tools)).toBe('Edited 2 files, searched the code');
  expect(stepsSummary([tool('t7', 'mystery') as any])).toBe('Used mystery');
});

test("the agent's newest task list is read from its todo tool", () => {
  const write = (key: string, todos: any[]): Item => ({ kind: 'tool', key, name: 'todowrite', input: { todos }, status: 'done' });
  expect(latestTodos([write('a', [{ content: 'old', status: 'pending' }]), write('b', [{ content: 'Read the code', status: 'completed' }, { content: 'Fix it', status: 'in_progress' }, { content: 'Test', status: 'weird' }])]))
    .toEqual([{ content: 'Read the code', status: 'completed' }, { content: 'Fix it', status: 'in_progress' }, { content: 'Test', status: 'pending' }]);
  expect(latestTodos([{ kind: 'text', key: 't', text: 'hi' }])).toEqual([]);
});

test('a provider error that arrives as raw JSON is shown as its sentence, in the retry note too', () => {
  const { plainError } = require('../backend/plain-error');
  expect(plainError('{"code":429,"reason":"TOKEN_LIMIT_EXCEEDED","message":"You have exceeded the token rate limit.","metadata":{}}')).toBe('You have exceeded the token rate limit. (429 TOKEN_LIMIT_EXCEEDED)');
  expect(plainError('Upstream: {"error":{"message":"Bad key","type":"auth_error"}}')).toBe('Upstream: Bad key (auth_error)');
  expect(plainError('Gateway is paused.')).toBe('Gateway is paused.');
  const note = applyEvent([], { type: 'session.retry.scheduled', data: { attempt: 2, error: { message: '{"code":429,"message":"Slow down"}' } } })[0] as any;
  expect(note.text).toBe('The model request failed: Slow down (429). Trying again (attempt 2).');
});

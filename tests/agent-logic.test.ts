import { test, expect } from 'bun:test';
import { fromHistory, applyEvent, approvalTitle, toolSubject, type Item } from '../src/agent-logic';
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
  items = applyEvent(items, { id: 'e3', type: 'session.agent.selected', data: { agent: 'polygate-accept-edits' } });
  expect(items.map(i => (i as any).text)).toEqual(['Allowed for this session: npm test', 'This turn failed: boom', 'Stopped.', 'Mode: Accept edits']);
  expect(applyEvent(items, { type: 'server.heartbeat', data: {} })).toBe(items);
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

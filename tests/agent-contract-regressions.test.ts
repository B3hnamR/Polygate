import { expect, test } from 'bun:test';
import { agentFiles, engineFiles, fromEngineFiles } from '../backend/agent-attachments';
import { applyEvent, fromHistory, fromInbox, snapshotEvents } from '../src/agent-logic';

// Source: embedded JS in @opencode/cli-windows-x64 2.2.5 opencode.exe,
// SHA-256 0c346fdaf519d2f23a31d3b6cb9d65e369a72d77cac6f027b5e0a06376ec3a43.
// PromptInput.FileAttachment uses uri; Prompt.FileAttachment (history/inbox) uses data/mime.
const file = { name: 'note.txt', mime: 'text/plain', data: 'aGVsbG8=', source: { type: 'inline' as const } };

test('outgoing attachments use the pinned PromptInput URI contract', () => {
  expect(engineFiles(agentFiles([file]))).toEqual([{ name: 'note.txt', uri: 'data:text/plain;base64,aGVsbG8=', source: { type: 'inline' } }]);
  expect(engineFiles([])).toEqual([]);
});

test('history, queued snapshot and live inbox attachments use materialized bytes', () => {
  const projected = { ...file, source: { type: 'uri', uri: 'file:///private/original.txt' } };
  const history = fromHistory([{ id: 'msg_user', type: 'user', text: 'Review', files: [projected] }]);
  const inbox = { type: 'user', delivery: 'queue', payload: { text: 'Review', files: [projected] } };
  const queued = fromInbox([{ id: 'msg_queue', ...inbox }]);
  const live = applyEvent([], { type: 'session.inbox.enqueued', data: { inboxID: 'msg_queue', item: inbox } });
  expect(history[0]).toMatchObject({ kind: 'user', files: [file] });
  expect(queued).toEqual(live);
  expect(queued[0]).toMatchObject({ kind: 'queued', files: [file] });
  expect(applyEvent(live, { type: 'session.inbox.delivered', data: { inboxID: 'msg_queue' } })[0]).toMatchObject({ kind: 'user', files: [file] });
  const files = queued[0].kind === 'queued' ? queued[0].files! : [];
  expect(engineFiles(agentFiles(files))[0].uri).toBe('data:text/plain;base64,aGVsbG8=');
  expect(JSON.stringify(engineFiles(files))).not.toContain('file:///');
});

test('optional engine attachment names normalize without guessing a URI response format', () => {
  expect(fromEngineFiles([{ mime: 'IMAGE/PNG', data: 'aGVsbG8=', source: { type: 'inline' } }]))
    .toEqual([{ name: 'Attached file', mime: 'image/png', data: 'aGVsbG8=', source: { type: 'inline' } }]);
  expect(fromEngineFiles([{ name: 'not-materialized', uri: 'media:' + '0'.repeat(64), mime: 'image/png' }])).toEqual([]);
});

test('projected mixed content shares live type-local ordinals, including empty parts', () => {
  const snapshot = fromHistory([{ id: 'msg_reply', type: 'assistant', content: [
    { type: 'reasoning', text: 'Think' },
    { type: 'text', text: '' },
    { type: 'tool', id: 'call_read', name: 'read', state: { status: 'completed', input: {}, content: [{ type: 'text', text: 'file' }] } },
    { type: 'text', text: 'Answer' },
    { type: 'reasoning', text: 'Reconsider' },
    { type: 'text', text: 'More' },
  ] }]);
  expect(snapshot.map(i => i.key)).toEqual(['msg_reply:r0', 'msg_reply:t0', 'call_read', 'msg_reply:t1', 'msg_reply:r1', 'msg_reply:t2']);
  expect(snapshot.find(i => i.key === 'msg_reply:t0')).toEqual({ kind: 'text', key: 'msg_reply:t0', text: '' });
  const delta = { type: 'session.text.delta', data: { assistantMessageID: 'msg_reply', ordinal: 1, delta: ' suffix' } };
  expect(snapshotEvents(snapshot, [delta])).toEqual({ events: [], refresh: true });
  const ended = { type: 'session.text.ended', data: { assistantMessageID: 'msg_reply', ordinal: 1, text: 'Answer suffix' } };
  const replay = snapshotEvents(snapshot, [delta, ended]);
  expect(replay.refresh).toBe(false);
  let result = snapshot;
  for (const event of replay.events) result = applyEvent(result, event);
  expect(result.filter(i => i.key === 'msg_reply:t1')).toEqual([{ kind: 'text', key: 'msg_reply:t1', text: 'Answer suffix' }]);
  expect(result).toHaveLength(snapshot.length);
});

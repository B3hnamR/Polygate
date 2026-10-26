import { expect, test } from 'bun:test';
import { describeBody, describeHeaders, describeResponseHeaders, beginAttempt, finishAttempt, takeAttempts } from '../backend/diagnostics';

const PROMPT = 'PRIVATE-PROMPT-TEXT-7731';
const kiloLike = {
  model: 'opencode/deepseek-v4.1-flash-free', max_tokens: 32000, reasoning_effort: 'low', tool_choice: 'auto', stream: true, stream_options: { include_usage: true },
  messages: [
    { role: 'system', content: 'You are Kilo.\n<env>\n  Platform: win32\n</env>\nSecret rule: ' + PROMPT },
    { role: 'user', content: [{ type: 'text', text: 'hi ' + PROMPT }, { type: 'text', text: 'more' }] },
  ],
  tools: [{ type: 'function', function: { name: 'read_file', description: 'x', parameters: { type: 'object' } } }, { type: 'function', function: { name: 'run', description: 'y', parameters: { type: 'object' } } }],
};

test('A body is described by sizes and counts, never by its content', () => {
  const shape = describeBody(kiloLike, 1234);
  expect(shape).toMatchObject({ bytes: 1234, model: 'opencode/deepseek-v4.1-flash-free', stream: true, maxTokens: 32000, reasoningEffort: 'low', toolChoice: 'auto', messages: 2, tools: 2 });
  expect(shape.roles).toEqual({ system: 1, user: 1 });
  expect(shape.userChars).toBe(('hi ' + PROMPT).length + 4);
  expect(JSON.stringify(shape)).not.toContain(PROMPT);
  expect(JSON.stringify(shape)).not.toContain('read_file');
});

test('The <env> check reports whether each block carries a working directory', () => {
  expect(describeBody(kiloLike, 1).env).toEqual({ blocks: 1, blocksWithWorkingDirectory: 0, tagPresent: true, workingDirectoryAnywhereInSystem: false });
  const fixed = { ...kiloLike, messages: [{ role: 'system', content: '<env>\n  Working directory: /x\n</env>' }] };
  expect(describeBody(fixed, 1).env).toMatchObject({ blocks: 1, blocksWithWorkingDirectory: 1 });
  expect(describeBody({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, 1).env).toMatchObject({ blocks: 0, tagPresent: false });
});

test('Header values stay private: credentials are never kept and identifiers are reduced to a format and hash', () => {
  const h = describeHeaders({
    authorization: 'Bearer sk-live-supersecretvalue', cookie: 'session=abc', 'user-agent': 'kilo/latest/7.8.17', 'x-opencode-client': 'vscode',
    'x-opencode-session': 'ses_e8bac0664ffeSUsBzAOmtkLVp4', 'x-opencode-project': 'global', 'x-custom': 'ignored',
  });
  expect(h.auth).toMatch(/^Bearer key \(\d+ chars\)$/);
  expect(h.names).toContain('authorization');
  expect(h.values['user-agent']).toBe('kilo/latest/7.8.17');
  expect(h.identity['x-opencode-session']).toMatch(/^ses_…len\d+#[0-9a-f]{8}$/);
  const text = JSON.stringify(h);
  for (const secret of ['supersecretvalue', 'session=abc', 'e8bac0664ffe']) expect(text).not.toContain(secret);
  expect(describeHeaders({ authorization: 'Bearer public' }).auth).toBe('Bearer public');
  // The same identifier hashes the same, so reuse across requests is visible without recording it.
  expect(describeHeaders({ 'x-session-id': 'abc123def456' }).identity['x-session-id']).toBe(describeHeaders({ 'x-session-id': 'abc123def456' }).identity['x-session-id']);
});

test('Response headers keep names and a small allowlist of values', () => {
  const r = describeResponseHeaders(new Headers({ 'retry-after': '120', 'cf-ray': 'abc-FRA', 'set-cookie': 'a=b', 'content-type': 'application/json', 'x-ratelimit-remaining': '0' }));
  expect(r.values).toMatchObject({ 'retry-after': '120', 'cf-ray': 'abc-FRA', 'x-ratelimit-remaining': '0' });
  expect(r.names).toContain('set-cookie'); expect(r.values['set-cookie']).toBeUndefined();
});

test('Outbound attempts are recorded per request id and taken once', () => {
  const a = beginAttempt('req-1', 'https://example.test/v1/chat/completions?x=1', { method: 'POST', headers: { authorization: 'Bearer k' }, body: JSON.stringify(kiloLike) });
  finishAttempt(a, new Response('x', { status: 429, headers: { 'retry-after': '5' } }));
  expect(beginAttempt('req-1', 'https://example.test/models', { method: 'GET' })).toBeUndefined();
  const taken = takeAttempts('req-1');
  expect(taken).toHaveLength(1);
  expect(taken[0]).toMatchObject({ url: 'https://example.test/v1/chat/completions', method: 'POST', response: { status: 429 } });
  expect(taken[0].body.tools).toBe(2);
  expect(JSON.stringify(taken)).not.toContain(PROMPT);
  expect(takeAttempts('req-1')).toEqual([]);
});

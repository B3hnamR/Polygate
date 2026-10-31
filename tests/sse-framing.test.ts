import { test, expect } from 'bun:test';
import http from 'node:http';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
const { stream, collect, lfBody } = await import('../backend/protocols');
const enc = new TextEncoder();
const chunk = (t: string, finish: string | null = null, index = 0) => ({ id: 'c', object: 'chat.completion.chunk', model: 'm', choices: [{ index, delta: t ? { content: t } : {}, finish_reason: finish }] });
const frames = (eol: string, extra: any[] = []) => [chunk('Hello '), chunk('world'), ...extra, chunk('', 'stop'), '[DONE]'].map(x => 'data: ' + (typeof x === 'string' ? x : JSON.stringify(x)) + eol + eol).join('');
// The body is sent in the given pieces, so a line end can fall between two of them.
const response = (text: string, size = 7) => new Response(new ReadableStream({ start(c) { const b = enc.encode(text); for (let i = 0; i < b.length; i += size) c.enqueue(b.subarray(i, i + size)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });

for (const [label, eol] of [['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r']] as const) {
  for (const size of [3, 7, 1000]) {
    test(`${label} framing, pieces of ${size} bytes: a non-streaming answer keeps its text`, async () => {
      const c: any = await collect(response(frames(eol), size));
      expect(c.choices[0].message.content).toBe('Hello world'); expect(c.choices[0].finish_reason).toBe('stop');
    });
  }
}
const server = http.createServer((req, res) => {
  const q = new URL(req.url || '/', 'http://x').searchParams;
  stream(req, res, response(frames(q.get('eol') === 'crlf' ? '\r\n' : '\n'), 5), q.get('p') as any, 'm').catch(() => res.end());
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
import { afterAll } from 'bun:test'; afterAll(() => { server.close(); });
for (const p of ['chat', 'responses', 'anthropic']) {
  test(`${p}: a CRLF stream gives the same answer as an LF stream, with no mid-reply error`, async () => {
    const get = async (eol: string) => (await (await fetch(`${base}/?p=${p}&eol=${eol}`)).text()).replace(/(resp_|msg_)[0-9a-f]+/g, '$1X').replace(/"created_at":\d+/g, '"created_at":0');
    const lf = await get('lf'), crlf = await get('crlf');
    expect(crlf).toBe(lf); expect(crlf).toContain('world'); expect(crlf).not.toContain('mid-reply');
  });
}
test('a request with n > 1 keeps every choice, each with its own text', async () => {
  const c: any = await collect(response(['data: ' + JSON.stringify(chunk('A1 ', null, 0)), 'data: ' + JSON.stringify(chunk('B1 ', null, 1)), 'data: ' + JSON.stringify(chunk('A2', null, 0)), 'data: ' + JSON.stringify(chunk('B2', 'length', 1)), 'data: ' + JSON.stringify(chunk('', 'stop', 0)), 'data: [DONE]', ''].join('\n\n'), 9));
  expect(c.choices.map((x: any) => [x.index, x.message.content, x.finish_reason])).toEqual([[0, 'A1 A2', 'stop'], [1, 'B1 B2', 'length']]);
});
test('a body that is not an event stream is left alone', async () => {
  const r = new Response('{"a":1}\r\n', { headers: { 'content-type': 'application/json' } });
  expect(lfBody(r)).toBe(r);
});

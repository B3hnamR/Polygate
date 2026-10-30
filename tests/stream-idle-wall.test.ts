import { test, expect, afterAll } from 'bun:test';
import http from 'node:http';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
const { stream } = await import('../backend/protocols');
const adapters: any = await import('../vendor/protocols/adapters.mjs');
const enc = new TextEncoder();
const part = (text: string, finish: string | null = null) => enc.encode(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: text ? { content: text } : {}, finish_reason: finish }] })}\n\n`);
// An upstream that sends `parts` chunks `gap` ms apart; with `hang` it then goes silent for a second before it would have finished.
const upstream = (parts: number, gap: number, hang: boolean) => new Response(new ReadableStream({
  async start(c) {
    try {
      for (let i = 0; i < parts; i++) { await Bun.sleep(gap); c.enqueue(part(`word${i} `)); }
      if (hang) await Bun.sleep(1000);
      c.enqueue(part('', 'stop')); c.enqueue(enc.encode('data: [DONE]\n\n')); c.close();
    } catch { /* the reader was cancelled by the wall */ }
  }
}), { headers: { 'content-type': 'text/event-stream' } });
const before = adapters.config.timeoutMs; adapters.config.timeoutMs = 300;
const server = http.createServer((req, res) => {
  const q = new URL(req.url || '/', 'http://x').searchParams;
  stream(req, res, upstream(Number(q.get('parts')), Number(q.get('gap')), q.get('hang') === '1'), q.get('protocol') as any, 'm').catch(() => res.end());
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
afterAll(() => { adapters.config.timeoutMs = before; server.close(); });
const get = async (protocol: string, parts: number, gap: number, hang: boolean) => (await fetch(`${base}/?protocol=${protocol}&parts=${parts}&gap=${gap}&hang=${hang ? 1 : 0}`)).text();

for (const protocol of ['chat', 'anthropic', 'responses']) {
  test(`${protocol}: a reply that keeps streaming is not cut when it takes longer than the silence limit`, async () => {
    const t = Date.now(); const out = await get(protocol, 9, 100, false); // about 900 ms in all, three times the 300 ms limit
    expect(Date.now() - t).toBeGreaterThan(800);
    expect(out).not.toContain('relay wall'); expect(out).not.toContain('ended mid-reply'); expect(out).toContain('word8');
  });
}
// Only the chat pump can interrupt a read that is waiting; the other two end once the upstream next speaks, and the gateway's own idle timer covers a silence that never ends.
test('chat: an upstream that goes silent is still cut, and says so', async () => {
  const t = Date.now(); const out = await get('chat', 2, 50, true);
  expect(Date.now() - t).toBeLessThan(900); expect(out).toContain('upstream stalled past the relay wall'); expect(out).not.toContain('word8');
});

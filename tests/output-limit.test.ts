import { test, expect } from 'bun:test';
// A provider that refuses the requested output size (providers.ts withOutputLimit): asked once more within the limit it names, and the
// limit is kept on the model. State folder comes from tests/setup.ts.
const { namedOutputLimit, withOutputLimit } = await import('../backend/providers');
const { models } = await import('../backend/state');
const model = (output = 0) => ({ id: 'ol/m', upstreamId: 'm', providerId: 'ol', name: 'm', context: 200000, output, tools: true, reasoning: false, state: 'available' as const, latency: 0, score: 50, priority: 100, failCount: 0, cooldownUntil: 0, checkedAt: 0, error: '' });
const refusing = (limit: number, text: string) => { const sent: number[] = []; return { sent, send: async (b: any) => { sent.push(b.max_tokens); return b.max_tokens > limit ? new Response(JSON.stringify({ error: { message: text } }), { status: 400, headers: { 'content-type': 'application/json' } }) : new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }); } }; };

test('the limit a refusal names is read from the usual wordings', () => {
  expect(namedOutputLimit('max_tokens is too large: 32000. This model supports at most 16384 completion tokens, whereas you provided 32000.')).toBe(16384);
  expect(namedOutputLimit('max_tokens: 32000 > 8192, which is the maximum allowed number of output tokens')).toBe(0);
  expect(namedOutputLimit('Invalid max_output_tokens: maximum value is 65536')).toBe(65536);
  expect(namedOutputLimit('The requested output must be less than or equal to 4096 tokens')).toBe(4096);
});

test('a refused output size is asked again with the named limit, which the model then keeps', async () => {
  const m = model(); const p = refusing(16384, 'This model supports at most 16384 completion tokens');
  const r = await withOutputLimit(m, { max_tokens: 32000, messages: [] }, p.send);
  expect(r.ok).toBe(true); expect(p.sent).toEqual([32000, 16384]); expect(m.output).toBe(16384); expect(models.get('ol/m')?.output).toBe(16384);
  // Next time it goes out within the limit at once.
  const again = refusing(16384, 'x'); await withOutputLimit(m, { max_tokens: 32000, messages: [] }, again.send); expect(again.sent).toEqual([16384]);
});

test('with no limit named, 8k is tried once; other 400s and requests without an output size pass through untouched', async () => {
  const m = model(); const p = refusing(8192, 'max_tokens too large');
  expect((await withOutputLimit(m, { max_tokens: 32000 }, p.send)).ok).toBe(true); expect(p.sent).toEqual([32000, 8192]);
  const other = refusing(0, 'messages: invalid role'); const r = await withOutputLimit(model(), { max_tokens: 32000 }, other.send);
  expect(r.status).toBe(400); expect(other.sent).toEqual([32000]); expect(await r.text()).toContain('invalid role');
  const none = refusing(0, 'max_tokens'); expect((await withOutputLimit(model(), { messages: [] }, none.send)).status).toBe(200); expect(none.sent).toEqual([undefined as any]);
});

import { test, expect, afterEach } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
const { settings } = await import('../backend/state');
const { rerollRelay, describeRoutes, __setCanarySender, __resetReroll } = await import('../backend/transport');

const LIMIT = JSON.stringify({ error: { message: 'Free usage limit reached. Free models work in OpenCode (https://opencode.ai)', type: 'FreeUsageLimitError', code: 429, log_id: 'l' } });
const usedUp = () => new Response(LIMIT, { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '7200', 'x-relay-runtime': 'bun' } });
const passes = () => new Response('data: {}\n\n', { status: 200, headers: { 'x-relay-runtime': 'bun' } });
const relay = (id: string, over: object = {}) => { const r: any = { id, name: 'Relay ' + id, kind: 'relay' as const, url: 'https://relay.example/' + id, enabled: true, models: [] as string[], exhaustedUntil: Date.now() + 3600e3, status: 'Daily Free allowance used (resets 00:00)', ...over }; settings.routes.push(r as any); return r; };
const saved = settings.routes;
afterEach(() => { __setCanarySender(); __resetReroll(); settings.routes = saved; settings.relayRecheck = undefined; });

test('a used-up relay that comes back on a fresh address is usable again, and stops being asked', async () => {
  const r = relay('rr-back'); let asked = 0;
  __setCanarySender(async () => (++asked === 1 ? usedUp() : passes()));
  expect(await rerollRelay(r as any, 0)).toBe(true);
  expect(asked).toBe(2); expect(r.exhaustedUntil).toBe(0); expect(r.status).toBe('healthy');
});

test('a relay that stays used up is asked twice, then left alone, and says when it was asked', async () => {
  const r = relay('rr-stuck'); let asked = 0;
  __setCanarySender(async () => { asked++; return usedUp(); });
  expect(await rerollRelay(r as any, 0)).toBe(false);
  expect(asked).toBe(2); expect(r.exhaustedUntil!).toBeGreaterThan(Date.now()); expect(r.recheckedAt!).toBeGreaterThan(0);
  expect(describeRoutes()['rr-stuck'].detail).toContain('asked again');
  asked = 0; expect(await rerollRelay(r as any, 0)).toBe(false); expect(asked).toBe(0); // not again within the gap
});

test('only relays are asked again, and not when the setting is off, nor for a refusal, nor twice at once', async () => {
  let asked = 0; __setCanarySender(async () => { asked++; return passes(); });
  expect(await rerollRelay(relay('rr-direct', { kind: 'direct' }) as any, 0)).toBe(false);
  settings.relayRecheck = false; expect(await rerollRelay(relay('rr-off') as any, 0)).toBe(false); settings.relayRecheck = undefined;
  expect(await rerollRelay(relay('rr-refused', { status: 'Refused by the Free tier (retry after 00:00)' }) as any, 0)).toBe(false);
  expect(asked).toBe(0);
  const r = relay('rr-once'); __setCanarySender(async () => { asked++; await new Promise(x => setTimeout(x, 40)); return passes(); });
  const [a, b] = await Promise.all([rerollRelay(r as any, 0), rerollRelay(r as any, 0)]);
  expect([a, b].filter(Boolean).length).toBe(1); expect(asked).toBe(1);
});

test('a check that cannot be made (no answer, or a different problem) ends the asking without marking it as asked twice', async () => {
  const r = relay('rr-nothing'); let asked = 0;
  __setCanarySender(async () => { asked++; return undefined; });
  expect(await rerollRelay(r as any, 0)).toBe(false); expect(asked).toBe(1);
  expect(r.exhaustedUntil!).toBeGreaterThan(Date.now());
});

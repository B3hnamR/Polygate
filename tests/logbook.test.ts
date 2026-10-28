import { test, expect, beforeAll, afterAll } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
const { startGateway } = await import('../backend/main');
const { settings } = await import('../backend/state');
const { logEvent, queryEvents, exportEvents, clearEvents, parseLogQuery, adminAction } = await import('../backend/logbook');
let gateway: Awaited<ReturnType<typeof startGateway>>, base = ''; let savedToken: string | undefined;
const admin = { authorization: 'Bearer logbook-test-secret' };
const get = (p: string) => fetch(base + p, { headers: admin });
const post = (p: string, body: unknown = {}) => fetch(base + p, { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeAll(async () => {
  savedToken = process.env.POLYGATE_ADMIN_TOKEN; process.env.POLYGATE_ADMIN_TOKEN = 'logbook-test-secret';
  settings.warp = { engine: 'disabled', autoStart: false, pool: 1, rotateMinutes: 0, helperPath: '', endpoint: '' };
  gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`;
});
afterAll(async () => { await gateway?.close(); if (savedToken === undefined) delete process.env.POLYGATE_ADMIN_TOKEN; else process.env.POLYGATE_ADMIN_TOKEN = savedToken; });

test('startup is recorded with the version and address', async () => {
  const { version } = await import('../backend/version');
  expect(queryEvents({ sources: ['gateway'] }).entries.some(e => e.message === `Polygate ${version} started on http://127.0.0.1:${gateway.port}`)).toBe(true);
});
test('entries are stored newest first and filtered by level, source, text and time', () => {
  clearEvents();
  logEvent('info', 'warp', 'WARP connected through Frankfurt');
  logEvent('warn', 'routes', 'Direct is paused for 30 s', { route: 'direct' });
  logEvent('error', 'models', 'opencode/big-pickle is unavailable (HTTP 404)');
  const all = queryEvents({});
  expect(all.entries.map(e => e.source)).toEqual(['models', 'routes', 'warp']);
  expect(all.entries[1].detail).toEqual({ route: 'direct' });
  expect(all.levels).toEqual({ info: 1, warn: 1, error: 1 });
  expect(queryEvents({ levels: ['warn', 'error'] }).entries).toHaveLength(2);
  expect(queryEvents({ sources: ['warp'] }).entries[0].message).toContain('Frankfurt');
  expect(queryEvents({ q: 'big-pickle' }).entries).toHaveLength(1);
  expect(queryEvents({ q: 'direct' }).entries).toHaveLength(1);   // found in the detail
  expect(queryEvents({ q: '100%' }).entries).toHaveLength(0);      // % is matched literally, not as a wildcard
  expect(queryEvents({ from: Date.now() + 60000 }).entries).toHaveLength(0);
  // Chip counts ignore the level and source filters, so each chip shows what choosing it would add.
  const filtered = queryEvents({ levels: ['error'] }); expect(filtered.total).toBe(1); expect(filtered.levels.info).toBe(1);
});
test('older pages and the live view continue from the last entry seen', () => {
  clearEvents();
  for (let i = 0; i < 5; i++) logEvent('info', 'gateway', 'entry ' + i);
  const first = queryEvents({ limit: 2 }); expect(first.entries.map(e => e.message)).toEqual(['entry 4', 'entry 3']); expect(first.more).toBe(true);
  const older = queryEvents({ limit: 10, before: first.entries[1].id }); expect(older.entries.map(e => e.message)).toEqual(['entry 2', 'entry 1', 'entry 0']); expect(older.more).toBe(false);
  logEvent('warn', 'gateway', 'entry 5');
  const live = queryEvents({ after: first.entries[0].id }); expect(live.entries.map(e => e.message)).toEqual(['entry 5']);
});
test('secrets are removed before an entry is saved', () => {
  clearEvents(); const key = settings.keys[0].value;
  logEvent('warn', 'auth', `client sent ${key} with Bearer abc.def`, { header: `Bearer ${key}` });
  const [entry] = queryEvents({}).entries;
  expect(entry.message).not.toContain(key); expect(entry.message).toContain('[redacted]'); expect(JSON.stringify(entry.detail)).not.toContain(key);
});
test('exports as readable text or JSON lines, oldest first', () => {
  clearEvents(); logEvent('info', 'gateway', 'first'); logEvent('error', 'requests', 'second', { status: 502 });
  const text = exportEvents({}, 'txt').trim().split('\n'); expect(text).toHaveLength(2); expect(text[0]).toContain('INFO'); expect(text[1]).toMatch(/ERROR\s+requests\s+second/);
  const lines = exportEvents({ levels: ['error'] }, 'json').trim().split('\n').map(l => JSON.parse(l)); expect(lines).toEqual([expect.objectContaining({ message: 'second', detail: { status: 502 } })]);
});
test('query strings are read safely', () => {
  const q = parseLogQuery(new URLSearchParams('level=warn,bogus,ERROR&source=WARP&q=%20x%20&from=abc&after=12&limit=-3'));
  expect(q).toEqual({ levels: ['warn', 'error'], sources: ['warp'], q: 'x', from: undefined, to: undefined, before: undefined, after: 12, limit: undefined });
  expect(adminAction('/admin/providers')).toEqual(['providers', 'Provider saved', 'Provider']);
  expect(adminAction('/admin/state')).toBeUndefined();
});
test('the gateway logs its start, dashboard changes, refused changes and refused API requests', async () => {
  // The start entry was written before this file cleared the table, so restart the record with a fresh action.
  clearEvents();
  expect((await post('/admin/settings', { maxConcurrent: settings.maxConcurrent })).status).toBe(200);
  expect((await post('/admin/providers', { name: '' })).status).toBeGreaterThanOrEqual(400);
  expect((await fetch(base + '/v1/models', { headers: { authorization: 'Bearer wrong-key' } })).status).toBe(401);
  const r = (await (await get('/admin/events')).json()) as any;
  const messages = r.entries.map((e: any) => `${e.level} ${e.source} ${e.message}`);
  expect(messages).toContainEqual('info settings Gateway settings saved');
  expect(messages.some((m: string) => /^warn providers Provider failed: /.test(m))).toBe(true);
  expect(messages.some((m: string) => /^warn requests 401 GET \/v1\/models/.test(m))).toBe(true);
  expect(messages.some((m: string) => m.includes('wrong-key'))).toBe(false);
});
test('the logs can be filtered, exported and cleared over the admin API', async () => {
  clearEvents(); logEvent('error', 'warp', 'tunnel stopped'); logEvent('info', 'gateway', 'hello');
  const r = (await (await get('/admin/events?level=error')).json()) as any; expect(r.entries).toHaveLength(1); expect(r.levels).toEqual({ error: 1, info: 1 });
  const file = await get('/admin/events/export?format=json&source=gateway');
  expect(file.headers.get('content-disposition')).toMatch(/attachment; filename="polygate-logs-.+\.ndjson"/); expect(await file.text()).toContain('"hello"');
  expect((await fetch(base + '/admin/events')).status).toBe(401);
  expect((await post('/admin/events/clear')).status).toBe(200);
  const after = (await (await get('/admin/events')).json()) as any; expect(after.entries.map((e: any) => e.message)).toEqual(['Logs cleared']);
});

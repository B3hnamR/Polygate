import { test, expect, beforeEach, afterAll } from 'bun:test';
import net from 'node:net';
import { preserveTestState } from './setup';
const restore = preserveTestState();
// The Psiphon route without starting Psiphon: regions are stand-in SOCKS servers, so picking, skipping used-up exits, the route test and the
// settings are tested exactly, with no network.
const { settings } = await import('../backend/state');
const P = await import('../backend/psiphon');
const { networkFetch, findRoute, describeRoutes, backupChain, routeForProvider, testRoute, __setExitVerifier, __setPsiphonRegionTester } = await import('../backend/transport');

// A SOCKS5 server that sends every connection to one local HTTP target.
function socksTo(targetPort: number) {
  const server = net.createServer(client => {
    let state = 'greet'; let buf = Buffer.alloc(0);
    client.on('error', () => {}); client.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (state === 'greet' && buf.length >= 2) { buf = buf.subarray(2 + buf[1]); client.write(Buffer.from([5, 0])); state = 'request'; }
      if (state === 'request' && buf.length >= 5) {
        const atyp = buf[3]; const end = atyp === 1 ? 8 : atyp === 3 ? 5 + buf[4] : 20; if (buf.length < end + 2) return; state = 'pipe';
        const up = net.connect(targetPort, '127.0.0.1', () => { client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); const rest = buf.subarray(end + 2); if (rest.length) up.write(rest); up.pipe(client); client.pipe(up); });
        up.on('error', () => client.destroy());
      }
    });
  });
  return new Promise<{ port: number; close: () => void }>(r => server.listen(0, '127.0.0.1', () => r({ port: (server.address() as any).port, close: () => server.close() })));
}
type Answer = 'ok' | 'opencode-used-up' | 'kilo-limit';
const answers: Record<string, Answer> = {}; let hits: Record<string, number> = {};
const target = (name: string) => Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => { hits[name] = (hits[name] || 0) + 1; const a = answers[name];
  if (a === 'opencode-used-up') return new Response(JSON.stringify({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached' } }), { status: 429, headers: { 'retry-after': '3600', 'content-type': 'application/json' } });
  if (a === 'kilo-limit') return new Response(JSON.stringify({ error: { code: 'PROMOTION_MODEL_LIMIT_REACHED', message: 'limit' } }), { status: 429, headers: { 'content-type': 'application/json' } });
  return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }); } });
const servers = { DE: target('DE'), NL: target('NL'), FR: target('FR') };
const socks = { DE: await socksTo(servers.DE.port as number), NL: await socksTo(servers.NL.port as number), FR: await socksTo(servers.FR.port as number) };
const exits: Record<string, string> = { DE: '203.0.113.1', NL: '203.0.113.2', FR: '203.0.113.3' };
const instance = (region: keyof typeof socks, state = 'ready') => ({ region, port: socks[region].port, state, exitIp: exits[region], location: region, startedAt: Date.now(), readyAt: Date.now(), failures: 0, restarts: 0, error: '', renewedAt: [], output: '' }) as any;
afterAll(() => { for (const s of Object.values(socks)) s.close(); for (const s of Object.values(servers)) s.stop(true); P.__instances.clear(); P.__psiphonTest.scope = ''; __setExitVerifier(); __setPsiphonRegionTester(); restore(); });
beforeEach(() => {
  hits = {}; for (const r of ['DE', 'NL', 'FR']) answers[r] = 'ok'; answers.DE = 'opencode-used-up';
  P.__instances.clear();
  for (const r of ['DE', 'NL', 'FR'] as const) P.__instances.set(r, instance(r));
  settings.psiphon = { enabled: true, autoStart: false, regions: ['DE', 'NL', 'FR'], mode: 'spread', pinned: '', skip: true, renew: false, spent: {} };
  settings.routes = settings.routes.filter(r => r.id !== 'psiphon').concat({ id: 'psiphon', name: 'Psiphon', kind: 'proxy', url: 'psiphon://local', enabled: true, models: [], managed: true });
  settings.exhaustedFailover = true;
  P.__psiphonTest.scope = 'opencode';
  __setExitVerifier(async () => 'exhausted');
});
const post = () => networkFetch('http://127.0.0.9/v1/chat', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }, 'psiphon');

test('taking turns: each pick is the next connected region', () => {
  const picks = Array.from({ length: 6 }, () => P.pickPsiphon()!.region);
  expect(new Set(picks)).toEqual(new Set(['DE', 'NL', 'FR']));
  expect(picks.slice(0, 3)).toEqual(picks.slice(3, 6));
});
test('a region that is not connected, or already tried in this request, is not picked', () => {
  P.__instances.set('FR', instance('FR', 'reconnecting'));
  for (let i = 0; i < 6; i++) expect(['DE', 'NL']).toContain(P.pickPsiphon()!.region);
  expect(P.pickPsiphon(new Set(['DE', 'NL']))).toBeNull();
});
test('staying on one region uses only that region, and never another when it cannot take the request', () => {
  settings.psiphon = { ...settings.psiphon!, mode: 'single', pinned: 'NL' };
  for (let i = 0; i < 4; i++) expect(P.pickPsiphon(new Set(), 'opencode')!.region).toBe('NL');
  P.psiphonSpent('NL', Date.now() + 3600e3);
  expect(P.pickPsiphon(new Set(), 'opencode')).toBeNull();
  expect(P.psiphonUnavailable('opencode')).toContain('NL');
});
test('an exit used up for OpenCode is skipped only for OpenCode: Kilo and other providers still use it', () => {
  P.psiphonSpent('DE', Date.now() + 3600e3);
  expect(P.spentUntil(exits.DE)).toBeGreaterThan(Date.now());
  for (let i = 0; i < 6; i++) expect(P.pickPsiphon(new Set(), 'opencode')!.region).not.toBe('DE');
  expect(Array.from({ length: 6 }, () => P.pickPsiphon(new Set(), 'kilo')!.region)).toContain('DE');
  expect(Array.from({ length: 6 }, () => P.pickPsiphon(new Set(), 'other')!.region)).toContain('DE');
  // With skipping off it stays in turn for OpenCode too.
  settings.psiphon = { ...settings.psiphon!, skip: false };
  expect(Array.from({ length: 6 }, () => P.pickPsiphon(new Set(), 'opencode')!.region)).toContain('DE');
});
test('an expired used-up mark no longer counts', () => {
  settings.psiphon = { ...settings.psiphon!, spent: { [exits.DE]: Date.now() - 1000 } };
  expect(P.spentUntil(exits.DE)).toBe(0);
});
test('an OpenCode request moves past a used-up exit to the next region and answers', async () => {
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) { const r = await post(); seen.push(String(r.status)); await r.text(); }
  expect(seen).toEqual(['200', '200', '200']);
  expect(hits.DE).toBe(1); // asked once, confirmed used up, skipped from then on
  expect(P.spentUntil(exits.DE)).toBeGreaterThan(Date.now());
});
test('the same answer for a request to another provider is passed back as it is and marks nothing', async () => {
  P.__psiphonTest.scope = 'other'; settings.psiphon = { ...settings.psiphon!, mode: 'single', pinned: 'DE' };
  const r = await post(); expect(r.status).toBe(429); await r.text();
  expect(P.spentUntil(exits.DE)).toBe(0);
});
test("Kilo's per-address limit sets that region aside for Kilo only, and the request goes on through the next one", async () => {
  P.__psiphonTest.scope = 'kilo'; answers.DE = 'kilo-limit';
  for (let i = 0; i < 3; i++) { const r = await post(); expect(r.status).toBe(200); await r.text(); }
  expect(hits.DE).toBe(1);
  expect(P.kiloUntil(exits.DE)).toBeGreaterThan(Date.now());
  expect(P.spentUntil(exits.DE)).toBe(0);
  expect(Array.from({ length: 6 }, () => P.pickPsiphon(new Set(), 'opencode')!.region)).toContain('DE');
});
test('with skipping off, the used-up answer goes back to the client as it is', async () => {
  settings.psiphon = { ...settings.psiphon!, skip: false, mode: 'single', pinned: 'DE' };
  const r = await post(); expect(r.status).toBe(429); await r.text();
});
test('a refusal that the check through the same exit does not confirm leaves the exit in turn', async () => {
  __setExitVerifier(async () => 'refused');
  settings.psiphon = { ...settings.psiphon!, mode: 'single', pinned: 'DE' };
  const r = await post(); expect(r.status).toBe(429); await r.text();
  expect(P.spentUntil(exits.DE)).toBe(0);
});
test('a refused request goes on to another region and answers there; the refusing exit is not marked', async () => {
  __setExitVerifier(async () => 'refused');
  const seen: number[] = [];
  for (let i = 0; i < 3; i++) { const r = await post(); seen.push(r.status); await r.text(); }
  expect(seen).toEqual([200, 200, 200]);
  expect(hits.DE).toBeGreaterThanOrEqual(1);
  expect(P.spentUntil(exits.DE)).toBe(0);
});
test('the region a request answered through is kept for its log line, and a move between regions is logged', async () => {
  const { routeContext, takePsiphonRegion } = await import('../backend/transport');
  const { queryEvents } = await import('../backend/logbook');
  // Regions take turns; DE's exit is used up, so the request that lands on DE moves on and answers through another region.
  const from = Date.now();
  let answered = '';
  for (let i = 0; i < 3 && !answered; i++) {
    const id = 'psi-region-' + (i + 2); const x = await routeContext.run({ routeId: 'psiphon', requestId: id }, post); await x.text();
    const reg = takePsiphonRegion(id)!; expect(['DE', 'NL', 'FR']).toContain(reg); expect(x.status).toBe(200);
    if (hits.DE && reg !== 'DE') answered = reg;
  }
  expect(answered).not.toBe('');
  const moves = queryEvents({ sources: ['psiphon'], from, limit: 50 }).entries.filter((e: any) => e.message.startsWith('A request moved from Psiphon DE'));
  expect(moves.length).toBe(1);
  expect(moves[0].message).toContain('used up for OpenCode Free');
  expect(takePsiphonRegion('psi-region-2')).toBeUndefined(); // read once
});
test('a used-up region followed by refusing ones hands back a refusal with no stale used-up note', async () => {
  const { routeContext } = await import('../backend/transport');
  const { takeExhaustion, takeRefused } = await import('../backend/exhaustion');
  __setExitVerifier(async (id: string) => id.endsWith(':DE') ? 'exhausted' : 'refused');
  for (const r of ['NL', 'FR']) answers[r] = 'opencode-used-up';
  const r = await routeContext.run({ routeId: 'psiphon', requestId: 'psi-mixed-1' }, post); await r.text();
  expect(r.status).toBe(429);
  expect(takeRefused('psi-mixed-1')).toBe(true);
  expect(takeExhaustion('psi-mixed-1')).toBeUndefined();
  expect(P.spentUntil(exits.DE)).toBeGreaterThan(Date.now()); // DE itself is still marked used up
});
test('when every region refuses, the refusal goes back after at most three regions', async () => {
  __setExitVerifier(async () => 'refused');
  for (const r of ['NL', 'FR']) answers[r] = 'opencode-used-up';
  const r = await post(); expect(r.status).toBe(429); await r.text();
  expect((hits.DE || 0) + (hits.NL || 0) + (hits.FR || 0)).toBe(3);
  for (const x of ['DE', 'NL', 'FR'] as const) expect(P.spentUntil(exits[x])).toBe(0);
});
test('nothing connected: the request fails with a reason, not a hang', async () => {
  P.__instances.clear();
  await expect(post()).rejects.toThrow(/Psiphon is not connected/);
});
test('each region can be reached on its own for the used-up check', () => {
  expect(findRoute('psiphon:NL')!.url).toBe(`socks5://127.0.0.1:${socks.NL.port}`);
  expect(findRoute('psiphon:XX')).toBeUndefined();
});
test('the route counts as ready only while a region could take the request, for each provider on its own', () => {
  const free = { id: 'opencode', name: 'OpenCode Free', kind: 'free', enabled: true, baseUrl: '', apiKey: '', models: [], routeId: '', routes: { ids: ['psiphon'] } } as any;
  const kilo = { ...free, id: 'kilo', name: 'Kilo Free', kind: 'kilo' };
  for (const r of ['DE', 'NL', 'FR']) P.psiphonSpent(r, Date.now() + 3600e3);
  expect(() => routeForProvider(free, 'm')).toThrow(/OpenCode Free allowance/);
  expect(routeForProvider(kilo, 'm').id).toBe('psiphon');
  const step = backupChain().find(b => b.id === 'psiphon');
  if (step) { expect(step.usable).toBe(false); expect(step.why).toBe('every region used up'); }
  expect(describeRoutes().psiphon.detail).toContain('3 used up');
});
test('the Routing page says how many regions are connected', () => {
  P.__instances.set('FR', instance('FR', 'starting'));
  expect(describeRoutes().psiphon.label).toBe('2 regions connected');
});
test('testing the route checks every connected region through its own exit and marks only the used-up one', async () => {
  settings.psiphon = { ...settings.psiphon!, spent: { [exits.NL]: Date.now() + 3600e3 } }; // a stale mark the test should clear
  const asked: string[] = [];
  __setPsiphonRegionTester(async id => { asked.push(id); const region = id.split(':')[1];
    return region === 'DE' ? { ok: true, status: 200, buffered: false, chat: 'used-up', summary: 'used up', until: Date.now() + 7200e3, latency: 300 } : { ok: true, status: 200, buffered: false, chat: 'ok', summary: 'ok', latency: region === 'NL' ? 100 : 200 }; });
  const t = await testRoute('psiphon');
  expect(asked.sort()).toEqual(['psiphon:DE', 'psiphon:FR', 'psiphon:NL']);
  expect(t.regions!.map(r => [r.region, r.chat])).toEqual([['DE', 'used-up'], ['NL', 'ok'], ['FR', 'ok']]);
  expect(t.chat).toBe('ok');
  expect(t.summary).toBe('Psiphon: 2 of 3 regions answered (NL, FR); DE is used up.');
  expect(P.spentUntil(exits.DE)).toBeGreaterThan(Date.now() + 3600e3);
  expect(P.spentUntil(exits.NL)).toBe(0);
  // The whole route is never marked used up by a test.
  expect(settings.routes.find(r => r.id === 'psiphon')!.exhaustedUntil || 0).toBe(0);
});
test('testing the route while nothing is connected says so', async () => {
  P.__instances.clear();
  await expect(testRoute('psiphon')).rejects.toThrow(/not connected/);
});
test('the route is on only while Psiphon runs; when it stops while in use, requests go back to the route before it', () => {
  settings.routes = settings.routes.filter(r => r.id !== 'r-prev').concat({ id: 'r-prev', name: 'Previous relay', kind: 'relay', url: 'https://relay.test', enabled: true, models: [] } as any);
  settings.routeId = 'psiphon'; settings.previousRouteId = 'r-prev';
  P.reconcilePsiphon(); expect(settings.routes.find(r => r.id === 'psiphon')!.enabled).toBe(true);
  P.__instances.clear(); P.reconcilePsiphon();
  expect(settings.routes.find(r => r.id === 'psiphon')!.enabled).toBe(false);
  expect(settings.routeId).toBe('r-prev');
  // A remembered route that is switched off is passed over.
  settings.routes.find(r => r.id === 'psiphon')!.enabled = true; settings.routeId = 'psiphon'; settings.routes.find(r => r.id === 'r-prev')!.enabled = false;
  P.reconcilePsiphon(); expect(settings.routeId).toBe('direct');
});
test('a new address is only for a running region', async () => {
  P.__instances.delete('FR');
  await expect(P.renewRegion('FR')).rejects.toThrow(/not running/);
  await expect(P.renewRegion('JP')).rejects.toThrow(/not one of the chosen regions/);
});
test('settings: region codes are checked, single mode always has a region in use, turning off stops everything', async () => {
  await expect(P.setPsiphonSettings({ regions: ['DE', 'germany'] as any })).rejects.toThrow(/not a region code/);
  await expect(P.setPsiphonSettings({ mode: 'fast' as any })).rejects.toThrow(/spread or single/);
  P.__instances.clear();
  let s = await P.setPsiphonSettings({ regions: ['jp', 'us'], mode: 'single', pinned: 'DE' });
  expect(s.config.regions).toEqual(['JP', 'US']); expect(s.config.pinned).toBe('JP');
  P.__instances.set('DE', instance('DE')); settings.routes.find(r => r.id === 'psiphon')!.enabled = true; settings.routeId = 'psiphon';
  s = await P.setPsiphonSettings({ enabled: false });
  expect(P.__instances.size).toBe(0); expect(s.route.enabled).toBe(false); expect(settings.routeId).not.toBe('psiphon');
});
test('which service a request is for decides which limits apply', () => {
  P.__psiphonTest.scope = '';
  expect(P.scopeOfUrl('https://opencode.ai/inference/v1/chat/completions')).toBe('opencode');
  expect(P.scopeOfUrl('https://api.kilo.ai/api/gateway/chat/completions')).toBe('kilo');
  expect(P.scopeOfUrl('https://api.example.com/v1/chat')).toBe('other');
  expect(P.scopeOfKind('free')).toBe('opencode'); expect(P.scopeOfKind('kilo')).toBe('kilo'); expect(P.scopeOfKind('openai')).toBe('other');
});
test('the bundled client is found where the app ships it, or the reason is given', () => {
  const s = P.psiphonStatus();
  if (process.platform === 'win32' || (process.platform === 'linux' && process.arch === 'x64')) expect(s.installed).toBe(true);
  else expect(s.problem).toContain('no official client');
});

// --- a used-up region gets a new address and is checked with that provider before it takes that provider's requests again ---
// The stand-in exit lookup answers 198.51.100.20 for every address (tests/setup.ts), which plays the new address here.
const NEW_IP = '198.51.100.20';
// Like a real reconnect, the region keeps its count of new addresses this hour.
const reconnected = async (region: 'DE' | 'NL' | 'FR') => { P.__instances.set(region, { ...instance(region), exitIp: '', renewedAt: P.__instances.get(region)?.renewedAt || [] }); await P.__connected(region); };
test('a region used up for OpenCode is skipped for OpenCode until its new address passes a check with OpenCode', async () => {
  settings.psiphon = { ...settings.psiphon!, renew: true };
  const asked: string[] = []; let answer: 'ok' | 'used-up' | 'unknown' = 'ok';
  P.setPsiphonChecker(async (region, scope) => { asked.push(`${region}:${scope}`); return { result: answer }; });
  try {
    P.psiphonSpent('DE', Date.now() + 3600e3);
    expect(P.psiphonStatus().regions.find(r => r.region === 'DE')!.checking).toBe('opencode');
    await reconnected('DE');                                   // the new address: not known as used up, so it is checked
    expect(asked).toEqual(['DE:opencode']);
    expect(P.__instances.get('DE')!.exitIp).toBe(NEW_IP);
    expect(P.psiphonStatus().regions.find(r => r.region === 'DE')!.checking).toBe('');
    expect(Array.from({ length: 6 }, () => P.pickPsiphon(new Set(), 'opencode')!.region)).toContain('DE');
  } finally { P.setPsiphonChecker(); }
});
test('while the check is pending the region still carries other providers, and Kilo is checked with Kilo', async () => {
  settings.psiphon = { ...settings.psiphon!, renew: true };
  const asked: string[] = []; let release!: () => void; const gate = new Promise<void>(r => release = r);
  P.setPsiphonChecker(async (region, scope) => { asked.push(`${region}:${scope}`); await gate; return { result: 'ok' }; });
  try {
    P.psiphonKiloLimited('NL', Date.now() + 1800e3);
    const pending = reconnected('NL');
    for (let i = 0; i < 6; i++) expect(P.pickPsiphon(new Set(), 'kilo')!.region).not.toBe('NL');
    expect(Array.from({ length: 6 }, () => P.pickPsiphon(new Set(), 'opencode')!.region)).toContain('NL');
    expect(Array.from({ length: 6 }, () => P.pickPsiphon(new Set(), 'other')!.region)).toContain('NL');
    release(); await pending;
    expect(asked).toEqual(['NL:kilo']);
    expect(Array.from({ length: 6 }, () => P.pickPsiphon(new Set(), 'kilo')!.region)).toContain('NL');
  } finally { P.setPsiphonChecker(); }
});
test('a new address that is used up too gets another one, at most three a hour; then the region stays skipped for that provider', async () => {
  settings.psiphon = { ...settings.psiphon!, renew: true };
  let checks = 0;
  P.setPsiphonChecker(async () => { checks++; return { result: 'used-up', until: Date.now() + 3600e3 }; });
  try {
    P.psiphonSpent('FR', Date.now() + 3600e3);                  // 1st new address
    await reconnected('FR');                                   // used up too: marked, 2nd new address asked for
    expect(P.spentUntil(NEW_IP)).toBeGreaterThan(Date.now());
    expect(P.psiphonStatus().regions.find(r => r.region === 'FR')!.checking).toBe('opencode');
    // The next reconnects land on the same used-up address: no check is spent on it, another address is asked for, up to the limit.
    const renewedAt = P.__instances.get('FR')!.renewedAt;
    P.__instances.set('FR', { ...instance('FR'), exitIp: '', renewedAt }); await P.__connected('FR');
    P.__instances.set('FR', { ...instance('FR'), exitIp: '', renewedAt: P.__instances.get('FR')!.renewedAt }); await P.__connected('FR');
    expect(checks).toBe(1);
    expect(P.__instances.get('FR')!.renewedAt.length).toBe(3);
    expect(P.psiphonStatus().regions.find(r => r.region === 'FR')!.checking).toBe('');
    for (let i = 0; i < 6; i++) expect(P.pickPsiphon(new Set(), 'opencode')!.region).not.toBe('FR');
  } finally { P.setPsiphonChecker(); }
});
test('a check that cannot be read puts the region back in turn; turning the option off does the same', async () => {
  settings.psiphon = { ...settings.psiphon!, renew: true };
  P.setPsiphonChecker(async () => ({ result: 'unknown', note: 'no model ready' }));
  try {
    P.psiphonSpent('DE', Date.now() + 3600e3); await reconnected('DE');
    expect(Array.from({ length: 6 }, () => P.pickPsiphon(new Set(), 'opencode')!.region)).toContain('DE');
    P.psiphonSpent('NL', Date.now() + 3600e3);
    expect(P.psiphonStatus().regions.find(r => r.region === 'NL')!.checking).toBe('opencode');
    await P.setPsiphonSettings({ renew: false });
    expect(P.psiphonStatus().regions.find(r => r.region === 'NL')!.checking).toBe('');
  } finally { P.setPsiphonChecker(); }
});
test('the option is on by default', () => {
  delete (settings as any).psiphon;
  expect(P.psiphonConfig().renew).toBe(true);
});

test('a client reporting fewer regions does not shrink the list; Update servers replaces it; chosen regions always stay offered', () => {
  settings.psiphon = { ...settings.psiphon!, available: [] };
  P.__saveRegions(['AT', 'AU', 'DE', 'LT', 'NL', 'RO', 'RS']);
  P.__saveRegions(['DE', 'NL']); // another client, connected through a server that knows fewer regions
  expect(settings.psiphon!.available).toEqual(['AT', 'AU', 'DE', 'LT', 'NL', 'RO', 'RS']);
  P.__saveRegions(['BE', 'DE']); // a new region is still added
  expect(settings.psiphon!.available).toContain('BE');
  P.__saveRegions(['DE', 'NL', 'SE'], true); // Update servers: the fresh list is the list
  expect(settings.psiphon!.available).toEqual(['DE', 'NL', 'SE']);
  settings.psiphon = { ...settings.psiphon!, regions: ['DE', 'RS'] }; // RS was chosen earlier and is not in the fresh list
  expect(P.psiphonStatus().available).toEqual(['DE', 'NL', 'RS', 'SE']);
});

test('there is no limit on how many regions are chosen: all 25 Psiphon offers today, and more', async () => {
  const codes = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(65 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26)));
  const before = settings.psiphon; P.__instances.clear();
  try {
    await P.setPsiphonSettings({ regions: codes(25) }); expect(settings.psiphon!.regions.length).toBe(25);
    await P.setPsiphonSettings({ regions: codes(60) }); expect(settings.psiphon!.regions.length).toBe(60);
  } finally { settings.psiphon = before; }
});

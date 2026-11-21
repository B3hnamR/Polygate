import { test, expect, beforeEach, afterAll } from 'bun:test';
import net from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { preserveTestState } from './setup';
const restore = preserveTestState();
// The Surfshark route without starting WireGuard: locations are stand-in SOCKS servers, so the key pair, the server list, picking, skipping
// used-up exits, the route test and the settings are tested exactly, with no network.
const { settings, publicSettings, redactError } = await import('../backend/state');
const S = await import('../backend/surfshark');
const { exitGroups, __exitTest } = await import('../backend/exit-group');
const { networkFetch, findRoute, testRoute, takeExitRegion, routeContext, __setExitVerifier, __setPsiphonRegionTester } = await import('../backend/transport');

// A real WireGuard (X25519) key pair, made here: the test never uses anyone's key.
function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }); const pub = publicKey.export({ format: 'der', type: 'spki' });
  return { privateKey: Buffer.from(priv.subarray(priv.length - 32)).toString('base64'), publicKey: Buffer.from(pub.subarray(pub.length - 32)).toString('base64') };
}
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
const IDS = ['de-fra', 'nl-ams', 'za-jnb'] as const;
const targets = Object.fromEntries(IDS.map(id => [id, target(id)])) as Record<string, ReturnType<typeof target>>;
const socks: Record<string, { port: number; close: () => void }> = {}; for (const id of IDS) socks[id] = await socksTo(targets[id].port as number);
const exits: Record<string, string> = { 'de-fra': '198.51.100.11', 'nl-ams': '198.51.100.12', 'za-jnb': '198.51.100.13' };
const instance = (id: string, state = 'ready') => ({ region: id, port: socks[id].port, state, exitIp: exits[id], location: id, startedAt: Date.now(), readyAt: Date.now(), failures: 0, restarts: 0, error: '', renewedAt: [], output: '', handshake: true }) as any;
const serverList = IDS.map(id => ({ id, host: `${id}.prod.surfshark.com`, country: id === 'de-fra' ? 'Germany' : id === 'nl-ams' ? 'Netherlands' : 'South Africa', countryCode: id.slice(0, 2).toUpperCase(), location: id, pubKey: keyPair().publicKey }));
const pair = keyPair();
afterAll(() => { for (const s of Object.values(socks)) s.close(); for (const s of Object.values(targets)) s.stop(true); S.__instances.clear(); __exitTest.scope = ''; __setExitVerifier(); __setPsiphonRegionTester(); restore(); });
beforeEach(() => {
  hits = {}; for (const id of IDS) answers[id] = 'ok'; answers['de-fra'] = 'opencode-used-up';
  S.__instances.clear(); for (const id of IDS) S.__instances.set(id, instance(id));
  settings.surfshark = { enabled: true, autoStart: false, regions: [...IDS], mode: 'spread', pinned: '', skip: true, renew: false, spent: {}, servers: serverList, privateKey: pair.privateKey, publicKey: pair.publicKey, address: '10.14.0.2/16' };
  settings.routes = settings.routes.filter(r => r.id !== 'surfshark').concat({ id: 'surfshark', name: 'Surfshark', kind: 'proxy', url: 'surfshark://local', enabled: true, models: [], managed: true });
  settings.exhaustedFailover = true; __exitTest.scope = 'opencode';
  __setExitVerifier(async () => 'exhausted');
});
const post = () => networkFetch('http://127.0.0.9/v1/chat', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }, 'surfshark');

test('Psiphon, Surfshark and WireGuard are exit groups', () => {
  expect(exitGroups().map(g => g.id).sort()).toEqual(['psiphon', 'surfshark', 'wireguard']);
});
test('a key pair is checked before it is saved: the public key must belong to the private key', async () => {
  settings.surfshark = { ...settings.surfshark!, privateKey: undefined, publicKey: undefined };
  const k = keyPair();
  expect(S.publicKeyOf(k.privateKey)).toBe(k.publicKey);
  await expect(S.setSurfsharkKeys({ privateKey: k.privateKey, publicKey: keyPair().publicKey })).rejects.toThrow('does not belong');
  await expect(S.setSurfsharkKeys({ privateKey: 'not-a-key' })).rejects.toThrow('not a WireGuard private key');
  await expect(S.setSurfsharkKeys({ privateKey: '' })).rejects.toThrow('Paste the private key');
  const st = await S.setSurfsharkKeys({ privateKey: ` ${k.privateKey} `, publicKey: k.publicKey });
  expect(st.keys).toEqual({ saved: true, publicKey: k.publicKey });
  expect(settings.surfshark!.privateKey).toBe(k.privateKey);
  // The private key is in neither the page's status nor the settings the dashboard reads.
  expect(JSON.stringify(S.surfsharkStatus())).not.toContain(k.privateKey);
  expect(JSON.stringify(publicSettings())).not.toContain(k.privateKey);
  expect((publicSettings() as any).surfshark).toBeUndefined();
  // Only the private key may be given: the public one is worked out from it.
  const k2 = keyPair(); expect((await S.setSurfsharkKeys({ privateKey: k2.privateKey })).keys.publicKey).toBe(k2.publicKey);
  S.__instances.clear(); const cleared = await S.clearSurfsharkKeys(); expect(cleared.keys).toEqual({ saved: false, publicKey: '' }); expect(settings.surfshark!.privateKey).toBeUndefined();
});
test("Surfshark's server list is read into locations: host, server key, country, city; anything else is left out", () => {
  const k = keyPair().publicKey;
  const list = S.__parseServers([
    { connectionName: 'za-jnb.prod.surfshark.com', pubKey: k, country: 'South Africa', countryCode: 'ZA', location: 'Johannesburg', load: 12 },
    { connectionName: 'at-vie.prod.surfshark.com', pubKey: k, country: 'Austria', countryCode: 'AT', location: 'Vienna' },
    { connectionName: 'za-jnb.prod.surfshark.com', pubKey: k, country: 'South Africa' },   // the same location twice
    { connectionName: 'evil.example.com', pubKey: k, country: 'X' },                       // not a Surfshark server
    { connectionName: 'fr-par.prod.surfshark.com', pubKey: 'short', country: 'France' },  // no usable key
  ]);
  expect(list.map(s => s.id)).toEqual(['at-vie', 'za-jnb']);
  expect(list[1]).toMatchObject({ host: 'za-jnb.prod.surfshark.com', country: 'South Africa', countryCode: 'ZA', location: 'Johannesburg', load: 12 });
  expect(S.__parseServers({ not: 'a list' })).toEqual([]);
});

test('diagnostic errors redact both account keys without using personal fixtures', () => {
  const text = redactError(`private=${pair.privateKey} public=${pair.publicKey}`);
  expect(text).toBe('private=[redacted] public=[redacted]');
  expect(text).not.toContain(pair.privateKey); expect(text).not.toContain(pair.publicKey);
});
test("the client's settings: the location's server, port 51820, the account's address, MTU 1280 for a tunnel inside another, SOCKS on 127.0.0.1 only", () => {
  const text = S.__configText(serverList[2] as any, 47410);
  expect(text).toContain('Endpoint = za-jnb.prod.surfshark.com:51820');
  expect(text).toContain(`PublicKey = ${serverList[2].pubKey}`);
  expect(text).toContain('Address = 10.14.0.2/32');
  expect(text).toContain('MTU = 1280');
  expect(text).toContain('BindAddress = 127.0.0.1:47410');
  expect(text).toContain(`PrivateKey = ${pair.privateKey}`);
});
test('requests take turns over the locations; a used-up exit is skipped for OpenCode only, and the request moves on and answers', async () => {
  const seen: number[] = []; for (let i = 0; i < 3; i++) { const r = await post(); seen.push(r.status); await r.text(); }
  expect(seen).toEqual([200, 200, 200]);
  expect(hits['de-fra']).toBe(1);
  expect(S.spentUntil(exits['de-fra'])).toBeGreaterThan(Date.now());
  for (let i = 0; i < 6; i++) expect(S.pickSurfshark(new Set(), 'opencode')!.region).not.toBe('de-fra');
  expect(Array.from({ length: 6 }, () => S.pickSurfshark(new Set(), 'kilo')!.region)).toContain('de-fra');
});
test('the location a request answered through is kept for its log line', async () => {
  answers['de-fra'] = 'ok';
  const r = await routeContext.run({ routeId: 'surfshark', requestId: 'ss-region-1' }, post); await r.text();
  expect(IDS).toContain(takeExitRegion('ss-region-1') as any);
});
test("Kilo's per-address limit sets a location aside for Kilo only", async () => {
  __exitTest.scope = 'kilo'; answers['de-fra'] = 'kilo-limit';
  for (let i = 0; i < 3; i++) { const r = await post(); expect(r.status).toBe(200); await r.text(); }
  expect(S.kiloUntil(exits['de-fra'])).toBeGreaterThan(Date.now());
  expect(S.spentUntil(exits['de-fra'])).toBe(0);
});
test('staying on one location never uses another; each location can be reached on its own for a check', () => {
  settings.surfshark = { ...settings.surfshark!, mode: 'single', pinned: 'nl-ams' };
  for (let i = 0; i < 4; i++) expect(S.pickSurfshark(new Set(), 'opencode')!.region).toBe('nl-ams');
  expect(findRoute('surfshark:za-jnb')!.url).toBe(`socks5://127.0.0.1:${socks['za-jnb'].port}`);
  expect(findRoute('surfshark:xx-nowhere')).toBeUndefined();
});
test('Test on the Surfshark route checks every connected location through its own exit', async () => {
  __setPsiphonRegionTester(async (id: string) => ({ ok: !id.endsWith('de-fra'), status: 200, buffered: false, chat: id.endsWith('de-fra') ? 'used-up' : 'ok', summary: id, latency: 50, until: Date.now() + 3600e3 }));
  const t = await testRoute('surfshark');
  expect(t.regions!.map(r => r.region).sort()).toEqual([...IDS].sort());
  expect(t.summary).toContain('Surfshark: 2 of 3 locations answered');
  expect(S.spentUntil(exits['de-fra'])).toBeGreaterThan(Date.now());
  __setPsiphonRegionTester();
});
test('nothing connected: requests fail with a reason that names Surfshark', async () => {
  S.__instances.clear();
  await expect(post()).rejects.toThrow(/Surfshark is not connected/);
});
test('settings: locations are checked and kept in lower case, and there is no limit on how many', async () => {
  S.__instances.clear();
  await expect(S.setSurfsharkSettings({ regions: ['DE-FRA', 'bad location!'] })).rejects.toThrow('not a Surfshark location');
  const many = Array.from({ length: 140 }, (_, i) => `xx-${String(i).padStart(3, '0')}`);
  await S.setSurfsharkSettings({ regions: many }); expect(settings.surfshark!.regions.length).toBe(140);
  await S.setSurfsharkSettings({ regions: ['DE-FRA', 'nl-ams'], mode: 'single', pinned: 'ZA-JNB' }); expect(settings.surfshark!.regions).toEqual(['de-fra', 'nl-ams']); expect(settings.surfshark!.pinned).toBe('de-fra');
});
test('Connect says what is missing: the key pair, the server list, a location', async () => {
  S.__instances.clear();
  settings.surfshark = { ...settings.surfshark!, privateKey: undefined };
  await expect(S.surfsharkConnect()).rejects.toThrow(S.findWireproxy() ? 'key pair' : 'WireGuard client');
  settings.surfshark = { ...settings.surfshark!, privateKey: pair.privateKey, servers: [] };
  if (S.findWireproxy()) await expect(S.surfsharkConnect()).rejects.toThrow('Update servers');
});

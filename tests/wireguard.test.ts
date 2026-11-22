import { test, expect, beforeEach, afterAll } from 'bun:test';
import net from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { preserveTestState } from './setup';
const restore = preserveTestState();
// The WireGuard route without starting the bundled client: validation runs first, then stand-in SOCKS servers carry the same group behaviour
// as Psiphon and Surfshark (taking turns, used-up exits, limits per provider, route tests), with no network.
const { settings, publicSettings, redactError } = await import('../backend/state');
const W = await import('../backend/wireguard');
const { exitGroups, __exitTest } = await import('../backend/exit-group');
const { networkFetch, findRoute, testRoute, takeExitRegion, routeContext, __setExitVerifier, __setPsiphonRegionTester } = await import('../backend/transport');

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }); const pub = publicKey.export({ format: 'der', type: 'spki' });
  return { privateKey: Buffer.from(priv.subarray(priv.length - 32)).toString('base64'), publicKey: Buffer.from(pub.subarray(pub.length - 32)).toString('base64') };
}
const pair = keyPair();
const conf = (ifaceExtra = '', peerExtra = '') => `[Interface]
PrivateKey = ${pair.privateKey}
Address = 10.7.0.2/32
DNS = 1.1.1.1${ifaceExtra ? '\n' + ifaceExtra : ''}

[Peer]
PublicKey = ${pair.publicKey}
Endpoint = 127.0.0.1:51820
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25${peerExtra ? '\n' + peerExtra : ''}
`;
const AMNEZIA = `Jc = 5
Jmin = 50
Jmax = 1000
S1 = 50
S2 = 60
S3 = 70
S4 = 80
H1 = 1234
H2 = 1235-1300
H3 = 1301
H4 = 1400-1500
RandomTrailers = true`;

// Stand-in exits: a SOCKS5 server that forwards to a local target, so a request really travels the group's route.
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
type Answer = 'ok' | 'opencode-used-up' | 'opencode-rate-limit' | 'kilo-limit';
const answers: Record<string, Answer> = {}; let hits: Record<string, number> = {};
const target = (name: string) => Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => { hits[name] = (hits[name] || 0) + 1; const a = answers[name];
  if (a === 'opencode-used-up') return new Response(JSON.stringify({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached' } }), { status: 429, headers: { 'retry-after': '3600', 'content-type': 'application/json' } });
  if (a === 'opencode-rate-limit') return new Response(JSON.stringify({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached' } }), { status: 429, headers: { 'retry-after': '600', 'content-type': 'application/json' } });
  if (a === 'kilo-limit') return new Response(JSON.stringify({ error: { code: 'PROMOTION_MODEL_LIMIT_REACHED', message: 'limit' } }), { status: 429, headers: { 'content-type': 'application/json' } });
  return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }); } });
const IDS = ['wg-home', 'wg-work', 'wg-travel'] as const;
const targets = Object.fromEntries(IDS.map(id => [id, target(id)])) as Record<string, ReturnType<typeof target>>;
const socks: Record<string, { port: number; close: () => void }> = {}; for (const id of IDS) socks[id] = await socksTo(targets[id].port as number);
const exits: Record<string, string> = { 'wg-home': '198.51.100.21', 'wg-work': '198.51.100.22', 'wg-travel': '198.51.100.23' };
const instance = (id: string, state = 'ready') => ({ id, name: id, port: socks[id].port, state, exitIp: exits[id], location: '', startedAt: Date.now(), readyAt: Date.now(), failures: 0, restarts: 0, opened: 0, cooldownUntil: 0, lastTraffic: 0, probedAt: 0, error: '', output: '', handshake: true }) as any;
const entries = () => IDS.map(id => ({ id, name: id, config: conf(), enabled: true, addedAt: Date.now() }));
// A port nothing listens on: the local bridge answers its own marked 502 instead of carrying the request.
const closedPort = async () => { const s = net.createServer(); await new Promise<void>(r => s.listen(0, '127.0.0.1', () => r())); const port = (s.address() as any).port; await new Promise<void>(r => s.close(() => r())); return port; };
afterAll(() => { for (const s of Object.values(socks)) s.close(); for (const s of Object.values(targets)) s.stop(true); W.__instances.clear(); __exitTest.scope = ''; __setExitVerifier(); __setPsiphonRegionTester(); restore(); });
beforeEach(() => {
  hits = {}; for (const id of IDS) answers[id] = 'ok'; answers['wg-home'] = 'opencode-used-up';
  W.__instances.clear(); for (const id of IDS) W.__instances.set(id, instance(id));
  settings.wireguard = { enabled: true, autoStart: false, mode: 'spread', pinned: '', skip: true, spent: {}, configs: entries() };
  settings.routes = settings.routes.filter(r => r.id !== 'wireguard').concat({ id: 'wireguard', name: 'WireGuard', kind: 'proxy', url: 'wireguard://local', enabled: true, models: [], managed: true });
  settings.exhaustedFailover = true; __exitTest.scope = 'opencode';
  __setExitVerifier(async () => 'exhausted');
});
const post = () => networkFetch('http://127.0.0.9/v1/chat', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }, 'wireguard');

test('WireGuard is an exit group beside Psiphon and Surfshark', () => {
  expect(exitGroups().map(g => g.id)).toContain('wireguard');
});
test('a config is parsed into what the tunnel needs: the interface, every peer counted, the first endpoint, the keepalive', () => {
  expect(W.parseConfig(conf())).toMatchObject({ privateKey: pair.privateKey, addresses: ['10.7.0.2/32'], dns: ['1.1.1.1'], mtu: 1420,
    endpoint: '127.0.0.1:51820', peers: 1, amnezia: false, allowedIPs: '0.0.0.0/0, ::/0', keepalive: '25' });
  const second = `[Peer]
PublicKey = ${keyPair().publicKey}
Endpoint = [2001:db8::1]:51821
AllowedIPs = 10.0.0.0/8`;
  expect(W.parseConfig(conf('', '\n' + second))).toMatchObject({ peers: 2, endpoint: '127.0.0.1:51820' });
});
test('keys, sections and values are read the way the client reads them: case-insensitive, comments stripped, the first duplicate kept', () => {
  const text = `\uFEFF[interface]\r
privatekey = ${pair.privateKey} # the account key\r
PRIVATEKEY = not-a-key\r
Address = 10.7.0.2/32 ; the interface address\r
MTU = 1280\r
\r
[PEER]\r
PublicKey = ${pair.publicKey}\r
Endpoint = VPN.Example.com:51820\r
AllowedIPs = 0.0.0.0/0\r
`;
  expect(W.parseConfig(text)).toMatchObject({ privateKey: pair.privateKey, addresses: ['10.7.0.2/32'], mtu: 1280, endpoint: 'VPN.Example.com:51820' });
});
test('AmneziaWG fields are kept and checked like the client checks them', () => {
  const parsed = W.parseConfig(conf(AMNEZIA));
  expect(parsed.amnezia).toBe(true);
  expect(parsed.amneziaFields).toEqual(['Jc 5', 'Jmin 50', 'Jmax 1000', 'S1 50', 'S2 60', 'S3 70', 'S4 80', 'H1 1234', 'H2 1235-1300', 'H3 1301', 'H4 1400-1500', 'RandomTrailers true']);
  const headerKey = keyPair().privateKey;
  const hidden = W.parseConfig(conf(AMNEZIA + `\nI1 = <b 0xdeadbeef>\nHeaderProtectionKey = ${headerKey}`));
  expect(hidden.amneziaFields).toContain('I1');
  expect(hidden.amneziaFields).toContain('HeaderProtectionKey');
  expect(JSON.stringify(hidden.amneziaFields)).not.toContain(headerKey);
  expect(W.parseConfig(conf('Jc = 5')).amnezia).toBe(true);
  expect(() => W.parseConfig(conf('Jc = 0'))).toThrow('Jc must be between 1 and 128');
  expect(() => W.parseConfig(conf('Jc = 129'))).toThrow('Jc must be between 1 and 128');
  expect(() => W.parseConfig(conf('Jmin = 200\nJmax = 100'))).toThrow('Jmin must be less than or equal to Jmax');
  expect(() => W.parseConfig(conf('Jmax = 1281'))).toThrow('Jmax must be 1280 or less');
  expect(() => W.parseConfig(conf('S1 = 20\nS2 = 76'))).toThrow('give two packets the same size');
  expect(() => W.parseConfig(conf('H1 = 100-200\nH2 = 150'))).toThrow('header ranges H1 and H2 overlap');
  expect(() => W.parseConfig(conf(`HeaderProtectionKey = ${keyPair().privateKey}`))).toThrow('all four AmneziaWG padding values');
  expect(() => W.parseConfig(conf(`Jc = 5\nS1 = 5\nS2 = 60\nS3 = 70\nS4 = 80\nHeaderProtectionKey = ${keyPair().privateKey}`))).toThrow('at least 12');
  expect(() => W.parseConfig(conf('Jc = many'))).toThrow('JC must be a whole number');
  expect(() => W.parseConfig(conf('RekeyAfterTime = soon'))).toThrow('must be a number or a range');
  expect(() => W.parseConfig(conf('RandomTrailers = maybe'))).toThrow('must be on or off');
  // go-ini's Key.Bool accepts yes/no/on/off as well as true/false; the client would accept this file, so import must too.
  expect(W.parseConfig(conf('RandomTrailers = yes')).amnezia).toBe(true);
  expect(W.parseConfig(conf('DisableCookies = off')).amnezia).toBe(true);
  expect(() => W.parseConfig(conf('RandomTrailers = maybe'))).toThrow('must be on or off');
  expect(W.parseConfig(conf(AMNEZIA + '\nDisableCookies = true')).amnezia).toBe(true);
});
test('a file that is not a usable config is refused with the section and key that are wrong', () => {
  expect(() => W.parseConfig('Address = 10.0.0.2/32')).toThrow('no [Interface] section');
  expect(() => W.parseConfig(conf() + '\n[Interface]\nAddress = 10.0.0.3/32')).toThrow('more than one [Interface]');
  expect(() => W.parseConfig(conf().split('[Peer]')[0])).toThrow('no [Peer] section');
  expect(() => W.parseConfig(conf().replace(/^PrivateKey.*$/m, ''))).toThrow('no PrivateKey');
  const secret = 'SUPERSECRETKEYMATERIAL';
  let keyError = '';
  try { W.parseConfig(conf().replace(/^PrivateKey.*$/m, 'PrivateKey = ' + secret)); } catch (e: any) { keyError = e.message; }
  expect(keyError).toContain('not a 32-byte base64');
  expect(keyError).not.toContain(secret);
  expect(() => W.parseConfig(conf().replace(/^PrivateKey.*$/m, 'PrivateKey = short'))).toThrow('not a 32-byte base64');
  expect(() => W.parseConfig(conf().replace(/^Address.*$/m, ''))).toThrow('no Address');
  expect(() => W.parseConfig(conf().replace(/^Address.*$/m, 'Address = 10.0.0.2/33'))).toThrow('is not an IP address or CIDR');
  expect(() => W.parseConfig(conf().replace(/^DNS.*$/m, 'DNS = dns.example.com'))).toThrow('DNS entry "dns.example.com"');
  expect(() => W.parseConfig(conf('MTU = 10'))).toThrow('between 68 and 65535');
  expect(() => W.parseConfig(conf().replace(/^PublicKey.*$/m, ''))).toThrow('no PublicKey');
  expect(() => W.parseConfig(conf().replace(/^PublicKey.*$/m, 'PublicKey = short'))).toThrow('not a 32-byte base64 WireGuard key');
  expect(() => W.parseConfig(conf('', 'PresharedKey = short'))).toThrow('PresharedKey is not a 32-byte base64 key');
  expect(() => W.parseConfig(conf().replace(/^Endpoint.*$/m, 'Endpoint = vpn.example.com'))).toThrow('is not a host and port');
  expect(() => W.parseConfig(conf().replace(/^Endpoint.*$/m, 'Endpoint = bad_host:51820'))).toThrow('is not a host and port');
  expect(() => W.parseConfig(conf().replace(/^AllowedIPs.*$/m, 'AllowedIPs = 0.0.0.0'))).toThrow('is not a CIDR');
  expect(() => W.parseConfig(conf().replace(/^PersistentKeepalive.*$/m, 'PersistentKeepalive = often'))).toThrow('must be a number of seconds');
  expect(() => W.parseConfig(conf().replace(/^Endpoint.*$/m, 'Endpoint = vpn.example.com:70000'))).toThrow('is not a host and port');
});
test('the wrapper points the client at the uploaded file and gives it the local SOCKS port', () => {
  expect(W.__wrapperText('C:\\Users\\me\\wireguard.conf', 47701)).toBe('WGConfig = C:/Users/me/wireguard.conf\n\n[Socks5]\nBindAddress = 127.0.0.1:47701\n');
});
test('the client copy caps the tunnel MTU so large TLS packets fit the path', () => {
  const out = W.__clientText(conf('MTU = 1280'));
  expect(out).toContain('MTU = 1200');
  expect(out).not.toContain('MTU = 1280');
  expect(W.__clientText(conf('MTU = 900'))).toContain('MTU = 900');
  expect(W.__clientText(conf())).toContain('MTU = 1200');
  expect(W.__clientText(conf('MTU = 1280\nListenPort = 51820'))).not.toContain('ListenPort');
  // S4 junk is added to every AmneziaWG transport packet, so the inner MTU has to leave room for it.
  expect(W.__clientText(conf(AMNEZIA))).toContain('MTU = 1120'); // min(1420, 1200 - S4 80)
  expect(W.wireguardStatus().configs[0].mtuUsed).toBe(1200);
});
test('a config without DNS gets a tunnel resolver in the client copy so DNS cannot leak to the host', () => {
  const noDns = conf().replace(/^DNS = .*\r?\n/m, '');
  expect(W.parseConfig(noDns).dns).toEqual([]);
  const out = W.__clientText(noDns);
  expect(out).toContain('DNS = 1.1.1.1, 9.9.9.9');
  settings.wireguard = { ...W.wireguardConfig(), configs: [{ id: 'wg-nodns', name: 'no-dns', config: noDns, enabled: true, addedAt: Date.now() }] };
  const row = W.wireguardStatus().configs[0];
  expect(row.dns).toEqual([]);
  expect(row.dnsUsed).toEqual(['1.1.1.1', '9.9.9.9']);
});
test('the parser accepts the forms go-ini accepts: spaced sections, colons, quotes, hex numbers and inline comments', () => {
  const text = `[ Interface ]
PrivateKey: "${pair.privateKey}"
Address = 10.7.0.2/32
DNS = 1.1.1.1#comment
Jc = 0x10

[Peer]
PublicKey = ${pair.publicKey}
Endpoint = vpn.example.com:51820#comment
AllowedIPs = 0.0.0.0/0
`;
  expect(W.parseConfig(text)).toMatchObject({ mtu: 1420, endpoint: 'vpn.example.com:51820', amnezia: true, amneziaFields: ['Jc 0x10'] });
  expect(W.__clientText(text)).toContain('MTU = 1200'); // the spaced [ Interface ] header is still edited
});
test('a restored config id cannot become a path outside the WireGuard state folder', () => {
  const before = W.wireguardConfig().configs.length;
  settings.wireguard = { ...W.wireguardConfig(), configs: [
    { id: '../../../etc', name: 'bad', config: conf(), enabled: true, addedAt: Date.now() },
    { id: 'wg-safe01', name: 'good', config: conf(), enabled: true, addedAt: Date.now() },
  ] } as any;
  const c = W.wireguardConfig();
  expect(c.configs.map(x => x.id)).toEqual(['wg-safe01']);
  expect(c.configs.length).toBeLessThan(before + 2);
  settings.wireguard = { ...c, configs: entries() } as any;
});
test('import adds every file, always suffixing duplicates, and reports each file it could not use', async () => {
  W.__instances.clear(); settings.wireguard = { ...W.wireguardConfig(), configs: [] };
  const r = await W.wireguardImport([
    { name: 'home.conf', text: conf() },
    { name: 'home.conf', text: conf(AMNEZIA) },
    { name: 'home.conf', text: conf() },
    { name: 'broken.conf', text: conf().replace(/^PrivateKey.*$/m, 'PrivateKey = nope') },
    { name: 'empty.conf', text: '  ' },
  ]);
  expect(r.added.map(a => a.name)).toEqual(['home', 'home-2', 'home-3']);
  expect(r.added.map(a => a.renamedFrom)).toEqual([undefined, 'home', 'home']);
  expect(r.added.map(a => a.amnezia)).toEqual([false, true, false]);
  expect(r.failed.map(f => f.name)).toEqual(['broken', 'empty']);
  expect(r.summary).toContain('Imported 3 WireGuard configs (1 AmneziaWG); 2 could not be used');
  const c = W.wireguardConfig();
  expect(c.configs.map(x => x.name)).toEqual(['home', 'home-2', 'home-3']);
  expect(new Set(c.configs.map(x => x.id)).size).toBe(3);
  expect(c.configs.every(x => x.enabled)).toBe(true);
  expect(c.configs[1].config).toContain('Jc = 5');
  const status = W.wireguardStatus();
  expect(JSON.stringify(status)).not.toContain(pair.privateKey);
  expect(status.configs[0]).toMatchObject({ dns: ['1.1.1.1'], mtu: 1420, mtuUsed: 1200, keepalive: '25', allowedIPs: '0.0.0.0/0, ::/0', amnezia: false });
  expect(status.configs[1].amneziaFields).toContain('Jc 5');
  expect(status.config).not.toHaveProperty('renew');
  expect(status.configs[0]).not.toHaveProperty('checking');
  expect((publicSettings() as any).wireguard).toBeUndefined();
  expect(JSON.stringify(publicSettings())).not.toContain(pair.privateKey);
  const again = await W.wireguardImport([{ name: 'home.conf', text: conf() }]);
  expect(again.added[0].name).toBe('home-4');
  const long = await W.wireguardImport([{ name: 'n'.repeat(60) + '.conf', text: conf() }, { name: 'n'.repeat(60) + '.conf', text: conf() }]);
  expect(long.added.map(a => a.name.length)).toEqual([60, 60]);
  expect(long.added[1].name).toBe('n'.repeat(58) + '-2');
  await expect(W.wireguardImport([])).rejects.toThrow('Choose one or more');
  await expect(W.wireguardImport('nope' as any)).rejects.toThrow('Choose one or more');
});
test('imported keys are redacted from any error that quotes the file', () => {
  const k1 = keyPair(); const k2 = keyPair(); const k3 = keyPair(); const k4 = keyPair(); const k5 = keyPair();
  settings.wireguard = { ...W.wireguardConfig(), configs: [{ id: 'wg-x', name: 'x', enabled: true, addedAt: 1,
    config: conf().replace(/^PrivateKey.*$/m, 'PrivateKey = ' + k1.privateKey) + `PresharedKey = ${k2.privateKey} ; backup key\nHeaderProtectionKey = ${k3.privateKey} # header key\nPrivateKey: "${k4.privateKey}"\nPresharedKey: '${k5.privateKey}'\n` }] };
  const text = redactError(`a ${k1.privateKey} b ${k2.privateKey} c ${k3.privateKey} d ${k4.privateKey} e ${k5.privateKey}`);
  expect(text).toBe('a [redacted] b [redacted] c [redacted] d [redacted] e [redacted]');
});
test('requests take turns over the configs; a used-up exit is skipped for OpenCode only, and the request moves on and answers', async () => {
  const seen: number[] = []; for (let i = 0; i < 3; i++) { const r = await post(); seen.push(r.status); await r.text(); }
  expect(seen).toEqual([200, 200, 200]);
  expect(hits['wg-home']).toBe(1);
  expect(W.spentUntil(exits['wg-home'])).toBeGreaterThan(Date.now());
  for (let i = 0; i < 6; i++) expect(W.pickWireguard(new Set(), 'opencode')!.region).not.toBe('wg-home');
  expect(Array.from({ length: 6 }, () => W.pickWireguard(new Set(), 'kilo')!.region)).toContain('wg-home');
});
test('a short OpenCode 429 is a rate limit, so the config is not marked used up', async () => {
  // Stay on one config so this test does not advance the shared round-robin counter used by later tests.
  settings.wireguard = { ...settings.wireguard!, mode: 'single', pinned: 'wg-home' };
  answers['wg-home'] = 'opencode-rate-limit';
  const r = await post(); await r.text();
  expect(W.spentUntil(exits['wg-home'])).toBe(0);
  expect(W.wireguardConfig().spent?.[exits['wg-home']]).toBeUndefined();
  expect(W.pickWireguard(new Set(), 'opencode')!.region).toBe('wg-home');
});
test('the config a request answered through is kept for its log line', async () => {
  answers['wg-home'] = 'ok';
  const r = await routeContext.run({ routeId: 'wireguard', requestId: 'wg-config-1' }, post); await r.text();
  expect(IDS).toContain(takeExitRegion('wg-config-1') as any);
});
test("Kilo's per-address limit sets one config aside for Kilo only", async () => {
  __exitTest.scope = 'kilo'; answers['wg-home'] = 'kilo-limit';
  for (let i = 0; i < 3; i++) { const r = await post(); expect(r.status).toBe(200); await r.text(); }
  expect(W.kiloUntil(exits['wg-home'])).toBeGreaterThan(Date.now());
  expect(W.spentUntil(exits['wg-home'])).toBe(0);
});
test('staying on one config never uses another; each config can be reached on its own for a check', () => {
  settings.wireguard = { ...settings.wireguard!, mode: 'single', pinned: 'wg-work' };
  for (let i = 0; i < 4; i++) expect(W.pickWireguard(new Set(), 'opencode')!.region).toBe('wg-work');
  expect(findRoute('wireguard:wg-travel')!.url).toBe(`socks5://127.0.0.1:${socks['wg-travel'].port}`);
  expect(findRoute('wireguard:wg-nowhere')).toBeUndefined();
});
test('the route group names a config by its id, and still finds it by name', () => {
  W.__instances.get('wg-work')!.name = 'Work';
  settings.wireguard = { ...settings.wireguard!, mode: 'single', pinned: 'wg-work', skip: false };
  expect(W.pickWireguard(new Set(), 'opencode')!.region).toBe('wg-work');
  expect(W.pickWireguard(new Set(['wg-work']), 'opencode')).toBeNull();
  expect(findRoute('wireguard:Work')!.url).toBe(`socks5://127.0.0.1:${socks['wg-work'].port}`);
  expect(findRoute('wireguard:wg-work')!.url).toBe(`socks5://127.0.0.1:${socks['wg-work'].port}`);
});
test('Test on the WireGuard route checks every connected config through its own exit', async () => {
  __setPsiphonRegionTester(async (id: string) => ({ ok: !id.endsWith('wg-home'), status: 200, buffered: false, chat: id.endsWith('wg-home') ? 'used-up' : 'ok', summary: id, latency: 50, until: Date.now() + 3600e3 }));
  const t = await testRoute('wireguard');
  expect(t.regions!.map(r => r.region).sort()).toEqual([...IDS].sort());
  expect(t.summary).toContain('WireGuard: 2 of 3 configs answered');
  expect(W.spentUntil(exits['wg-home'])).toBeGreaterThan(Date.now());
  __setPsiphonRegionTester();
});
test('nothing connected: requests fail with a reason that names WireGuard', async () => {
  W.__instances.clear();
  await expect(post()).rejects.toThrow(/WireGuard is not connected/);
});
test('settings: mode, pinned config and a duplicate rename are checked; removing the pinned config clears it', async () => {
  W.__instances.clear();
  await expect(W.setWireguardSettings({ mode: 'everywhere' as any })).rejects.toThrow('Mode must be spread or single');
  await expect(W.setWireguardSettings({ pinned: 'wg-nope' })).rejects.toThrow('not one of the imported WireGuard configs');
  await W.setWireguardSettings({ mode: 'single', pinned: 'wg-work' });
  expect(W.wireguardConfig()).toMatchObject({ mode: 'single', pinned: 'wg-work' });
  await W.wireguardToggle('wg-work', false);
  expect(W.wireguardConfig().pinned).toBe('wg-home');
  await W.wireguardUpdate({ id: 'wg-travel', name: 'wg-home' });
  expect(W.wireguardConfig().configs.find(x => x.id === 'wg-travel')!.name).toBe('wg-home-2');
  await W.wireguardRemove('wg-home');
  expect(W.wireguardConfig().configs.map(x => x.name)).toEqual(['wg-work', 'wg-home-2']);
  expect(W.wireguardConfig().pinned).toBe('');
});
test('editing a config checks the new file before it is saved, and a running config keeps the old one when it is refused', async () => {
  W.__instances.clear();
  const before = W.wireguardConfig().configs.find(x => x.id === 'wg-work')!.config;
  await expect(W.wireguardUpdate({ id: 'wg-work', text: conf().replace(/^PrivateKey.*$/m, 'PrivateKey = nope') })).rejects.toThrow('not a 32-byte base64');
  expect(W.wireguardConfig().configs.find(x => x.id === 'wg-work')!.config).toBe(before);
  const changed = conf(AMNEZIA);
  await W.wireguardUpdate({ id: 'wg-work', name: 'office', text: changed });
  expect(W.wireguardConfigText('wg-work')).toContain('Jc = 5');
  expect(W.wireguardConfig().configs.find(x => x.id === 'wg-work')!.name).toBe('office');
  await expect(W.wireguardUpdate({})).rejects.toThrow('No such WireGuard config');
});
test('turning WireGuard off stops every client and takes the route out of use', async () => {
  W.__instances.clear(); settings.routeId = 'wireguard';
  const st = await W.setWireguardSettings({ enabled: false });
  expect(st.running).toBe(false);
  expect(st.route.enabled).toBe(false);
  expect(settings.routeId).not.toBe('wireguard');
});
test('an explicit stop hands requests back to the previous route and remembers the choice', async () => {
  const saved = { routes: settings.routes, routeId: settings.routeId, previousRouteId: settings.previousRouteId, managedChoice: settings.managedChoice };
  try {
    settings.routes = [
      { id: 'direct', name: 'Direct', kind: 'direct', url: '', enabled: true, models: [] },
      { id: 'wireguard', name: 'WireGuard', kind: 'proxy', url: 'wireguard://local', enabled: true, models: [], managed: true },
    ];
    settings.routeId = 'wireguard'; settings.previousRouteId = 'direct'; delete settings.managedChoice;
    await W.wireguardDisconnect();
    expect(settings.routeId).toBe('direct');
    expect((settings as any).managedChoice).toBe('wireguard');
    // The remembered choice puts WireGuard back in use when it connects again.
    W.__instances.set('wg-home', instance('wg-home'));
    W.reconcileWireguard();
    expect(settings.routeId).toBe('wireguard');
    expect((settings as any).managedChoice).toBeUndefined();
  } finally { Object.assign(settings, saved); }
});
test('with no other route on, stopping WireGuard leaves the selection on it and requests fail closed', async () => {
  const saved = { routes: settings.routes, routeId: settings.routeId, managedChoice: settings.managedChoice };
  try {
    settings.routes = [
      { id: 'direct', name: 'Direct', kind: 'direct', url: '', enabled: false, models: [] },
      { id: 'wireguard', name: 'WireGuard', kind: 'proxy', url: 'wireguard://local', enabled: true, models: [], managed: true },
    ];
    settings.routeId = 'wireguard'; delete settings.managedChoice;
    W.__instances.clear();
    await W.setWireguardSettings({ enabled: false });
    expect(settings.routeId).toBe('wireguard');
    expect(W.wireguardStatus().route.enabled).toBe(false);
    await expect(post()).rejects.toThrow('Network route is disabled or missing');
  } finally { Object.assign(settings, saved); }
});
test('a tunnel that cannot carry the request is marked by the local bridge, and the request moves to another config', async () => {
  W.__instances.get('wg-home')!.port = await closedPort();
  const r = await post(); expect(r.status).toBe(200); await r.text();
  expect(hits['wg-home']).toBeUndefined();
  expect(W.__instances.get('wg-home')!.failures).toBe(1);
});
test('when no tunnel carries the request, it fails as a route error that names WireGuard', async () => {
  for (const id of IDS) W.__instances.get(id)!.port = await closedPort();
  await expect(post()).rejects.toMatchObject({ status: 502, type: 'route_unreachable', message: expect.stringContaining('could not carry the request') });
});
test('a config paused after repeated failures is not picked until its wait ends', () => {
  const home = W.__instances.get('wg-home')!;
  home.cooldownUntil = Date.now() + 60000;
  for (let i = 0; i < 6; i++) expect(W.pickWireguard(new Set(), 'other')!.region).not.toBe('wg-home');
  home.cooldownUntil = 0;
  expect(Array.from({ length: 6 }, () => W.pickWireguard(new Set(), 'other')!.region)).toContain('wg-home');
});
test('three failures in a row pause the config out of turn', () => {
  const saved = { allowDirect: settings.allowDirect, failover: settings.failover };
  try {
    settings.allowDirect = true; settings.failover = true;
    for (const id of ['wg-work', 'wg-travel']) W.__instances.get(id)!.state = 'failed';
    const home = W.__instances.get('wg-home')!;
    W.wireguardFailed('wg-home'); W.wireguardFailed('wg-home');
    expect(home.state).toBe('ready');
    W.wireguardFailed('wg-home');
    expect(home.state).toBe('failed');
    expect(home.cooldownUntil).toBeGreaterThan(Date.now());
    expect(W.wireguardLive()).toBe(0);
  } finally { Object.assign(settings, saved); }
});
test('a used-up mark written before the exit address was known still skips that config', async () => {
  const home = W.__instances.get('wg-home')!; home.exitIp = '';
  settings.wireguard = { ...W.wireguardConfig(), spent: { 'id:wg-home': Date.now() + 3600e3 } };
  for (let i = 0; i < 6; i++) expect(W.pickWireguard(new Set(), 'opencode')!.region).not.toBe('wg-home');
  const r = await post(); expect(r.status).toBe(200); await r.text();
  expect(hits['wg-home']).toBeUndefined();
});
test('migrating an id-keyed used-up mark to the learned address keeps the later expiry', () => {
  const home = W.__instances.get('wg-home')!;
  const ip = exits['wg-home'], idUntil = Date.now() + 3600e3, ipUntil = Date.now() + 7200e3;
  settings.wireguard = { ...W.wireguardConfig(), spent: { [`id:${home.id}`]: idUntil, [ip]: ipUntil } };
  W.__migrateLimits(home, ip);
  expect(W.wireguardConfig().spent?.[ip]).toBe(ipUntil);
  expect(W.wireguardConfig().spent?.[`id:${home.id}`]).toBeUndefined();
  settings.wireguard = { ...W.wireguardConfig(), spent: { [`id:${home.id}`]: ipUntil, [ip]: idUntil } };
  W.__migrateLimits(home, ip);
  expect(W.wireguardConfig().spent?.[ip]).toBe(ipUntil);
});
test("a passing Kilo check clears WireGuard's mark for the address", () => {
  const g = exitGroups().find(x => x.id === 'wireguard')!;
  g.kiloLimited('wg-home', Date.now() + 3600e3);
  expect(W.kiloUntil(exits['wg-home'])).toBeGreaterThan(0);
  g.clearKilo!('wg-home', exits['wg-home']);
  expect(W.kiloUntil(exits['wg-home'])).toBe(0);
});
test('a config name never equals another config id', async () => {
  W.__instances.clear();
  settings.wireguard = { ...W.wireguardConfig(), configs: W.wireguardConfig().configs.map(x => ({ ...x, name: x.name.replace('wg-', '') })) };
  const r = await W.wireguardImport([{ name: 'wg-work.conf', text: conf() }]);
  expect(r.added[0].name).toBe('wg-work-2');
  expect(r.added[0].renamedFrom).toBe('wg-work');
  expect(W.wireguardConfig().configs.find(x => x.id === r.added[0].id)!.name).toBe('wg-work-2');
});
test('a config that is still starting reports what the client last said', () => {
  const home = W.__instances.get('wg-home')!; home.state = 'starting'; home.output = 'The handshake did not complete';
  expect(W.wireguardStatus().configs.find(x => x.id === 'wg-home')!.error).toContain('The handshake did not complete');
});
test('a restored setting is cleaned before use: unknown entries, duplicate ids, repeated names, modes and pins are dropped or defaulted', () => {
  settings.wireguard = { configs: [
    { id: 'a', name: 'x'.repeat(70), config: conf(), addedAt: '5' },
    { id: 'a', name: 'duplicate id', config: conf(), addedAt: 1 },
    { id: 'b' },
    { id: 'c', name: 'x'.repeat(70), config: conf(), addedAt: 2 },
    null,
  ], mode: 'weird', pinned: 'nope' } as any;
  const c = W.wireguardConfig();
  expect(c.configs.map(x => x.id)).toEqual(['a', 'c']);
  expect(c.configs[0].name.length).toBe(60);
  expect(c.configs[1].name.length).toBe(60);
  expect(c.configs[1].name.endsWith('-2')).toBe(true);
  expect(c.configs[0].enabled).toBe(true);
  expect(c.configs[0].addedAt).toBe(5);
  expect(c.mode).toBe('spread');
  expect(c.pinned).toBe('');
});
test('bulk removal stops the selected clients, keeps the rest, and clears a pinned selection', async () => {
  settings.wireguard = { ...W.wireguardConfig(), mode: 'single', pinned: 'wg-home' };
  const st = await W.wireguardRemoveMany(['wg-home', 'wg-work', 'wg-nope']);
  const c = W.wireguardConfig();
  expect(c.configs.map(x => x.id)).toEqual(['wg-travel']);
  expect(c.pinned).toBe('');
  expect([...W.__instances.keys()]).toEqual(['wg-travel']);
  expect(JSON.stringify(st)).not.toContain(pair.privateKey);
});
test('removing every config turns the route off and keeps the WireGuard settings', async () => {
  const saved = { routes: settings.routes, routeId: settings.routeId, previousRouteId: settings.previousRouteId, managedChoice: settings.managedChoice };
  try {
    settings.routes = [
      { id: 'direct', name: 'Direct', kind: 'direct', url: '', enabled: true, models: [] },
      { id: 'wireguard', name: 'WireGuard', kind: 'proxy', url: 'wireguard://local', enabled: true, models: [], managed: true },
    ];
    settings.routeId = 'wireguard';
    settings.wireguard = { ...W.wireguardConfig(), enabled: true, autoStart: true, mode: 'single', skip: false };
    const st = await W.wireguardRemoveAll();
    const c = W.wireguardConfig();
    expect(c.configs).toEqual([]);
    expect(c).toMatchObject({ enabled: true, autoStart: true, mode: 'single', skip: false });
    expect(st.route.enabled).toBe(false);
    expect(settings.routeId).toBe('direct');
    expect(W.__instances.size).toBe(0);
  } finally { Object.assign(settings, saved); }
});
test('identical files are marked from the kept copy, and duplicate removal keeps the pinned config', async () => {
  const bomCrlf = '\uFEFF' + conf().replace(/\n/g, '\r\n') + '\r\n';
  settings.wireguard = { ...W.wireguardConfig(), mode: 'single', pinned: 'wg-work', configs: [
    { id: 'wg-home', name: 'wg-home', config: conf(), enabled: true, addedAt: 1 },
    { id: 'wg-work', name: 'wg-work', config: bomCrlf, enabled: true, addedAt: 2 },
    { id: 'wg-travel', name: 'wg-travel', config: conf(), enabled: true, addedAt: 3 },
    { id: 'wg-extra', name: 'wg-extra', config: conf(AMNEZIA), enabled: true, addedAt: 4 },
  ] };
  const rows = W.wireguardStatus().configs;
  const row = (id: string) => rows.find(x => x.id === id)!;
  expect(row('wg-home').sameAs).toBe('wg-work');
  expect(row('wg-travel').sameAs).toBe('wg-work');
  expect(row('wg-work').sameAs).toBeUndefined();
  expect(row('wg-extra').sameAs).toBeUndefined();
  await W.wireguardRemoveDuplicates();
  const c = W.wireguardConfig();
  expect(c.configs.map(x => x.id)).toEqual(['wg-work', 'wg-extra']);
  expect(c.pinned).toBe('wg-work');
  expect([...W.__instances.keys()]).toEqual(['wg-work']);
});
test('duplicate removal keeps an enabled copy when the first copy is off', async () => {
  settings.wireguard = { ...W.wireguardConfig(), configs: [
    { id: 'wg-home', name: 'wg-home', config: conf(), enabled: false, addedAt: 1 },
    { id: 'wg-work', name: 'wg-work', config: conf(), enabled: true, addedAt: 2 },
  ] };
  await W.wireguardRemoveDuplicates();
  expect(W.wireguardConfig().configs.map(x => x.id)).toEqual(['wg-work']);
});
test('used-up removal deletes only connected configs whose exit is marked used up now', async () => {
  settings.wireguard = { ...W.wireguardConfig(), spent: { [exits['wg-home']]: Date.now() + 3600e3, [exits['wg-travel']]: Date.now() + 3600e3 } };
  W.__instances.delete('wg-travel');
  const st = await W.wireguardRemoveUsedUp();
  const c = W.wireguardConfig();
  expect(c.configs.map(x => x.id)).toEqual(['wg-work', 'wg-travel']);
  expect(st.configs.find((x: any) => x.id === 'wg-travel')!.usedUpUntil).toBe(0);
  expect(c.spent?.[exits['wg-home']]).toBeGreaterThan(Date.now());
  expect([...W.__instances.keys()]).toEqual(['wg-work']);
  const again = await W.wireguardRemoveUsedUp();
  expect(again.configs.map((x: any) => x.id)).toEqual(['wg-work', 'wg-travel']);
});
test('bulk removal refuses a missing selection or more ids than an import can add', async () => {
  await expect(W.wireguardRemoveMany([])).rejects.toThrow('Say which WireGuard configs to remove.');
  await expect(W.wireguardRemoveMany('nope' as any)).rejects.toThrow('Say which WireGuard configs to remove.');
  await expect(W.wireguardRemoveMany(Array.from({ length: 201 }, (_, i) => `wg-${i}`))).rejects.toThrow('Remove at most 200 configs at a time.');
  await expect(W.wireguardRemoveMany(['wg-nope'])).rejects.toMatchObject({ status: 404, message: 'Those WireGuard configs are no longer there. Reload the page and try again.' });
});

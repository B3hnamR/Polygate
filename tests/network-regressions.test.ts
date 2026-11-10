import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import path from 'node:path';
import net from 'node:net';
import { AsyncLocalStorage } from 'node:async_hooks';
import { gzipSync, gunzipSync } from 'node:zlib';

// Evaluate the current source with isolated dependencies: no real sockets, processes, state or timers.
function isolated(file: string, deps: Record<string, any>, exports: string[], js = false) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    .replace(/^import .*;\r?$/gm, '').replace(/^export \{[^\n]*\};\r?$/gm, '')
    .replace(/\bexport default\b/g, 'const relay =').replace(/\bexport /g, '');
  const code = js ? source : new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
  return new Function('deps', `const { ${Object.keys(deps).join(', ')} } = deps;\n${code}\nreturn { ${exports.join(', ')} };`)(deps);
}
class GatewayError extends Error {
  constructor(message: string, public status = 500, public type = '') { super(message); }
}
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; };
const tick = () => new Promise<void>(resolve => queueMicrotask(resolve));
const timer = () => ({ unref() {} });
const base = (settings: any = {}) => ({
  settings, path, net, stateDir: '/isolated', existsSync: () => false, readFileSync: () => '',
  mkdirSync() {}, writeFileSync() {}, writeFileAtomic() {}, persist() {}, notify() {},
  redactError: String, GatewayError, setTimeout: timer, clearTimeout() {}, setInterval: timer, clearInterval() {},
});

test('malformed percent credentials are rejected before any proxy socket is opened', async () => {
  let opened = 0;
  const engine = isolated('../backend/proxy-engine.ts', { ...base(), PROXY_SOURCES: [], net: { ...net, connect() { opened++; throw new Error('must not open'); } } }, ['checkApi']);
  for (const login of ['bad%:pass', 'user:bad%ZZ', 'bad%E0%A4:pass']) {
    expect(await engine.checkApi({ proxy: `http://${login}@8.8.8.8:8080`, proto: 'http' }, 1000, 'http://example.com/models')).toBeNull();
  }
  expect(opened).toBe(0);
});

test('downloaded text, JSON and ranges accept only canonical public IPv4 candidates', () => {
  const engine = isolated('../backend/proxy-engine.ts', { ...base(), PROXY_SOURCES: [] }, ['parseProxyText', 'isPublicHost']);
  const bad = ['127.0.0.01', '010.0.0.1', '192.168.001.1', '008.8.8.8', '256.1.1.1', '10.0.0.1', '172.16.0.1', '169.254.1.1', '100.64.0.1'];
  for (const host of bad) {
    expect(engine.isPublicHost(host)).toBe(false);
    for (const text of [`${host}:8080`, `${host}/30:8080`, JSON.stringify({ ip: host, port: 8080 })]) {
      expect(engine.parseProxyText(text, 'http', true)).toEqual([]);
    }
  }
  expect(engine.parseProxyText('8.8.8.8:8080', 'http', true).map((c: any) => c.host)).toEqual(['8.8.8.8']);
});

test('credential delimiters cannot change the validated endpoint across text and HTML parser stages', () => {
  const { parseProxyText } = isolated('../backend/proxy-engine.ts', { ...base(), PROXY_SOURCES: [] }, ['parseProxyText']);
  const inputs = [
    'http://127.0.0.1:80#@8.8.8.8:8080',
    'http://127.0.0.1:80?@8.8.8.8:8080',
    'http://user:p#fragment@8.8.8.8:8080',
    'http://user:p?query@8.8.8.8:8080',
    'http://user:p%2Fpath%40name@8.8.8.8:8080',
    'http://user:p/path@8.8.8.8:8080',
    'http://user:p@name@8.8.8.8:8080',
    '<table><tr><td>8.8.8.8</td><td>8080:alice:pass#?word</td></tr></table>',
  ];
  for (const text of inputs) {
    const candidates = parseProxyText(text, 'http', true);
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      const parsed = new URL(c.proxy);
      expect(c.host).toBe('8.8.8.8'); expect(parsed.hostname).toBe(c.host); expect(parsed.port).toBe('8080');
      expect(parsed.search).toBe(''); expect(parsed.hash).toBe(''); expect(parsed.pathname).toBe('/');
    }
  }
  const hostile = parseProxyText(inputs[0], 'http', true)[0];
  expect(decodeURIComponent(new URL(hostile.proxy).password)).toBe('80#');
  // The line parser must not approve a name that URL parsing turns into a different numeric endpoint.
  for (const text of ['http://user:secret@0x7f000001:8080', 'http://user:secret@2130706433:8080']) {
    expect(parseProxyText(text, 'http')).toEqual([]);
  }
});

test('JSON credentials are literal values, including delimiters and percent escapes', () => {
  const { parseProxyText } = isolated('../backend/proxy-engine.ts', { ...base(), PROXY_SOURCES: [] }, ['parseProxyText']);
  for (const proto of ['http', 'socks5']) for (const delimiter of ['#', '?', '/', '@', '%40', '%', ':', '\\']) {
    const username = `127.0.0.1${delimiter}name`; const password = `80${delimiter}secret`;
    const candidates = parseProxyText(JSON.stringify({ data: [{ ip: '8.8.8.8', port: 8080, protocol: proto, username, password }] }), 'http', true);
    expect(candidates.length).toBe(1);
    const c = candidates[0]; const parsed = new URL(c.proxy);
    expect(parsed.hostname).toBe('8.8.8.8'); expect(parsed.hostname).toBe(c.host); expect(parsed.port).toBe('8080');
    expect(decodeURIComponent(parsed.username)).toBe(username); expect(decodeURIComponent(parsed.password)).toBe(password);
    expect(parsed.search).toBe(''); expect(parsed.hash).toBe('');
    // A second text-parser pass must not decode the original literal percent value twice.
    expect(parseProxyText(c.proxy, 'http', true)[0].proxy).toBe(c.proxy);
  }
});

test('ordinary and URI-escaped text credentials retain their existing one-decode semantics', () => {
  const { parseProxyText } = isolated('../backend/proxy-engine.ts', { ...base(), PROXY_SOURCES: [] }, ['parseProxyText']);
  for (const [text, proxy, decoded] of [
    ['http://user:secret@8.8.8.8:8080', 'http://user:secret@8.8.8.8:8080', 'secret'],
    ['http://user:p%40ss@8.8.8.8:8080', 'http://user:p%40ss@8.8.8.8:8080', 'p@ss'],
    ['http://user:p%2540ss@8.8.8.8:8080', 'http://user:p%2540ss@8.8.8.8:8080', 'p%40ss'],
    ['8.8.8.8:8080:alice:secret', 'http://alice:secret@8.8.8.8:8080', 'secret'],
  ]) {
    const c = parseProxyText(text, 'http', true)[0];
    expect(c.proxy).toBe(proxy); expect(decodeURIComponent(new URL(c.proxy).password)).toBe(decoded);
    expect(parseProxyText(c.proxy, 'http', true)[0].proxy).toBe(proxy);
  }
});

test('nonrotating selected and explicit routes fail closed on provider incompatibility', () => {
  const restricted = { id: 'worker', kind: 'relay', name: 'Worker', enabled: true, models: [], only: 'kilo' };
  const settings = { routes: [restricted, { id: 'direct', kind: 'direct', enabled: true, models: [] }], routeId: 'worker', rotate: false };
  const { routeFor } = isolated('../backend/transport.ts', { ...base(settings), AsyncLocalStorage, promisify: () => () => {}, execFile() {} }, ['routeFor']);
  expect(() => routeFor('', '', 'free')).toThrow('cannot carry this provider');
  expect(() => routeFor('', 'worker', 'free')).toThrow('cannot carry this provider');
  expect(routeFor('', '', 'kilo')).toBe(restricted);
  expect(routeFor('', '', 'openai')).toBe(restricted); // existing Kilo/OpenAI compatibility remains intact
  settings.rotate = true;
  expect(() => routeFor('', 'worker', 'free')).toThrow('cannot carry this provider');
});

test('provider backups cannot reintroduce paused routes, including the clean pool', () => {
  const route = (id: string) => ({ id, name: id, kind: 'relay', enabled: true, models: [] });
  const a = route('A'), b = { ...route('B'), exhaustedUntil: Date.now() + 60000 }, backup = route('backup');
  const pool = { ...route('proxy-pool'), kind: 'proxy' };
  const settings = { routes: [a, b, pool, backup], exhaustedFailover: true };
  const provider = { id: 'free', kind: 'free', name: 'Free', routes: { ids: ['A', 'B'], paused: ['A', 'proxy-pool'], backups: true } };
  const transport = isolated('../backend/transport.ts', { ...base(settings), AsyncLocalStorage, promisify: () => () => {}, execFile() {}, hasCleanStandby: () => true, resetTime: () => 'fixture reset' }, ['routeForProvider', 'exhaustedRouteAfter', 'exhaustedAlternative']);
  expect(transport.routeForProvider(provider, 'model')).toBe(backup);
  expect(transport.exhaustedRouteAfter(provider, b)).toBe(backup);
  expect(transport.exhaustedAlternative(b)).toBe(pool); // global policy has no provider exclusions
  settings.routes = [a, b, pool];
  expect(() => transport.routeForProvider(provider, 'model')).toThrow('None of the routes');
  expect(transport.exhaustedRouteAfter(provider, b)).toBeUndefined();
  provider.routes.paused = ['A', 'B'];
  expect(() => transport.routeForProvider(provider, 'model')).toThrow('Every route');
  expect(transport.exhaustedRouteAfter(provider, b)).toBeUndefined();
});

test('scheduled full pool checks send nothing while the gateway is paused', async () => {
  const scheduled: { callback: () => void; ms: number }[] = []; let cleared = 0; let scans = 0;
  const settings = { enabled: false, routes: [{ id: 'proxy-pool', enabled: true }] };
  const pool = isolated('../backend/pool.ts', {
    ...base(settings), storedProxies: () => [], setInterval(callback: () => void, ms: number) { scheduled.push({ callback, ms }); return timer(); },
    clearInterval() { cleared++; },
  }, ['startPoolMaintenance', 'poolJob', '__setPoolEntries', '__setApiRunner']);
  pool.__setPoolEntries([{ url: 'http://8.8.8.8:8080', proxy: 'http://8.8.8.8:8080', host: '8.8.8.8', port: 8080, proto: 'http' }]);
  pool.__setApiRunner(async () => { scans++; return new Map(); });
  const stop = pool.startPoolMaintenance();
  for (const task of scheduled) task.callback();
  for (let i = 0; i < 10; i++) await tick();
  expect(scheduled.map(t => t.ms)).toEqual([45000, 20000, 60000]);
  expect(pool.poolJob().startedAt).toBe(0); expect(scans).toBe(0);
  settings.enabled = true; scheduled.find(t => t.ms === 60000)!.callback();
  for (let i = 0; i < 10; i++) await tick();
  expect(scans).toBe(1);
  stop(); expect(cleared).toBe(3);
});

function warpHarness(register?: (signal: AbortSignal) => Promise<any>) {
  const settings = { warp: { engine: 'embedded', pool: 1, split: 'off', helperPath: '/fake-helper' }, routes: [] };
  let killed = 0; let spawned = 0; let probeOk = false;
  const timers: { callback: () => void; ms: number }[] = [];
  const proc: any = new EventEmitter(); proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = () => { killed++; };
  const fakeNet = {
    ...net,
    createServer() { const server: any = new EventEmitter(); server.listen = (_: any, cb: () => void) => cb(); server.close = (cb: () => void) => cb(); return server; },
    connect() { const socket: any = new EventEmitter(); socket.destroy = () => {}; socket.setTimeout = () => {}; socket.write = () => queueMicrotask(() => socket.emit('data', Buffer.from([5, 0]))); queueMicrotask(() => socket.emit('connect')); return socket; },
  };
  const warp = isolated('../backend/warp.ts', {
    ...base(settings), net: fakeNet, setTimeout(callback: () => void, ms: number) { timers.push({ callback, ms }); return timer(); }, accessSync() {}, statSync: () => ({ isFile: () => true }), fsConstants: { X_OK: 1 },
    chmodSync() {}, rmSync() {}, readdirSync: () => [], readFileSync: () => register ? '{}' : JSON.stringify({ private_key: 'x', access_token: 'x', endpoint_pub_key: 'x' }),
    promisify: () => (_: any, __: any, opts: any) => register ? register(opts.signal) : Promise.resolve({}), execFile() {},
    spawn() { spawned++; return proc; }, socksBridge: async () => 'http://fake-bridge', socksConnect() {},
    fetch: async () => probeOk ? new Response('ip=8.8.8.8\nwarp=on\n') : new Response('', { status: 502 }),
    delay: async (_: number, __: any, opts: any) => { opts.signal.throwIfAborted(); }, Bun: { which: () => '', sleep: async () => {} },
  }, ['__tunnels', '__tunnelExited', 'refreshStatus', 'warpSuccess', 'warpConnect', 'setWarpSettings', 'stopWarp', 'warpStatus', 'restartTunnel', 'status']);
  return { warp, settings, proc, timers, counts: () => ({ killed, spawned }), probe: (ok: boolean) => { probeOk = ok; } };
}

test('busy WARP restart retries in the same epoch and admits the missing tunnel once', async () => {
  const h = warpHarness(); h.warp.status.busy = true; h.probe(true);
  await h.warp.restartTunnel(40000, 0, 1);
  expect(h.counts().spawned).toBe(0); expect(h.timers.map(t => t.ms)).toEqual([5000]);
  h.timers.shift()!.callback(); await tick();
  expect(h.counts().spawned).toBe(0); expect(h.timers.map(t => t.ms)).toEqual([5000]);
  h.warp.status.busy = false; const retry = h.timers.shift()!.callback;
  retry(); retry(); // an overlapping callback is rejected by the in-progress guard
  for (let i = 0; i < 40; i++) await tick();
  expect(h.counts().spawned).toBe(1); expect(h.warp.__tunnels.size).toBe(1);
  retry(); for (let i = 0; i < 10; i++) await tick();
  expect(h.counts().spawned).toBe(1); expect(h.timers.length).toBe(0);
  await h.warp.stopWarp();
});

test('a busy restart cannot reconnect after epoch cancellation or disabling WARP', async () => {
  for (const disabled of [false, true]) {
    const h = warpHarness(); h.warp.status.busy = true; h.probe(true);
    await h.warp.restartTunnel(40000, 0, 1);
    const retry = h.timers.shift()!.callback;
    if (disabled) h.settings.warp.engine = 'disabled'; else await h.warp.stopWarp();
    h.warp.status.busy = false; retry();
    for (let i = 0; i < 10; i++) await tick();
    expect(h.counts().spawned).toBe(0); expect(h.warp.__tunnels.size).toBe(0); expect(h.timers.length).toBe(0);
    await h.warp.stopWarp();
  }
});

test('live SOCKS with three failed real probes retires via the existing exit handler', async () => {
  const h = warpHarness();
  const tunnel = { port: 40000, index: 0, proc: h.proc, egress: { ip: '8.8.8.8' }, failures: 0, probeFailures: 0, cooldownUntil: 0, restarts: 0 };
  h.warp.__tunnels.set(tunnel.port, tunnel);
  await h.warp.refreshStatus(true, true); h.warp.warpSuccess(tunnel.port);
  await h.warp.refreshStatus(true, true); h.warp.warpSuccess(tunnel.port);
  expect(h.counts().killed).toBe(0);
  await h.warp.refreshStatus(true, true);
  expect(tunnel.probeFailures).toBe(3); expect(h.counts().killed).toBe(1);
  expect(h.warp.__tunnels.has(tunnel.port)).toBe(true);
  h.warp.__tunnelExited(tunnel.port, h.proc, 1, 0, -1);
  expect(h.warp.__tunnels.has(tunnel.port)).toBe(false);
});

test('only a successful real probe clears the probe-failure streak', async () => {
  const h = warpHarness(); const tunnel = { port: 40000, index: 0, proc: h.proc, egress: { ip: '8.8.8.8' }, failures: 0, probeFailures: 0, cooldownUntil: 0, restarts: 0 };
  h.warp.__tunnels.set(tunnel.port, tunnel);
  await h.warp.refreshStatus(true, true); expect(tunnel.probeFailures).toBe(1);
  h.probe(true); await h.warp.refreshStatus(true, true); expect(tunnel.probeFailures).toBe(0);
  h.probe(false); await h.warp.refreshStatus(true, true); expect(tunnel.probeFailures).toBe(1); expect(h.counts().killed).toBe(0);
});

test('disable during helper readiness cancels setup and kills the unadmitted helper', async () => {
  const h = warpHarness(); const connecting = h.warp.warpConnect().then(() => 'connected', () => 'cancelled');
  for (let i = 0; i < 20 && !h.counts().spawned; i++) await tick();
  expect(h.counts().spawned).toBe(1);
  await h.warp.setWarpSettings({ engine: 'disabled' });
  expect(await connecting).toBe('cancelled'); expect(h.counts().killed).toBeGreaterThan(0);
  expect(h.warp.__tunnels.size).toBe(0); expect((await h.warp.warpStatus()).connected).toBe(false);
  await h.warp.stopWarp();
});

test('disable aborts registration and rejects a late registration completion before spawning', async () => {
  const pending = deferred<any>(); let registrationSignal: AbortSignal | undefined;
  const h = warpHarness(signal => { registrationSignal = signal; return pending.promise; });
  const connecting = h.warp.warpConnect().then(() => 'connected', () => 'cancelled');
  for (let i = 0; i < 20 && !registrationSignal; i++) await tick();
  expect(registrationSignal).toBeDefined();
  await h.warp.setWarpSettings({ engine: 'disabled' }); expect(registrationSignal!.aborted).toBe(true);
  pending.resolve({}); expect(await connecting).toBe('cancelled');
  expect(h.counts().spawned).toBe(0); expect(h.warp.__tunnels.size).toBe(0);
  await h.warp.stopWarp();
});

const text = 'data: {"message":"compressed response"}\n\n';
const zipped = gzipSync(Buffer.from(text));
test('Netlify preserves real gzip bytes as base64 even for textual content types', async () => {
  const https = { request(_: any, cb: any) { const req: any = new EventEmitter(); req.end = () => { const res: any = new EventEmitter(); res.statusCode = 200; res.headers = { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' }; cb(res); res.emit('data', zipped); res.emit('end'); }; return req; } };
  const output: any = {};
  isolated('../relays/netlify-relay.js', { require: (id: string) => id === 'node:crypto' ? crypto : https, exports: output, process: { env: { POLYGATE_RELAY_TOKEN: 'secret' }, versions: process.versions } }, [], true);
  const response = await output.handler({ httpMethod: 'GET', headers: { 'x-relay-key': 'secret', 'x-relay-target': 'https://example.com' } });
  expect(response.isBase64Encoded).toBe(true); expect(response.headers['content-encoding']).toBe('gzip');
  expect(Buffer.from(response.body, 'base64')).toEqual(zipped); expect(gunzipSync(Buffer.from(response.body, 'base64')).toString()).toBe(text);
});

for (const bun of [false, true]) test(`Vercel ${bun ? 'Bun strips decoded' : 'Node preserves raw'} gzip metadata and bytes`, async () => {
  const https = { request(_: any, cb: any) { const req: any = new EventEmitter(); req.end = () => { const res: any = Readable.from([zipped]); res.statusCode = 200; res.headers = { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' }; cb(res); }; return req; } };
  const { relay } = isolated('../relays/vercel-bun/api/relay.js', {
    crypto, https, Readable, Bun: bun ? { version: 'test' } : undefined,
    process: { env: { POLYGATE_RELAY_TOKEN: 'secret' }, versions: process.versions },
    fetch: async (url: any) => String(url).endsWith('/cdn-cgi/trace') ? new Response('ip=8.8.8.8') : new Response(text, { headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' } }),
  }, ['relay'], true);
  const response = await relay.fetch(new Request('https://relay.example', { headers: { 'x-relay-key': 'secret', 'x-relay-target': 'https://example.com' } }));
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(response.headers.get('content-encoding')).toBe(bun ? null : 'gzip');
  expect(bun ? bytes.toString() : gunzipSync(bytes).toString()).toBe(text);
  if (!bun) expect(bytes).toEqual(zipped);
});

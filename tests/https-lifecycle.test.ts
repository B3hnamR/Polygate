import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import dns from 'node:dns/promises';
import os from 'node:os';
import path from 'node:path';
import * as https from '../backend/https';
import * as state from '../backend/state';
import * as notifications from '../backend/notifications';

// Exercise the real module with inert network/listener/timer boundaries, not a copied implementation.
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const managed = (httpPort = 8080) => ({ mode: 'ip' as const, ip: '198.51.100.20', port: 8443, httpPort, redirect: true });
const plain = { port: 4317, host: '127.0.0.1' };
const tlsDir = path.join(state.stateDir, 'tls');
const files = ['ip-fullchain.pem', 'ip-privkey.pem', 'custom-fullchain.pem', 'custom-privkey.pem', 'acme-account.json'];
let savedFiles: (Buffer | undefined)[], originalHttps: typeof state.settings.https, originalEnv: Record<string, string | undefined>;
let spies: { mockRestore(): void }[], servers: { port: number; stopped: boolean; stop(): void; fetch(req: Request): Response | Promise<Response> }[];
let timers: Map<object, { callback: () => void; ms: number; interval: boolean }>, timerHistory: (() => void)[];
let requests: { url: string; signal: AbortSignal }[], timeoutLimits: number[], bindCalls: any[], releases: (() => void)[];
let failPort: number | undefined, fetchImpl: (url: string) => Promise<Response>;
let cert: string, certDir: string;
let persistSpy: ReturnType<typeof spyOn>, notifySpy: ReturnType<typeof spyOn>;

beforeAll(() => {
  certDir = mkdtempSync(path.join(os.tmpdir(), 'pg-https-lifecycle-'));
  if (!Bun.which('openssl')) return;
  const result = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem'), '-subj', '/CN=fixture.test', '-days', '30'], { stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error('Could not generate the HTTPS fixture certificate');
  cert = readFileSync(path.join(certDir, 'cert.pem'), 'utf8');
});
afterAll(() => { rmSync(certDir, { recursive: true, force: true }); });
beforeEach(() => {
  https.stopHttps(); originalHttps = state.settings.https;
  originalEnv = Object.fromEntries(['POLYGATE_PUBLIC_IP', 'POLYGATE_ACME_DIRECTORY'].map(key => [key, process.env[key]]));
  process.env.POLYGATE_PUBLIC_IP = '198.51.100.20'; process.env.POLYGATE_ACME_DIRECTORY = 'https://acme.invalid/directory';
  mkdirSync(tlsDir, { recursive: true });
  savedFiles = files.map(file => existsSync(path.join(tlsDir, file)) ? readFileSync(path.join(tlsDir, file)) : undefined);
  for (const file of files) rmSync(path.join(tlsDir, file), { force: true });
  state.settings.https = managed(); servers = []; requests = []; timeoutLimits = []; bindCalls = []; releases = []; spies = []; failPort = undefined;
  timers = new Map(); timerHistory = [];
  const timer = (callback: () => void, ms: number, interval: boolean) => { const handle = { unref() {} }; timers.set(handle, { callback, ms, interval }); timerHistory.push(callback); return handle as any; };
  spies.push(spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms: number) => timer(fn, ms, false)) as any));
  spies.push(spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms: number) => timer(fn, ms, true)) as any));
  spies.push(spyOn(globalThis, 'clearTimeout').mockImplementation(((handle: object) => { timers.delete(handle); }) as any));
  spies.push(spyOn(globalThis, 'clearInterval').mockImplementation(((handle: object) => { timers.delete(handle); }) as any));
  spies.push(spyOn(AbortSignal, 'timeout').mockImplementation(ms => { timeoutLimits.push(ms); return new AbortController().signal; }));
  spies.push(spyOn(Bun, 'sleep').mockImplementation((async () => {}) as any));
  spies.push(spyOn(Bun, 'serve').mockImplementation(((options: any) => {
    if (options.port === failPort) throw new Error('fixture port busy');
    const server = { port: options.port, stopped: false, stop() { this.stopped = true; }, fetch: options.fetch }; servers.push(server); return server;
  }) as any));
  spies.push(spyOn(dns, 'resolve4').mockResolvedValue(['198.51.100.20']));
  fetchImpl = async () => { throw new Error('fixture issuance failed'); };
  spies.push(spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init: RequestInit) => { const url = String(input); requests.push({ url, signal: init.signal! }); return fetchImpl(url); }) as any));
  persistSpy = spyOn(state, 'persist').mockImplementation(() => {}); spies.push(persistSpy);
  notifySpy = spyOn(notifications, 'notify').mockImplementation(() => {}); spies.push(notifySpy);
});
afterEach(async () => {
  https.stopHttps(); for (const release of releases) release();
  try { await settled(); } finally {
    for (const spy of spies.reverse()) spy.mockRestore();
    state.settings.https = originalHttps;
    files.forEach((file, i) => { const full = path.join(tlsDir, file); if (savedFiles[i]) writeFileSync(full, savedFiles[i]!); else rmSync(full, { force: true }); });
    for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
async function until(predicate: () => boolean | Promise<boolean>) { for (let i = 0; i < 300; i++) { if (await predicate()) return; await Promise.resolve(); } throw new Error('HTTPS fixture did not reach its bounded checkpoint'); }
const settled = () => until(async () => !(await https.httpsStatus()).job.running);
const rebind = async (options: any) => { bindCalls.push(options); return options.port; };
const snapshot = () => ({ settings: JSON.stringify(state.settings.https), files: files.map(file => existsSync(path.join(tlsDir, file)) ? readFileSync(path.join(tlsDir, file), 'utf8') : null), persists: persistSpy.mock.calls.length, notices: notifySpy.mock.calls.length, binds: bindCalls.length });
function issuance() {
  fetchImpl = async url => {
    const headers = { 'replay-nonce': 'fixture-nonce', location: 'https://acme.invalid/order' };
    if (url.endsWith('/directory')) return Response.json({ newNonce: 'https://acme.invalid/nonce', newAccount: 'https://acme.invalid/account', newOrder: 'https://acme.invalid/order' });
    if (url.endsWith('/nonce')) return new Response(null, { headers });
    if (url.endsWith('/account')) return Response.json({}, { headers });
    if (url.endsWith('/order')) return Response.json({ status: 'valid', authorizations: [], finalize: 'https://acme.invalid/finalize', certificate: 'https://acme.invalid/certificate' }, { headers });
    if (url.endsWith('/finalize')) return Response.json({}, { headers });
    if (url.endsWith('/certificate')) return new Response(cert, { headers });
    throw new Error('Unexpected fixture ACME URL: ' + url);
  };
}

for (const kind of ['bind', 'issuance'] as const) test(`${kind} failure preserves the actual previous challenge listener and redirect`, async () => {
  await https.startHttps(rebind, plain); const old = servers[0];
  // Saved configuration need not describe the port the old listener is actually bound to.
  state.settings.https = managed(8081);
  if (kind === 'bind') failPort = 8082;
  await https.httpsApply(managed(8082)); await settled();
  expect(old.stopped).toBe(false); expect(old.port).toBe(8080);
  expect(servers.filter(s => !s.stopped)).toEqual([old]);
  expect(state.settings.https?.httpPort).toBe(8081);
  expect((await old.fetch(new Request('http://198.51.100.20/test'))).headers.get('location')).toBe('https://198.51.100.20:8443/test');
});
test('a failed direct apply does not start a previously absent listener', async () => {
  await https.httpsApply(managed(8082)); await settled();
  expect(servers).toHaveLength(1); expect(servers[0].stopped).toBe(true);
  expect((await https.httpsStatus()).challengeServer).toBe(false);
});
test('same-port failure reuses the old listener without closing it', async () => {
  await https.startHttps(rebind, plain); await https.httpsApply(managed()); await settled();
  expect(servers).toHaveLength(1); expect(servers[0].stopped).toBe(false);
});
test('stop cancels both renewal timers and stale callbacks cannot renew', async () => {
  await https.startHttps(rebind, plain);
  expect([...timers.values()].map(t => t.ms).sort((a, b) => a - b)).toEqual([30000, 21600000]);
  https.stopHttps(); expect(timers.size).toBe(0);
  const before = snapshot(); for (const callback of timerHistory) callback(); await settled();
  expect(requests).toHaveLength(0); expect(snapshot()).toEqual(before); expect(servers[0].stopped).toBe(true);
});
test('stop during startup cannot install renewal timers after its await', async () => {
  const starting = https.startHttps(rebind, plain); https.stopHttps(); await starting;
  expect(timers.size).toBe(0); expect(servers[0].stopped).toBe(true);
});
test('stop during DNS leaves no late writes, listeners, or requests', async () => {
  const gate = deferred<string[]>(); releases.push(() => gate.resolve(['198.51.100.20']));
  spies.push(spyOn(dns, 'resolve4').mockImplementation(() => gate.promise as any));
  await https.httpsApply({ ...managed(), mode: 'domain', domain: 'fixture.test' });
  await expect(https.httpsApply(managed())).rejects.toThrow('already running');
  https.stopHttps(); const before = snapshot(); gate.resolve(['198.51.100.20']); await settled();
  expect(snapshot()).toEqual(before); expect(servers).toHaveLength(0); expect(requests).toHaveLength(0);
});
test('stop aborts pending issuance and ignores even an abort-ignoring fetch response', async () => {
  const gate = deferred<Response>(); releases.push(() => gate.resolve(Response.json({})));
  fetchImpl = () => gate.promise;
  await https.httpsApply(managed()); await until(() => requests.length === 1);
  https.stopHttps(); const before = snapshot(); expect(requests[0].signal.aborted).toBe(true);
  gate.resolve(Response.json({})); await settled();
  expect(snapshot()).toEqual(before); expect(servers.every(s => s.stopped)).toBe(true); expect(timers.size).toBe(0);
  expect(timeoutLimits).toContain(30000);
});
test('stop during public-IP detection aborts preflight without starting a job', async () => {
  delete process.env.POLYGATE_PUBLIC_IP;
  const gate = deferred<Response>(); releases.push(() => gate.resolve(new Response('198.51.100.20')));
  fetchImpl = () => gate.promise;
  const pending = https.httpsApply({ ...managed(), ip: '' });
  const settled = pending.then(() => undefined, error => error);
  await until(() => requests.length === 1); https.stopHttps(); const before = snapshot();
  expect(requests[0].signal.aborted).toBe(true); expect(timeoutLimits).toContain(6000);
  process.env.POLYGATE_PUBLIC_IP = '198.51.100.20'; gate.resolve(new Response('198.51.100.20')); expect(await settled).toBeInstanceOf(Error);
  expect(snapshot()).toEqual(before); expect(servers).toHaveLength(0); expect(timers.size).toBe(0);
});
test('a replaced configuration is not overwritten by failed issuance', async () => {
  const gate = deferred<Response>(); releases.push(() => gate.resolve(new Response('failed', { status: 500 })));
  fetchImpl = () => gate.promise; await https.httpsApply(managed());
  const replacement = { ...managed(9090), mode: 'off' as const }; state.settings.https = replacement;
  gate.resolve(new Response('failed', { status: 500 })); await settled();
  expect(state.settings.https).toBe(replacement); expect(persistSpy).not.toHaveBeenCalled();
  expect(servers.every(s => s.stopped)).toBe(true);
});
test.skipIf(!Bun.which('openssl'))('stop during certificate download prevents certificate installation', async () => {
  issuance(); const original = fetchImpl, gate = deferred<Response>(); releases.push(() => gate.resolve(new Response(cert)));
  fetchImpl = url => url.endsWith('/certificate') ? gate.promise : original(url);
  await https.startHttps(rebind, plain); await https.httpsApply(managed(8082)); await until(() => requests.some(r => r.url.endsWith('/certificate')));
  https.stopHttps(); const before = snapshot(); gate.resolve(new Response(cert)); await settled();
  expect(snapshot()).toEqual(before); expect(bindCalls).toHaveLength(0); expect(timers.size).toBe(0);
});
test.skipIf(!Bun.which('openssl'))('managed rebind failure restores PEMs and retains the old bound listener', async () => {
  issuance(); writeFileSync(path.join(tlsDir, 'ip-fullchain.pem'), 'old certificate'); writeFileSync(path.join(tlsDir, 'ip-privkey.pem'), 'old key');
  await https.startHttps(async () => { throw new Error('fixture bind failure'); }, plain); const old = servers[0];
  await https.httpsApply(managed(8082)); await settled();
  expect(readFileSync(path.join(tlsDir, 'ip-fullchain.pem'), 'utf8')).toBe('old certificate');
  expect(readFileSync(path.join(tlsDir, 'ip-privkey.pem'), 'utf8')).toBe('old key');
  expect(state.settings.https?.httpPort).toBe(8080); expect(state.settings.https?.lastError).toContain('fixture bind failure');
  expect(servers.filter(s => !s.stopped)).toEqual([old]); expect(timers.size).toBe(2);
});
for (const reject of [false, true]) test.skipIf(!Bun.which('openssl'))(`stop during deferred rebind ignores late ${reject ? 'failure' : 'success'}`, async () => {
  issuance(); const gate = deferred<void>(); releases.push(() => gate.resolve());
  await https.startHttps(async options => { bindCalls.push(options); await gate.promise; if (reject) throw new Error('late bind failure'); return options.port; }, plain);
  await https.httpsApply(managed(8082)); await until(() => bindCalls.length === 1);
  https.stopHttps(); const before = snapshot(); gate.resolve(); await settled();
  expect(snapshot()).toEqual(before); expect(servers.every(s => s.stopped)).toBe(true); expect(timers.size).toBe(0);
});
test.skipIf(!Bun.which('openssl'))('restart replaces old listeners and timers, and a fresh apply can succeed', async () => {
  issuance(); await https.startHttps(rebind, plain); const stale = [...timerHistory];
  state.settings.https = managed(9090); await https.startHttps(rebind, plain);
  expect(servers[0].stopped).toBe(true); expect(servers[1].port).toBe(9090); expect(timers.size).toBe(2);
  for (const callback of stale) callback(); expect(requests).toHaveLength(0);
  await https.httpsApply(managed(9091)); await settled();
  expect(state.settings.https?.httpPort).toBe(9091); expect(bindCalls).toHaveLength(1);
  expect(servers.filter(s => !s.stopped).map(s => s.port)).toEqual([9091]); expect(timers.size).toBe(2);
  https.stopHttps(); expect(timers.size).toBe(0);
});

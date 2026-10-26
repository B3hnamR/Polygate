import net from 'node:net';
import tls from 'node:tls';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stateDir } from './state';
import { socksConnect } from './socks-bridge';
import { PROXY_SOURCES } from './proxy-sources';
// Finds and keeps public proxies. It downloads the lists in proxy-sources.ts (or reads a pasted list), asks each proxy to load the OpenCode API
// and keeps the ones that answer fast enough. Whether a proxy can carry a model request is decided later, by pool.ts, with a real request.
export type Proto = 'http' | 'socks4' | 'socks5';
export type Candidate = { url: string; proxy: string; proto: Proto; host: string; port: number };
export type StoredProxy = Candidate & { latencyMs?: number; addedAt: number };
export type ApiResult = { latency: number; status: number };
const MAX_CANDIDATES = 12000; const MAX_STORED = 5000;
// A list found on the internet must not make this machine knock on its own network.
export function isPublicHost(raw: string) {
  const host = raw.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) return false;
  if (net.isIPv4(host)) { const [a, b] = host.split('.').map(Number); return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)); }
  if (net.isIPv6(host)) return !(host === '::1' || host === '::' || /^(fc|fd|fe80)/.test(host));
  return true;
}
const LINE = /^(?:(https?|socks4a?|socks5h?):\/\/)?(?:([^:@\s/]+):([^@\s/]*)@)?(\[[0-9a-f:]+\]|[a-z0-9][a-z0-9.-]*):(\d{1,5})(?![\w.-])/i;
const SCHEME: Record<string, Proto> = { http: 'http', https: 'http', socks4: 'socks4', socks4a: 'socks4', socks5: 'socks5', socks5h: 'socks5' };
// ipOnly (used for downloaded lists) drops host names, which could point at this machine's own network.
// Accepts ip:port, scheme://ip:port and scheme://user:password@ip:port, one per line; anything after the address on a line is ignored.
// An address without a scheme is tried as the hint says; "all" tries http, socks5 and socks4.
export function parseProxyText(text: string, hint: Proto | 'https' | 'all' = 'all', ipOnly = false): Candidate[] {
  const seen = new Set<string>(); const out: Candidate[] = [];
  for (const line of text.split(/[\r\n]+/)) {
    const m = LINE.exec(line.trim()); if (!m) continue;
    const [, scheme, user, pass, host, portText] = m; const port = Number(portText); if (!(port > 0 && port < 65536) || !isPublicHost(host) || (ipOnly && !net.isIP(host.replace(/^\[|\]$/g, '')))) continue;
    const protos: Proto[] = scheme ? [SCHEME[scheme.toLowerCase()]] : hint === 'all' ? ['http', 'socks5', 'socks4'] : [hint === 'https' ? 'http' : hint];
    for (const proto of protos) {
      const url = `${proto}://${host}:${port}`; if (seen.has(url)) continue; seen.add(url);
      out.push({ url, proxy: user ? `${proto}://${user}:${pass || ''}@${host}:${port}` : url, proto, host, port });
    }
  }
  return out;
}
// --- one request through one proxy ---
function httpConnect(c: Candidate, host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  const u = new URL(c.proxy);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) || 80 }); let buffer = Buffer.alloc(0); let done = false;
    const fail = (error: Error) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); reject(error); };
    const timer = setTimeout(() => fail(new Error('CONNECT timed out')), timeoutMs);
    const auth = u.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}\r\n` : '';
    socket.once('connect', () => socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`));
    socket.on('data', (chunk: Buffer) => {
      if (done) return; buffer = Buffer.concat([buffer, chunk]); const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) { if (buffer.length > 8192) fail(new Error('Proxy answer too large')); return; }
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(buffer.subarray(0, end).toString('latin1'))?.[1];
      if (status !== '200') return fail(new Error(`CONNECT refused (${status || 'no status'})`));
      done = true; clearTimeout(timer); socket.removeAllListeners('data'); socket.removeAllListeners('error');
      const rest = buffer.subarray(end + 4); if (rest.length) socket.unshift(rest); resolve(socket);
    });
    socket.once('error', fail); socket.once('close', () => fail(new Error('Proxy closed the connection')));
  });
}
function openTunnel(c: Candidate, host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  if (c.proto === 'http') return httpConnect(c, host, port, timeoutMs);
  const u = new URL(c.proxy);
  return socksConnect({ host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) || 1080, username: u.username ? decodeURIComponent(u.username) : undefined, password: u.username ? decodeURIComponent(u.password) : undefined, version: c.proto === 'socks4' ? 4 : 5 }, host, port, timeoutMs);
}
// Loads the OpenCode model list through the proxy. Reaching it proves the proxy can tunnel to the provider (not hijacked, not blocking it) and how fast.
export async function checkApi(c: Candidate, timeoutMs: number, api: string): Promise<ApiResult | null> {
  const t0 = Date.now(); const url = new URL(api); const secure = url.protocol === 'https:'; const port = Number(url.port) || (secure ? 443 : 80);
  let socket: net.Socket | undefined; let aborted = false; const timer = setTimeout(() => { aborted = true; socket?.destroy(); }, timeoutMs);
  try {
    const raw = await openTunnel(c, url.hostname, port, timeoutMs); socket = raw; raw.on('error', () => {}); if (aborted) return null;
    const conn: net.Socket = secure ? tls.connect({ socket: raw, servername: url.hostname }) : raw; socket = conn; conn.on('error', () => {});
    if (secure) await new Promise<void>((resolve, reject) => { conn.once('secureConnect', () => resolve()); conn.once('error', reject); conn.once('close', () => reject(new Error('closed'))); });
    conn.write(`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer public\r\nUser-Agent: opencode/latest/2.1.4/cli\r\nAccept: application/json\r\nConnection: close\r\n\r\n`);
    const text = await new Promise<string>(resolve => { let body = ''; conn.setEncoding('utf8'); conn.on('data', (d: string) => { body += d; if (body.length > 65536) conn.destroy(); }); conn.on('close', () => resolve(body)); conn.on('end', () => resolve(body)); });
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1] || 0);
    return status === 200 && text.includes('"id"') ? { latency: Date.now() - t0, status } : null;
  } catch { return null; } finally { clearTimeout(timer); socket?.destroy(); }
}
export type VerifyOptions = { api: string; timeoutMs: number; concurrency?: number; progress?: (done: number, total: number, passed: number) => void; cancelled?: () => boolean };
export async function verify(list: Candidate[], o: VerifyOptions): Promise<Map<string, ApiResult>> {
  const found = new Map<string, ApiResult>(); let next = 0; let done = 0;
  await Promise.all(Array.from({ length: Math.min(o.concurrency ?? 200, list.length) }, async () => {
    while (next < list.length && !o.cancelled?.()) { const c = list[next++]; const r = await checkApi(c, o.timeoutMs, o.api); done++; if (r) found.set(c.url, r); o.progress?.(done, list.length, found.size); }
  }));
  return found;
}
// --- the saved pool ---
const dir = path.join(stateDir, 'proxies'); const file = path.join(dir, 'polygate-pool.json');
const valid = (s: any): s is StoredProxy => !!s && typeof s.url === 'string' && typeof s.proxy === 'string' && ['http', 'socks4', 'socks5'].includes(s.proto) && typeof s.host === 'string' && Number(s.port) > 0;
function load(): StoredProxy[] { try { if (existsSync(file)) { const j = JSON.parse(readFileSync(file, 'utf8')); if (Array.isArray(j)) return j.filter(valid); } } catch { /* start empty */ } return []; }
let stored: StoredProxy[] = load();
const save = () => { try { mkdirSync(dir, { recursive: true }); writeFileSync(file, JSON.stringify(stored), { mode: 0o600 }); } catch { /* the pool is rebuilt by the next scan */ } };
export const storedProxies = () => stored;
export function addVerified(list: Candidate[], found: Map<string, ApiResult>) {
  const byUrl = new Map(stored.map(s => [s.url, s])); const now = Date.now();
  for (const c of list) { const r = found.get(c.url); if (r) byUrl.set(c.url, { ...c, latencyMs: r.latency, addedAt: byUrl.get(c.url)?.addedAt || now }); }
  stored = [...byUrl.values()].sort((a, b) => (a.latencyMs || 1e9) - (b.latencyMs || 1e9)).slice(0, MAX_STORED); save();
}
export function removeProxies(urls?: string[]) { stored = urls ? stored.filter(s => !urls.includes(s.url)) : []; save(); }
// --- jobs: scan the public lists, or check a pasted list ---
export type EngineJob = { running: boolean; kind: 'idle' | 'scan' | 'import'; phase: 'idle' | 'download' | 'check' | 'done' | 'stopped' | 'error'; total: number; done: number; passed: number; message: string; startedAt: number; finishedAt: number };
const idle: EngineJob = { running: false, kind: 'idle', phase: 'idle', total: 0, done: 0, passed: 0, message: '', startedAt: 0, finishedAt: 0 };
let job: EngineJob = { ...idle }; let stopFlag = false;
export const engineJob = () => ({ ...job });
export const stopEngine = () => { stopFlag = true; };
// after: runs when a job has finished without being stopped, so the caller can go on to the next stage.
export type EngineOptions = { api: string; timeoutSec: number; gateMs: number; concurrency?: number; after?: () => void };
function shuffle<T>(list: T[]) { for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; } return list; }
async function downloadSources(): Promise<Candidate[]> {
  const all = new Map<string, Candidate>(); let done = 0; let next = 0; job.total = PROXY_SOURCES.length;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < PROXY_SOURCES.length && !stopFlag) {
      const [hint, url] = PROXY_SOURCES[next++];
      try { const r = await fetch(url, { signal: AbortSignal.timeout(25000), headers: { 'user-agent': 'polygate' } }); if (r.ok) for (const c of parseProxyText((await r.text()).slice(0, 8_000_000), hint, true)) all.set(c.url, c); } catch { /* a dead list is skipped */ }
      job.done = ++done; job.message = `Downloaded ${done} of ${PROXY_SOURCES.length} lists (${all.size.toLocaleString()} proxy addresses)…`;
    }
  }));
  const list = [...all.values()]; return list.length > MAX_CANDIDATES ? shuffle(list).slice(0, MAX_CANDIDATES) : list;
}
function run(kind: 'scan' | 'import', gather: () => Promise<Candidate[]>, o: EngineOptions): EngineJob {
  if (job.running) return engineJob(); stopFlag = false;
  job = { ...idle, running: true, kind, phase: kind === 'scan' ? 'download' : 'check', message: kind === 'scan' ? 'Downloading public proxy lists…' : 'Reading the list…', startedAt: Date.now() };
  void (async () => {
    try {
      const list = await gather();
      if (!list.length) { job = { ...job, running: false, phase: stopFlag ? 'stopped' : 'done', finishedAt: Date.now(), message: stopFlag ? 'Stopped.' : 'No proxy addresses were found.' }; return; }
      job = { ...job, phase: 'check', done: 0, total: list.length, message: `Checking ${list.length.toLocaleString()} proxies against the OpenCode API…` };
      const found = await verify(list, { api: o.api, timeoutMs: o.timeoutSec * 1000, concurrency: o.concurrency, cancelled: () => stopFlag, progress: (d, t, p) => { job.done = d; job.total = t; job.passed = p; } });
      const fast = new Map([...found].filter(([, r]) => r.latency <= o.gateMs)); addVerified(list, fast);
      job = { ...job, running: false, phase: stopFlag ? 'stopped' : 'done', finishedAt: Date.now(), passed: fast.size, message: `${stopFlag ? 'Stopped. ' : ''}${fast.size.toLocaleString()} of ${list.length.toLocaleString()} reached the OpenCode API within ${o.gateMs} ms and ${fast.size === 1 ? 'was' : 'were'} added to the pool.` };
      if (!stopFlag) o.after?.();
    } catch (e: any) { job = { ...job, running: false, phase: 'error', finishedAt: Date.now(), message: String(e?.message || e).slice(0, 200) }; }
  })();
  return engineJob();
}
export const startScan = (o: EngineOptions) => run('scan', downloadSources, o);
export const startImport = (text: string, o: EngineOptions) => run('import', async () => parseProxyText(text.slice(0, 4_000_000)), o);
// Test seam: forget everything, including the saved file.
export function __resetEngine() { stored = []; job = { ...idle }; stopFlag = false; }

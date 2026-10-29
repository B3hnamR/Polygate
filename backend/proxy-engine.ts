import net from 'node:net';
import { lookup } from 'node:dns/promises';
import tls from 'node:tls';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stateDir, settings, persist, writeFileAtomic } from './state';
import type { ProxySource } from './types';
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
// The 16 bytes of an IPv6 address written in any form (compressed, full, or with a dotted IPv4 tail).
function ipv6Bytes(host: string): number[] | undefined {
  let text = host.split('%')[0]; const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) { const o = tail[1].split('.').map(Number); text = text.slice(0, -tail[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16); }
  const [head, rest] = text.split('::'); const left = head ? head.split(':') : []; const right = rest ? rest.split(':') : [];
  const groups = text.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  if (groups.length !== 8) return undefined;
  return groups.flatMap(g => { const n = parseInt(g || '0', 16); return [n >> 8, n & 255]; });
}
export function isPublicHost(raw: string) {
  const host = raw.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) return false;
  if (net.isIPv4(host)) { const [a, b] = host.split('.').map(Number); return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)); }
  if (net.isIPv6(host)) {
    const v = ipv6Bytes(host); if (!v) return false;
    if (v.every(x => x === 0) || v.slice(0, 15).every(x => x === 0) && v[15] === 1) return false; // :: and ::1
    if ((v[0] & 0xfe) === 0xfc || v[0] === 0xff || (v[0] === 0xfe && (v[1] & 0xc0) === 0x80)) return false; // fc00::/7, multicast, fe80::/10 (fe80 to febf)
    // An IPv4 address written inside an IPv6 one (::ffff:127.0.0.1, ::127.0.0.1, 64:ff9b::10.0.0.1) is judged as that IPv4 address.
    const mapped = v.slice(0, 10).every(x => x === 0) && v[10] === 255 && v[11] === 255, compat = v.slice(0, 12).every(x => x === 0), nat64 = v[0] === 0 && v[1] === 0x64 && v[2] === 0xff && v[3] === 0x9b && v.slice(4, 12).every(x => x === 0);
    if (mapped || compat || nat64) return isPublicHost(v.slice(12).join('.'));
    return true;
  }
  return true;
}
const LINE = /^(?:(https?|socks4a?|socks5h?):\/\/)?(?:([^:@\s/]+):([^@\s/]*)@)?(\[[0-9a-f:]+\]|[a-z0-9][a-z0-9.-]*):(\d{1,5})(?![\w.-])/i;
const SCHEME: Record<string, Proto> = { http: 'http', https: 'http', socks4: 'socks4', socks4a: 'socks4', socks5: 'socks5', socks5h: 'socks5' };
export type Hint = Proto | 'https' | 'all';
// Anywhere in a text: [scheme://][user:pass@]ip[/range]:port[:user:pass] (the same rules as ProxyHive). The trailing ":user:pass" is how many
// paid providers hand out logins; "ip:port:US:elite" style lists put facts there instead, which are not taken as a login.
const ANY_IP = /(?:([a-z][a-z0-9]*):\/\/)?(?:([^\s:@/<>"']{1,64}):([^\s@/<>"']{0,64})@)?(?<![\d.])((?:\d{1,3}\.){3}\d{1,3})(?:\/(\d{1,2}))?:(\d{1,5})(?!\d)(?::([^\s:@/{}<>"']{1,200}):([^\s:@/{}<>"']{1,200}))?/gi;
const NOT_A_LOGIN = new Set(['http', 'https', 'socks4', 'socks5', 'elite', 'anonymous', 'transparent', 'high', 'anon', 'none', 'yes', 'no', 'true', 'false', 'unknown']);
const HOST_KEYS = ['ip', 'host', 'address', 'ip_address', 'ipAddress', 'proxy_ip', 'server'], PORT_KEYS = ['port', 'proxy_port', 'portNumber'], PROTO_KEYS = ['protocols', 'protocol', 'type', 'types', 'scheme'];
// A list reached from the internet may hold a small address range (/24 or narrower), never a whole network.
const MIN_RANGE = 24;
const validIp = (host: string, port: number) => port > 0 && port < 65536 && host.split('.').every(o => Number(o) <= 255) && isPublicHost(host);
function rangeHosts(host: string, prefix: number) {
  if (prefix < MIN_RANGE || prefix > 32 || host.split('.').some(o => Number(o) > 255)) return [];
  const n = host.split('.').reduce((a, o) => a * 256 + Number(o), 0); const size = 2 ** (32 - prefix); const start = n - (n % size);
  const first = prefix >= 31 ? start : start + 1, last = prefix >= 31 ? start + size - 1 : start + size - 2;
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => [24, 16, 8, 0].map(s => ((first + i) >>> s) & 255).join('.'));
}
// Finds every proxy in a pasted list, a downloaded file, a saved web page (an HTML table) or a JSON document.
// An address without a scheme is tried as the hint says; "all" tries http, socks5 and socks4. ipOnly (downloaded lists) drops host names,
// which could point at this machine's own network; a pasted list may use names.
export function parseProxyText(text: string, hint: Hint = 'all', ipOnly = false): Candidate[] {
  const seen = new Map<string, Candidate>();
  const fallback = (): Proto[] => hint === 'all' ? ['http', 'socks5', 'socks4'] : [hint === 'https' ? 'http' : hint];
  const add = (protos: Proto[], host: string, port: number, login?: [string, string]) => {
    for (const proto of protos) {
      if (seen.size >= MAX_CANDIDATES) return;
      const url = `${proto}://${host}:${port}`;
      // The first login listed for a proxy wins; a later bare mention does not drop it.
      if (!seen.has(url) || (login && !seen.get(url)!.proxy.includes('@'))) seen.set(url, { url, proxy: login ? `${proto}://${login[0]}:${login[1]}@${host}:${port}` : url, proto, host, port });
    }
  };
  const scan = (body: string) => {
    for (const m of body.matchAll(ANY_IP)) {
      if (seen.size >= MAX_CANDIDATES) return; // a hostile list of many ranges stops here, not after millions of addresses
      const [, scheme, user, pass, host, range, portText, u2, p2] = m; const port = Number(portText);
      const proto = scheme ? SCHEME[scheme.toLowerCase()] : undefined; if (scheme && !proto) continue;
      const trailing = u2 && (scheme || !(/^[A-Za-z]{2}$/.test(u2) || NOT_A_LOGIN.has(u2.toLowerCase()) || NOT_A_LOGIN.has(p2.toLowerCase()))) ? [u2, p2] as [string, string] : undefined;
      const login = user ? [user, pass || ''] as [string, string] : trailing;
      for (const h of range ? rangeHosts(host, Number(range)) : [host]) if (validIp(h, port)) add(proto ? [proto] : fallback(), h, port, login);
    }
  };
  const body = text.slice(0, 8_000_000); scan(body);
  // <td>1.2.3.4</td><td>8080</td> in a saved web page.
  if (/<\/t[dh]/i.test(body.slice(0, 3_000_000))) scan(body.replace(/\s*<\/t[dh]\s*>\s*<t[dh][^>]*>\s*/gi, ':').replace(/<[^>]+>/g, ' '));
  // JSON records such as {"ip": "1.2.3.4", "port": 8080, "protocols": ["socks5"]}, at any depth.
  if (/^\s*[[{]/.test(body)) {
    try {
      const walk = (o: any, depth: number): void => {
        if (depth > 12 || !o || typeof o !== 'object') return;
        if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
        const host = HOST_KEYS.map(k => o[k]).find(v => typeof v === 'string'); const port = Number(PORT_KEYS.map(k => o[k]).find(v => v !== undefined && v !== ''));
        if (host && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host.trim()) && validIp(host.trim(), port)) {
          const named = PROTO_KEYS.flatMap(k => Array.isArray(o[k]) ? o[k] : [o[k]]).map(v => typeof v === 'string' ? SCHEME[v.toLowerCase()] : undefined).filter(Boolean) as Proto[];
          const user = ['username', 'user', 'login'].map(k => o[k]).find(v => typeof v === 'string' && v); const pw = ['password', 'pass', 'pwd'].map(k => o[k]).find(v => typeof v === 'string') || '';
          add(named.length ? [...new Set(named)] : fallback(), host.trim(), port, user ? [user, pw] : undefined);
        }
        for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v, depth + 1);
      };
      walk(JSON.parse(body), 0);
    } catch { /* not JSON after all */ }
  }
  // IPv6 addresses, and host names (pasted lists only), one per line as before.
  for (const line of body.split(/[\r\n]+/)) {
    const m = LINE.exec(line.trim()); if (!m) continue;
    const [, scheme, user, pass, host, portText] = m; const port = Number(portText); const ip = net.isIP(host.replace(/^\[|\]$/g, ''));
    if (ip === 4 || (ipOnly && !ip) || !(port > 0 && port < 65536) || !isPublicHost(host)) continue;
    add(scheme ? [SCHEME[scheme.toLowerCase()]] : fallback(), host, port, user ? [user, pass || ''] : undefined);
  }
  return [...seen.values()];
}
// A pasted text may mix proxies with links to lists: a line that is only a web address (and not a proxy) is a list to download.
export function splitLinks(text: string) {
  const links: string[] = []; const rest: string[] = [];
  for (const raw of text.split(/[\r\n]+/)) {
    const line = raw.trim(); if (/^https?:\/\/\S+$/i.test(line) && !/^https?:\/\/(?:[^\s:@/]+:[^\s@/]*@)?[^\s/:]+:\d{1,5}\/?$/i.test(line)) { if (!links.includes(line)) links.push(line); }
    else rest.push(raw);
  }
  return { links, text: rest.join('\n') };
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
const save = () => { try { mkdirSync(dir, { recursive: true }); writeFileAtomic(file, JSON.stringify(stored)); } catch { /* the pool is rebuilt by the next scan */ } };
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
// --- list links: the built-in public lists plus the user's own ---
// A list with more than this many addresses is junk (or not a proxy list) and is refused, as in ProxyHive.
const MAX_PER_LIST = 150000;
export const proxyLists = () => (settings.proxyLists ||= { builtin: true, sources: [] });
// Fetches an address that must lead to the public internet. A name is resolved first and every address it gives must be public, and a redirect is
// followed by hand so its target is checked the same way; otherwise a name or a redirect could point this machine at its own network.
async function publicGet(start: URL, signal: AbortSignal): Promise<Response> {
  let u = start;
  for (let hop = 0; hop < 4; hop++) {
    if (!['http:', 'https:'].includes(u.protocol) || !isPublicHost(u.hostname)) throw new Error('Only public http(s) addresses can be downloaded');
    const bare = u.hostname.replace(/^\[|\]$/g, '');
    if (!net.isIP(bare)) { const addresses = await lookup(bare, { all: true }).catch(() => []); if (!addresses.length || addresses.some(a => !isPublicHost(a.address))) throw new Error('That name does not lead to a public address'); }
    const r = await fetch(u, { signal, redirect: 'manual', headers: { 'user-agent': 'polygate' } });
    const next = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
    if (!next) return r;
    await r.body?.cancel().catch(() => {}); u = new URL(next, u);
  }
  throw new Error('Too many redirects');
}
// Downloads one list. Links come from the user or the built-in table, so only public web addresses are fetched.
export async function fetchList(url: string, hint: Hint): Promise<{ found: Candidate[]; error?: string }> {
  let u: URL; try { u = new URL(url); } catch { return { found: [], error: 'Not a web address' }; }
  if (!['http:', 'https:'].includes(u.protocol) || !isPublicHost(u.hostname)) return { found: [], error: 'Only public http(s) addresses can be downloaded' };
  try {
    const r = await publicGet(u, AbortSignal.timeout(25000));
    if (!r.ok) { await r.body?.cancel().catch(() => {}); return { found: [], error: `HTTP ${r.status}` }; }
    const found = parseProxyText((await r.text()).slice(0, 8_000_000), hint, true);
    // Counted by address: "any type" tries each address three ways, which must not make a normal list look too big.
    const addresses = new Set(found.map(c => `${c.host}:${c.port}`)).size;
    if (addresses > MAX_PER_LIST) return { found: [], error: `Refused: ${addresses.toLocaleString()} addresses is more than a proxy list should hold` };
    return { found, ...(found.length ? {} : { error: 'No proxy addresses in it' }) };
  } catch (e: any) { return { found: [], error: e?.name === 'TimeoutError' ? 'No answer within 25 s' : String(e?.message || e).slice(0, 120) }; }
}
// Your own lists come first: when there are more addresses than one run checks, the public lists' share is cut, not yours.
async function downloadSources(): Promise<Candidate[]> {
  const cfg = proxyLists(); const own = cfg.sources.filter(s => s.enabled);
  const lists: { hint: Hint; url: string; mine?: ProxySource }[] = [...own.map(s => ({ hint: s.proto, url: s.url, mine: s })), ...(cfg.builtin !== false ? PROXY_SOURCES.map(([hint, url]) => ({ hint, url })) : [])];
  if (!lists.length) throw new Error('No lists to download: add a list link or switch the public lists back on.');
  const mine = new Map<string, Candidate>(); const pub = new Map<string, Candidate>(); let done = 0; let next = 0; job.total = lists.length;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < lists.length && !stopFlag) {
      const item = lists[next++]; const r = await fetchList(item.url, item.hint);
      for (const c of r.found) (item.mine ? mine : pub).set(c.url, c);
      if (item.mine) Object.assign(item.mine, { lastAt: Date.now(), lastCount: r.found.length, lastError: r.error });
      job.done = ++done; job.message = `Downloaded ${done} of ${lists.length} lists (${(mine.size + pub.size).toLocaleString()} proxy addresses)…`;
    }
  }));
  if (own.length) persist();
  for (const url of mine.keys()) pub.delete(url);
  const yours = [...mine.values()]; const room = Math.max(0, MAX_CANDIDATES - yours.length); const theirs = [...pub.values()];
  return [...(yours.length > MAX_CANDIDATES ? shuffle(yours).slice(0, MAX_CANDIDATES) : yours), ...(theirs.length > room ? shuffle(theirs).slice(0, room) : theirs)];
}
// A pasted list: proxies and links to lists, mixed. A plain ip:port means what the hint says.
async function readPasted(text: string, hint: Hint): Promise<Candidate[]> {
  const { links, text: rest } = splitLinks(text.slice(0, 4_000_000)); const all = new Map<string, Candidate>();
  for (const c of parseProxyText(rest, hint)) all.set(c.url, c);
  if (links.length) { job.phase = 'download'; job.total = links.length; job.message = `Downloading ${links.length} list(s)…`; }
  let done = 0; const failed: string[] = [];
  await Promise.all(links.map(async url => { const r = await fetchList(url, hint); for (const c of r.found) all.set(c.url, c); if (r.error && !r.found.length) failed.push(`${url}: ${r.error}`); job.done = ++done; }));
  if (!all.size && failed.length) throw new Error(`Nothing found. ${failed.slice(0, 3).join(' · ')}`);
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
export const startImport = (text: string, o: EngineOptions, hint: Hint = 'all') => run('import', () => readPasted(text, hint), o);
// Test seam: forget everything, including the saved file.
export function __resetEngine() { stored = []; job = { ...idle }; stopFlag = false; }

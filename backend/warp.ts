import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { accessSync, chmodSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { settings, persist, stateDir, redactError } from './state';
import { GatewayError } from './queue';
import { socksBridge, socksConnect } from './socks-bridge';
import { notify } from './notifications';
import type { Route, WarpSettings } from './types';
const run = promisify(execFile);
const warpDir = path.join(stateDir, 'warp'); const binDir = path.join(stateDir, 'bin');
const isWin = process.platform === 'win32';
const appDir = process.env.POLYGATE_APP_DIR || process.cwd();
// The helper is a locally patched usque build (MIT): MASQUE over TCP/HTTP2. Unlike the old WireGuard engine it does not need
// outbound UDP, and it speaks the same protocol the official WARP client uses on networks that drop WireGuard.
// A network can block one MASQUE anycast address and allow another, so a failed tunnel tries the next one.
const H2_ENDPOINTS = ['162.159.198.183', '162.159.198.2'];
// Another program may already listen on the port a tunnel wants (Cloudflare's own warp-cli uses 40000 by default; so can an xray inbound).
// That listener is never used or taken over: the tunnel moves to the next free port instead.
const portFree = (port: number) => new Promise<boolean>(resolve => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen({ port, host: '127.0.0.1', exclusive: true }, () => s.close(() => resolve(true))); });
export async function freePort(from: number, avoid: Set<number> = new Set()): Promise<number> {
  for (let port = from; port < Math.min(65535, from + 300); port++) if (!avoid.has(port) && await portFree(port)) return port;
  throw new GatewayError(`No free local port was found from ${from} up. Free one or choose another SOCKS port.`, 503, 'warp_no_port');
}
export type WarpEngine = 'embedded' | 'disabled';
type Tunnel = { port: number; index: number; proc: ChildProcess; identity: string; endpoint: string; startedAt: number; egress?: Egress; egressIp?: string; lastProbe?: number; failures: number; cooldownUntil: number; restarts: number };
type Egress = { ip: string; colo: string; warp: string; loc?: string };
export type WarpState = 'disabled' | 'not_installed' | 'not_registered' | 'disconnected' | 'connecting' | 'connected' | 'error';
const defaults: WarpSettings = { engine: 'embedded', autoStart: false, pool: 2, rotateMinutes: 0, helperPath: '', endpoint: '' };
// Settings saved by older versions may name an engine that no longer exists and carry the wireproxy path; only the engine
// and the user's preferences survive. The helper is found next to the app, so an old path is never trusted.
export const warpConfig = (): WarpSettings => {
  const c: any = { ...defaults, ...settings.warp };
  delete c.host; delete c.wireproxyPath;
  c.engine = c.engine === 'disabled' ? 'disabled' : 'embedded';
  c.helperPath = String(c.helperPath || '');
  c.endpoint = String(c.endpoint || '').trim();
  return c as WarpSettings;
};
const basePort = () => settings.warpProxyPort || 40000;
const status = { progress: { percent: 0, stage: 'idle', message: 'WARP is idle' }, lastError: '', egress: undefined as Egress | undefined, checkedAt: 0, busy: false, state: 'disconnected' as WarpState };
const tunnels = new Map<number, Tunnel>();
let monitor: ReturnType<typeof setInterval> | undefined, rotateTimer: ReturnType<typeof setInterval> | undefined, lastRegistration = 0, registerBackoffUntil = 0, rr = 0, stopping = false, lastNotified = '';
const progress = (percent: number, stage: string, message: string) => { status.progress = { percent, stage, message }; };
const fail = (message: string) => { status.lastError = redactError(message); status.progress = { percent: 0, stage: 'error', message: status.lastError }; return status.lastError; };
// --- discovery ---
function which(name: string) { try { return (Bun.which(name) as string | null) || ''; } catch { return ''; } }
const helperName = (): string => {
  if (process.platform === 'win32') return 'usque-windows-amd64.exe';
  if (process.platform === 'linux') return process.arch === 'arm64' ? 'usque-linux-arm64' : process.arch === 'x64' ? 'usque-linux-amd64' : '';
  return '';
};
// A directory or a file without the execute bit is not a helper: spawning it emits 'error', which used to end the whole gateway.
function runnable(file: string) {
  try { if (!statSync(file).isFile()) return false; if (!isWin) accessSync(file, fsConstants.X_OK); return true; } catch { return false; }
}
export function findWarpHelper() {
  const name = helperName();
  const configured = warpConfig().helperPath;
  // A configured path is checked even on platforms Polygate does not ship a helper for: a user-supplied usque build
  // works there too. Bundled names only exist where the packages carry them.
  const bundled = name ? [path.join(appDir, 'warp', name), path.join(binDir, name), path.join(appDir, 'resources', 'warp', name), path.join(path.dirname(process.execPath), name)] : [];
  const candidates = [configured, process.env.POLYGATE_WARP_HELPER || '', ...bundled, which('usque')];
  return candidates.find(c => c && runnable(c)) || '';
}
export const engineMode = (): WarpEngine => warpConfig().engine;
const identityFile = (index: number) => path.join(warpDir, `identity-${index + 1}.json`);
const readIdentity = (file: string): any | null => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const validIdentity = (file: string) => { const j = readIdentity(file); return !!(j && j.private_key && j.access_token && j.endpoint_pub_key); };
const writeIdentityEndpoint = (file: string, endpoint: string) => {
  const j = readIdentity(file); if (!j) throw new GatewayError('WARP identity is missing or unreadable', 503, 'warp_not_registered');
  if (j.endpoint_h2_v4 !== endpoint) { j.endpoint_h2_v4 = endpoint; writeFileSync(file, JSON.stringify(j, null, 2), { mode: 0o600 }); }
};
const helperEnv = () => ({ ...process.env, USQUE_FRAGMENT: process.env.POLYGATE_WARP_FRAGMENT || '64:2:2048' });
const lastLine = (s: string) => s.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0]?.slice(0, 260) || '';
function stopProcess(proc?: ChildProcess) { try { proc?.kill(); } catch { /* already gone */ } }
// --- SOCKS probing ---
function socksAlive(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host, port }); let settled = false;
    const finish = (ok: boolean) => { if (settled) return; settled = true; socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => finish(false)); socket.once('error', () => finish(false));
    socket.once('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])));
    socket.once('data', d => finish(d.length >= 2 && d[0] === 0x05 && d[1] === 0x00));
  });
}
// A real request through the tunnel is the only readiness signal that matters. Port-open is not enough: usque opens its SOCKS
// listener before the MASQUE handshake, and a network can accept TCP while dropping the TLS ClientHello.
// 1.1.1.1/cdn-cgi/trace answers through WARP and reports the exit IP; its trace page does not always include warp=on.
export async function traceVia(host: string, port: number, timeoutMs = 20000): Promise<Egress | null> {
  try {
    const proxy = await socksBridge({ host, port });
    const r = await fetch(process.env.POLYGATE_WARP_TRACE_URL || 'https://1.1.1.1/cdn-cgi/trace', { proxy, signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'curl/8.0' } } as any);
    if (!r.ok) return null;
    const text = await r.text(); const pick = (k: string) => text.match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1]?.trim() || '';
    const ip = pick('ip'); if (!ip) return null;
    return { ip, colo: pick('colo'), warp: pick('warp'), loc: pick('loc') };
  } catch { return null; }
}
// --- identities (the helper owns Cloudflare registration; Polygate only keeps the resulting config) ---
async function registerIdentity(file: string): Promise<void> {
  const helper = findWarpHelper();
  if (!helper) throw new GatewayError('WARP helper is not installed. Put the platform helper in the app\'s warp folder, set its path in WARP settings, or run scripts/build-warp-helper.sh.', 503, 'warp_not_installed');
  if (Date.now() < registerBackoffUntil) throw new GatewayError(`Cloudflare is rate limiting WARP registrations; waiting ${Math.ceil((registerBackoffUntil - Date.now()) / 60000)} more minute(s).`, 429, 'warp_rate_limited');
  const wait = 12000 - (Date.now() - lastRegistration); if (wait > 0) await Bun.sleep(wait); lastRegistration = Date.now();
  mkdirSync(warpDir, { recursive: true }); rmSync(file, { force: true });
  let output = '';
  try {
    const r: any = await run(helper, ['-c', file, 'register', '--accept-tos'], { timeout: 90000, windowsHide: true, env: helperEnv(), maxBuffer: 1024 * 1024 });
    output = `${r?.stdout || ''}\n${r?.stderr || ''}`;
  } catch (e: any) {
    output = `${e?.stdout || ''}\n${e?.stderr || ''}\n${e?.message || e}`;
    const text = redactError(output);
    if (/\b429\b|1015|rate.?limit|too many/i.test(text)) { registerBackoffUntil = Date.now() + 15 * 60000; throw new GatewayError('Cloudflare is rate limiting WARP registrations; try again in 15 minutes.', 429, 'warp_rate_limited'); }
    throw new GatewayError(`WARP registration failed: ${text.replace(/\s+/g, ' ').slice(-300)}`, 502, 'warp_register_failed');
  }
  if (!validIdentity(file)) throw new GatewayError(`WARP registration finished without a usable identity${output ? ': ' + lastLine(output) : ''}`, 502, 'warp_register_failed');
  try { chmodSync(file, 0o600); } catch { /* Windows has no mode bits */ }
}
const endpointCandidates = (preferred: string) => [...new Set([preferred, ...H2_ENDPOINTS].map(x => String(x || '').trim()).filter(Boolean))];
// --- tunnel lifecycle ---
async function startTunnel(port: number, index: number, preferredEndpoint: string): Promise<Tunnel> {
  const helper = findWarpHelper(); if (!helper) throw new GatewayError('WARP helper is not installed. Put the platform helper in the app\'s warp folder, set its path in WARP settings, or run scripts/build-warp-helper.sh.', 503, 'warp_not_installed');
  const identity = identityFile(index); let lastError = 'no MASQUE endpoint answered';
  for (const endpoint of endpointCandidates(preferredEndpoint)) {
    writeIdentityEndpoint(identity, endpoint);
    let proc: ChildProcess, spawnError = '', output = '', exited = false;
    try {
      proc = spawn(helper, ['-c', identity, 'socks', '--http2', '-b', '127.0.0.1', '-p', String(port), '-d', '8.8.8.8', '-d', '9.9.9.9', '--keepalive-period', '10s', '--always-reconnect'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: helperEnv() });
    } catch (e: any) { throw new GatewayError(`WARP helper could not be started (${helper}): ${e?.message || e}`, 503, 'warp_not_installed'); }
    proc.once('error', e => { spawnError = e.message || String(e); exited = true; });
    proc.stdout?.on('data', d => { output = (output + d).slice(-1600); });
    proc.stderr?.on('data', d => { output = (output + d).slice(-1600); });
    proc.once('exit', () => { exited = true; });
    let alive = false;
    for (let i = 0; i < 60 && !exited; i++) { await Bun.sleep(250); if (await socksAlive('127.0.0.1', port, 800)) { alive = true; break; } }
    // Spawn failures are asynchronous: the 'error' event arrives after spawn() returns, so read it here, not on the next line.
    if (spawnError) throw new GatewayError(`WARP helper could not be started (${helper}): ${spawnError}`, 503, 'warp_not_installed');
    if (alive) {
      const egress = await traceVia('127.0.0.1', port, 30000);
      if (egress?.ip) {
        const tunnel: Tunnel = { port, index, proc, identity, endpoint, startedAt: Date.now(), egressIp: egress.ip, egress, failures: 0, cooldownUntil: 0, restarts: 0 };
        proc.once('exit', code => { if (tunnels.get(port)?.proc !== proc) return; tunnels.delete(port); if (!stopping) { notify('WARP tunnel stopped', `Tunnel on port ${port} exited (${code}).`, 'warning', 'warp-tunnel-' + port); setTimeout(() => void restartTunnel(port, index, tunnel.restarts + 1), Math.min(60000, 5000 * 2 ** tunnel.restarts)).unref(); } });
        return tunnel;
      }
      lastError = `endpoint ${endpoint} opened SOCKS but no request passed through WARP${output ? ': ' + lastLine(output) : ''}`;
    } else lastError = `helper ${exited ? 'exited' : 'did not open a SOCKS port'} on endpoint ${endpoint}${output ? ': ' + lastLine(output) : ''}`;
    stopProcess(proc);
  }
  throw new GatewayError(`Could not start a WARP tunnel: ${lastError}. Try another MASQUE endpoint in WARP settings, or another network.`, 502, 'warp_error');
}
async function restartTunnel(port: number, index: number, restarts: number) {
  if (stopping || [...tunnels.values()].some(t => t.index === index) || engineMode() !== 'embedded') return;
  try { if (!await portFree(port)) port = await freePort(port + 1, new Set(tunnels.keys())); const t = await startTunnel(port, index, warpConfig().endpoint); t.restarts = restarts; tunnels.set(port, t); ensureRoute(); } catch { if (restarts < 6) setTimeout(() => void restartTunnel(port, index, restarts + 1), Math.min(120000, 5000 * 2 ** restarts)).unref(); }
}
async function embeddedConnect(fresh = false) {
  // Without the helper nothing can start, so do not register identities (or wait out the registration pause) first.
  if (!findWarpHelper()) throw new GatewayError('WARP helper is not installed. Put the platform helper in the app\'s warp folder, set its path in WARP settings, or run scripts/build-warp-helper.sh.', 503, 'warp_not_installed');
  const want = Math.max(1, Math.min(4, warpConfig().pool));
  if (fresh) for (const [port] of tunnels) { stopProcess(tunnels.get(port)?.proc); tunnels.delete(port); }
  progress(15, 'accounts', 'Preparing WARP identities…');
  for (let i = 0; i < want; i++) {
    if ([...tunnels.values()].some(t => t.index === i)) continue;
    const wanted = basePort() + i; const port = await freePort(wanted, new Set(tunnels.keys()));
    if (port !== wanted) notify('WARP uses another local port', `Port ${wanted} is used by another program on this machine, so WARP tunnel ${i + 1} listens on ${port} instead. The other program is not touched.`, 'info', 'warp-port-' + wanted, 3600000);
    const file = identityFile(i);
    if (fresh) rmSync(file, { force: true });
    if (!validIdentity(file)) { progress(25 + i * 10, 'registering', `Registering WARP identity ${i + 1}/${want}…`); try { await registerIdentity(file); } catch (e) { if (tunnels.size) break; throw e; } }
    progress(50 + i * 10, 'starting', `Starting WARP tunnel ${i + 1}/${want} on port ${port}…`);
    try { tunnels.set(port, await startTunnel(port, i, warpConfig().endpoint)); } catch (e) { if (!tunnels.size) throw e; }
    ensureRoute();
  }
  if (!tunnels.size) throw new GatewayError('No WARP tunnel could be started.', 502, 'warp_error');
}
async function stopTunnels() { for (const [, t] of tunnels) stopProcess(t.proc); tunnels.clear(); await Bun.sleep(150); }
// --- public API ---
export type WarpTarget = { host: string; port: number };
export function warpTarget(): WarpTarget | null {
  if (engineMode() === 'disabled') return null;
  const live = [...tunnels.values()].filter(t => t.cooldownUntil < Date.now()); const pool = live.length ? live : [...tunnels.values()];
  if (!pool.length) return null; return { host: '127.0.0.1', port: pool[rr++ % pool.length].port };
}
export function warpFailure(port: number) { const t = tunnels.get(port); if (!t) return; if (++t.failures >= 3) { t.cooldownUntil = Date.now() + 30000; t.failures = 0; } }
export function warpSuccess(port: number) { const t = tunnels.get(port); if (t) t.failures = 0; }
// Keeps one managed route ('warp') pointing at the live endpoint so routing, rotation and failover can treat WARP like any other route.
export function ensureRoute() {
  const engine = engineMode(); if (engine === 'disabled') return;
  let route = settings.routes.find(r => r.id === 'warp');
  // The saved URL is only a label (the live tunnel is chosen per request), so it must not depend on the rotating pick.
  const url = `socks5://127.0.0.1:${basePort()}`;
  if (!route) { route = { id: 'warp', name: 'Cloudflare WARP', kind: 'warp', url, enabled: true, models: [], managed: true } satisfies Route; settings.routes.push(route); persist(); }
  else if (route.url !== url && route.managed) { route.url = url; persist(); }
}
// The SOCKS port being open says nothing about the tunnel: usque listens before the MASQUE handshake completes, and a
// NAT box can black-hole an idle outer connection while the port still accepts. So the periodic monitor pushes one tiny
// real request through the least-recently-probed tunnel (round-robin): it warms the connection through NAT, refreshes the
// exit IP shown in the dashboard, and counts a dead tunnel toward its failure cooldown.
let probing = false;
export async function refreshStatus(force = false, probe = false): Promise<void> {
  if (!force && Date.now() - status.checkedAt < 2500) return; status.checkedAt = Date.now();
  const engine = engineMode(); const before = status.state;
  if (engine === 'disabled') { status.state = 'disabled'; }
  else {
    for (const [port, t] of [...tunnels]) if (!(await socksAlive('127.0.0.1', port, 1500))) { t.failures++; if (t.failures >= 3) { stopProcess(t.proc); tunnels.delete(port); } }
    status.state = tunnels.size ? 'connected' : (findWarpHelper() ? (status.busy ? 'connecting' : 'disconnected') : 'not_installed');
  }
  if (status.state === 'connected' && !status.egress) { const t = [...tunnels.values()].find(x => x.egress); if (t?.egress) status.egress = t.egress; else { const target = warpTarget(); if (target) status.egress = await traceVia(target.host, target.port, 20000) || undefined; } }
  if (probe && status.state === 'connected' && !status.busy && tunnels.size && !probing) {
    probing = true;
    try {
      const t = [...tunnels.values()].sort((a, b) => (a.lastProbe || 0) - (b.lastProbe || 0))[0]; t.lastProbe = Date.now();
      const egress = await traceVia('127.0.0.1', t.port, 10000);
      if (egress?.ip) { t.egress = egress; t.egressIp = egress.ip; t.failures = 0; status.egress = egress; } else warpFailure(t.port);
    } finally { probing = false; }
  }
  if (status.state !== 'connected') status.egress = undefined; else if (status.state !== before) progress(100, 'connected', 'Cloudflare WARP is connected');
  if (status.state === 'connected') ensureRoute();
  if (before !== status.state && before !== 'disabled' && lastNotified !== status.state) { lastNotified = status.state; if (status.state === 'connected') notify('WARP connected', status.egress ? `Exit IP ${status.egress.ip} (${status.egress.colo}).` : 'The WARP tunnel is up.', 'success', 'warp-up'); else if (before === 'connected') notify('WARP disconnected', status.lastError || 'The WARP tunnel went down.', 'warning', 'warp-down'); }
}
export async function warpStatus() {
  await refreshStatus(); const engine = engineMode(); const helper = findWarpHelper(); const w = warpConfig();
  return {
    engine, state: status.state, connected: status.state === 'connected', busy: status.busy,
    host: '127.0.0.1', port: basePort(), helper: { path: helper, installed: !!helper, kind: 'usque' },
    egress: status.egress || null, tunnels: [...tunnels.values()].map(t => ({ port: t.port, egressIp: t.egressIp || '', endpoint: t.endpoint, since: t.startedAt, cooling: t.cooldownUntil > Date.now() })),
    progress: status.progress, lastError: status.lastError, config: { helperPath: w.helperPath, endpoint: w.endpoint }, autoStart: w.autoStart, pool: w.pool, rotateMinutes: w.rotateMinutes, platform: process.platform, canRotate: engine === 'embedded',
    install: { kind: 'usque', automatic: false, note: 'The bundled helper speaks MASQUE over HTTP/2. If this build has no helper, set its path in WARP settings or run scripts/build-warp-helper.sh.' },
  };
}
export async function warpConnect() {
  if (status.busy) throw new GatewayError('WARP setup is already running', 409);
  status.busy = true; status.lastError = ''; stopping = false;
  try {
    if (engineMode() === 'disabled') throw new GatewayError('WARP is turned off. Turn it on in the WARP settings first.', 400);
    await embeddedConnect();
    // Every tunnel start already pushed a real request through the tunnel, so the exit it reports is trusted here.
    progress(90, 'verifying', 'Verifying a request through WARP…');
    const t = warpTarget(); const egress = [...tunnels.values()].find(x => x.egress)?.egress || (t ? await traceVia(t.host, t.port, 30000) : null);
    if (!egress?.ip) { await stopTunnels(); throw new Error('The WARP helper is running but no request could pass through it. Check the helper and try another MASQUE endpoint.'); }
    if (egress.warp === 'off') { await stopTunnels(); throw new Error('Traffic reaches Cloudflare but is not tunnelled through WARP (warp=off).'); }
    status.egress = egress; status.state = 'connected'; status.checkedAt = Date.now();
    progress(100, 'connected', `Connected through Cloudflare (${egress.ip}${egress.colo ? ', ' + egress.colo : ''})`); ensureRoute(); startTimers();
  } catch (e: any) { const message = fail(String(e.message || e)); status.busy = false; status.checkedAt = 0; await refreshStatus(true).catch(() => {}); status.lastError = message; throw e instanceof GatewayError ? e : new GatewayError(message, 502, 'warp_error'); }
  finally { status.busy = false; }
  return warpStatus();
}
export async function warpDisconnect() {
  if (status.busy) throw new GatewayError('WARP setup is running', 409); stopping = true;
  try { await stopTunnels(); } catch (e: any) { throw new GatewayError(redactError(String(e.message || e)), 502, 'warp_error'); } finally { stopping = false; }
  status.checkedAt = 0; status.egress = undefined; progress(0, 'idle', 'WARP is disconnected'); await refreshStatus(true); return warpStatus();
}
export async function warpRotate() {
  if (status.busy) throw new GatewayError('WARP setup is running', 409);
  if (engineMode() === 'disabled') throw new GatewayError('WARP is turned off', 400);
  if (!findWarpHelper()) throw new GatewayError('WARP helper is not installed. Put the platform helper in the app\'s warp folder, set its path in WARP settings, or run scripts/build-warp-helper.sh.', 503, 'warp_not_installed');
  status.busy = true; stopping = true;
  try { await stopTunnels(); stopping = false; progress(10, 'rotating', 'Creating new WARP identities…'); await embeddedConnect(true); status.egress = [...tunnels.values()].find(t => t.egress)?.egress; status.state = 'connected'; status.checkedAt = Date.now(); progress(100, 'connected', 'WARP identity rotated'); notify('WARP identity rotated', 'New WARP tunnels are running.', 'info', 'warp-rotate', 0); }
  catch (e: any) { fail(String(e.message || e)); throw new GatewayError(status.lastError, 502, 'warp_error'); } finally { stopping = false; status.busy = false; }
  return warpStatus();
}
// The helper is shipped with the app. This endpoint is kept so a build that lacks it can say so clearly instead of failing at connect time.
export async function warpInstall() {
  const helper = findWarpHelper();
  if (!helper) throw new GatewayError('The WARP helper is not bundled with this build. Put the platform helper in the app\'s warp folder, set its path in WARP settings, or run scripts/build-warp-helper.sh.', 503, 'warp_not_installed');
  progress(100, 'installed', 'WARP helper found'); return { installed: true, ...await warpStatus() };
}
export async function setWarpSettings(patch: Partial<WarpSettings>, port?: number) {
  const next = { ...warpConfig(), ...patch };
  if (!['embedded', 'disabled'].includes(next.engine)) throw new GatewayError('Unknown WARP setting', 400);
  next.pool = Math.max(1, Math.min(4, Math.floor(Number(next.pool) || 1))); next.rotateMinutes = Math.max(0, Math.min(10080, Math.floor(Number(next.rotateMinutes) || 0)));
  next.helperPath = String(next.helperPath || '').slice(0, 500);
  next.endpoint = String(next.endpoint || '').trim().slice(0, 200);
  if (next.endpoint && !/^[A-Za-z0-9.:[\]-]+$/.test(next.endpoint)) throw new GatewayError('The MASQUE endpoint must be a hostname or IP address', 400);
  if (port !== undefined) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new GatewayError('The SOCKS port must be between 1024 and 65535', 400);
    // Running helpers listen on the old ports: the managed route still picks warpTarget(), but the dashboard and the saved
    // route URL would advertise a port nothing listens on. Refuse the move unless the requested port is already live.
    if (port !== basePort() && tunnels.size && !tunnels.has(port) && next.engine !== 'disabled') throw new GatewayError('Disconnect WARP before changing its SOCKS port', 409, 'warp_port_in_use');
  }
  settings.warp = { engine: next.engine, autoStart: !!next.autoStart, pool: next.pool, rotateMinutes: next.rotateMinutes, helperPath: next.helperPath, endpoint: next.endpoint };
  if (port !== undefined) settings.warpProxyPort = port;
  persist(); status.checkedAt = 0; startTimers();
  if (next.engine === 'disabled' && tunnels.size) await stopTunnels(); // a disabled engine must not leave helper processes running
  // Only move an existing managed route: saving settings must not create an enabled route before WARP has ever connected.
  if (port !== undefined && settings.routes.some(r => r.id === 'warp')) ensureRoute();
  await refreshStatus(true);
}
function startTimers() {
  if (!monitor) { monitor = setInterval(() => void refreshStatus(true, true).catch(() => {}), 20000); monitor.unref?.(); }
  if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = undefined; }
  const minutes = warpConfig().rotateMinutes;
  if (minutes > 0) { rotateTimer = setInterval(() => void warpRotate().catch(() => {}), minutes * 60000); rotateTimer.unref?.(); }
}
export async function startWarp() {
  startTimers(); const engine = engineMode(); if (engine === 'disabled') return;
  await refreshStatus(true).catch(() => {});
  if (warpConfig().autoStart && status.state !== 'connected') await warpConnect().catch(e => console.warn('[warp] auto-start:', redactError(String(e.message || e))));
  else if (status.state === 'connected') ensureRoute();
}
export async function stopWarp() { stopping = true; if (monitor) clearInterval(monitor); if (rotateTimer) clearInterval(rotateTimer); monitor = rotateTimer = undefined; await stopTunnels(); }
export function listWarpFiles() { try { return readdirSync(warpDir); } catch { return []; } }
export { socksConnect };

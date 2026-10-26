import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { generateKeyPairSync, createHash } from 'node:crypto';
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
const ENDPOINTS = ['162.159.192.1:2408', '162.159.193.1:2408', '162.159.195.1:2408', '188.114.97.1:2408', '188.114.96.1:2408', 'engage.cloudflareclient.com:2408'];
// Polygate runs WARP itself (wireproxy: userspace WireGuard + SOCKS5). The official client and external SOCKS5 sidecars were removed on 26 October 2026:
// they gave OpenCode the same WARP exit but could not manage identities, and any SOCKS5 endpoint can still be added as an ordinary route.
export type WarpEngine = 'embedded' | 'disabled';
type Account = { privateKey: string; addressV4: string; addressV6: string; peerPublicKey: string; accountId: string; registeredAt: string };
type Tunnel = { port: number; proc?: ChildProcess; account: Account; endpoint: string; startedAt: number; egressIp?: string; failures: number; cooldownUntil: number; restarts: number };
type Egress = { ip: string; colo: string; warp: string };
export type WarpState = 'disabled' | 'not_installed' | 'not_registered' | 'disconnected' | 'connecting' | 'connected' | 'error';
const defaults: WarpSettings = { engine: 'embedded', autoStart: false, pool: 2, rotateMinutes: 0, wireproxyPath: '' };
// Settings saved by older versions may name an engine that no longer exists; only "disabled" is kept, everything else is the built-in engine.
export const warpConfig = (): WarpSettings => { const c: any = { ...defaults, ...settings.warp }; delete c.host; return { ...c, engine: c.engine === 'disabled' ? 'disabled' : 'embedded' }; };
const basePort = () => settings.warpProxyPort || 40000;
const status = { progress: { percent: 0, stage: 'idle', message: 'WARP is idle' }, lastError: '', egress: undefined as Egress | undefined, checkedAt: 0, busy: false, state: 'disconnected' as WarpState };
const tunnels = new Map<number, Tunnel>();
let monitor: ReturnType<typeof setInterval> | undefined, rotateTimer: ReturnType<typeof setInterval> | undefined, lastRegistration = 0, registerBackoffUntil = 0, rr = 0, stopping = false, lastNotified = '';
const progress = (percent: number, stage: string, message: string) => { status.progress = { percent, stage, message }; };
const fail = (message: string) => { status.lastError = redactError(message); status.progress = { percent: 0, stage: 'error', message: status.lastError }; return status.lastError; };
// --- discovery ---
function which(name: string) { try { return (Bun.which(name) as string | null) || ''; } catch { return ''; } }
export function findWireproxy() {
  const name = isWin ? 'wireproxy.exe' : 'wireproxy';
  const candidates = [warpConfig().wireproxyPath, process.env.WIREPROXY_PATH || '', path.join(binDir, name), path.join(appDir, 'bin', name), path.join(path.dirname(process.execPath), name), which('wireproxy'), '/usr/local/bin/wireproxy', '/usr/bin/wireproxy'];
  return candidates.find(c => c && existsSync(c)) || '';
}
export const engineMode = (): WarpEngine => warpConfig().engine;
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
// Fetches Cloudflare's trace page through the tunnel; warp=on|plus proves the traffic really leaves through WARP.
export async function traceVia(host: string, port: number, timeoutMs = 8000): Promise<Egress | null> {
  try {
    const proxy = await socksBridge({ host, port });
    const r = await fetch(process.env.POLYGATE_WARP_TRACE_URL || 'https://www.cloudflare.com/cdn-cgi/trace', { proxy, signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'curl/8.0' } } as any);
    const text = await r.text(); const pick = (k: string) => text.match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1]?.trim() || '';
    return pick('ip') ? { ip: pick('ip'), colo: pick('colo'), warp: pick('warp') } : null;
  } catch { return null; }
}
// --- embedded engine (wireproxy: userspace WireGuard + SOCKS5, no system-wide VPN) ---
const accountFile = path.join(warpDir, 'accounts.json');
const loadAccounts = (): Account[] => { try { return existsSync(accountFile) ? JSON.parse(readFileSync(accountFile, 'utf8')) : []; } catch { return []; } };
const saveAccounts = (list: Account[]) => { mkdirSync(warpDir, { recursive: true }); writeFileSync(accountFile, JSON.stringify(list), { mode: 0o600 }); };
export async function registerAccount(): Promise<Account> {
  if (Date.now() < registerBackoffUntil) throw new Error(`Cloudflare is rate limiting WARP registrations; waiting ${Math.ceil((registerBackoffUntil - Date.now()) / 60000)} more minute(s).`);
  const wait = 12000 - (Date.now() - lastRegistration); if (wait > 0) await Bun.sleep(wait); lastRegistration = Date.now();
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'); const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64');
  const r = await fetch('https://api.cloudflareclient.com/v0a3371/reg', { method: 'POST', headers: { 'content-type': 'application/json; charset=UTF-8', 'user-agent': 'okhttp/3.12.1' }, body: JSON.stringify({ key: pub, install_id: '', fcm_token: '', tos: new Date().toISOString(), model: 'PC', serial_number: '', locale: 'en_US' }), signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  if (!r.ok) { if (r.status === 429 || text.includes('1015')) registerBackoffUntil = Date.now() + 15 * 60000; throw new Error(`Cloudflare registration failed (HTTP ${r.status}): ${text.slice(0, 200)}`); }
  const j = JSON.parse(text);
  return { privateKey: priv, accountId: j.id, addressV4: j.config?.interface?.addresses?.v4 || '172.16.0.2', addressV6: j.config?.interface?.addresses?.v6 || '', peerPublicKey: j.config?.peers?.[0]?.public_key || 'bmXOC+F1FxEMF9dyiK2H5/1SUtzHP0JyV5VC9G3ZDio=', registeredAt: new Date().toISOString() };
}
async function startTunnel(port: number, account: Account): Promise<Tunnel> {
  const bin = findWireproxy(); if (!bin) throw new GatewayError('wireproxy is not installed. Use Install to download it.', 503, 'warp_not_installed');
  let lastError = 'no endpoint answered';
  for (const endpoint of ENDPOINTS) {
    mkdirSync(warpDir, { recursive: true });
    const conf = path.join(warpDir, `wireproxy_${port}.conf`);
    writeFileSync(conf, `[Interface]\nPrivateKey = ${account.privateKey}\nAddress = ${account.addressV4}/32${account.addressV6 ? `, ${account.addressV6}/128` : ''}\nDNS = 1.1.1.1, 8.8.8.8\n\n[Peer]\nPublicKey = ${account.peerPublicKey}\nEndpoint = ${endpoint}\nAllowedIPs = 0.0.0.0/0, ::/0\nPersistentKeepalive = 25\n\n[Socks5]\nBindAddress = 127.0.0.1:${port}\n`, { mode: 0o600 });
    const proc = spawn(bin, ['-c', conf], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); let output = ''; let exited = false;
    proc.stdout?.on('data', d => { output = (output + d).slice(-600); }); proc.stderr?.on('data', d => { output = (output + d).slice(-600); }); proc.once('exit', () => { exited = true; });
    let alive = false; for (let i = 0; i < 40 && !exited; i++) { await Bun.sleep(250); if (await socksAlive('127.0.0.1', port, 800)) { alive = true; break; } }
    if (alive) {
      const egress = await traceVia('127.0.0.1', port, 7000);
      if (egress && ['on', 'plus'].includes(egress.warp)) {
        const tunnel: Tunnel = { port, proc, account, endpoint, startedAt: Date.now(), egressIp: egress.ip, failures: 0, cooldownUntil: 0, restarts: 0 };
        proc.once('exit', code => { if (tunnels.get(port)?.proc !== proc) return; tunnels.delete(port); if (!stopping) { notify('WARP tunnel stopped', `Tunnel on port ${port} exited (${code}).`, 'warning', 'warp-tunnel-' + port); setTimeout(() => void restartTunnel(port, account, tunnel.restarts + 1), Math.min(60000, 5000 * 2 ** tunnel.restarts)).unref(); } });
        return tunnel;
      }
      lastError = `endpoint ${endpoint} did not carry traffic through WARP`;
    } else lastError = `wireproxy ${exited ? 'exited' : 'did not answer'} on endpoint ${endpoint}${output ? ': ' + output.trim().split('\n').pop() : ''}`;
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
  }
  throw new Error(`Could not start a WARP tunnel on port ${port}: ${lastError}`);
}
async function restartTunnel(port: number, account: Account, restarts: number) {
  if (stopping || tunnels.has(port) || engineMode() !== 'embedded') return;
  try { const t = await startTunnel(port, account); t.restarts = restarts; tunnels.set(port, t); ensureRoute(); } catch (e) { if (restarts < 6) setTimeout(() => void restartTunnel(port, account, restarts + 1), Math.min(120000, 5000 * 2 ** restarts)).unref(); }
}
async function embeddedConnect(fresh = false) {
  // Without the helper nothing can start, so do not register identities with Cloudflare (or wait out the registration pause) first.
  if (!findWireproxy()) throw new GatewayError('wireproxy is not installed. Use "Download tunnel helper" first.', 503, 'warp_not_installed');
  const want = Math.max(1, Math.min(4, warpConfig().pool)); let accounts = fresh ? [] : loadAccounts();
  progress(15, 'accounts', 'Preparing WARP identities…');
  for (let i = 0; i < want; i++) {
    const port = basePort() + i; if (tunnels.has(port)) continue;
    if (!accounts[i]) { progress(25 + i * 10, 'registering', `Registering WARP identity ${i + 1}/${want}…`); try { accounts[i] = await registerAccount(); saveAccounts(accounts.filter(Boolean)); } catch (e) { if (tunnels.size) break; throw e; } }
    progress(50 + i * 10, 'starting', `Starting WARP tunnel ${i + 1}/${want} on port ${port}…`);
    try { tunnels.set(port, await startTunnel(port, accounts[i])); } catch (e) { if (!tunnels.size) throw e; }
    ensureRoute();
  }
  if (!tunnels.size) throw new Error('No WARP tunnel could be started.');
}
async function stopTunnels() { for (const [, t] of tunnels) { try { t.proc?.kill('SIGTERM'); } catch { /* already gone */ } } tunnels.clear(); await Bun.sleep(150); }
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
export async function refreshStatus(force = false): Promise<void> {
  if (!force && Date.now() - status.checkedAt < 2500) return; status.checkedAt = Date.now();
  const engine = engineMode(); const before = status.state;
  if (engine === 'disabled') { status.state = 'disabled'; }
  else {
    for (const [port, t] of [...tunnels]) if (!(await socksAlive('127.0.0.1', port, 1500))) { t.failures++; if (t.failures >= 3) { try { t.proc?.kill('SIGKILL'); } catch { /* gone */ } tunnels.delete(port); } }
    status.state = tunnels.size ? 'connected' : (findWireproxy() ? (status.busy ? 'connecting' : 'disconnected') : 'not_installed');
  }
  if (status.state === 'connected' && !status.egress) { const t = warpTarget(); if (t) status.egress = await traceVia(t.host, t.port) || undefined; }
  if (status.state !== 'connected') status.egress = undefined; else if (status.state !== before) progress(100, 'connected', 'Cloudflare WARP is connected');
  if (status.state === 'connected') ensureRoute();
  if (before !== status.state && before !== 'disabled' && lastNotified !== status.state) { lastNotified = status.state; if (status.state === 'connected') notify('WARP connected', status.egress ? `Exit IP ${status.egress.ip} (${status.egress.colo}).` : 'The WARP tunnel is up.', 'success', 'warp-up'); else if (before === 'connected') notify('WARP disconnected', status.lastError || 'The WARP tunnel went down.', 'warning', 'warp-down'); }
}
export async function warpStatus() {
  await refreshStatus(); const engine = engineMode(); const wireproxy = findWireproxy(); const w = warpConfig();
  return {
    engine, state: status.state, connected: status.state === 'connected', busy: status.busy,
    host: '127.0.0.1', port: basePort(), wireproxy: { path: wireproxy, installed: !!wireproxy },
    egress: status.egress || null, tunnels: [...tunnels.values()].map(t => ({ port: t.port, egressIp: t.egressIp || '', endpoint: t.endpoint, since: t.startedAt, cooling: t.cooldownUntil > Date.now() })),
    progress: status.progress, lastError: status.lastError, config: { wireproxyPath: w.wireproxyPath }, autoStart: w.autoStart, pool: w.pool, rotateMinutes: w.rotateMinutes, platform: process.platform, canRotate: engine === 'embedded',
    install: { kind: 'wireproxy', automatic: true, note: 'Downloads wireproxy (userspace WireGuard) from its GitHub release and verifies its checksum.' },
  };
}
export async function warpConnect() {
  if (status.busy) throw new GatewayError('WARP setup is already running', 409);
  status.busy = true; status.lastError = ''; stopping = false;
  try {
    if (engineMode() === 'disabled') throw new GatewayError('WARP is turned off. Turn it on in the WARP settings first.', 400);
    await embeddedConnect();
    progress(90, 'verifying', 'Verifying traffic leaves through Cloudflare…'); status.checkedAt = 0; status.egress = undefined; await refreshStatus(true);
    const t = warpTarget(); const egress = t ? await traceVia(t.host, t.port) : null; status.egress = egress || undefined;
    if (!egress) throw new Error('The WARP proxy answers but could not reach the internet. Check the host network and try again.');
    if (!['on', 'plus'].includes(egress.warp)) throw new Error(`Traffic reaches Cloudflare but is not tunnelled through WARP (warp=${egress.warp || 'off'}).`);
    progress(100, 'connected', `Connected through Cloudflare (${egress.ip}, ${egress.colo})`); ensureRoute(); startTimers();
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
  if (!findWireproxy()) throw new GatewayError('wireproxy is not installed. Use "Download tunnel helper" first.', 503, 'warp_not_installed');
  status.busy = true; stopping = true;
  try { await stopTunnels(); stopping = false; progress(10, 'rotating', 'Creating new WARP identities…'); await embeddedConnect(true); status.egress = undefined; progress(100, 'connected', 'WARP identity rotated'); notify('WARP identity rotated', 'New WARP tunnels are running.', 'info', 'warp-rotate', 0); }
  catch (e: any) { fail(String(e.message || e)); throw new GatewayError(status.lastError, 502, 'warp_error'); } finally { stopping = false; status.busy = false; }
  return warpStatus();
}
// Downloads the pinned wireproxy release and verifies it against the checksums published with that release.
const WIREPROXY_VERSION = 'v1.1.3';
export async function downloadWireproxy() {
  const arch = ({ x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' } as Record<string, string>)[process.arch]; const os = ({ linux: 'linux', win32: 'windows', darwin: 'darwin' } as Record<string, string>)[process.platform];
  if (!arch || !os) throw new GatewayError(`No wireproxy build for ${process.platform}/${process.arch}`, 400);
  const asset = `wireproxy_${os}_${arch}.tar.gz`; const base = `https://github.com/windtf/wireproxy/releases/download/${WIREPROXY_VERSION}`;
  progress(10, 'downloading', `Downloading ${asset}…`);
  const [archive, sums] = await Promise.all([fetch(`${base}/${asset}`, { signal: AbortSignal.timeout(120000) }), fetch(`${base}/checksums.txt`, { signal: AbortSignal.timeout(30000) })]);
  if (!archive.ok) throw new GatewayError(`Download failed (HTTP ${archive.status})`, 502); const bytes = Buffer.from(await archive.arrayBuffer());
  const expected = sums.ok ? (await sums.text()).split('\n').map(l => l.trim().split(/\s+/)).find(p => p[1] === asset)?.[0] : '';
  if (!expected) throw new GatewayError('Could not find a published checksum for this download; refusing to install it.', 502);
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new GatewayError('Checksum mismatch; the download was discarded.', 502);
  mkdirSync(binDir, { recursive: true }); const tmp = path.join(binDir, asset); writeFileSync(tmp, bytes);
  try { await run('tar', ['-xzf', tmp, '-C', binDir, isWin ? 'wireproxy.exe' : 'wireproxy'], { windowsHide: true }); } finally { rmSync(tmp, { force: true }); }
  if (!isWin) chmodSync(path.join(binDir, 'wireproxy'), 0o755); progress(100, 'installed', 'wireproxy installed'); return findWireproxy();
}
export async function warpInstall() {
  await downloadWireproxy(); return { installed: true, ...await warpStatus() };
}
export async function setWarpSettings(patch: Partial<WarpSettings>) {
  const next = { ...warpConfig(), ...patch };
  if (!['embedded', 'disabled'].includes(next.engine)) throw new GatewayError('Unknown WARP setting', 400);
  next.pool = Math.max(1, Math.min(4, Math.floor(Number(next.pool) || 1))); next.rotateMinutes = Math.max(0, Math.min(10080, Math.floor(Number(next.rotateMinutes) || 0)));
  settings.warp = { engine: next.engine, autoStart: !!next.autoStart, pool: next.pool, rotateMinutes: next.rotateMinutes, wireproxyPath: String(next.wireproxyPath || '').slice(0, 500) };
  persist(); status.checkedAt = 0; startTimers(); await refreshStatus(true);
}
function startTimers() {
  if (!monitor) { monitor = setInterval(() => void refreshStatus(true).catch(() => {}), 20000); monitor.unref?.(); }
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

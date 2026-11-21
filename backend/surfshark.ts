// Surfshark as one route. With the account's WireGuard key pair (made in the Surfshark account under VPN → Manual setup → WireGuard) and
// Surfshark's public server list, Polygate runs one wireproxy client per chosen location. wireproxy (resources/surfshark, ISC licence) is a
// WireGuard client that lives entirely in its own process and offers the tunnel as a local SOCKS port: no network adapter, route or DNS
// change on this computer, only the gateway's own requests use it. Together the locations are the route "surfshark", an exit group like
// Psiphon (backend/exit-group.ts): taking turns or staying on one, used-up exits skipped per provider, new addresses checked first.
import { spawn, type ChildProcess } from 'node:child_process';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { accessSync, constants as fsConstants, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { settings, persist, stateDir, redactError } from './state';
import { GatewayError } from './queue';
import { freePort, traceVia } from './warp';
import { logEvent } from './logbook';
import { notify } from './notifications';
import { cancellable, detached, isCancelled, cancelledError } from './cancel';
import { registerExitGroup, type ExitScope, type ExitCheck, type ExitChecker } from './exit-group';
import type { Route, SurfsharkServer, SurfsharkSettings } from './types';

const isWin = process.platform === 'win32';
const appDir = process.env.POLYGATE_APP_DIR || process.cwd();
const dataDir = path.join(stateDir, 'surfshark');
// Each location is its own client on its own port, counted up from here (every port is checked free first; Psiphon starts at 47100).
const BASE_PORT = 47400;
export const ROUTE_ID = 'surfshark';
const ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
// Surfshark's WireGuard settings, as in the configuration files its account page offers: every account uses this address, these DNS servers
// and port 51820. MTU 1280 leaves room for a tunnel inside another one (an xray or other VPN connection on this computer).
const DEFAULT_ADDRESS = '10.14.0.2/16'; const DNS = '162.252.172.57'; const WG_PORT = 51820; const MTU = 1280;
const LIST_URLS = ['https://api.surfshark.com/v4/server/clusters/generic', 'https://api.surfshark.com/v3/server/clusters'];
const defaults: SurfsharkSettings = { enabled: true, autoStart: false, regions: [], mode: 'spread', pinned: '', skip: true, renew: true };
export const surfsharkConfig = (): SurfsharkSettings => {
  const c: any = { ...defaults, ...settings.surfshark };
  c.regions = Array.isArray(c.regions) ? [...new Set(c.regions.map((r: unknown) => String(r).toLowerCase()).filter((r: string) => ID.test(r)))] : [];
  c.mode = c.mode === 'single' ? 'single' : 'spread';
  c.pinned = ID.test(String(c.pinned || '')) ? String(c.pinned) : '';
  return c as SurfsharkSettings;
};
const save = (patch: Partial<SurfsharkSettings>) => { settings.surfshark = { ...surfsharkConfig(), ...patch }; persist(); };

// --- the account's key pair ---
// WireGuard keys are 32 bytes in base64. The public key is worked out from the private one, so a pasted pair that does not belong together
// (a key from another pair, a typing slip) is caught here and not by a tunnel that silently never connects.
const KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
export function publicKeyOf(privateKey: string): string {
  const raw = Buffer.from(privateKey, 'base64');
  if (!KEY.test(privateKey) || raw.length !== 32) throw new GatewayError('That is not a WireGuard private key: it is 44 characters ending in "=". Copy it again from your Surfshark account.', 400, 'surfshark_key');
  const der = Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), raw]);
  const spki = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' });
  return Buffer.from(spki.subarray(spki.length - 32)).toString('base64');
}
export const surfsharkHasKeys = () => !!surfsharkConfig().privateKey;
export async function setSurfsharkKeys(input: { privateKey?: unknown; publicKey?: unknown }) {
  const privateKey = String(input.privateKey || '').trim(); const publicKey = String(input.publicKey || '').trim();
  if (!privateKey) throw new GatewayError('Paste the private key from your Surfshark account.', 400, 'surfshark_key');
  const derived = publicKeyOf(privateKey);
  if (publicKey && publicKey !== derived) throw new GatewayError('The public key does not belong to this private key. Copy both from the same key pair in your Surfshark account.', 400, 'surfshark_key');
  const had = surfsharkConfig().privateKey;
  save({ privateKey, publicKey: derived, address: surfsharkConfig().address || DEFAULT_ADDRESS });
  logEvent('info', 'surfshark', `Surfshark key pair ${had ? 'replaced' : 'saved'}`);
  // Running locations use the old key: they reconnect with the new one.
  if (had && had !== privateKey && instances.size) for (const r of [...instances.keys()]) await startInstance(r, true).catch(() => {});
  return surfsharkStatus();
}
export async function clearSurfsharkKeys() {
  await stopAll(); ensureRoute(false, true);
  const { privateKey: _p, publicKey: _q, ...rest } = surfsharkConfig(); settings.surfshark = rest; persist();
  logEvent('info', 'surfshark', 'Surfshark key pair removed');
  return surfsharkStatus();
}

// --- the bundled client ---
const binName = () => isWin ? (process.arch === 'x64' ? 'wireproxy-windows-amd64.exe' : '') : process.platform === 'linux' ? (process.arch === 'x64' ? 'wireproxy-linux-amd64' : process.arch === 'arm64' ? 'wireproxy-linux-arm64' : '') : '';
const folders = () => [process.env.POLYGATE_SURFSHARK_DIR || '', path.join(appDir, 'surfshark'), path.join(appDir, 'resources', 'surfshark'), path.join(path.dirname(process.execPath), 'surfshark')].filter(Boolean);
function runnable(file: string) { try { if (!statSync(file).isFile()) return false; if (!isWin) accessSync(file, fsConstants.X_OK); return true; } catch { return false; } }
export function findWireproxy(): string | null { const name = binName(); if (!name) return null; for (const f of folders()) { const p = path.join(f, name); if (runnable(p)) return p; } return null; }
export function wireproxyMissing(): string {
  if (!binName()) return `Surfshark's WireGuard client has no build for this platform (${process.platform} ${process.arch}). It runs on Windows x64 and Linux x64 and arm64.`;
  const present = folders().map(f => path.join(f, binName())).find(f => { try { return statSync(f).isFile() && !runnable(f); } catch { return false; } });
  return present ? `The WireGuard client at ${present} cannot be run (it has no execute permission). Fix it with: chmod +x ${present}` : 'The WireGuard client is not in this build. It belongs in the app\'s surfshark folder.';
}

// --- Surfshark's server list ---
const servers = () => surfsharkConfig().servers || [];
const serverOf = (id: string) => servers().find(s => s.id === id);
function parseServers(list: unknown): SurfsharkServer[] {
  if (!Array.isArray(list)) return [];
  const out: SurfsharkServer[] = [];
  for (const s of list as any[]) {
    const host = String(s?.connectionName || ''); const pubKey = String(s?.pubKey || '');
    if (!/^[a-z0-9-]+\.prod\.surfshark\.com$/.test(host) || !KEY.test(pubKey)) continue;
    const id = host.split('.')[0]; if (!ID.test(id) || out.some(x => x.id === id)) continue;
    out.push({ id, host, pubKey, country: String(s.country || id), countryCode: String(s.countryCode || '').toUpperCase().slice(0, 2), location: String(s.location || ''), load: Number.isFinite(Number(s.load)) ? Number(s.load) : undefined });
  }
  return out.sort((a, b) => a.country.localeCompare(b.country) || a.location.localeCompare(b.location));
}
// Fetches Surfshark's public list of servers (no account involved): each location's host and WireGuard server key.
export function surfsharkUpdateServers() {
  return guard('updating servers', async () => {
    let last = '';
    for (const url of LIST_URLS) {
      try {
        const r = await fetch(url, { signal: cancellable(30000) });
        if (!r.ok) { last = `HTTP ${r.status}`; await r.body?.cancel().catch(() => {}); continue; }
        const list = parseServers(await r.json());
        if (list.length) {
          // A location Surfshark no longer lists leaves the chosen ones too: it is not shown any more, so it could not be unticked, and
          // Connect would refuse every time because of it.
          const c = surfsharkConfig(); const offered = new Set(list.map(s => s.id)); const gone = c.regions.filter(r => !offered.has(r));
          const regions = c.regions.filter(r => offered.has(r)); const pinned = offered.has(c.pinned) ? c.pinned : regions[0] || '';
          save({ servers: list, updatedAt: Date.now(), ...(gone.length ? { regions, pinned } : {}) });
          logEvent('info', 'surfshark', `Surfshark servers updated: ${list.length} locations in ${new Set(list.map(s => s.countryCode)).size} countries${gone.length ? `; no longer offered, so removed from your locations: ${gone.join(', ')}` : ''}`);
          return surfsharkStatus();
        }
        last = 'the list was empty';
      } catch (e: any) { if (isCancelled()) throw cancelledError(); last = redactError(String(e?.message || e)).slice(0, 120); }
    }
    throw new GatewayError(`Surfshark's server list could not be read (${last}). Check this computer's connection and try again.`, 502, 'surfshark_error');
  });
}

// --- instances ---
type State = 'starting' | 'ready' | 'reconnecting' | 'failed';
type Instance = { region: string; port: number; proc?: ChildProcess; state: State; exitIp: string; location: string; startedAt: number; readyAt: number;
  failures: number; restarts: number; error: string; renewedAt: number[]; stopping?: boolean; output: string; handshake: boolean; checking?: ExitScope };
const instances = new Map<string, Instance>();
let rr = 0, monitor: ReturnType<typeof setInterval> | undefined, busy = '', lastError = '', lastNotified = '';
const regionDir = (region: string) => path.join(dataDir, region);
const used = () => new Set([...instances.values()].map(i => i.port));
// What wireproxy prints is kept for an error message, with anything that looks like a key taken out.
const clean = (s: string) => s.replace(/[A-Za-z0-9+/]{42,}={0,2}/g, '•••').replace(/\s+/g, ' ').trim();
// The client reads its settings, which hold the private key, from a file. The file lives in Polygate's own data folder, readable by this user
// only, and only while the client starts: it is deleted as soon as the tunnel is up (or the start failed).
function configText(server: SurfsharkServer, port: number) {
  const c = surfsharkConfig(); const address = String(c.address || DEFAULT_ADDRESS).replace(/\/\d+$/, '/32');
  return ['[Interface]', `Address = ${address}`, `PrivateKey = ${c.privateKey}`, `DNS = ${DNS}`, `MTU = ${MTU}`, '',
    '[Peer]', `PublicKey = ${server.pubKey}`, `Endpoint = ${server.host}:${WG_PORT}`, 'AllowedIPs = 0.0.0.0/0', 'PersistentKeepalive = 25', '',
    '[Socks5]', `BindAddress = 127.0.0.1:${port}`, ''].join('\n');
}
const confOf = (region: string) => path.join(regionDir(region), 'wireproxy.conf');
const dropConf = (region: string) => { try { rmSync(confOf(region), { force: true }); } catch { /* already gone */ } };
async function launch(inst: Instance): Promise<ChildProcess> {
  const bin = findWireproxy(); if (!bin) throw new GatewayError(wireproxyMissing(), 503, 'surfshark_not_installed');
  const server = serverOf(inst.region); if (!server) throw new GatewayError(`${inst.region} is not in Surfshark's server list. Press Update servers.`, 400, 'surfshark_region');
  if (!surfsharkHasKeys()) throw new GatewayError('Save your Surfshark key pair first.', 400, 'surfshark_key');
  mkdirSync(regionDir(inst.region), { recursive: true });
  writeFileSync(confOf(inst.region), configText(server, inst.port), { mode: 0o600 });
  const proc = spawn(bin, ['-c', confOf(inst.region)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  const data = (d: Buffer) => { buf += d; if (buf.length > 1e6) buf = buf.slice(-2e5); let n; while ((n = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, n); buf = buf.slice(n + 1); onLine(inst, line); } };
  proc.stdout!.on('data', data); proc.stderr!.on('data', data);
  await new Promise<void>((resolve, reject) => { proc.once('spawn', () => resolve()); proc.once('error', e => { dropConf(inst.region); reject(new GatewayError(`The WireGuard client could not start: ${e.message}`, 502, 'surfshark_error')); }); });
  return proc;
}
function onLine(inst: Instance, line: string) {
  if (instances.get(inst.region) !== inst) return;
  if (/Received handshake response/i.test(line)) { if (!inst.handshake) { inst.handshake = true; void learnExit(inst, true); } }
  else if (/error|failed|could not|unable/i.test(line) && !/DEBUG/.test(line)) inst.output = clean(line).slice(0, 300);
}

// One start per location at a time, and none survives a stop: `epoch` moves on every stopAll (as in backend/psiphon.ts).
let epoch = 0; const starting = new Map<string, Promise<Instance>>();
function startInstance(region: string, fresh = false): Promise<Instance> {
  const running = starting.get(region); if (running) return running;
  // A client outlives the request that started it: it runs detached from that request, so a cancel never reaches its later checks.
  const job = detached(() => startOnce(region, fresh, epoch)).finally(() => { if (starting.get(region) === job) starting.delete(region); });
  starting.set(region, job); return job;
}
const stopped = () => new GatewayError('Surfshark was stopped', 409, 'surfshark_stopped');
function stopProcess(proc?: ChildProcess) { try { proc?.kill(); } catch { /* already gone */ } }
const exitOf = (proc: ChildProcess) => new Promise<void>(r => { if (proc.exitCode !== null || proc.signalCode) return r(); proc.once('exit', () => r()); setTimeout(r, 5000); });
async function startOnce(region: string, fresh: boolean, at: number): Promise<Instance> {
  const old = instances.get(region);
  if (old) { old.stopping = true; stopProcess(old.proc); if (old.proc) await exitOf(old.proc); }
  if (at !== epoch) throw stopped();
  const avoid = used(); if (old) avoid.delete(old.port);
  const port = old?.port && !fresh ? old.port : await freePort(BASE_PORT, avoid);
  if (at !== epoch) throw stopped();
  const inst: Instance = { region, port, state: 'starting', exitIp: '', location: '', startedAt: Date.now(), readyAt: 0, failures: 0, restarts: old?.restarts || 0, error: '', renewedAt: old?.renewedAt || [], output: '', handshake: false };
  instances.set(region, inst);
  try {
    inst.proc = await launch(inst);
    inst.proc.once('exit', code => { dropConf(region); onExit(inst, code); });
    if (at !== epoch || instances.get(region) !== inst) { inst.stopping = true; stopProcess(inst.proc); if (instances.get(region) === inst) instances.delete(region); throw stopped(); }
    // No handshake within 45 s: the WireGuard packets (UDP 51820) do not get through, or the key is not accepted. The client is stopped and
    // started again later with a growing wait, like a client that stopped by itself.
    const t = setTimeout(() => { if (instances.get(region) === inst && inst.state === 'starting') { inst.error = inst.handshake ? 'Connected to Surfshark, but no request passed through the tunnel.' : 'Surfshark did not answer: the WireGuard handshake never completed. UDP port 51820 may be blocked on this network, or the key pair was replaced in your Surfshark account.'; inst.state = 'failed'; stopProcess(inst.proc); } }, 45000);
    t.unref?.();
  } catch (e: any) { dropConf(region); inst.state = 'failed'; inst.error = redactError(String(e.message || e)); throw e; }
  return inst;
}
// The exit address is what OpenCode sees, and what its allowance belongs to. A reconnect can land on another server of the same location.
async function learnExit(inst: Instance, first: boolean) {
  let egress = null;
  for (let i = 0; i < 3 && !egress; i++) { egress = await traceVia('127.0.0.1', inst.port, 20000); if (instances.get(inst.region) !== inst) return; }
  if (!egress?.ip) { if (first) inst.output = inst.output || 'The tunnel is up but no request passed through it yet.'; return; }
  const wasReady = inst.state === 'ready';
  const changed = egress.ip !== inst.exitIp; inst.exitIp = egress.ip; inst.location = egress.loc || '';
  inst.state = 'ready'; inst.error = ''; inst.failures = 0; inst.restarts = 0; if (!wasReady) inst.readyAt = Date.now();
  dropConf(inst.region); // the tunnel is up: the file with the key is no longer needed
  const spent = spentUntil(egress.ip);
  if (!wasReady || changed) logEvent('info', 'surfshark', `Surfshark ${inst.region} is connected; exit ${egress.ip}${spent ? ' (used up today)' : ''}`, { region: inst.region, ip: egress.ip });
  const scope = recheck.get(inst.region);
  if (scope) {
    if (!surfsharkConfig().renew) { recheck.delete(inst.region); return; }
    if (scope === 'opencode' ? spent : kiloUntil(egress.ip)) { if (!tryRenew(inst, scope)) recheck.delete(inst.region); return; }
    void checkExit(inst, scope);
  }
}
const recheck = new Map<string, ExitScope>();
function tryRenew(inst: Instance, scope: ExitScope) {
  const now = Date.now(); inst.renewedAt = inst.renewedAt.filter(t => now - t < 3600000);
  if (inst.renewedAt.length >= 3) return false;
  inst.renewedAt.push(now); recheck.set(inst.region, scope);
  const t = detached(() => setTimeout(() => { if (instances.get(inst.region) === inst) void renewSurfshark(inst.region, true).catch(() => recheck.delete(inst.region)); }, 3000)); t.unref?.(); return true;
}
let checker: ExitChecker | undefined;
export const setSurfsharkChecker = (fn?: ExitChecker) => { checker = fn; };
const scopeName = (scope: ExitScope) => scope === 'kilo' ? 'Kilo Free' : 'OpenCode Free';
async function checkExit(inst: Instance, scope: ExitScope) {
  if (inst.checking) return;
  if (!checker) { recheck.delete(inst.region); return; }
  inst.checking = scope;
  let r: ExitCheck; try { r = await checker(inst.region, scope); } catch (e: any) { r = { result: 'unknown', note: redactError(String(e?.message || e)) }; }
  if (instances.get(inst.region) !== inst) return;
  inst.checking = undefined;
  recheck.delete(inst.region);
  if (r.result === 'used-up') {
    logEvent('info', 'surfshark', `Surfshark ${inst.region}'s new address ${inst.exitIp} is used up for ${scopeName(scope)} too`, { region: inst.region, ip: inst.exitIp });
    if (scope === 'kilo') surfsharkKiloLimited(inst.region, r.until || Date.now() + 30 * 60000); else surfsharkSpent(inst.region, r.until || Date.now() + 3600000);
    return;
  }
  if (r.result === 'ok') { if (scope === 'opencode') surfsharkClean(inst.region); logEvent('info', 'surfshark', `Surfshark ${inst.region}'s new address ${inst.exitIp} works for ${scopeName(scope)}; it is back in turn`, { region: inst.region, ip: inst.exitIp }); }
  else logEvent('info', 'surfshark', `Surfshark ${inst.region}'s new address ${inst.exitIp} could not be checked with ${scopeName(scope)}${r.note ? ` (${r.note.slice(0, 160)})` : ''}; real requests decide`, { region: inst.region });
}
function onExit(inst: Instance, code: number | null) {
  if (instances.get(inst.region) !== inst || inst.stopping) return;
  inst.state = 'failed'; inst.error = inst.error || inst.output || `The WireGuard client stopped (code ${code ?? '?'})`;
  if (!surfsharkConfig().enabled || inst.restarts >= 5) return;
  const wait = Math.min(120000, 5000 * 2 ** inst.restarts); inst.restarts++;
  const t = detached(() => setTimeout(() => { if (instances.get(inst.region) === inst && !inst.stopping) void startInstance(inst.region).catch(() => {}); }, wait)); t.unref?.();
}

// --- used-up exits (as in backend/psiphon.ts) ---
export function spentUntil(ip: string): number { const until = (ip && surfsharkConfig().spent?.[ip]) || 0; return until > Date.now() ? until : 0; }
const kiloLimits = new Map<string, number>();
export const kiloUntil = (ip: string) => { const until = (ip && kiloLimits.get(ip)) || 0; return until > Date.now() ? until : 0; };
export const clearSurfsharkKiloLimit = (ip: string) => kiloLimits.delete(ip);
function pruneSpent() {
  const c = surfsharkConfig(); const now = Date.now(); const spent = Object.fromEntries(Object.entries(c.spent || {}).filter(([, until]) => until > now));
  if (Object.keys(spent).length !== Object.keys(c.spent || {}).length) save({ spent });
  for (const [ip, until] of kiloLimits) if (until <= now) kiloLimits.delete(ip);
}
export function surfsharkSpent(region: string, until: number) {
  const inst = instances.get(region); if (!inst?.exitIp) return;
  const c = surfsharkConfig(); save({ spent: { ...(c.spent || {}), [inst.exitIp]: until } });
  logEvent('info', 'surfshark', `Surfshark ${region} exit ${inst.exitIp} has used up its OpenCode Free allowance until ${new Date(until).toISOString().slice(0, 16).replace('T', ' ')} UTC`, { region, ip: inst.exitIp });
  if (c.renew) tryRenew(inst, 'opencode');
}
export function surfsharkKiloLimited(region: string, until: number) {
  const inst = instances.get(region); if (!inst?.exitIp) return;
  kiloLimits.set(inst.exitIp, until);
  logEvent('info', 'surfshark', `Surfshark ${region} exit ${inst.exitIp} reached Kilo's free limit for its address; Kilo uses the other locations until ${new Date(until).toISOString().slice(11, 16)} UTC`, { region, ip: inst.exitIp });
  if (surfsharkConfig().renew) tryRenew(inst, 'kilo');
}
export function surfsharkClean(region: string) {
  const inst = instances.get(region); const c = surfsharkConfig(); if (!inst?.exitIp || !c.spent?.[inst.exitIp]) return;
  const { [inst.exitIp]: _gone, ...spent } = c.spent; save({ spent });
}
export function surfsharkFailed(region: string) { const inst = instances.get(region); if (!inst) return; if (++inst.failures >= 3 && inst.state === 'ready') { inst.failures = 0; void renewSurfshark(region, true).catch(() => {}); } }
export function surfsharkOk(region: string) { const inst = instances.get(region); if (inst) inst.failures = 0; }

// --- picking an exit for a request ---
const blocked = (i: Instance, scope: ExitScope, skip: boolean) => {
  if (!skip || scope === 'other') return false;
  if (recheck.get(i.region) === scope) return true;
  return scope === 'opencode' ? !!spentUntil(i.exitIp) : !!kiloUntil(i.exitIp);
};
const usable = (i: Instance, scope: ExitScope, skip: boolean) => i.state === 'ready' && !blocked(i, scope, skip);
const candidates = (c: SurfsharkSettings) => (c.mode === 'single' ? [c.pinned || c.regions[0] || ''] : c.regions).map(r => instances.get(r)).filter((i): i is Instance => !!i);
export function pickSurfshark(tried: Set<string> = new Set(), scope: ExitScope = 'other') {
  const c = surfsharkConfig(); if (!c.enabled) return null;
  const live = candidates(c).filter(i => !tried.has(i.region) && usable(i, scope, c.skip));
  if (!live.length) return null; const i = c.mode === 'single' ? live[0] : live[rr++ % live.length]; return { region: i.region, port: i.port };
}
export const surfsharkSkips = () => surfsharkConfig().skip;
export const surfsharkLive = () => [...instances.values()].filter(i => i.state === 'ready').length;
export const surfsharkReady = (scope: ExitScope = 'other') => { const c = surfsharkConfig(); return c.enabled ? candidates(c).filter(i => usable(i, scope, c.skip)).length : 0; };
const nameOf = (region: string) => { const s = serverOf(region); return s ? `${s.country}${s.location && s.location !== s.country ? ' · ' + s.location : ''}` : region; };
export function surfsharkUnavailable(scope: ExitScope = 'other'): string {
  const c = surfsharkConfig();
  if (!c.enabled) return 'Surfshark is turned off. Turn it on under Routing → Surfshark.';
  if (!instances.size) return 'Surfshark is not connected. Connect it under Routing → Surfshark.';
  const all = candidates(c); const ready = all.filter(i => i.state === 'ready');
  const limit = scope === 'kilo' ? "Kilo's free limit" : 'its OpenCode Free allowance';
  if (c.mode === 'single') { const i = all[0]; const id = c.pinned || c.regions[0]; return `Surfshark ${nameOf(id)} can't take this request: ${!i || i.state !== 'ready' ? 'it is not connected' : `its exit has reached ${limit}`}. Choose another location, or let Surfshark take turns.`; }
  if (!ready.length) return `No Surfshark location is connected yet (${[...instances.values()].map(i => `${i.region}: ${i.state}`).join(', ')}).`;
  return `Every connected Surfshark exit has reached ${limit}.${c.renew ? ' Polygate is getting new addresses for them.' : ' Turn on "Get a new address when one is used up" to have Polygate try others.'}`;
}
export function surfsharkVirtualRoute(region: string): Route | undefined {
  const i = instances.get(region); return i ? { id: `${ROUTE_ID}:${region}`, name: `Surfshark ${region}`, kind: 'proxy', url: `socks5://127.0.0.1:${i.port}`, enabled: true, models: [] } : undefined;
}
export const surfsharkRegionsReady = () => [...instances.values()].filter(i => i.state === 'ready').map(i => ({ region: i.region, exitIp: i.exitIp }));

// --- the managed route (as in backend/psiphon.ts) ---
function fallbackRoute(): string {
  const on = (id?: string) => !!id && id !== ROUTE_ID && settings.routes.some(r => r.id === id && r.enabled);
  return on(settings.previousRouteId) ? settings.previousRouteId! : on('direct') ? 'direct' : settings.routes.find(r => r.enabled && r.id !== ROUTE_ID)?.id || settings.routeId;
}
function ensureRoute(enabled: boolean, explicitStop = false) {
  let route = settings.routes.find(r => r.id === ROUTE_ID);
  if (!route) { if (!enabled) return; route = { id: ROUTE_ID, name: 'Surfshark', kind: 'proxy', url: 'surfshark://local', enabled: true, models: [], managed: true } satisfies Route; settings.routes.push(route); persist(); return; }
  if (route.enabled !== enabled) { route.enabled = enabled; if (enabled) { route.cooldownUntil = 0; route.failures = 0; route.opened = 0; } }
  // Only an explicit stop hands traffic back. An idle restored selection stays selected but unavailable until it starts.
  if (enabled && settings.managedChoice === ROUTE_ID) { settings.routeId = ROUTE_ID; settings.managedChoice = undefined; }
  if (!enabled && explicitStop && settings.routeId === ROUTE_ID) { const to = fallbackRoute(); if (to !== ROUTE_ID) { settings.managedChoice = ROUTE_ID; settings.routeId = to; logEvent('info', 'surfshark', `Surfshark stopped; requests now use ${settings.routes.find(r => r.id === to)?.name || to}`, { route: to }); } }
  persist();
}
export function reconcileSurfshark() { ensureRoute(instances.size > 0 && surfsharkConfig().enabled); }

// --- actions ---
const guard = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  if (busy) throw new GatewayError(`Surfshark is busy (${busy}). Try again in a moment.`, 409, 'surfshark_busy');
  busy = name; lastError = '';
  try { return await fn(); } catch (e: any) { if (isCancelled()) throw cancelledError(); lastError = redactError(String(e.message || e)); throw e instanceof GatewayError ? e : new GatewayError(lastError, 502, 'surfshark_error'); } finally { busy = ''; }
};
export function surfsharkConnect() {
  return guard('connecting', async () => {
    const c = surfsharkConfig();
    if (!c.enabled) throw new GatewayError('Surfshark is turned off. Turn it on first.', 400);
    if (!findWireproxy()) throw new GatewayError(wireproxyMissing(), 503, 'surfshark_not_installed');
    if (!c.privateKey) throw new GatewayError('Save your Surfshark key pair first.', 400, 'surfshark_key');
    if (!servers().length) throw new GatewayError('Press Update servers first, to load Surfshark\'s locations.', 400);
    if (!c.regions.length) throw new GatewayError('Choose at least one location.', 400);
    const missing = c.regions.filter(r => !serverOf(r)); if (missing.length) throw new GatewayError(`Not in Surfshark's server list any more: ${missing.join(', ')}. Press Update servers, then choose again.`, 400);
    for (const [region, inst] of [...instances]) if (!c.regions.includes(region)) { inst.stopping = true; stopProcess(inst.proc); instances.delete(region); dropConf(region); }
    for (const region of c.regions) { const i = instances.get(region); if (!i || i.state === 'failed') { if (i) i.restarts = 0; await startInstance(region); } }
    ensureRoute(true); startMonitor();
    return surfsharkStatus();
  });
}
export function surfsharkDisconnect() { return guard('disconnecting', async () => { await stopAll(); ensureRoute(false, true); return surfsharkStatus(); }); }
// Reconnects one location: its hostname is looked up again, which can land on another server, so another exit address.
export async function renewSurfshark(region: string, auto = false) {
  const c = surfsharkConfig(); if (!c.regions.includes(region)) throw new GatewayError(`${region} is not one of the chosen locations`, 400);
  if (!auto && busy) throw new GatewayError(`Surfshark is busy (${busy}). Try again in a moment.`, 409, 'surfshark_busy');
  if (!instances.has(region)) throw new GatewayError(`Surfshark ${region} is not running. Connect Surfshark first.`, 409, 'surfshark_not_running');
  const before = instances.get(region)?.exitIp || '';
  await startInstance(region, true);
  logEvent('info', 'surfshark', `Surfshark ${region} is reconnecting for a new address${before ? ` (was ${before})` : ''}`, { region, auto });
  return surfsharkStatus();
}
export async function setSurfsharkSettings(patch: Partial<SurfsharkSettings>) {
  const c = surfsharkConfig(); const next: SurfsharkSettings = { ...c };
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.autoStart !== undefined) next.autoStart = !!patch.autoStart;
  if (patch.skip !== undefined) next.skip = !!patch.skip;
  if (patch.renew !== undefined) { next.renew = !!patch.renew; if (!next.renew) recheck.clear(); }
  if (patch.mode !== undefined) { if (!['spread', 'single'].includes(String(patch.mode))) throw new GatewayError('Mode must be spread or single', 400); next.mode = patch.mode; }
  if (patch.regions !== undefined) {
    if (!Array.isArray(patch.regions)) throw new GatewayError('Locations must be a list', 400);
    const list = [...new Set(patch.regions.map(r => String(r).toLowerCase()))];
    const bad = list.find(r => !ID.test(r)); if (bad) throw new GatewayError(`"${bad}" is not a Surfshark location`, 400);
    next.regions = list;
  }
  if (patch.pinned !== undefined) { const p = String(patch.pinned || '').toLowerCase(); if (p && !ID.test(p)) throw new GatewayError(`"${p}" is not a Surfshark location`, 400); next.pinned = p; }
  if (next.mode === 'single' && !next.regions.includes(next.pinned)) next.pinned = next.regions[0] || '';
  settings.surfshark = next; persist();
  if (!next.enabled) await stopAll();
  else if (instances.size) { for (const [region, inst] of [...instances]) if (!next.regions.includes(region)) { inst.stopping = true; stopProcess(inst.proc); instances.delete(region); dropConf(region); } for (const r of next.regions) if (!instances.has(r) && serverOf(r)) await startInstance(r).catch(() => {}); }
  ensureRoute(instances.size > 0 && surfsharkConfig().enabled, patch.enabled === false || patch.regions?.length === 0);
  return surfsharkStatus();
}
async function stopAll() {
  epoch++; const live = [...instances.values()]; instances.clear(); recheck.clear();
  for (const i of live) { i.stopping = true; stopProcess(i.proc); }
  await Promise.all(live.map(i => i.proc ? exitOf(i.proc) : undefined));
  for (const i of live) dropConf(i.region);
}
function startMonitor() {
  if (monitor) return;
  monitor = setInterval(() => {
    pruneSpent();
    for (const i of instances.values()) if (i.state !== 'failed' && i.handshake && !i.exitIp) void learnExit(i, false);
    const state = surfsharkLive() ? 'up' : instances.size ? 'down' : 'off';
    if (state !== lastNotified && lastNotified) { if (state === 'up') notify('Surfshark connected', `${surfsharkLive()} location${surfsharkLive() === 1 ? '' : 's'} connected.`, 'success', 'surfshark-up'); else if (state === 'down') notify('Surfshark disconnected', 'No Surfshark location is connected. Polygate keeps trying.', 'warning', 'surfshark-down'); }
    lastNotified = state;
  }, 30000);
  monitor.unref?.();
}
// What the Surfshark page shows. The private key is never part of it: only whether one is saved, and the public key.
export function surfsharkStatus() {
  const c = surfsharkConfig(); const bin = findWireproxy(); const now = Date.now(); const route = settings.routes.find(r => r.id === ROUTE_ID);
  return {
    installed: !!bin, problem: bin ? '' : wireproxyMissing(), platform: `${process.platform}-${process.arch}`,
    busy, lastError, running: instances.size > 0, live: surfsharkLive(),
    keys: { saved: !!c.privateKey, publicKey: c.publicKey || '' },
    config: { enabled: c.enabled, autoStart: c.autoStart, regions: c.regions, mode: c.mode, pinned: c.pinned, skip: c.skip, renew: c.renew },
    servers: servers().map(s => ({ id: s.id, country: s.country, countryCode: s.countryCode, location: s.location, load: s.load })), updatedAt: c.updatedAt || 0,
    regions: c.regions.map(region => { const i = instances.get(region); const s = serverOf(region); const until = i?.exitIp ? spentUntil(i.exitIp) : 0;
      return { region, country: s?.country || region, location: s?.location || '', state: i ? i.state : 'stopped', port: i?.port || 0, exitIp: i?.exitIp || '', since: i?.readyAt || 0, usedUpUntil: until, kiloUntil: i?.exitIp ? kiloUntil(i.exitIp) : 0, checking: i && recheck.get(region) ? recheck.get(region) : '', error: i?.state === 'failed' ? i.error : '' }; }),
    spent: Object.entries(c.spent || {}).filter(([, until]) => until > now).length,
    route: { exists: !!route, enabled: !!route?.enabled, inUse: settings.routeId === ROUTE_ID },
  };
}
export async function startSurfshark() {
  const c = surfsharkConfig(); pruneSpent();
  reconcileSurfshark();
  const wanted = c.enabled && (c.autoStart || settings.routeId === ROUTE_ID);
  if (wanted) await surfsharkConnect().catch(e => console.warn('[surfshark] start:', redactError(String(e.message || e))));
}
export async function stopSurfshark() { if (monitor) clearInterval(monitor); monitor = undefined; await stopAll(); }
// Surfshark is one exit group: the route machinery (backend/transport.ts) reaches it through these.
registerExitGroup({ id: ROUTE_ID, label: 'Surfshark', unit: 'location', source: 'surfshark', pick: pickSurfshark, ready: surfsharkReady, live: surfsharkLive, unavailable: surfsharkUnavailable,
  virtualRoute: surfsharkVirtualRoute, regionsReady: surfsharkRegionsReady, spent: surfsharkSpent, kiloLimited: surfsharkKiloLimited, clean: surfsharkClean,
  failed: surfsharkFailed, ok: surfsharkOk, skips: surfsharkSkips, setChecker: setSurfsharkChecker });
export const __instances = instances;
export const __parseServers = parseServers;
export const __configText = configText;
export const __connected = (region: string) => { const i = instances.get(region); if (i) i.handshake = true; return i ? learnExit(i, true) : Promise.resolve(); };

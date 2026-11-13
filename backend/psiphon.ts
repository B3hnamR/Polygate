// Psiphon as one route. Polygate starts Psiphon's own client (psiphon-tunnel-core, resources/psiphon) once per chosen region, each with its
// own data folder and local SOCKS port, and the managed route "psiphon" picks one of them per request: taking turns, or staying on one region.
// OpenCode's free allowance belongs to an exit address, so a used-up exit is remembered by its IP and skipped; a region can also reconnect,
// which usually lands on another exit of the same region.
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants as fsConstants, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { settings, persist, stateDir, redactError } from './state';
import { GatewayError } from './queue';
import { freePort, traceVia } from './warp';
import { logEvent } from './logbook';
import { notify } from './notifications';
import type { PsiphonSettings, Route } from './types';

const isWin = process.platform === 'win32';
const appDir = process.env.POLYGATE_APP_DIR || process.cwd();
const dataDir = path.join(stateDir, 'psiphon');
const BASE_PORT = 47100;
export const ROUTE_ID = 'psiphon';
const REGION = /^[A-Z]{2}$/;
// Regions Psiphon has offered; the real list comes from the client (AvailableEgressRegions) and is saved with the settings.
const KNOWN = ['BE', 'CA', 'CH', 'DE', 'DK', 'ES', 'FR', 'GB', 'IE', 'IN', 'IT', 'JP', 'NL', 'NO', 'PL', 'SE', 'SG', 'US'];
const defaults: PsiphonSettings = { enabled: true, autoStart: false, regions: [], mode: 'spread', pinned: '', skip: true, renew: true };
export const psiphonConfig = (): PsiphonSettings => {
  const c: any = { ...defaults, ...settings.psiphon };
  c.regions = Array.isArray(c.regions) ? [...new Set(c.regions.map((r: unknown) => String(r).toUpperCase()).filter((r: string) => REGION.test(r)))] : [];
  c.mode = c.mode === 'single' ? 'single' : 'spread';
  c.pinned = REGION.test(String(c.pinned || '')) ? String(c.pinned) : '';
  return c as PsiphonSettings;
};

// --- the bundled client and its settings ---
const coreName = () => isWin ? 'psiphon-tunnel-core-windows-i686.exe' : process.platform === 'linux' && process.arch === 'x64' ? 'psiphon-tunnel-core-linux-amd64' : '';
const folders = () => [process.env.POLYGATE_PSIPHON_DIR || '', path.join(appDir, 'psiphon'), path.join(appDir, 'resources', 'psiphon'), path.join(path.dirname(process.execPath), 'psiphon')].filter(Boolean);
function runnable(file: string) { try { if (!statSync(file).isFile()) return false; if (!isWin) accessSync(file, fsConstants.X_OK); return true; } catch { return false; } }
export function findPsiphon(): { core: string; folder: string } | null {
  const name = coreName(); if (!name) return null;
  for (const folder of folders()) { const core = path.join(folder, name); if (runnable(core) && existsSync(path.join(folder, 'psiphon.json')) && existsSync(path.join(folder, 'server-list.dat'))) return { core, folder }; }
  return null;
}
export function psiphonMissing(): string {
  if (!coreName()) return `Psiphon has no official client for this platform (${process.platform} ${process.arch}). It runs on Windows and on Linux x86-64.`;
  const present = folders().map(f => path.join(f, coreName())).find(f => { try { return statSync(f).isFile() && !runnable(f); } catch { return false; } });
  return present ? `The Psiphon client at ${present} cannot be run (it has no execute permission). Fix it with: chmod +x ${present}` : 'The Psiphon client is not in this build. It belongs in the app\'s psiphon folder.';
}

// --- instances ---
type State = 'starting' | 'ready' | 'reconnecting' | 'failed';
type Instance = { region: string; port: number; proc?: ChildProcess; state: State; exitIp: string; location: string; startedAt: number; readyAt: number;
  failures: number; restarts: number; error: string; renewedAt: number[]; stopping?: boolean; output: string; checking?: PsiphonScope };
// Which limits a request is subject to: OpenCode Free's daily allowance and Kilo's per-address limit belong to different services, so an exit
// used up for one is still good for the other, and for every other provider.
export type PsiphonScope = 'opencode' | 'kilo' | 'other';
// Tests reach only local addresses, so they say which service a request stands for.
export const __psiphonTest = { scope: '' as PsiphonScope | '' };
export const scopeOfUrl = (url: string): PsiphonScope => { if (__psiphonTest.scope) return __psiphonTest.scope; try { const h = new URL(url).hostname; return h === 'opencode.ai' || h.endsWith('.opencode.ai') ? 'opencode' : h === 'kilo.ai' || h.endsWith('.kilo.ai') ? 'kilo' : 'other'; } catch { return 'other'; } };
export const scopeOfKind = (kind?: string): PsiphonScope => kind === 'free' ? 'opencode' : kind === 'kilo' ? 'kilo' : 'other';
const instances = new Map<string, Instance>();
let rr = 0, monitor: ReturnType<typeof setInterval> | undefined, busy = '', lastError = '', updating = false, lastNotified = '';

const regionDir = (region: string) => path.join(dataDir, region.toLowerCase());
const nodesDir = path.join(dataDir, 'nodes');
const storeOf = (dir: string) => path.join(dir, 'ca.psiphon.PsiphonTunnel.tunnel-core');
const used = () => new Set([...instances.values()].map(i => i.port));

function saveRegions(regions: unknown) {
  if (!Array.isArray(regions)) return;
  const list = [...new Set(regions.map(r => String(r).toUpperCase()).filter(r => REGION.test(r)))].sort();
  if (!list.length) return;
  const c = psiphonConfig(); if (JSON.stringify(c.available || []) === JSON.stringify(list)) return;
  settings.psiphon = { ...c, available: list }; persist();
}
// Starts one client. `region` empty: no region chosen (used to update the node list). Resolves when it is listening or has failed to start.
async function launch(region: string, dir: string, port: number, onNotice: (n: any) => void): Promise<ChildProcess> {
  const found = findPsiphon(); if (!found) throw new GatewayError(psiphonMissing(), 503, 'psiphon_not_installed');
  mkdirSync(dir, { recursive: true });
  const base = JSON.parse(readFileSync(path.join(found.folder, 'psiphon.json'), 'utf8'));
  // Only what Psiphon needs: no remote server lists (the handshake brings new servers), no upgrade downloads, no feedback uploads, no HTTP proxy.
  const config = { ...base, DataRootDirectory: dir, LocalSocksProxyPort: port, DisableLocalHTTPProxy: true, DisableRemoteServerListFetcher: true,
    EnableUpgradeDownload: false, EnableFeedbackUpload: false, EstablishTunnelTimeoutSeconds: 0, ...(region ? { EgressRegion: region } : {}) };
  const file = path.join(dir, 'polygate.config'); writeFileSync(file, JSON.stringify(config));
  const proc = spawn(found.core, ['-config', file, '-serverList', path.join(found.folder, 'server-list.dat')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  const data = (d: Buffer) => { buf += d; if (buf.length > 1e6) buf = buf.slice(-2e5); let n; while ((n = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, n); buf = buf.slice(n + 1); try { onNotice(JSON.parse(line)); } catch { /* not a notice */ } } };
  proc.stdout!.on('data', data); proc.stderr!.on('data', data);
  await new Promise<void>((resolve, reject) => { proc.once('spawn', () => resolve()); proc.once('error', e => reject(new GatewayError(`The Psiphon client could not start: ${e.message}`, 502, 'psiphon_error'))); });
  return proc;
}
function stopProcess(proc?: ChildProcess) { try { proc?.kill(); } catch { /* already gone */ } }
const exitOf = (proc: ChildProcess) => new Promise<void>(r => { if (proc.exitCode !== null || proc.signalCode) return r(); proc.once('exit', () => r()); setTimeout(r, 5000); });

// One start per region at a time (a manual and an automatic new address can coincide), and none survives a stop: `epoch` moves on every
// stopAll, and a start that began before it gives up instead of bringing a region back after Disconnect.
let epoch = 0; const starting = new Map<string, Promise<Instance>>();
function startInstance(region: string, fresh = false): Promise<Instance> {
  const running = starting.get(region); if (running) return running;
  const job = startOnce(region, fresh, epoch).finally(() => { if (starting.get(region) === job) starting.delete(region); });
  starting.set(region, job); return job;
}
const stopped = () => new GatewayError('Psiphon was stopped', 409, 'psiphon_stopped');
async function startOnce(region: string, fresh: boolean, at: number): Promise<Instance> {
  const old = instances.get(region);
  if (old) { old.stopping = true; stopProcess(old.proc); if (old.proc) await exitOf(old.proc); }
  if (at !== epoch) throw stopped();
  const dir = regionDir(region);
  // A fresh start forgets the region's saved connection, so it can land on another server. The node list from the last update is copied in.
  if (fresh) rmSync(storeOf(dir), { recursive: true, force: true });
  if (!updating && existsSync(storeOf(nodesDir)) && !existsSync(storeOf(dir))) { try { cpSync(storeOf(nodesDir), storeOf(dir), { recursive: true }); } catch { /* starts from the bundled list */ } }
  const avoid = used(); if (old) avoid.delete(old.port);
  const port = old?.port && !fresh ? old.port : await freePort(BASE_PORT, avoid);
  if (at !== epoch) throw stopped();
  const inst: Instance = { region, port, state: 'starting', exitIp: '', location: '', startedAt: Date.now(), readyAt: 0, failures: 0, restarts: old?.restarts || 0, error: '', renewedAt: old?.renewedAt || [], output: '' };
  instances.set(region, inst);
  try {
    inst.proc = await launch(region, dir, port, n => onNotice(inst, n));
    inst.proc.once('exit', code => onExit(inst, code));
    if (at !== epoch || instances.get(region) !== inst) { inst.stopping = true; stopProcess(inst.proc); if (instances.get(region) === inst) instances.delete(region); throw stopped(); }
  } catch (e: any) { inst.state = 'failed'; inst.error = redactError(String(e.message || e)); throw e; }
  return inst;
}
function onNotice(inst: Instance, n: any) {
  if (instances.get(inst.region) !== inst) return;
  const t = n?.noticeType, d = n?.data || {};
  if (t === 'AvailableEgressRegions') saveRegions(d.regions);
  else if (t === 'Tunnels') {
    if (d.count > 0) { const first = !inst.readyAt; inst.state = 'ready'; inst.readyAt = Date.now(); inst.error = ''; inst.failures = 0; void learnExit(inst, first); }
    else if (inst.state === 'ready') inst.state = 'reconnecting';
  }
  else if (t === 'Error' || t === 'Alert') inst.output = String(d.message || '').slice(0, 300);
}
// The exit address is what OpenCode sees, and what its allowance belongs to. A reconnect can change it.
async function learnExit(inst: Instance, first: boolean) {
  const egress = await traceVia('127.0.0.1', inst.port, 20000);
  if (instances.get(inst.region) !== inst || !egress?.ip) return;
  const changed = egress.ip !== inst.exitIp; inst.exitIp = egress.ip; inst.location = egress.loc || '';
  const spent = spentUntil(egress.ip);
  if (first || changed) logEvent('info', 'psiphon', `Psiphon ${inst.region} is connected; exit ${egress.ip}${spent ? ' (used up today)' : ''}`, { region: inst.region, ip: egress.ip });
  // A region that got a new address because its exit was used up for a provider is checked with that provider before it carries that
  // provider's requests again. An address already known to be used up for it (the reconnect landed on the same exit) gets another one.
  const scope = recheck.get(inst.region);
  if (scope) {
    if (!psiphonConfig().renew) { recheck.delete(inst.region); return; }
    if (scope === 'opencode' ? spent : kiloUntil(egress.ip)) { if (!tryRenew(inst, scope)) recheck.delete(inst.region); return; }
    void checkExit(inst, scope);
  }
}
// region → the provider the region's next address is checked with. While it is set, that provider's requests skip the region.
const recheck = new Map<string, PsiphonScope>();
// Reconnects a region for a new address, at most three times a hour per region, so a region with only used-up exits does not loop.
function tryRenew(inst: Instance, scope: PsiphonScope) {
  const now = Date.now(); inst.renewedAt = inst.renewedAt.filter(t => now - t < 3600000);
  if (inst.renewedAt.length >= 3) return false;
  inst.renewedAt.push(now); recheck.set(inst.region, scope);
  const t = setTimeout(() => { if (instances.get(inst.region) === inst) void renewRegion(inst.region, true).catch(() => recheck.delete(inst.region)); }, 3000); t.unref?.(); return true;
}
// The check is a request, so backend/transport.ts sends it and registers itself here: one small chat request to that provider through
// exactly this region's exit. 'unknown' (the check could not be sent or read) lets real requests decide, as before the option existed.
export type ExitCheck = { result: 'ok' | 'used-up' | 'unknown'; until?: number; note?: string };
let checker: ((region: string, scope: PsiphonScope) => Promise<ExitCheck>) | undefined;
export const setPsiphonChecker = (fn?: (region: string, scope: PsiphonScope) => Promise<ExitCheck>) => { checker = fn; };
const scopeName = (scope: PsiphonScope) => scope === 'kilo' ? 'Kilo Free' : 'OpenCode Free';
async function checkExit(inst: Instance, scope: PsiphonScope) {
  if (inst.checking) return;
  if (!checker) { recheck.delete(inst.region); return; }
  inst.checking = scope;
  let r: ExitCheck; try { r = await checker(inst.region, scope); } catch (e: any) { r = { result: 'unknown', note: redactError(String(e?.message || e)) }; }
  if (instances.get(inst.region) !== inst) return;
  inst.checking = undefined;
  if (r.result === 'used-up') {
    logEvent('info', 'psiphon', `Psiphon ${inst.region}'s new address ${inst.exitIp} is used up for ${scopeName(scope)} too`, { region: inst.region, ip: inst.exitIp });
    // Marking it gets the next address (the same limit of three a hour); when that limit is reached the region stays skipped for this provider.
    recheck.delete(inst.region);
    if (scope === 'kilo') psiphonKiloLimited(inst.region, r.until || Date.now() + 30 * 60000); else psiphonSpent(inst.region, r.until || Date.now() + 3600000);
    return;
  }
  recheck.delete(inst.region);
  if (r.result === 'ok') { if (scope === 'opencode') psiphonClean(inst.region); logEvent('info', 'psiphon', `Psiphon ${inst.region}'s new address ${inst.exitIp} works for ${scopeName(scope)}; it is back in turn`, { region: inst.region, ip: inst.exitIp }); }
  else logEvent('info', 'psiphon', `Psiphon ${inst.region}'s new address ${inst.exitIp} could not be checked with ${scopeName(scope)}${r.note ? ` (${r.note.slice(0, 160)})` : ''}; real requests decide`, { region: inst.region });
}
function onExit(inst: Instance, code: number | null) {
  if (instances.get(inst.region) !== inst || inst.stopping) return;
  inst.state = 'failed'; inst.error = inst.output || `The Psiphon client stopped (code ${code ?? '?'})`;
  // Restarted with a growing wait, so a client that keeps failing does not spin. Five failures in a row leave it stopped until asked.
  if (!psiphonConfig().enabled || inst.restarts >= 5) return;
  const wait = Math.min(120000, 5000 * 2 ** inst.restarts); inst.restarts++;
  const t = setTimeout(() => { if (instances.get(inst.region) === inst && !inst.stopping) void startInstance(inst.region).catch(() => {}); }, wait); t.unref?.();
}

// --- used-up exits ---
// OpenCode's used-up marks are saved by exit address (they last until OpenCode's reset); Kilo's per-address limit is kept in memory for half an hour.
export function spentUntil(ip: string): number { const until = (ip && psiphonConfig().spent?.[ip]) || 0; return until > Date.now() ? until : 0; }
const kiloLimits = new Map<string, number>();
export const kiloUntil = (ip: string) => { const until = (ip && kiloLimits.get(ip)) || 0; return until > Date.now() ? until : 0; };
function pruneSpent() {
  const c = psiphonConfig(); const now = Date.now(); const spent = Object.fromEntries(Object.entries(c.spent || {}).filter(([, until]) => until > now));
  if (Object.keys(spent).length !== Object.keys(c.spent || {}).length) { settings.psiphon = { ...c, spent }; persist(); }
  for (const [ip, until] of kiloLimits) if (until <= now) kiloLimits.delete(ip);
}
// Called when OpenCode confirmed that this region's exit has used up its allowance (backend/transport.ts).
export function psiphonSpent(region: string, until: number) {
  const inst = instances.get(region); if (!inst?.exitIp) return;
  const c = psiphonConfig(); settings.psiphon = { ...c, spent: { ...(c.spent || {}), [inst.exitIp]: until } }; persist();
  logEvent('info', 'psiphon', `Psiphon ${region} exit ${inst.exitIp} has used up its OpenCode Free allowance until ${new Date(until).toISOString().slice(0, 16).replace('T', ' ')} UTC`, { region, ip: inst.exitIp });
  // A new connection usually gets another exit in the same region, which is checked with OpenCode before it carries OpenCode requests again.
  if (c.renew) tryRenew(inst, 'opencode');
}
// Kilo's free tier stopped answering from this region's exit: only Kilo requests skip it, for half an hour.
export function psiphonKiloLimited(region: string, until: number) {
  const inst = instances.get(region); if (!inst?.exitIp) return;
  kiloLimits.set(inst.exitIp, until);
  logEvent('info', 'psiphon', `Psiphon ${region} exit ${inst.exitIp} reached Kilo's free limit for its address; Kilo uses the other regions until ${new Date(until).toISOString().slice(11, 16)} UTC`, { region, ip: inst.exitIp });
  // The same as for OpenCode: a new address, checked with Kilo before it carries Kilo requests again.
  if (psiphonConfig().renew) tryRenew(inst, 'kilo');
}
// A check through this region was accepted: the saved used-up mark of its address was wrong or has expired early.
export function psiphonClean(region: string) {
  const inst = instances.get(region); const c = psiphonConfig(); if (!inst?.exitIp || !c.spent?.[inst.exitIp]) return;
  const { [inst.exitIp]: _gone, ...spent } = c.spent; settings.psiphon = { ...c, spent }; persist();
}
export function psiphonFailed(region: string) { const inst = instances.get(region); if (!inst) return; if (++inst.failures >= 3 && inst.state === 'ready') { inst.failures = 0; void renewRegion(region, true).catch(() => {}); } }
export function psiphonOk(region: string) { const inst = instances.get(region); if (inst) inst.failures = 0; }

// --- picking an exit for a request ---
// skip off: a used-up exit stays in turn, and its refusal goes back to the client.
// A region waiting for its new address to be checked with a provider is skipped for that provider until the check is done.
const blocked = (i: Instance, scope: PsiphonScope, skip: boolean) => {
  if (!skip || scope === 'other') return false;
  if (recheck.get(i.region) === scope) return true;
  return scope === 'opencode' ? !!spentUntil(i.exitIp) : !!kiloUntil(i.exitIp);
};
const usable = (i: Instance, scope: PsiphonScope, skip: boolean) => i.state === 'ready' && !blocked(i, scope, skip);
// The regions a request can be sent to, in the order of the setting: the pinned region alone, or every chosen region.
const candidates = (c: PsiphonSettings) => (c.mode === 'single' ? [c.pinned || c.regions[0] || ''] : c.regions).map(r => instances.get(r)).filter((i): i is Instance => !!i);
export type PsiphonPick = { region: string; port: number };
// tried: regions this request already went through. Single mode never leaves the pinned region.
export function pickPsiphon(tried: Set<string> = new Set(), scope: PsiphonScope = 'other'): PsiphonPick | null {
  const c = psiphonConfig(); if (!c.enabled) return null;
  const live = candidates(c).filter(i => !tried.has(i.region) && usable(i, scope, c.skip));
  if (!live.length) return null; const i = c.mode === 'single' ? live[0] : live[rr++ % live.length]; return { region: i.region, port: i.port };
}
export const psiphonSkips = () => psiphonConfig().skip;
export const psiphonLive = () => [...instances.values()].filter(i => i.state === 'ready').length;
// How many regions could take a request of this kind now: connected, and (when skipping) not used up for it. 0 keeps the route out of
// the spread and the backup exits, so requests are not sent into a route that can only refuse them.
export const psiphonReady = (scope: PsiphonScope = 'other') => { const c = psiphonConfig(); return c.enabled ? candidates(c).filter(i => usable(i, scope, c.skip)).length : 0; };
// Why nothing could be picked, in words, for the request's error.
export function psiphonUnavailable(scope: PsiphonScope = 'other'): string {
  const c = psiphonConfig();
  if (!c.enabled) return 'Psiphon is turned off. Turn it on on the Routing page.';
  if (!instances.size) return 'Psiphon is not connected. Connect it on the Routing page.';
  const all = candidates(c); const ready = all.filter(i => i.state === 'ready');
  const limit = scope === 'kilo' ? "Kilo's free limit" : 'its OpenCode Free allowance';
  if (c.mode === 'single') { const i = all[0]; return `Psiphon ${c.pinned || c.regions[0]} can't take this request: ${!i || i.state !== 'ready' ? 'it is not connected' : `its exit has reached ${limit}`}. Choose another region, or let Psiphon take turns.`; }
  if (!ready.length) return `No Psiphon region is connected yet (${[...instances.values()].map(i => `${i.region}: ${i.state}`).join(', ')}).`;
  return `Every connected Psiphon exit has reached ${limit}.${c.renew ? ' Polygate is getting new addresses for them.' : ' Turn on "Get a new address when one is used up" to have Polygate try others.'}`;
}
// A route object for one region, so a check request (is this exit really used up?) can go through exactly that exit.
export function psiphonVirtualRoute(region: string): Route | undefined {
  const i = instances.get(region); return i ? { id: `${ROUTE_ID}:${region}`, name: `Psiphon ${region}`, kind: 'proxy', url: `socks5://127.0.0.1:${i.port}`, enabled: true, models: [] } : undefined;
}
export const psiphonRegionsReady = () => [...instances.values()].filter(i => i.state === 'ready').map(i => ({ region: i.region, exitIp: i.exitIp }));

// --- the managed route ---
// The route is on exactly while Psiphon runs. When it goes off while it is the route in use, requests go back to the route used before it
// (or Direct, or the first route that is on), never to a route that is switched off.
function fallbackRoute(): string {
  const on = (id?: string) => !!id && id !== ROUTE_ID && settings.routes.some(r => r.id === id && r.enabled);
  return on(settings.previousRouteId) ? settings.previousRouteId! : on('direct') ? 'direct' : settings.routes.find(r => r.enabled && r.id !== ROUTE_ID)?.id || settings.routeId;
}
function ensureRoute(enabled: boolean) {
  let route = settings.routes.find(r => r.id === ROUTE_ID);
  if (!route) { if (!enabled) return; route = { id: ROUTE_ID, name: 'Psiphon', kind: 'proxy', url: 'psiphon://local', enabled: true, models: [], managed: true } satisfies Route; settings.routes.push(route); persist(); return; }
  if (route.enabled !== enabled) { route.enabled = enabled; if (enabled) { route.cooldownUntil = 0; route.failures = 0; route.opened = 0; } }
  if (!enabled && settings.routeId === ROUTE_ID) { const to = fallbackRoute(); if (to !== ROUTE_ID) { settings.routeId = to; logEvent('info', 'psiphon', `Psiphon stopped; requests now use ${settings.routes.find(r => r.id === to)?.name || to}`, { route: to }); } }
  persist();
}
// Makes the route match what is running: on while a client runs, off when none does (after a restart, or a restored backup).
export function reconcilePsiphon() { ensureRoute(instances.size > 0 && psiphonConfig().enabled); }

// --- actions ---
const guard = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  if (busy) throw new GatewayError(`Psiphon is busy (${busy}). Try again in a moment.`, 409, 'psiphon_busy');
  busy = name; lastError = '';
  try { return await fn(); } catch (e: any) { lastError = redactError(String(e.message || e)); throw e instanceof GatewayError ? e : new GatewayError(lastError, 502, 'psiphon_error'); } finally { busy = ''; }
};
// Starts the chosen regions and stops the others. Resolves once every region is running (not yet connected; that follows within seconds).
export function psiphonConnect() {
  return guard('connecting', async () => {
    const c = psiphonConfig();
    if (!c.enabled) throw new GatewayError('Psiphon is turned off. Turn it on first.', 400);
    if (!findPsiphon()) throw new GatewayError(psiphonMissing(), 503, 'psiphon_not_installed');
    if (!c.regions.length) throw new GatewayError('Choose at least one region.', 400);
    for (const [region, inst] of [...instances]) if (!c.regions.includes(region)) { inst.stopping = true; stopProcess(inst.proc); instances.delete(region); }
    for (const region of c.regions) { const i = instances.get(region); if (!i || i.state === 'failed') { if (i) i.restarts = 0; await startInstance(region); } }
    ensureRoute(true); startMonitor();
    return psiphonStatus();
  });
}
export function psiphonDisconnect() {
  return guard('disconnecting', async () => { await stopAll(); ensureRoute(false); return psiphonStatus(); });
}
// Reconnects one region on a fresh connection: usually another server of the same region, so another exit address.
export async function renewRegion(region: string, auto = false) {
  const c = psiphonConfig(); if (!c.regions.includes(region)) throw new GatewayError(`${region} is not one of the chosen regions`, 400);
  if (!auto && busy) throw new GatewayError(`Psiphon is busy (${busy}). Try again in a moment.`, 409, 'psiphon_busy');
  // Only a running region gets a new address; a disconnected Psiphon is not started by it.
  if (!instances.has(region)) throw new GatewayError(`Psiphon ${region} is not running. Connect Psiphon first.`, 409, 'psiphon_not_running');
  const before = instances.get(region)?.exitIp || '';
  await startInstance(region, true);
  logEvent('info', 'psiphon', `Psiphon ${region} is reconnecting for a new address${before ? ` (was ${before})` : ''}`, { region, auto });
  return psiphonStatus();
}
// Runs one client with no region for up to a minute and a half: its handshake brings Psiphon's current servers and regions. The node list it
// saves is what each region starts from next time it reconnects.
export function psiphonUpdateNodes() {
  return guard('updating nodes', async () => {
    if (!findPsiphon()) throw new GatewayError(psiphonMissing(), 503, 'psiphon_not_installed');
    updating = true; let proc: ChildProcess | undefined; let regions: string[] = []; let connected = false;
    try {
      rmSync(storeOf(nodesDir), { recursive: true, force: true });
      const port = await freePort(BASE_PORT + 90, used());
      const done = new Promise<void>(resolve => {
        const t = setTimeout(resolve, 90000); t.unref?.();
        void launch('', nodesDir, port, n => {
          if (n?.noticeType === 'AvailableEgressRegions' && Array.isArray(n.data?.regions)) regions = n.data.regions;
          if (n?.noticeType === 'Tunnels' && n.data?.count > 0 && !connected) { connected = true; const w = setTimeout(() => { clearTimeout(t); resolve(); }, 15000); w.unref?.(); }
        }).then(p => { proc = p; p.once('exit', () => { clearTimeout(t); resolve(); }); }).catch(() => { clearTimeout(t); resolve(); });
      });
      await done;
    } finally { stopProcess(proc); if (proc) await exitOf(proc); updating = false; }
    if (!connected && !regions.length) throw new GatewayError('Psiphon could not connect to update its servers. Check this computer\'s connection and try again.', 502, 'psiphon_error');
    saveRegions(regions); const c = psiphonConfig(); settings.psiphon = { ...c, updatedAt: Date.now() }; persist();
    // Regions not running pick up the new list on their next start; running ones keep their connection.
    for (const r of c.regions) if (!instances.has(r)) { try { rmSync(storeOf(regionDir(r)), { recursive: true, force: true }); } catch { /* in use */ } }
    logEvent('info', 'psiphon', `Psiphon servers updated: ${(c.available || []).length} regions`, { connected });
    return psiphonStatus();
  });
}
export async function setPsiphonSettings(patch: Partial<PsiphonSettings>) {
  const c = psiphonConfig(); const next: PsiphonSettings = { ...c };
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.autoStart !== undefined) next.autoStart = !!patch.autoStart;
  if (patch.skip !== undefined) next.skip = !!patch.skip;
  // Turned off, no region waits for a check any more: it goes back in turn and real requests decide.
  if (patch.renew !== undefined) { next.renew = !!patch.renew; if (!next.renew) recheck.clear(); }
  if (patch.mode !== undefined) { if (!['spread', 'single'].includes(String(patch.mode))) throw new GatewayError('Mode must be spread or single', 400); next.mode = patch.mode; }
  if (patch.regions !== undefined) {
    if (!Array.isArray(patch.regions)) throw new GatewayError('Regions must be a list', 400);
    const list = [...new Set(patch.regions.map(r => String(r).toUpperCase()))];
    const bad = list.find(r => !REGION.test(r)); if (bad) throw new GatewayError(`"${bad}" is not a region code`, 400);
    if (list.length > 18) throw new GatewayError('Choose at most 18 regions', 400);
    next.regions = list;
  }
  if (patch.pinned !== undefined) { const p = String(patch.pinned || '').toUpperCase(); if (p && !REGION.test(p)) throw new GatewayError(`"${p}" is not a region code`, 400); next.pinned = p; }
  if (next.mode === 'single' && !next.regions.includes(next.pinned)) next.pinned = next.regions[0] || '';
  settings.psiphon = next; persist();
  if (!next.enabled) { await stopAll(); ensureRoute(false); }
  // Running clients follow the chosen regions at once: removed ones stop, added ones start.
  else if (instances.size) { for (const [region, inst] of [...instances]) if (!next.regions.includes(region)) { inst.stopping = true; stopProcess(inst.proc); instances.delete(region); } for (const r of next.regions) if (!instances.has(r)) await startInstance(r).catch(() => {}); }
  // With no region left running (all removed), the route goes off with them.
  reconcilePsiphon();
  return psiphonStatus();
}
async function stopAll() {
  epoch++; const live = [...instances.values()]; instances.clear(); recheck.clear();
  for (const i of live) { i.stopping = true; stopProcess(i.proc); }
  await Promise.all(live.map(i => i.proc ? exitOf(i.proc) : undefined));
}
function startMonitor() {
  if (monitor) return;
  // Every half minute: forget expired used-up marks, re-learn exit addresses that are missing, and say when Psiphon comes up or goes down.
  monitor = setInterval(() => {
    pruneSpent();
    for (const i of instances.values()) if (i.state === 'ready' && !i.exitIp) void learnExit(i, false);
    const state = psiphonLive() ? 'up' : instances.size ? 'down' : 'off';
    if (state !== lastNotified && lastNotified) { if (state === 'up') notify('Psiphon connected', `${psiphonLive()} region${psiphonLive() === 1 ? '' : 's'} connected.`, 'success', 'psiphon-up'); else if (state === 'down') notify('Psiphon disconnected', 'No Psiphon region is connected. Polygate keeps trying.', 'warning', 'psiphon-down'); }
    lastNotified = state;
  }, 30000);
  monitor.unref?.();
}

export function psiphonStatus() {
  const c = psiphonConfig(); const found = findPsiphon(); const now = Date.now();
  const route = settings.routes.find(r => r.id === ROUTE_ID);
  return {
    installed: !!found, problem: found ? '' : psiphonMissing(), platform: `${process.platform}-${process.arch}`,
    busy, lastError, running: instances.size > 0, live: psiphonLive(),
    config: { enabled: c.enabled, autoStart: c.autoStart, regions: c.regions, mode: c.mode, pinned: c.pinned, skip: c.skip, renew: c.renew },
    available: c.available?.length ? c.available : KNOWN, updatedAt: c.updatedAt || 0,
    regions: c.regions.map(region => { const i = instances.get(region); const until = i?.exitIp ? spentUntil(i.exitIp) : 0;
      return { region, state: i ? i.state : 'stopped', port: i?.port || 0, exitIp: i?.exitIp || '', location: i?.location || '', since: i?.readyAt || 0, usedUpUntil: until, kiloUntil: i?.exitIp ? kiloUntil(i.exitIp) : 0, checking: i && recheck.get(region) ? recheck.get(region) : '', error: i?.state === 'failed' ? i.error : '' }; }),
    spent: Object.entries(c.spent || {}).filter(([, until]) => until > now).length,
    route: { exists: !!route, enabled: !!route?.enabled, inUse: settings.routeId === ROUTE_ID },
  };
}
// At start: connect when asked to, or when Psiphon is the route in use (requests would otherwise fail, or move elsewhere unannounced).
// Otherwise the route is switched off to match, so nothing is sent into a Psiphon that is not running.
export async function startPsiphon() {
  const c = psiphonConfig(); pruneSpent();
  const wanted = c.enabled && c.regions.length > 0 && !!findPsiphon() && (c.autoStart || settings.routeId === ROUTE_ID);
  if (wanted) await psiphonConnect().catch(e => console.warn('[psiphon] start:', redactError(String(e.message || e))));
  reconcilePsiphon();
}
export async function stopPsiphon() { if (monitor) clearInterval(monitor); monitor = undefined; await stopAll(); }
export const __instances = instances;
// Tests: what happens once a region has reconnected and its exit is known (the client says so in real use).
export const __connected = (region: string) => { const i = instances.get(region); return i ? learnExit(i, false) : Promise.resolve(); };

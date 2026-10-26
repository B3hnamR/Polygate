import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { settings, stateDir, redactError, persist } from './state';
import { GatewayError } from './queue';
import { storedProxies, verify, engineJob, type Candidate } from './proxy-engine';
import { notify } from './notifications';
import { exhaustionOf, takeExhaustion, type Exhaustion } from './exhaustion';
import type { PoolSettings, Route } from './types';
// Model-aware proxy pool. proxy-engine.ts finds proxies that can load the OpenCode API; this module proves they can actually carry model
// traffic, remembers the result, and hands the gateway one healthy proxy per request, moving on to the next as soon as one misbehaves.
export type PoolEntry = { url: string; proxy: string; proto: string; host: string; port: number; https: boolean; latencyMs?: number; exitIp?: string };
export type ProxyStatus = 'untested' | 'reachable' | 'ready' | 'limited' | 'exhausted' | 'blocked' | 'unreachable' | 'bad';
export type PoolHealth = { url: string; status: ProxyStatus; latency: number; checkedAt: number; deep: boolean; error: string; failures: number; successes: number; coolUntil: number; opened: number; exhaustedUntil?: number; api?: ApiCheck; warm?: { at: number; ms: number; fails: number } };
// Stage 1 result: can this proxy load the OpenCode API at all, and how quickly.
export type ApiCheck = { ok: boolean; latency: number; at: number };
export type PoolJob = { running: boolean; phase: 'idle' | 'api' | 'quick' | 'deep' | 'done' | 'stopped'; total: number; done: number; ready: number; failed: number; startedAt: number; finishedAt: number; deep: boolean; message: string };
export const poolConfig = (): PoolSettings => ({ mode: 'ready', deepTest: true, recheckMinutes: 30, maxTested: 60, concurrency: 6, retries: 3, standby: true, standbyTarget: 5, standbyFreshMinutes: 20, apiCheck: true, apiMaxLatencyMs: 2500, apiTimeoutSec: 8, apiRecheckMinutes: 60, keepWarm: true, ...settings.pool });
const healthFile = path.join(stateDir, 'pool-health.json');
const health = new Map<string, PoolHealth>();
try { if (existsSync(healthFile)) for (const h of JSON.parse(readFileSync(healthFile, 'utf8')) as PoolHealth[]) health.set(h.url, h); } catch { /* start with no history */ }
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const save = () => { if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = undefined; try { writeFileSync(healthFile, JSON.stringify([...health.values()])); } catch { /* history is a convenience */ } }, 1500); saveTimer.unref?.(); };
let entries: PoolEntry[] = []; let byUrl = new Map<string, PoolEntry>(); let source: unknown;
// The saved list is replaced as a whole when it changes, so the rows are rebuilt only then.
export async function poolEntries(_force = false): Promise<PoolEntry[]> {
  if (seamed) return entries;
  const saved = storedProxies();
  if (source !== saved) {
    source = saved; entries = saved.map(s => ({ url: s.url, proxy: s.proxy, proto: s.proto, host: s.host, port: s.port, https: true, latencyMs: s.latencyMs }));
    byUrl = new Map(entries.map(e => [e.url, e])); for (const url of health.keys()) if (!byUrl.has(url)) health.delete(url);
  }
  return entries;
}
// Test seam: lets tests supply pool rows without the proxy engine.
let seamed = false;
export function __setPoolEntries(list: PoolEntry[]) { seamed = true; entries = list; byUrl = new Map(list.map(e => [e.url, e])); }
export const __poolHealth = health;
export function virtualPoolRoute(url: string): Route | undefined {
  const e = byUrl.get(url); return e ? { id: 'pool:' + url, name: `${e.host}:${e.port}`, kind: 'proxy', url: e.proxy, enabled: true, models: [] } : undefined;
}
const blank = (url: string): PoolHealth => ({ url, status: 'untested', latency: 0, checkedAt: 0, deep: false, error: '', failures: 0, successes: 0, coolUntil: 0, opened: 0 });
const entryHealth = (url: string) => { let h = health.get(url); if (!h) { h = blank(url); health.set(url, h); } return h; };
export const isUsable = (h?: PoolHealth) => !!h && h.status === 'ready' && (!poolConfig().deepTest || h.deep) && h.coolUntil < Date.now() && (h.exhaustedUntil || 0) < Date.now();
// Two proxies that leave through the same address share one allowance, so a used-up address takes all of them out.
const exitOf = (e: PoolEntry) => e.exitIp || e.host;
export function poolExhausted(url: string, ex: Exhaustion) {
  const e = byUrl.get(url); const mark = (u: string) => { const h = entryHealth(u); Object.assign(h, { status: 'exhausted' as ProxyStatus, exhaustedUntil: ex.until, coolUntil: ex.until, checkedAt: Date.now(), failures: 0, error: 'The daily Free allowance of this exit address is used up (resets at 00:00 UTC)' }); };
  mark(url); if (e) for (const o of entries) if (o.url !== url && exitOf(o) === exitOf(e)) mark(o.url); save();
}
// True when a request could go through a proxy that has just been verified clean.
export const hasCleanStandby = () => entries.some(e => isUsable(health.get(e.url)));
// Counts shared by the Proxies page, the Routing page and the dashboard state, so they always agree.
export function poolSummary() {
  const now = Date.now(); const cfg = poolConfig(); const fresh = cfg.standbyFreshMinutes! * 60000;
  return { clean: new Set(entries.filter(e => isUsable(health.get(e.url)) && health.get(e.url)!.checkedAt > now - fresh).map(exitOf)).size, ready: entries.filter(e => isUsable(health.get(e.url))).length, exhausted: entries.filter(e => (health.get(e.url)?.exhaustedUntil || 0) > now).length, target: cfg.standbyTarget!, enabled: !!cfg.standby, testing: standbyBusy, total: entries.length, warm: entries.filter(e => { const w = health.get(e.url)?.warm; return !!w && w.ms > 0 && Date.now() - w.at < 60000; }).length };
}
// Outcome of a real request through a proxy. Two bad outcomes in a row cool it down (2 min, doubling to 30 min); one success clears it.
export function poolReport(url: string, outcome: 'ok' | 'blocked' | 'bad' | 'unreachable', ms: number, deep = true) {
  const h = entryHealth(url); h.checkedAt = Date.now();
  if (outcome === 'ok') { h.successes++; h.failures = 0; h.opened = 0; h.coolUntil = 0; h.deep ||= deep; h.status = h.deep || !poolConfig().deepTest ? 'ready' : 'reachable'; h.error = ''; if (ms) h.latency = h.latency ? Math.round(h.latency * 0.7 + ms * 0.3) : ms; save(); return; }
  h.failures += outcome === 'blocked' ? 2 : 1; h.error = outcome === 'blocked' ? 'The upstream refused this IP (403)' : outcome === 'bad' ? 'The upstream answered with a server error' : 'Connection failed';
  if (outcome === 'blocked') h.status = 'blocked'; else if (h.failures >= 2) h.status = outcome === 'bad' ? 'bad' : 'unreachable';
  if (h.failures >= 2) { h.opened++; h.coolUntil = Date.now() + Math.min(30 * 60000, 120000 * 2 ** (h.opened - 1)); h.failures = 0; }
  save();
}
let cursor = 0; let lastPick = '';
// One proxy for one request, chosen from the proxies that passed the model test (or the saved selection) and are not cooling down.
export async function pickPoolProxy(route: Route): Promise<{ url: string; proxy: string } | null> {
  const all = await poolEntries(); const cfg = poolConfig();
  const wanted = cfg.mode === 'selected' && route.poolUrls?.length ? all.filter(e => route.poolUrls!.includes(e.url)) : all;
  // A hand-picked selection prefers proxies that passed the model test, but still works before any test has run.
  const usable = wanted.filter(e => isUsable(health.get(e.url)));
  const ready = usable.length ? usable : cfg.mode === 'selected' ? wanted.filter(e => entryHealth(e.url).coolUntil < Date.now()) : [];
  if (!ready.length) return null;
  const order = settings.strategy === 'fastest' ? [...ready].sort((a, b) => (health.get(a.url)?.latency || a.latencyMs || 1e9) - (health.get(b.url)?.latency || b.latencyMs || 1e9)) : ready;
  // "Fastest" means the fastest, not a rotation over the list sorted by speed.
  const speed = (e: PoolEntry) => health.get(e.url)?.latency || e.latencyMs || 1e9;
  // The default ("selected route") sticks to the proxy that carried the last request: Bun keeps its tunnel to the provider open, so the next
  // request skips the 1-7 s it costs a slow proxy to set one up. Round robin and random still spread requests on purpose.
  const pick = settings.strategy === 'random' ? order[Math.floor(Math.random() * order.length)] : settings.strategy === 'fastest' ? order[0] : settings.strategy === 'round_robin' ? order[cursor++ % order.length] : (ready.find(e => e.url === lastPick) || [...ready].sort((a, b) => speed(a) - speed(b))[0]);
  lastPick = pick.url;
  return { url: pick.url, proxy: pick.proxy };
}
// --- testing ---
let job: PoolJob = { running: false, phase: 'idle', total: 0, done: 0, ready: 0, failed: 0, startedAt: 0, finishedAt: 0, deep: false, message: '' };
let stopRequested = false;
export const poolJob = () => ({ ...job });
export function stopPoolTest() { stopRequested = true; }
async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>) {
  let i = 0; await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (i < items.length && !stopRequested) await work(items[i++]); }));
}
function classify(status: number, text: string): { status: ProxyStatus; error: string } {
  if (status < 400) return { status: 'ready', error: '' };
  if (status === 429 && /FreeUsageLimit|Free usage limit/i.test(text)) return { status: 'exhausted', error: 'The daily Free allowance of this exit address is used up' };
  if (status === 429) return { status: 'limited', error: 'Reachable, but the upstream is rate limiting this IP' };
  if (status === 403 || /abuse|unusual activity|ip.block|freeusage|freetier/i.test(text)) return { status: 'blocked', error: 'The upstream refused this IP' };
  return { status: status >= 500 ? 'bad' : 'unreachable', error: `HTTP ${status}` };
}
async function testOne(e: PoolEntry, deep: boolean) {
  const { networkFetch } = await import('./transport'); const h = entryHealth(e.url); const started = Date.now(); const route = 'pool:' + e.url;
  try {
    if (!(deep && apiFresh(h))) {
      const quick = await networkFetch(process.env.POLYGATE_POOL_CATALOG_URL || 'https://opencode.ai/inference/v1/models', { signal: AbortSignal.timeout(12000), headers: { authorization: 'Bearer public' } }, route);
      await quick.body?.cancel(); const q = classify(quick.status, ''); h.latency = Date.now() - started; h.checkedAt = Date.now();
      if (q.status !== 'ready') { Object.assign(h, q, { deep: false }); return; }
      if (!deep) { Object.assign(h, { status: poolConfig().deepTest ? 'reachable' : 'ready', error: '', deep: false }); return; }
    }
    const { rankedModels, providerChat, sessionFor } = await import('./providers'); const { collect } = await import('./protocols');
    const provider = settings.providers.find(p => p.enabled && p.kind === 'free') || settings.providers.find(p => p.enabled);
    const model = rankedModels().find(m => m.providerId === provider?.id && m.state !== 'unavailable' && m.cooldownUntil <= Date.now());
    if (!provider || !model) { Object.assign(h, { status: 'reachable', error: 'No model available for a deep test; refresh models or wait for cooldowns.', deep: false }); return; }
    const t0 = Date.now(); const testId = 'pool-test-' + crypto.randomUUID(); const r = await providerChat(provider, model, { messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 8, stream: true }, AbortSignal.timeout(40000), route, sessionFor('pool-test', [{ role: 'user', content: e.url }], {}), testId);
    if (r.ok) { takeExhaustion(testId); await collect(r); Object.assign(h, { status: 'ready', error: '', deep: true, latency: Date.now() - t0, exhaustedUntil: 0, checkedAt: Date.now() }); }
    else {
      const text = (await r.text()).slice(0, 300); const ex = takeExhaustion(testId) || exhaustionOf(r.status, r.headers.get('retry-after'), text);
      if (ex) { poolExhausted(e.url, ex); return; }
      Object.assign(h, classify(r.status, text), { deep: true, checkedAt: Date.now() });
    }
  } catch (error) { Object.assign(h, { status: 'unreachable', error: redactError(String((error as Error).message || error)).slice(0, 160), deep, checkedAt: Date.now() }); }
  finally {
    if (h.status === 'ready' || h.status === 'reachable') { h.failures = 0; h.opened = 0; h.coolUntil = 0; h.successes++; } else if (h.status === 'exhausted') { /* coolUntil already runs to the reset */ } else if (h.status !== 'untested') { h.coolUntil = Date.now() + 5 * 60000; }
  }
}
// --- stage 1: the OpenCode API ---
// A proxy that cannot load the API, or loads it slowly, is not worth a model request. The whole pool is checked against one URL in parallel
// (thousands in minutes); only proxies that answer within the speed gate go on to the model test.
export const apiUrl = () => process.env.POLYGATE_POOL_API_URL || 'https://opencode.ai/inference/v1/models';
export type ApiRunner = (list: PoolEntry[], opts: { timeoutSec: number; progress: (done: number, total: number) => void; cancelled: () => boolean }) => Promise<Map<string, { latency: number; status: number }> | null>;
export const engineApiRunner: ApiRunner = (list, { timeoutSec, progress, cancelled }) => verify(list as unknown as Candidate[], { api: apiUrl(), timeoutMs: timeoutSec * 1000, concurrency: 200, progress: (done, total) => progress(done, total), cancelled });
let apiRunner: ApiRunner = engineApiRunner;
export const __setApiRunner = (fn: ApiRunner) => { apiRunner = fn; };
export type ApiScan = { running: boolean; at: number; checked: number; passed: number; message: string };
let apiScan: ApiScan = { running: false, at: 0, checked: 0, passed: 0, message: '' };
export const apiScanState = () => ({ ...apiScan });
const apiGate = () => poolConfig().apiMaxLatencyMs!;
export const apiPassed = (h?: PoolHealth) => !!h?.api?.ok && h.api.latency <= apiGate();
const apiFresh = (h?: PoolHealth) => apiPassed(h) && Date.now() - h!.api!.at < poolConfig().apiRecheckMinutes! * 60000;
// Checks every proxy in the pool against the OpenCode API. Returns the proxies that answered within the speed gate, fastest first.
export async function scanApi(list: PoolEntry[], onProgress?: (done: number, total: number) => void): Promise<PoolEntry[] | null> {
  const cfg = poolConfig(); apiScan = { running: true, at: Date.now(), checked: 0, passed: 0, message: `Checking ${list.length} proxies against the OpenCode API…` };
  try {
    const found = await apiRunner(list, { timeoutSec: cfg.apiTimeoutSec!, cancelled: () => stopRequested, progress: (done, total) => { apiScan.checked = done; onProgress?.(done, total); } });
    if (!found) { apiScan = { ...apiScan, running: false, message: 'The proxy check could not run.' }; return null; }
    const at = Date.now();
    for (const e of list) {
      const h = entryHealth(e.url); const r = found.get(e.url);
      // A scan that was stopped part-way proves nothing about the proxies it never reached.
      if (!r && stopRequested) continue;
      h.api = r ? { ok: true, latency: r.latency, at } : { ok: false, latency: 0, at };
      if (!r) { if (h.status === 'untested' || h.status === 'reachable' || h.status === 'ready') { h.status = 'unreachable'; h.error = 'No usable reply from the OpenCode API (refused, hijacked or too slow)'; h.deep = false; } }
      else if (h.status === 'unreachable' && h.error.startsWith('No usable reply')) { h.status = 'untested'; h.error = ''; }
    }
    const passed = list.filter(e => apiPassed(health.get(e.url))).sort((a, b) => health.get(a.url)!.api!.latency - health.get(b.url)!.api!.latency);
    apiScan = { running: false, at, checked: list.length, passed: passed.length, message: `${passed.length} of ${list.length} proxies reach the OpenCode API within ${cfg.apiMaxLatencyMs} ms.` }; save();
    return passed;
  } catch (e) { apiScan = { ...apiScan, running: false, message: redactError(String((e as Error).message || e)) }; throw e; }
}
// Tests the whole pool (not one proxy): the OpenCode API for every proxy first, then a real model request for the fast survivors.
// attach: when the run finishes with model-ready proxies, put them in the pool route (select: also make it the active route).
export async function testPool(opts: { deep?: boolean; urls?: string[]; api?: boolean; attach?: { select: boolean } } = {}) {
  if (job.running) return poolJob(); const cfg = poolConfig(); const deep = opts.deep ?? cfg.deepTest; stopRequested = false;
  const all = await poolEntries(true); const picked = !!opts.urls?.length; let list = picked ? all.filter(e => opts.urls!.includes(e.url)) : all;
  if (!list.length) { job = { ...job, running: false, phase: 'done', finishedAt: Date.now(), total: 0, done: 0, message: 'The pool is empty. Scan or import proxies first.' }; return poolJob(); }
  const staged = (opts.api ?? cfg.apiCheck !== false) && !picked;
  job = { running: true, phase: staged ? 'api' : 'quick', total: staged ? list.length : Math.min(list.length, cfg.maxTested), done: 0, ready: 0, failed: 0, startedAt: Date.now(), finishedAt: 0, deep, message: staged ? `Checking ${list.length} proxies against the OpenCode API…` : `Checking ${Math.min(list.length, cfg.maxTested)} proxies against the upstream…` };
  void (async () => {
    try {
      let candidates = list; let usedApi = false;
      if (staged) {
        const passed = await scanApi(list, (done, total) => { job.done = done; job.total = total || job.total; });
        if (passed) { usedApi = true; candidates = passed; }
        else candidates = [...list].sort((a, b) => (a.latencyMs || 1e9) - (b.latencyMs || 1e9));
        if (usedApi) job.message = `${passed!.length.toLocaleString()} of ${list.length.toLocaleString()} reach the API in time.`;
      }
      candidates = usedApi ? candidates : [...candidates].sort((a, b) => (a.latencyMs || 1e9) - (b.latencyMs || 1e9));
      candidates = candidates.slice(0, cfg.maxTested);
      if (stopRequested) { job = { ...job, running: false, phase: 'stopped', finishedAt: Date.now(), message: 'Stopped.' }; return; }
      if (usedApi && !deep) { job = { ...job, running: false, phase: 'done', ready: candidates.length, finishedAt: Date.now(), message: apiScan.message }; return; }
      const survivors: PoolEntry[] = [];
      if (usedApi) { survivors.push(...candidates); job = { ...job, phase: 'deep', done: 0, total: survivors.length, message: `${apiScan.passed.toLocaleString()} of ${list.length.toLocaleString()} reach the API in time. Model-testing the fastest ${survivors.length}…` }; }
      else {
        job = { ...job, phase: 'quick', done: 0, total: candidates.length, message: `Checking ${candidates.length} proxies against the upstream…` };
        await pool(candidates, cfg.concurrency, async e => { await testOne(e, false); job.done++; const h = health.get(e.url); if (h && ['reachable', 'ready'].includes(h.status) && h.coolUntil < Date.now()) survivors.push(e); else job.failed++; });
        if (deep && survivors.length && !stopRequested) job = { ...job, phase: 'deep', done: 0, total: survivors.length, message: `Sending a real model request through ${survivors.length} proxies…` };
      }
      if (deep && survivors.length && !stopRequested) await pool(survivors, Math.max(1, Math.floor(cfg.concurrency / 2)), async e => { await testOne(e, true); job.done++; if (!isUsable(health.get(e.url))) job.failed++; });
      const ready = list.filter(e => isUsable(health.get(e.url))).length; save();
      job = { ...job, running: false, phase: stopRequested ? 'stopped' : 'done', ready, finishedAt: Date.now(), message: stopRequested ? 'Stopped.' : `${usedApi ? `${apiScan.passed.toLocaleString()} reach the API in time. ` : ''}${ready} of ${survivors.length || candidates.length} model-tested are ready.` };
      if (!stopRequested && opts.attach && ready) { try { await attachPool({ select: opts.attach.select }); job.message += opts.attach.select ? ' Added to the pool and in use.' : ' Added to the pool as standby.'; } catch (e) { job.message += ' ' + redactError(String((e as Error).message || e)); } }
      if (!stopRequested) notify('Proxy pool tested', job.message, ready ? 'success' : 'warning', 'pool-tested', 0);
    } catch (error) { job = { ...job, running: false, phase: 'stopped', finishedAt: Date.now(), message: redactError(String(error)) }; }
  })();
  return poolJob();
}
// Active route or standby. Becoming standby gives the route back that requests used before the pool took over.
export function setPoolRole(active: boolean) {
  if (active) { if (settings.routeId !== 'proxy-pool') settings.previousRouteId = settings.routeId; settings.routeId = 'proxy-pool'; }
  else if (settings.routeId === 'proxy-pool') settings.routeId = settings.routes.find(r => r.id === settings.previousRouteId && r.enabled && r.id !== 'proxy-pool')?.id || 'direct';
}
// The pool route: every model-ready proxy (or an explicit selection). select:false leaves the active route alone, so the pool is
// only used when that route's exit has used up its daily allowance.
export async function attachPool(opts: { urls?: string[]; select?: boolean } = {}) {
  const all = await poolEntries(true); const urls = opts.urls || []; const mode = urls.length ? 'selected' as const : 'ready' as const;
  const selected = mode === 'selected' ? all.filter(p => urls.includes(p.url)) : all;
  if (!selected.length) throw new GatewayError('No verified HTTPS-capable proxies match. Import/check proxies first.', 400);
  const route: Route = { id: 'proxy-pool', name: 'Verified proxy pool', kind: 'proxy', url: 'pool://verified', enabled: true, models: [], status: 'connected', poolUrls: mode === 'selected' ? selected.map(p => p.url) : [], poolCount: selected.length, managed: true };
  const old = settings.routes.find(r => r.id === route.id); if (old) Object.assign(old, route); else settings.routes.push(route);
  settings.pool = { ...poolConfig(), mode }; setPoolRole(opts.select !== false); persist();
  let testing = false; if (mode === 'ready') { const status = await poolStatus(); if (!status.ready && !status.job.running) { await testPool({}); testing = true; } }
  return { selected: selected.length, mode, testing };
}
// --- what the dashboard shows: filtered, sorted and paged on the server so a pool of thousands stays light ---
export type PoolTab = 'all' | 'ready' | 'api' | 'exhausted' | 'failed' | 'untested';
export const stageOf = (e: PoolEntry, h: PoolHealth | undefined, now = Date.now()): Exclude<PoolTab, 'all'> => {
  if (isUsable(h)) return 'ready'; if ((h?.exhaustedUntil || 0) > now) return 'exhausted';
  if (h && ['unreachable', 'blocked', 'bad', 'limited'].includes(h.status)) return 'failed';
  if (h?.api && !h.api.ok) return 'failed'; if (h?.api?.ok && !apiPassed(h)) return 'failed';
  if (apiPassed(h)) return 'api'; return 'untested';
};
export type PoolQuery = { tab?: string; q?: string; proto?: string; sort?: string; page?: number; pageSize?: number };
export async function poolStatus(query: PoolQuery = {}) {
  const list = await poolEntries();
  const now = Date.now(); const cfg = poolConfig(); const fresh = cfg.standbyFreshMinutes! * 60000;
  const standby = poolSummary(); const route = settings.routes.find(r => r.id === 'proxy-pool'); const prev = settings.routes.find(r => r.id === settings.previousRouteId);
  const counts: Record<PoolTab, number> = { all: list.length, ready: 0, api: 0, exhausted: 0, failed: 0, untested: 0 }; const stages = new Map<string, Exclude<PoolTab, 'all'>>();
  for (const e of list) { const s = stageOf(e, health.get(e.url), now); stages.set(e.url, s); counts[s]++; }
  const needle = (query.q || '').trim().toLowerCase(); const tab = (['ready', 'api', 'exhausted', 'failed', 'untested'] as string[]).includes(query.tab || '') ? query.tab as PoolTab : 'all';
  let rows = list.filter(e => (tab === 'all' || stages.get(e.url) === tab) && (!query.proto || e.proto === query.proto) && (!needle || `${e.host}:${e.port} ${e.proto} ${e.exitIp || ''}`.toLowerCase().includes(needle)));
  const apiMs = (e: PoolEntry) => { const a = health.get(e.url)?.api; return a?.ok ? a.latency : 1e9; }; const modelMs = (e: PoolEntry) => health.get(e.url)?.latency || 1e9;
  const rank: Record<string, number> = { ready: 0, api: 1, untested: 2, exhausted: 3, failed: 4 };
  const sorters: Record<string, (a: PoolEntry, b: PoolEntry) => number> = {
    best: (a, b) => rank[stages.get(a.url)!] - rank[stages.get(b.url)!] || apiMs(a) - apiMs(b) || (a.latencyMs || 1e9) - (b.latencyMs || 1e9),
    api: (a, b) => apiMs(a) - apiMs(b), model: (a, b) => modelMs(a) - modelMs(b), latency: (a, b) => (a.latencyMs || 1e9) - (b.latencyMs || 1e9),
  };
  rows = [...rows].sort(sorters[query.sort || 'best'] || sorters.best);
  const pageSize = Math.min(500, Math.max(10, Math.floor(query.pageSize || 50))); const pages = Math.max(1, Math.ceil(rows.length / pageSize)); const page = Math.min(pages, Math.max(1, Math.floor(query.page || 1)));
  const shown = rows.slice((page - 1) * pageSize, page * pageSize);
  return { entries: shown.map(e => ({ ...e, proxy: undefined, stage: stages.get(e.url), health: health.get(e.url) || blank(e.url) })), total: rows.length, page, pages, pageSize, counts, job: poolJob(), list: engineJob(), config: cfg, ready: counts.ready, standby, route: { attached: !!route?.enabled, active: !!route?.enabled && settings.routeId === 'proxy-pool', previous: prev?.name || 'Direct connection' }, api: { ...apiScanState(), gate: cfg.apiMaxLatencyMs, url: apiUrl() }, };
}
// Standby: keeps `standbyTarget` proxies (distinct exit addresses) that passed a real model request within the last
// `standbyFreshMinutes`, testing only as many candidates as are missing, so a used-up exit is replaced from the shelf.
let standbyBusy = false;
export async function standbyTick() {
  const cfg = poolConfig(); const route = settings.routes.find(r => r.id === 'proxy-pool');
  if (!cfg.standby || !route?.enabled || !settings.enabled || job.running || standbyBusy) return; standbyBusy = true;
  try {
    const all = await poolEntries(); const now = Date.now(); const fresh = cfg.standbyFreshMinutes! * 60000;
    let wanted = cfg.mode === 'selected' && route.poolUrls?.length ? all.filter(e => route.poolUrls!.includes(e.url)) : all;
    const clean = (e: PoolEntry) => { const h = health.get(e.url); return isUsable(h) && h!.checkedAt > now - fresh; };
    const taken = new Set(wanted.filter(clean).map(exitOf)); const need = cfg.standbyTarget! - taken.size; if (need <= 0) return;
    // Stage 1 first: only proxies that load the OpenCode API fast enough are worth a model request. The scan covers the whole pool and is repeated when stale.
    if (cfg.apiCheck !== false && !apiScan.running && now - apiScan.at > cfg.apiRecheckMinutes! * 60000) { stopRequested = false; await scanApi(all); }
    if (cfg.apiCheck !== false && apiScan.at) wanted = wanted.filter(e => apiPassed(health.get(e.url)));
    for (const e of wanted) if ((health.get(e.url)?.exhaustedUntil || 0) > now) taken.add(exitOf(e));
    const order = (e: PoolEntry) => { const h = health.get(e.url); return !h || h.status === 'untested' ? 0 : h.status === 'reachable' ? 1 : 2; }; const speed = (e: PoolEntry) => health.get(e.url)?.api?.latency || e.latencyMs || 1e9;
    const batch: PoolEntry[] = [];
    for (const e of [...wanted].filter(e => (health.get(e.url)?.coolUntil || 0) < now).sort((a, b) => order(a) - order(b) || speed(a) - speed(b))) {
      if (batch.length >= Math.min(need * 2, 6)) break; if (clean(e) || taken.has(exitOf(e))) continue; taken.add(exitOf(e)); batch.push(e);
    }
    stopRequested = false; await pool(batch, 3, e => testOne(e, true)); save();
  } catch { /* the next tick tries again */ } finally { standbyBusy = false; }
}
// Keeps the tunnel to the provider open on the proxies most likely to be used next, so the first chat request after a pause does not pay for
// a new connection (measured: a cold request through a slow proxy takes 1.8 to 5 s, a warm one 0.55 to 0.95 s). The request is the catalog
// read, which spends no allowance. A proxy whose warm-up fails twice in a row is taken out before a real request finds it dead.
let warming = false;
export async function warmTick(count = 3) {
  const cfg = poolConfig(); const route = settings.routes.find(r => r.id === 'proxy-pool');
  if (cfg.keepWarm === false || !route?.enabled || !settings.enabled || warming || job.running) return; warming = true;
  try {
    const { usableProxy } = await import('./transport');
    const candidates = entries.filter(e => isUsable(health.get(e.url))).sort((a, b) => (e => (e.url === lastPick ? -1 : 0))(a) - (e => (e.url === lastPick ? -1 : 0))(b) || (health.get(a.url)?.latency || 1e9) - (health.get(b.url)?.latency || 1e9)).slice(0, count);
    await Promise.all(candidates.map(async e => {
      const h = entryHealth(e.url); const t0 = Date.now();
      try {
        const r = await fetch(apiUrl(), { proxy: await usableProxy(e.proxy), signal: AbortSignal.timeout(10000) });
        await r.arrayBuffer();   // read to the end so the connection goes back to the pool instead of being closed
        if (r.status >= 400) throw new Error('HTTP ' + r.status);
        h.warm = { at: Date.now(), ms: Date.now() - t0, fails: 0 };
      } catch { const fails = (h.warm?.fails || 0) + 1; h.warm = { at: h.warm?.at || 0, ms: 0, fails }; if (fails >= 2) { poolReport(e.url, 'unreachable', 0); poolReport(e.url, 'unreachable', 0); h.warm.fails = 0; } }
    }));
    save();
  } catch { /* the next tick tries again */ } finally { warming = false; }
}
// Re-tests the pool on a schedule so proxies that died (or recovered) are noticed without anyone pressing a button.
export function startPoolMaintenance() {
  const standby = setInterval(() => { void standbyTick(); }, 45000); standby.unref?.();
  const warm = setInterval(() => { void warmTick(); }, 20000); warm.unref?.();
  const timer = setInterval(() => {
    const route = settings.routes.find(r => r.id === 'proxy-pool'); if (!route?.enabled || job.running) return;
    if (Date.now() - Math.max(job.finishedAt, 0) < poolConfig().recheckMinutes * 60000) return;
    void testPool({ deep: poolConfig().deepTest }).catch(() => {});
  }, 60000); timer.unref?.(); return () => { clearInterval(timer); clearInterval(standby); clearInterval(warm); };
}

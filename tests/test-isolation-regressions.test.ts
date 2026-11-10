import { afterAll, expect, test } from 'bun:test';
import type { IncomingMessage } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { preserveTestState } from './setup';
import { db, models, record, saveModel, settings, stateDir, tallyRoute } from '../backend/state';
import { authenticate, checkTokenRate, recordUsage } from '../backend/keys';
import { logEvent } from '../backend/logbook';
import { storedProxies } from '../backend/proxy-engine';
import { __capturePoolTestState, __poolHealth, __setApiRunner, __setPoolEntries, apiScanState, pickPoolProxy, poolConfig, poolEntries, poolJob, poolReport, scanApi, stopPoolTest, virtualPoolRoute, type PoolEntry } from '../backend/pool';

const restoreFile = preserveTestState();
afterAll(restoreFile);
const entry = (n: number, latencyMs = n * 10): PoolEntry => ({ url: `http://127.0.0.1:${19000 + n}`, proxy: `http://127.0.0.1:${19000 + n}`, host: '127.0.0.1', port: 19000 + n, proto: 'http', https: true, latencyMs });
const route = { id: 'proxy-pool', name: 'Fixture', kind: 'proxy' as const, url: 'pool://verified', enabled: true, models: [] };
const activity = () => ['models', 'requests', 'usage_daily', 'usage_keys_daily', 'route_outcomes', 'events'].map(table => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all());

test('sequential file-like scopes restore settings, model memory and disk, activity, environment and key windows', () => {
  const outer = preserveTestState();
  try {
    const key = { id: 'isolation-key', name: 'Fixture', value: 'isolation-secret', enabled: true, limit: 0, rpm: 2, tpm: 3 };
    settings.keys = [key];
    const request = { headers: { authorization: `Bearer ${key.value}` } } as IncomingMessage;
    // The baseline deliberately already contains rate history and a pending usage save.
    authenticate(request, true); recordUsage(key.id, 1);
    record({ id: 'isolation-baseline', time: Date.now(), model: 'isolation/baseline', provider: 'isolation', protocol: 'chat', route: 'baseline-route', status: 200, ms: 3, input: 1, output: 1, error: '', keyId: key.id });
    tallyRoute('baseline-route', 'ok'); logEvent('info', 'isolation', 'Baseline file activity');
    const beforeSettings = structuredClone(settings), beforeModels = structuredClone([...models]), beforeActivity = activity();
    const beforeEnv = process.env.POLYGATE_ISOLATION_FIXTURE;
    const restore = preserveTestState();
    try {
      settings.providers = []; settings.enabled = false;
      process.env.POLYGATE_ISOLATION_FIXTURE = 'first-file';
      saveModel({ id: 'isolation/model', upstreamId: 'model', providerId: 'isolation', name: 'Fixture', context: 0, output: 0, tools: false, reasoning: false, state: 'unchecked', latency: 0, score: 50, priority: 100, failCount: 0, cooldownUntil: 0, checkedAt: 0, error: '' });
      record({ id: 'isolation-request', time: Date.now(), model: 'isolation/model', provider: 'isolation', protocol: 'chat', route: 'isolation-route', status: 200, ms: 7, input: 2, output: 1, error: '', keyId: key.id });
      tallyRoute('isolation-route', 'ok'); logEvent('info', 'isolation', 'First file activity');
      db.exec("DELETE FROM requests WHERE id='isolation-baseline'; UPDATE route_outcomes SET n=99 WHERE route='baseline-route'");
      authenticate(request, true); recordUsage(key.id, 2);
      expect(() => authenticate(request, true)).toThrow(/Request rate limit/);
      expect(() => checkTokenRate(key)).toThrow(/Token rate limit/);
      restore();
      expect(settings).toEqual(beforeSettings); expect([...models]).toEqual(beforeModels); expect(activity()).toEqual(beforeActivity);
      expect(JSON.stringify(process.env.POLYGATE_ISOLATION_FIXTURE)).toBe(JSON.stringify(beforeEnv));
      const restoredKey = settings.keys[0];
      expect(() => checkTokenRate(restoredKey)).not.toThrow();
      // A second scope gets the one remaining RPM slot, not zero slots or an empty window.
      authenticate(request, true);
      expect(() => authenticate(request, true)).toThrow(/Request rate limit/);
      restore(); restore();
      expect(settings).toEqual(beforeSettings); expect(activity()).toEqual(beforeActivity);
    } finally { restore(); }
  } finally { outer(); }
});

test('pool scopes deeply restore rows, lookup, health, runner, scan, stop flag and both selection cursors', async () => {
  const outer = preserveTestState();
  try {
    const a = entry(1, 50), b = entry(2, 10);
    __setPoolEntries([a, b]); __poolHealth.clear(); settings.pool = { ...poolConfig(), mode: 'selected', deepTest: true }; settings.strategy = 'round_robin';
    __setApiRunner(async list => new Map(list.map(e => [e.url, { latency: 17, status: 200 }])));
    await scanApi([a, b]); poolReport(a.url, 'ok', 50); poolReport(b.url, 'ok', 10);
    __poolHealth.get(a.url)!.warm = { at: 123, ms: 5, fails: 0 };
    const first = (await pickPoolProxy(route))!.url;
    const next = first === a.url ? b.url : a.url;
    settings.strategy = 'single'; await pickPoolProxy(route, new Set([b.url])); settings.strategy = 'round_robin';
    const beforeHealth = structuredClone([...__poolHealth]), beforeScan = apiScanState(), beforeJob = poolJob();
    const healthPath = path.join(stateDir, 'pool-health.json');
    const beforeDisk = existsSync(healthPath) ? readFileSync(healthPath) : undefined;
    const restore = __capturePoolTestState();
    try {
      a.host = 'mutated'; __poolHealth.get(a.url)!.warm!.fails = 9; __poolHealth.get(a.url)!.api!.latency = 999;
      __setPoolEntries([entry(3)]); __poolHealth.clear();
      __setApiRunner(async () => new Map()); await scanApi([entry(3)]); await pickPoolProxy(route); stopPoolTest();
      restore();
      expect(await poolEntries()).toEqual([entry(1, 50), entry(2, 10)]);
      expect(virtualPoolRoute(entry(3).url)).toBeUndefined(); expect(virtualPoolRoute(a.url)?.name).toBe('127.0.0.1:19001');
      expect([...__poolHealth]).toEqual(beforeHealth); expect(apiScanState()).toEqual(beforeScan); expect(poolJob()).toEqual(beforeJob);
      expect(existsSync(healthPath) ? readFileSync(healthPath) : undefined).toEqual(beforeDisk);
      // Consume the restored cursor, then verify sticky resumes at the saved last selection.
      expect((await pickPoolProxy(route))?.url).toBe(next);
      restore(); settings.strategy = 'single'; expect((await pickPoolProxy(route))?.url).toBe(a.url);
      settings.strategy = 'round_robin'; restore();
      __setApiRunner(async (list, opts) => { expect(opts.cancelled()).toBe(false); return new Map(list.map(e => [e.url, { latency: 1, status: 200 }])); });
      await scanApi([a]); restore();
      await scanApi([entry(1), b]); expect(__poolHealth.get(a.url)?.api?.latency).toBe(17);
    } finally { restore(); }
  } finally { outer(); }
});

test('restoring a file scope rejects active pool work without partially restoring settings or activity', async () => {
  const outer = preserveTestState();
  let finish!: (found: Map<string, { latency: number; status: number }>) => void;
  try {
    const restore = preserveTestState();
    __setApiRunner(() => new Promise(resolve => { finish = resolve; }));
    const pending = scanApi([entry(4)]);
    try {
      settings.enabled = !settings.enabled; const enabled = settings.enabled;
      logEvent('info', 'isolation', 'Active scope'); const during = activity();
      expect(() => __capturePoolTestState()).toThrow(/idle pool/);
      expect(() => restore()).toThrow(/idle pool/);
      expect(settings.enabled).toBe(enabled); expect(activity()).toEqual(during); expect(apiScanState().running).toBe(true);
    } finally { finish(new Map()); await pending; restore(); }
  } finally { outer(); }
});

test('an unseamed file baseline returns to engine rows instead of retaining injected fixtures', async () => {
  const outer = preserveTestState();
  try {
    __setPoolEntries(); await poolEntries();
    const restore = __capturePoolTestState();
    try {
      __setPoolEntries([entry(5)]); expect((await poolEntries())[0].url).toBe(entry(5).url);
      restore();
      expect((await poolEntries()).map(e => e.url)).toEqual(storedProxies().map(e => e.url));
      expect(virtualPoolRoute(entry(5).url)).toBeUndefined();
      // The saved source identity still works after releasing the seam a second time.
      __setPoolEntries([entry(6)]); restore();
      expect((await poolEntries()).map(e => e.url)).toEqual(storedProxies().map(e => e.url));
    } finally { restore(); }
  } finally { outer(); }
});

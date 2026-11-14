// Loaded before every test file (bunfig.toml). Test files share one process, so backend/state is loaded once with whichever
// POLYGATE_STATE is set first; a per-file folder that one file deletes would break every later file. One temporary folder for the
// whole run, removed at process exit, also keeps tests away from the real state under %LOCALAPPDATA% or ~/.local/state.
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';

const harness = process.env.POLYGATE_HARNESS === '1';
// Test files make their own temporary folders (projects, agent data, libraries, TLS files), and on Windows `bun test` never fires the
// process's exit event, so nothing removed them: a few hundred piled up per run. Each run therefore starts by removing the test folders
// earlier runs left. Only folders older than half an hour go (a run going on in another terminal keeps its own), and never the app's
// update staging folders (polygate-update-…).
if (!harness) {
  try {
    const tmp = os.tmpdir(); const old = Date.now() - 30 * 60000;
    for (const e of readdirSync(tmp, { withFileTypes: true })) {
      if (!e.isDirectory() || !/^(pg-|pgrelay-|polygate-)/.test(e.name) || e.name.startsWith('polygate-update-')) continue;
      const full = path.join(tmp, e.name);
      try { if (statSync(full).mtimeMs < old) rmSync(full, { recursive: true, force: true }); } catch { /* in use */ }
    }
  } catch { /* the temp directory could not be read */ }
}
const dir = harness ? process.env.POLYGATE_STATE! : mkdtempSync(path.join(os.tmpdir(), 'polygate-test-'));
if (!dir) throw new Error('A harness must supply its temporary POLYGATE_STATE');
process.env.POLYGATE_STATE = dir;
process.env.POLYGATE_NO_DISCOVERY = '1';
process.env.AUTO_UPDATE = '0';
process.env.POLYGATE_DIAG_EGRESS = '0';
for (const key of Object.keys(process.env)) if (/^(?:https?|all|no)_proxy$/i.test(key)) delete process.env[key];
delete process.env.POLYGATE_ADMIN_PASSWORD;
if (harness) for (const key of ['POLYGATE_DESKTOP', 'POLYGATE_DASHBOARD_PATH', 'POLYGATE_TRUST_PROXY', 'POLYGATE_ALLOWED_HOSTS', 'POLYGATE_ACME_DIRECTORY', 'POLYGATE_ACME_INSECURE']) delete process.env[key];

export const isFixtureHost = (host: string) => host === '::1' || host === '[::1]' || (net.isIPv4(host) && host.startsWith('127.'));
const denied = (target: string) => new Error(`External network denied by test harness: ${target}`);
const realFetch = globalThis.fetch;
// Check both ends: a local target with an external proxy is still external traffic.
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit & { proxy?: string }) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (init?.proxy && !isFixtureHost(new URL(init.proxy).hostname)) throw denied(init.proxy);
  if (!isFixtureHost(url.hostname)) {
    if (url.href === 'https://api.github.com/repos/B3hnamR/Polygate/releases/latest') return Response.json({ draft: false, prerelease: false, tag_name: 'v0.0.0', assets: [] });
    if (harness && url.hostname === 'api.vercel.com') return Response.json({ error: { message: 'Fixture token refused' } }, { status: 403 });
    if (url.pathname === '/cdn-cgi/trace') return new Response('ip=198.51.100.20\nloc=US\n');
    if (url.hostname === 'api.ipify.org' || (url.hostname === 'ifconfig.me' && url.pathname === '/ip')) return new Response('198.51.100.20');
    if ((url.hostname === 'opencode.ai' && url.pathname.startsWith('/update/')) || url.hostname === 'raw.githubusercontent.com' || (url.hostname === 'github.com' && url.pathname.endsWith('/releases.atom'))) return new Response('Offline verification fixture', { status: 503 });
    throw denied(url.href);
  }
  const response = await realFetch(input, { ...init, redirect: 'manual' });
  // Do not let a loopback fixture redirect Bun's native fetch around this guard.
  if (response.status >= 300 && response.status < 400 && response.headers.has('location') && (init?.redirect ?? (input instanceof Request ? input.redirect : 'follow')) !== 'manual') {
    await response.body?.cancel();
    throw denied(`automatic redirect from ${url.href}`);
  }
  return response;
}, realFetch) as typeof fetch;

function checkConnect(args: any[]) {
  const a = args[0];
  if (Array.isArray(a)) return checkConnect(a);
  if (typeof a === 'string' && !/^\d+$/.test(a)) throw denied('socket path ' + a);
  const host = typeof a === 'object' ? a.host ?? a.hostname : typeof args[1] === 'string' ? args[1] : undefined;
  if (typeof a === 'object' && (a.path || a.unix)) throw denied('socket path ' + (a.path || a.unix));
  if (host && !isFixtureHost(host)) throw denied(String(host));
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) { checkConnect(args); return Reflect.apply(connect, this, args); } as typeof connect;
const tlsConnect = tls.connect;
tls.connect = ((...args: any[]) => { checkConnect(args); return Reflect.apply(tlsConnect, tls, args); }) as typeof tls.connect;
const bunConnect = Bun.connect;
Bun.connect = ((options: any) => { checkConnect([options]); return bunConnect(options); }) as typeof Bun.connect;
// Refuse DNS before resolution as well as refusing the eventual socket.
const lookup = dns.lookup;
dns.lookup = ((host: string, ...args: any[]) => { if (!isFixtureHost(host)) throw denied(host); return Reflect.apply(lookup, dns, [host, ...args]); }) as typeof dns.lookup;
const promiseLookup = dns.promises.lookup;
dns.promises.lookup = (async (host: string, ...args: any[]) => { if (!isFixtureHost(host)) throw denied(host); return Reflect.apply(promiseLookup, dns.promises, [host, ...args]); }) as typeof dns.promises.lookup;
for (const name of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse'] as const) {
  (dns as any)[name] = (host: string) => { throw denied(`DNS ${host}`); };
  (dns.promises as any)[name] = async (host: string) => { throw denied(`DNS ${host}`); };
}

const state = await import('../backend/state');
const { __capturePoolTestState } = await import('../backend/pool');
const { __captureKeyTestState } = await import('../backend/keys');
if (harness) {
  for (const provider of state.settings.providers) provider.enabled = false;
  state.settings.warp = { engine: 'disabled', autoStart: false, pool: 1, rotateMinutes: 0, helperPath: '', endpoint: '' };
  state.persist();
}

// Explicit file scopes preserve sequential integration tests, but do not leak their settings,
// models, activity, key windows, pool fixtures or environment into another file. This is not a
// concurrent-test sandbox: close gateways, stop maintenance and await requests/jobs before restoring.
export function preserveTestState() {
  const restorePool = __capturePoolTestState();
  const restoreKeys = __captureKeyTestState();
  const settings = structuredClone(state.settings);
  const models = structuredClone([...state.models]);
  const env = { ...process.env };
  const tables = ['models', 'requests', 'usage_daily', 'usage_keys_daily', 'route_outcomes', 'events'] as const;
  const rows = tables.map(table => ({ table, rows: state.db.query(`SELECT * FROM ${table}`).all() as Record<string, any>[] }));
  const eventSequence = state.db.query("SELECT seq FROM sqlite_sequence WHERE name='events'").get() as { seq: number } | null;
  return () => {
    // Fail before changing settings or tables when a pool worker can still write into this scope.
    restorePool.assertIdle(); restoreKeys.assertIdle();
    restorePool(); restoreKeys();
    state.db.transaction(() => {
      for (const snapshot of rows) {
        state.db.exec(`DELETE FROM ${snapshot.table}`);
        if (!snapshot.rows.length) continue;
        const columns = Object.keys(snapshot.rows[0]);
        const insert = state.db.query(`INSERT INTO ${snapshot.table} (${columns.map(c => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
        for (const row of snapshot.rows) insert.run(...columns.map(c => row[c]));
      }
      state.db.exec("DELETE FROM sqlite_sequence WHERE name='events'");
      if (eventSequence) state.db.query("INSERT INTO sqlite_sequence(name,seq) VALUES ('events',?)").run(eventSequence.seq);
    })();
    for (const key of Object.keys(state.settings)) delete (state.settings as any)[key];
    Object.assign(state.settings, structuredClone(settings));
    state.models.clear();
    for (const [id, model] of models) state.models.set(id, structuredClone(model));
    state.persist();
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  };
}

// A stray process.exit (for example a relay's recycle timer outliving its test) used to end the run early with code 0, so CI passed
// with half the tests unrun. During tests it is an error instead; a test that expects an exit replaces it for its own duration.
if (!harness) process.exit = ((code?: number) => { throw new Error(`process.exit(${code ?? ''}) was called during the test run`); }) as typeof process.exit;

// A preload afterAll can run at a file boundary. The process exit hook is the only
// place where closing the shared database cannot invalidate a later test file.
if (!harness) process.once('exit', () => {
  state.db.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* the folder is in the temp directory */ }
});

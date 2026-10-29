import { Database } from 'bun:sqlite';
import { randomBytes, createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Settings, Model, LogRow, Provider, McpServer } from './types';

// Windows keeps state under %LOCALAPPDATA%; Linux follows XDG (a service sets POLYGATE_STATE explicitly).
export const stateDir = process.env.POLYGATE_STATE || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'Polygate', 'state') : path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'polygate'));
// The folder holds the vault key, the encrypted settings and the activity database: owner-only where the platform supports it.
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const masterPath = path.join(stateDir, 'vault.key');
if (!existsSync(masterPath)) writeFileSync(masterPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
const master = readFileSync(masterPath);
// Written to a temporary file, flushed, then renamed over the old one: a crash leaves the old file or the new one, never half of one.
export function writeFileAtomic(file: string, data: string | Buffer, mode = 0o600) {
  const tmp = file + '.tmp'; const fd = openSync(tmp, 'w', mode);
  try { writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}
export const deriveKey = (label: string) => createHmac('sha256', master).update(label).digest();
const configPath = path.join(stateDir, 'settings.vault');
// Built-in providers: present in every install, switched off instead of deleted. Kilo's catalog is the same free tier the dashboard lists.
export const KILO_ID = 'kilo';
export const KILO_BASE = 'https://api.kilo.ai/api/gateway';
const kiloProvider = (): Provider => ({ id: KILO_ID, name: 'Kilo Free', kind: 'kilo', enabled: true, baseUrl: KILO_BASE, apiKey: '', models: [], routeId: '' });
// Settings saved before a built-in provider existed get it added (enabled, behind OpenCode in auto) without touching anything else.
export const withBuiltIns = (s: Settings): Settings => s.providers.some(p => p.id === KILO_ID) ? s : { ...s, providers: [...s.providers, kiloProvider()] };
export const initialSettings = (): Settings => ({
  enabled: true, maxConcurrent: 4, maxQueue: 32, timeoutMs: 120000, retries: 1, fallback: true,
  strategy: 'single', rotate: false, routeId: 'direct', refreshMinutes: 60, autoProbe: false, warpProxyPort: 40000,
  providers: [{ id: 'opencode', name: 'OpenCode Free', kind: 'free', enabled: true, baseUrl: '', apiKey: '', models: [], routeId: '' }, kiloProvider()],
  routes: [{ id: 'direct', name: 'Direct connection', kind: 'direct', url: '', enabled: true, models: [] }],
  keys: [{ id: crypto.randomUUID(), name: 'Local client', value: 'pg_' + randomBytes(24).toString('hex'), enabled: true, limit: 4 }]
});
function load(): Settings {
  if (!existsSync(configPath)) return initialSettings();
  try {
    const raw = readFileSync(configPath); const iv = raw.subarray(0, 12); const tag = raw.subarray(12, 28);
    const d = createDecipheriv('aes-256-gcm', master, iv); d.setAuthTag(tag);
    return withBuiltIns({ ...initialSettings(), ...JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString()) });
  } catch (e: any) {
    // The vault key and the vault no longer belong together (one was replaced or deleted) or the file is damaged. Starting with a clear message and a
    // copy kept aside is better than failing on every launch with a raw crypto error.
    const kept = configPath + '.unreadable-' + Date.now();
    try { renameSync(configPath, kept); } catch { /* it stays where it is */ }
    console.error(`[settings] Polygate could not open its saved settings (${e?.message || e}). The file was kept as ${kept}. Starting with default settings; if vault.key was replaced, put the original back and restore that file.`);
    return initialSettings();
  }
}
export let settings = load();
export function persist() {
  const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', master, iv);
  const body = Buffer.concat([c.update(JSON.stringify(settings)), c.final()]);
  // Written to a temporary file, flushed to disk, then renamed over the old one: a crash or power cut leaves either the old or the new
  // vault, never a truncated one that fails decryption at the next start.
  const tmp = configPath + '.tmp'; const fd = openSync(tmp, 'w', 0o600);
  try { writeSync(fd, Buffer.concat([iv, c.getAuthTag(), body])); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, configPath);
}
if(process.env.POLYGATE_READ_ONLY_STATE!=='1')persist();
export function equal(a: string, b: string) { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
export const db = new Database(path.join(stateDir, 'activity.sqlite'), { create: true });
db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY,time INTEGER,model TEXT,provider TEXT,protocol TEXT,route TEXT,status INTEGER,ms INTEGER,input INTEGER,output INTEGER,error TEXT,keyId TEXT); CREATE INDEX IF NOT EXISTS requests_time ON requests(time);');
// fault=1 marks rows where an upstream model returned the failing verdict; queue rejections, cancellations and local errors are not model faults.
if(!(db.query('PRAGMA table_info(requests)').all() as {name:string}[]).some(c=>c.name==='fault'))db.exec('ALTER TABLE requests ADD COLUMN fault INTEGER NOT NULL DEFAULT 0; UPDATE requests SET fault=1 WHERE status>=500 OR status=429;');
// detail is the request-shape record (sizes, counts, header names, upstream answer; no content) described in diagnostics.ts.
if(!(db.query('PRAGMA table_info(requests)').all() as {name:string}[]).some(c=>c.name==='detail'))db.exec('ALTER TABLE requests ADD COLUMN detail TEXT;');
// The request log keeps a week. This table keeps one row per day, model and route for 400 days, so usage over months stays on the Usage page.
// Days are UTC days. A new table is filled from the requests that are still in the log.
db.exec('CREATE TABLE IF NOT EXISTS usage_daily (day INTEGER NOT NULL, model TEXT NOT NULL, route TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, model, route));');
if (!(db.query('SELECT 1 FROM usage_daily LIMIT 1').get())) db.exec('INSERT INTO usage_daily (day,model,route,requests,errors,input,output,ms) SELECT time/86400000, model, route, COUNT(*), SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END), COALESCE(SUM(input),0), COALESCE(SUM(output),0), COALESCE(SUM(ms),0) FROM requests GROUP BY time/86400000, model, route');
// How each route did, per day: what the relay results table on the Relays page reads. outcome is ok, refused, used_up, redirected or failed. Kept 90 days.
db.exec('CREATE TABLE IF NOT EXISTS route_outcomes (day INTEGER NOT NULL, route TEXT NOT NULL, outcome TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, route, outcome));');
let lastOutcomePrune = 0;
export function tallyRoute(routeId: string, outcome: 'ok' | 'refused' | 'used_up' | 'redirected' | 'failed') {
  try {
    db.query('INSERT INTO route_outcomes (day,route,outcome,n) VALUES (?,?,?,1) ON CONFLICT(day,route,outcome) DO UPDATE SET n=n+1').run(Math.floor(Date.now() / 86400000), routeId, outcome);
    if (Date.now() - lastOutcomePrune > 3600000) { lastOutcomePrune = Date.now(); db.query('DELETE FROM route_outcomes WHERE day < ?').run(Math.floor(Date.now() / 86400000) - 90); }
  } catch { /* a counter is never worth failing a request */ }
}
export const models = new Map<string, Model>();
for (const row of db.query('SELECT data FROM models').all() as {data: string}[]) { try { const m = JSON.parse(row.data); models.set(m.id, m); } catch { /* a damaged row is skipped; the next catalog refresh adds the model again */ } }
export function saveModel(m: Model) { models.set(m.id, m); db.query('INSERT OR REPLACE INTO models VALUES (?,?)').run(m.id, JSON.stringify(m)); }
export function removeModels(providerId: string) { for (const [id, m] of models) if (m.providerId === providerId) { models.delete(id); db.query('DELETE FROM models WHERE id=?').run(id); } }
let lastPrune = 0;
export function record(row: LogRow) {
  db.query('INSERT INTO requests (id,time,model,provider,protocol,route,status,ms,input,output,error,keyId,fault,detail) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id,row.time,row.model,row.provider,row.protocol,row.route,row.status,row.ms,row.input,row.output,row.error.slice(0,800),row.keyId,row.fault?1:0,row.detail??null);
  db.query('INSERT INTO usage_daily (day,model,route,requests,errors,input,output,ms) VALUES (?,?,?,1,?,?,?,?) ON CONFLICT(day,model,route) DO UPDATE SET requests=requests+1, errors=errors+excluded.errors, input=input+excluded.input, output=output+excluded.output, ms=ms+excluded.ms').run(Math.floor(row.time / 86400000), row.model, row.route || '', row.status >= 400 ? 1 : 0, row.input || 0, row.output || 0, row.ms || 0);
  if (Date.now() - lastPrune > 60000) { lastPrune = Date.now(); db.query('DELETE FROM usage_daily WHERE day < ?').run(Math.floor(Date.now() / 86400000) - 400); db.query('DELETE FROM requests WHERE time < ?').run(Date.now() - 7 * 86400000);
    // A busy gateway can log far more than a week's worth in a day: the newest 100000 rows are the most that are kept.
    db.query('DELETE FROM requests WHERE time <= (SELECT time FROM requests ORDER BY time DESC LIMIT 1 OFFSET 100000)').run();
    // Failures keep their shape record for the whole retention window; successes only the latest 50, as a baseline to compare with.
    db.exec('UPDATE requests SET detail=NULL WHERE detail IS NOT NULL AND status<400 AND id NOT IN (SELECT id FROM requests WHERE detail IS NOT NULL AND status<400 ORDER BY time DESC LIMIT 50)'); }
}
export function logs(limit = 150) { return db.query('SELECT id,time,model,provider,protocol,route,status,ms,input,output,error,keyId,(detail IS NOT NULL) AS hasDetail FROM requests ORDER BY time DESC LIMIT ?').all(limit) as LogRow[]; }
export function requestDetail(id: string) { const r = db.query('SELECT id,time,model,provider,protocol,route,status,ms,input,output,error,keyId,detail FROM requests WHERE id=?').get(id) as any; if (!r) return undefined; const { detail, ...row } = r; return { ...row, detail: detail ? JSON.parse(detail) : null }; }
export function recentFailureDetails(limit = 20) { return (db.query('SELECT id,time,model,protocol,route,status,ms,error,detail FROM requests WHERE fault=1 AND detail IS NOT NULL ORDER BY time DESC LIMIT ?').all(limit) as any[]).map(({ detail, ...row }) => ({ ...row, detail: JSON.parse(detail) })); }
export function recentBaselineDetails(limit = 5) { return (db.query('SELECT id,time,model,protocol,route,status,ms,detail FROM requests WHERE status<400 AND detail IS NOT NULL ORDER BY time DESC LIMIT ?').all(limit) as any[]).map(({ detail, ...row }) => ({ ...row, detail: JSON.parse(detail) })); }
export function stats() { return db.query('SELECT COUNT(*) total, SUM(CASE WHEN status < 400 THEN 1 ELSE 0 END) success, COALESCE(AVG(ms),0) latency, COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output FROM requests WHERE time > ?').get(Date.now() - 86400000) as any; }
export function usagePenalties() { const out = new Map<string, number>(); for (const x of db.query('SELECT model,COUNT(*) n,SUM(fault) errors FROM requests WHERE time>? AND (fault=1 OR status<400) GROUP BY model').all(Date.now()-7*86400000) as {model: string, n: number, errors: number}[]) out.set(x.model, x.n < 5 ? 0 : x.errors/x.n >= .8 ? 8 : x.errors/x.n >= .5 ? 4 : 0); return out; }
export function publicSettings() { const { admin, ...rest } = settings; return { ...rest, deployTokens: settings.deployTokens ? Object.fromEntries(Object.entries(settings.deployTokens).filter(([, v]) => v).map(([k]) => [k, '••••••••'])) : undefined, notify: settings.notify ? { ...settings.notify, webhookUrl: settings.notify.webhookUrl ? '••••••••' : '' } : undefined, providers: settings.providers.map(p => ({ ...p, apiKey: p.apiKey ? '••••••••' : '' })), routes: settings.routes.map(r => ({ ...r, token: r.token ? '••••••••' : '', url: redactUrl(r.url) })), mcp: settings.mcp ? { ...settings.mcp, servers: settings.mcp.servers.map(maskMcp) } : undefined }; }
const maskValues = (o?: Record<string, string>) => o ? Object.fromEntries(Object.keys(o).map(k => [k, '••••••••'])) : undefined;
// Remote MCP addresses often carry their key in the query (?api_key=…): those values are secrets too.
const SECRET_PARAM = /key|token|secret|auth|pass|sig|credential/i;
export const secretParams = (raw?: string) => { try { return [...new URL(raw || '').searchParams].filter(([k, v]) => SECRET_PARAM.test(k) && v).map(([, v]) => v); } catch { return []; } };
export const maskUrl = (raw: string) => { try { const u = new URL(redactUrl(raw)); for (const [k, v] of [...u.searchParams]) if (SECRET_PARAM.test(k) && v) u.searchParams.set(k, '••••••••'); return u.toString(); } catch { return raw; } };
export const maskMcp = (s: McpServer): McpServer => ({ ...s, url: s.url ? maskUrl(s.url) : s.url, headers: maskValues(s.headers), env: maskValues(s.env) });
export function redactUrl(raw: string) { try { const u = new URL(raw); if (u.username || u.password) { u.username='redacted'; u.password='redacted'; } return u.toString(); } catch { return raw; } }
export function redactError(raw: string, max = 800) { let s = raw; for (const v of [...settings.providers.map(p=>p.apiKey),...settings.routes.flatMap(r=>[r.token||'',r.url]),...settings.keys.map(k=>k.value),...Object.values(settings.deployTokens||{}),...(settings.mcp?.servers||[]).flatMap(m=>[...Object.values(m.headers||{}),...Object.values(m.env||{}),...secretParams(m.url)])]) if(v.length>5) s=s.split(v).join('[redacted]'); return s.replace(/(Bearer\s+)[^\s"']+/gi,'$1[redacted]').slice(0,max); }

import { db, redactError } from './state';
// The Logs page: one timeline of what the gateway did (requests, model and route changes, dashboard actions, sign-ins, WARP, proxies,
// HTTPS, start and stop) and anything it printed. Entries are redacted before they are stored and kept for 7 days, at most 50,000 rows.
export type Level = 'info' | 'warn' | 'error';
export type LogEntry = { id: number; time: number; level: Level; source: string; message: string; detail: unknown };
export const LEVELS: Level[] = ['info', 'warn', 'error'];
const KEEP_MS = 7 * 86400000, KEEP_ROWS = 50000, MAX_PAGE = 500, MAX_EXPORT = 50000;
db.exec('CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, level TEXT NOT NULL, source TEXT NOT NULL, message TEXT NOT NULL, detail TEXT); CREATE INDEX IF NOT EXISTS events_time ON events(time);');
const insert = db.prepare('INSERT INTO events (time,level,source,message,detail) VALUES (?,?,?,?,?)');
const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
let lastPrune = 0, writing = false;
function store(level: Level, source: string, message: string, detail?: unknown) {
  if (writing) return; writing = true;   // a failure while storing must not log itself again
  try {
    const text = redactError(String(message).trim(), 4000); if (!text) return;
    insert.run(Date.now(), level, source.toLowerCase().slice(0, 40), text, detail === undefined ? null : redactError(JSON.stringify(detail), 16000));
    if (Date.now() - lastPrune > 60000) { lastPrune = Date.now(); db.query('DELETE FROM events WHERE time < ?').run(Date.now() - KEEP_MS); db.query('DELETE FROM events WHERE id <= (SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?)').run(KEEP_ROWS); }
  } catch { /* logging never breaks the gateway */ } finally { writing = false; }
}
// Records an event and prints it, so service logs (journald, gateway.log, docker logs) keep the same line. Successful requests are
// only stored: printing every one would flood those logs. Test runs stay quiet.
export function logEvent(level: Level, source: string, message: string, detail?: unknown) {
  store(level, source, message, detail);
  if (process.env.NODE_ENV === 'test' || (source === 'requests' && level === 'info')) return;
  (level === 'error' ? original.error : level === 'warn' ? original.warn : original.log)(`[${source}] ${redactError(message, 4000)}`);
}
// Printed tags that belong to a part of Polygate the Logs page already names.
const aliases: Record<string, string> = { 'opencode-free-bridge': 'providers', catalog: 'models', state: 'gateway' };
// Everything the gateway prints also lands in the log; "[warp] …" lines are filed under warp. JSON lines are for the desktop app and installer.
export function captureConsole() {
  const text = (args: unknown[]) => args.map(a => typeof a === 'string' ? a : a instanceof Error ? a.stack || a.message : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()).join(' ');
  for (const [method, level] of [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error']] as const) {
    console[method] = (...args: unknown[]) => {
      original[method](...args);
      const line = text(args); if (line.startsWith('{')) return;
      const tag = /^\[([a-z][\w -]{0,30})\]\s*/i.exec(line);
      store(level, tag ? aliases[tag[1].toLowerCase()] || tag[1] : 'gateway', tag ? line.slice(tag[0].length) : line);
    };
  }
}
export type LogQuery = { levels?: Level[]; sources?: string[]; q?: string; from?: number; to?: number; before?: number; after?: number; limit?: number };
function where(f: LogQuery, withFacets = true) {
  const parts: string[] = [], args: (string | number)[] = [];
  if (f.from) { parts.push('time >= ?'); args.push(f.from); }
  if (f.to) { parts.push('time <= ?'); args.push(f.to); }
  if (withFacets && f.levels?.length) { parts.push(`level IN (${f.levels.map(() => '?').join(',')})`); args.push(...f.levels); }
  if (withFacets && f.sources?.length) { parts.push(`source IN (${f.sources.map(() => '?').join(',')})`); args.push(...f.sources); }
  if (f.q) { parts.push("(message LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')"); const like = '%' + f.q.replace(/[\\%_]/g, c => '\\' + c) + '%'; args.push(like, like); }
  return { sql: parts.length ? ' WHERE ' + parts.join(' AND ') : '', args };
}
const row = (r: any): LogEntry => ({ ...r, detail: r.detail ? (() => { try { return JSON.parse(r.detail); } catch { return r.detail; } })() : null });
// Newest first. "before" pages back through older entries; "after" returns only entries newer than the last one seen (live view).
export function queryEvents(f: LogQuery) {
  const w = where(f); const limit = Math.max(1, Math.min(MAX_PAGE, f.limit || 200));
  const page = (cond: string, value?: number, asc = false) => { const sql = 'SELECT id,time,level,source,message,detail FROM events' + (w.sql ? w.sql + (cond ? ' AND ' + cond : '') : cond ? ' WHERE ' + cond : '') + (asc ? ' ORDER BY id ASC LIMIT ?' : ' ORDER BY id DESC LIMIT ?'); return (db.query(sql).all(...w.args, ...(value === undefined ? [] : [value]), limit + 1) as any[]); };
  // "after" takes the oldest rows newer than the last one seen, so a burst larger than one page is read in order over the next polls instead of skipping the gap.
  const rows = f.after ? page('id > ?', f.after, true) : f.before ? page('id < ?', f.before) : page('');
  const more = rows.length > limit; const entries = (f.after ? rows.slice(0, limit).reverse() : rows.slice(0, limit)).map(row);
  // Counts ignore the level and source filters, so each filter chip shows what choosing it would add.
  const scope = where({ ...f, levels: undefined, sources: undefined }, false);
  const levels = Object.fromEntries((db.query('SELECT level, COUNT(*) n FROM events' + scope.sql + ' GROUP BY level').all(...scope.args) as any[]).map(x => [x.level, x.n]));
  const sources = (db.query('SELECT source, COUNT(*) n FROM events' + scope.sql + ' GROUP BY source ORDER BY n DESC').all(...scope.args) as any[]).map(x => ({ source: x.source as string, count: x.n as number }));
  return { entries, more: !f.after && more, levels, sources, total: (db.query('SELECT COUNT(*) n FROM events' + w.sql).get(...w.args) as any).n as number };
}
export function exportEvents(f: LogQuery, format: 'txt' | 'json') {
  const w = where(f); const rows = (db.query('SELECT id,time,level,source,message,detail FROM events' + w.sql + ' ORDER BY id ASC LIMIT ?').all(...w.args, MAX_EXPORT) as any[]).map(row);
  if (format === 'json') return rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  return rows.map(r => `${new Date(r.time).toISOString()}  ${r.level.toUpperCase().padEnd(5)}  ${r.source.padEnd(10)}  ${r.message}${r.detail ? '  ' + JSON.stringify(r.detail) : ''}`).join('\n') + (rows.length ? '\n' : '');
}
export function clearEvents() { db.exec('DELETE FROM events'); }
// Dashboard and manager actions (POST to /admin/…) in plain words, filed under the part of Polygate they change.
const actions: Record<string, [string, string]> = {
  '/admin/settings': ['settings', 'Gateway settings saved'], '/admin/chains/save': ['chains', 'Model chain saved'], '/admin/chains/delete': ['chains', 'Model chain deleted'], '/admin/password': ['auth', 'Dashboard password changed'], '/admin/signout-all': ['auth', 'Sign-out on every device'],
  '/admin/shutdown': ['gateway', 'Shutdown requested'], '/admin/identity/refresh': ['providers', 'OpenCode identity refreshed'],
  '/admin/discover': ['models', 'Model catalog refreshed'], '/admin/probe': ['models', 'Model availability checked'], '/admin/model': ['models', 'Model settings changed'],
  '/admin/providers': ['providers', 'Provider saved'], '/admin/providers/delete': ['providers', 'Provider removed'],
  '/admin/routes': ['routes', 'Route saved'], '/admin/routes/delete': ['routes', 'Route removed'], '/admin/routes/toggle': ['routes', 'Route switched on or off'], 
  '/admin/relays/deploy': ['relays', 'Relay deployed'], '/admin/relays/inspect': ['relays', 'Relay checked'],
  '/admin/keys': ['keys', 'Client API key created'], '/admin/keys/update': ['keys', 'Client API key changed'], '/admin/keys/delete': ['keys', 'Client API key deleted'],
  '/admin/pool/settings': ['proxies', 'Proxy pool settings saved'], '/admin/pool/test': ['proxies', 'Proxy pool test started'], '/admin/pool/stop': ['proxies', 'Proxy pool test stopped'], '/admin/pool/find': ['proxies', 'Proxy search started'], '/admin/pool/role': ['proxies', 'Proxy role changed'],
  '/admin/proxies/scan': ['proxies', 'Proxy scan started'], '/admin/proxies/import': ['proxies', 'Proxies imported'], '/admin/proxies/remove': ['proxies', 'Proxies removed'], '/admin/proxies/stop': ['proxies', 'Proxy scan stopped'], '/admin/proxies/sources': ['proxies', 'Proxy list links saved'], '/admin/proxy/attach': ['proxies', 'Proxy attached to a route'],
  '/admin/warp/connect': ['warp', 'WARP connection requested'], '/admin/warp/disconnect': ['warp', 'WARP disconnected'], '/admin/warp/install': ['warp', 'WARP install started'], '/admin/warp/rotate': ['warp', 'New WARP identity requested'], '/admin/warp/settings': ['warp', 'WARP settings saved'],
  '/admin/https/apply': ['https', 'HTTPS setup started'], '/admin/https/disable': ['https', 'HTTPS turned off'], '/admin/https/renew': ['https', 'HTTPS certificate renewal requested'],
  '/admin/notify/settings': ['notify', 'Notification settings saved'], '/admin/notify/test': ['notify', 'Test notification sent'], '/admin/notifications/clear': ['notify', 'Notifications cleared'],
  '/admin/mcp/settings': ['mcp', 'MCP hub settings saved'], '/admin/mcp/servers': ['mcp', 'MCP server saved'], '/admin/mcp/servers/delete': ['mcp', 'MCP server removed'], '/admin/mcp/servers/toggle': ['mcp', 'MCP server switched on or off'],
  '/admin/mcp/servers/tools': ['mcp', 'MCP tool choice saved'], '/admin/mcp/servers/reconnect': ['mcp', 'MCP server reconnected'], '/admin/mcp/import': ['mcp', 'MCP servers imported'],
  '/admin/logs/clear': ['requests', 'Request activity cleared'], '/admin/events/clear': ['logs', 'Logs cleared'], '/admin/updates/check': ['updates', 'Update check'],
};
// [where, what happened, what was attempted (for "… failed: reason")]
export const adminAction = (p: string): [string, string, string] | undefined => {
  const a = actions[p]; if (!a) return undefined;
  const attempted = a[1].replace(/ (saved|removed|started|changed|created|deleted|requested|tested|checked|imported|attached|refreshed|cleared|sent|deployed|disconnected|stopped|turned off|switched on or off)$/, '');
  return [a[0], a[1], attempted === a[1] ? a[1] : attempted];
};
// Reads the filters from a query string, ignoring anything malformed.
export function parseLogQuery(params: URLSearchParams): LogQuery {
  const list = (k: string) => (params.get(k) || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const num = (k: string) => { const n = Number(params.get(k)); return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined; };
  return { levels: list('level').filter((l): l is Level => (LEVELS as string[]).includes(l)), sources: list('source').map(s => s.slice(0, 40)), q: (params.get('q') || '').trim().slice(0, 200) || undefined, from: num('from'), to: num('to'), before: num('before'), after: num('after'), limit: num('limit') };
}

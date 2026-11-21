import { db, settings, models } from './state';
import { queue, readiness } from './gateway';
type Row = Record<string, number | string | null>;
const rows = (sql: string, ...args: (number | string)[]) => db.query(sql).all(...args) as Row[];
const one = (sql: string, ...args: (number | string)[]) => (db.query(sql).get(...args) || {}) as Row;
const percentile = (sorted: number[], p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
// Keys by their current name; a key deleted since is shown with the start of its id, so two deleted keys stay apart.
const keyName = (id: string) => !id ? 'No key' : settings.keys.find(k => k.id === id)?.name || `Deleted key ${id.slice(0, 6)}`;
// The message a provider or the gateway gave, without the JSON around it.
export function failureText(raw: string) {
  let text = String(raw || '').trim();
  try { const parsed = JSON.parse(text); const inner = parsed?.error?.message ?? parsed?.message ?? parsed?.error; if (typeof inner === 'string') text = inner; } catch { /* not JSON: the text is the message */ }
  return text.replace(/\s+/g, ' ').slice(0, 160);
}
// The most common failures in the period; numbers are left out when comparing, so the same failure counts as one. A client that hung up (499) is not a failure of anything.
function topFailures(since: number, until: number) {
  const seen = new Map<string, { message: string; status: number; count: number; lastAt: number; model: string }>();
  for (const r of rows('SELECT status, error, model, time FROM requests WHERE time>? AND time<=? AND status>=400 AND status<>499 ORDER BY time DESC LIMIT 5000', since, until)) {
    const message = failureText(String(r.error || '')) || `HTTP ${r.status}`; const key = `${r.status}:${message.replace(/\d+/g, '#')}`;
    const had = seen.get(key); if (had) had.count++; else seen.set(key, { message, status: Number(r.status), count: 1, lastAt: Number(r.time), model: String(r.model || '') });
  }
  return [...seen.values()].sort((a, b) => b.count - a.count).slice(0, 5);
}
const hourMs = 3600000;
// A rollup survives log pruning but cannot be split at a timestamp. Count only retained detail for
// historical partial hours; if some is gone this is a lower bound, not an estimate from the entire hour.
function windowHours(since: number, until: number, live = false) {
  // (since, until] in integer milliseconds; the middle contains precisely the complete buckets.
  const first = Math.ceil((since + 1) / hourMs);
  let end = Math.floor((until + 1) / hourMs);
  // Ordinarily the live bucket only contains traffic through now. Keep its rollup too unless the
  // clock moved backwards. For a historical cutoff, never assume missing detail was on either side.
  if (live && (until + 1) % hourMs !== 0 && !one('SELECT 1 n FROM requests WHERE time>? AND time<? LIMIT 1', until, (end + 1) * hourMs).n) end++;
  return db.query(`SELECT hour h, requests n, errors, input, output, ms FROM usage_hourly WHERE hour>=? AND hour<?
    UNION ALL SELECT time/3600000 h, COUNT(*), SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END), COALESCE(SUM(input),0), COALESCE(SUM(output),0), COALESCE(SUM(ms),0)
    FROM requests WHERE (time>? AND time<?) OR (time>=? AND time<=?) GROUP BY time/3600000 ORDER BY h`).all(first, end, since, first * hourMs, end * hourMs, until) as {h: number, n: number, errors: number, input: number, output: number, ms: number}[];
}
export function metrics(now = Date.now()) {
  const day = now - 86400000; const minute = now - 60000;
  const hourly = windowHours(day, now, true);
  const sum = (key: 'n' | 'errors' | 'input' | 'output' | 'ms') => hourly.reduce((s, r) => s + r[key], 0);
  const n = sum('n'), errors = sum('errors');
  const latencies = rows('SELECT ms FROM requests WHERE time>? AND time<=? AND status<400 ORDER BY ms', day, now).map(r => Number(r.ms)); const live = one('SELECT COUNT(*) n, COALESCE(SUM(input+output),0) tokens FROM requests WHERE time>? AND time<=?', minute, now);
  const speed = one('SELECT COALESCE(SUM(output),0) out, COALESCE(SUM(ms),0) ms FROM requests WHERE time>? AND time<=? AND status<400 AND output>0', day, now);
  const byModel = rows('SELECT model, COUNT(*) n, SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END) errors, COALESCE(SUM(input+output),0) tokens, COALESCE(AVG(ms),0) avg FROM requests WHERE time>? AND time<=? GROUP BY model ORDER BY n DESC LIMIT 12', day, now);
  const byRoute = rows("SELECT CASE WHEN route='' THEN '-' ELSE route END route, COUNT(*) n, SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END) errors, COALESCE(AVG(ms),0) avg FROM requests WHERE time>? AND time<=? GROUP BY route ORDER BY n DESC LIMIT 12", day, now);
  const byStatus = rows('SELECT status, COUNT(*) n FROM requests WHERE time>? AND time<=? GROUP BY status ORDER BY n DESC LIMIT 8', day, now);
  // Where the requests went and came from, and what failed: the Overview's summary and the Routing map's line weights.
  const byProvider = rows('SELECT provider, COUNT(*) n, SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END) errors, COALESCE(SUM(input+output),0) tokens, COALESCE(AVG(ms),0) avg FROM requests WHERE time>? AND time<=? GROUP BY provider ORDER BY n DESC LIMIT 60', day, now);
  const byLink = rows("SELECT provider, route, COUNT(*) n FROM requests WHERE time>? AND time<=? AND route<>'' GROUP BY provider, route LIMIT 500", day, now);
  const byKey = rows('SELECT keyId, COUNT(*) n, COALESCE(SUM(input+output),0) tokens FROM requests WHERE time>? AND time<=? GROUP BY keyId ORDER BY n DESC LIMIT 8', day, now);
  const before = windowHours(day - 86400000, day);
  return {
    uptimeSeconds: Math.round(process.uptime()), requests: n, successRate: n ? Math.round((n - errors) / n * 1000) / 10 : null, errors,
    inputTokens: sum('input'), outputTokens: sum('output'), avgMs: n ? Math.round(sum('ms') / n) : 0, p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99),
    rpm: Number(live.n), tpm: Number(live.tokens), tokensPerSecond: Number(speed.ms) ? Math.round(Number(speed.out) / (Number(speed.ms) / 1000) * 10) / 10 : 0,
    hourly: hourly.map(r => ({ hour: r.h * hourMs, requests: r.n, errors: r.errors, tokens: r.input + r.output, avgMs: r.n ? Math.round(r.ms / r.n) : 0 })),
    byModel: byModel.map(r => ({ model: r.model, requests: Number(r.n), errors: Number(r.errors), tokens: Number(r.tokens), avgMs: Math.round(Number(r.avg)) })),
    byRoute: byRoute.map(r => ({ route: r.route, requests: Number(r.n), errors: Number(r.errors), avgMs: Math.round(Number(r.avg)) })),
    byStatus: byStatus.map(r => ({ status: Number(r.status), requests: Number(r.n) })),
    byProvider: byProvider.map(r => ({ provider: String(r.provider), requests: Number(r.n), errors: Number(r.errors), tokens: Number(r.tokens), avgMs: Math.round(Number(r.avg)) })),
    byLink: byLink.map(r => ({ provider: String(r.provider), route: String(r.route), requests: Number(r.n) })),
    byKey: byKey.map(r => ({ name: keyName(String(r.keyId || '')), requests: Number(r.n), tokens: Number(r.tokens) })),
    previousRequests: before.reduce((s, r) => s + r.n, 0), failures: topFailures(day, now),
    keys: settings.keys.map(k => ({ id: k.id, name: k.name, requests: k.requests || 0, tokens: k.used || 0, budget: k.budget || 0, lastUsed: k.lastUsed || 0 })),
  };
}
// Prometheus text exposition for scrapers.
export function prometheus() {
  const m = metrics(); const r = readiness(); const lines: string[] = [];
  const add = (name: string, help: string, type: string, samples: [string, number][]) => { lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`); for (const [labels, value] of samples) lines.push(`${name}${labels} ${value}`); };
  add('polygate_requests_24h', 'Requests in the last 24 hours.', 'gauge', [['{result="success"}', m.requests - m.errors], ['{result="error"}', m.errors]]);
  add('polygate_tokens_24h', 'Tokens in the last 24 hours.', 'gauge', [['{type="input"}', m.inputTokens], ['{type="output"}', m.outputTokens]]);
  add('polygate_latency_ms', 'Successful request latency over 24 hours.', 'gauge', [['{quantile="0.5"}', m.p50], ['{quantile="0.95"}', m.p95], ['{quantile="0.99"}', m.p99]]);
  add('polygate_requests_per_minute', 'Requests in the last minute.', 'gauge', [['', m.rpm]]);
  add('polygate_queue', 'Admission queue state.', 'gauge', [['{state="active"}', queue.active], ['{state="waiting"}', queue.waiting.length]]);
  add('polygate_ready', '1 when the gateway can serve requests.', 'gauge', [['', r.ready ? 1 : 0]]);
  add('polygate_models_ready', 'Models that are not unavailable.', 'gauge', [['', [...models.values()].filter(x => x.state === 'available' || x.state === 'unchecked').length]]);
  add('polygate_routes_up', 'Enabled routes that are not cooling down.', 'gauge', [['', r.routes]]);
  add('polygate_uptime_seconds', 'Process uptime.', 'counter', [['', m.uptimeSeconds]]);
  return lines.join('\n') + '\n';
}
// Usage over time from the daily summary (kept 400 days, unlike the request log). Days are UTC days; every day in the range is present, with zeros when idle.
export function usage(rawDays: number) {
  const days = [7, 30, 90, 365].includes(rawDays) ? rawDays : 30; const today = Math.floor(Date.now() / 86400000); const first = today - days + 1;
  const base = rows('SELECT day, COALESCE(SUM(requests),0) n, COALESCE(SUM(errors),0) errors, COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output, COALESCE(SUM(ms),0) ms FROM usage_daily WHERE day>=? GROUP BY day', first);
  const daily = Array.from({ length: days }, (_, i) => { const r = base.find(x => Number(x.day) === first + i); return { day: (first + i) * 86400000, requests: Number(r?.n || 0), errors: Number(r?.errors || 0), input: Number(r?.input || 0), output: Number(r?.output || 0) }; });
  const group = (column: 'model' | 'route' | 'key', table = 'usage_daily', label = (name: string) => name || '-') => {
    const top = rows(`SELECT ${column} name, SUM(requests) n, SUM(errors) errors, SUM(input+output) tokens, SUM(ms) ms FROM ${table} WHERE day>=? GROUP BY ${column} ORDER BY n DESC LIMIT 10`, first);
    return top.map(t => { const per = rows(`SELECT day, SUM(requests) n FROM ${table} WHERE day>=? AND ${column}=? GROUP BY day`, first, String(t.name)); const n = Number(t.n);
      return { name: label(String(t.name)), requests: n, errors: Number(t.errors), tokens: Number(t.tokens), avgMs: n ? Math.round(Number(t.ms) / n) : 0, daily: Array.from({ length: days }, (_, i) => Number(per.find(x => Number(x.day) === first + i)?.n || 0)) }; });
  };
  const requests = daily.reduce((s, d) => s + d.requests, 0); const busiest = daily.reduce((b, d) => d.requests > b.requests ? d : b, daily[0]);
  return { days, daily, models: group('model'), routes: group('route'), keys: group('key', 'usage_keys_daily', keyName), totals: { requests, errors: daily.reduce((s, d) => s + d.errors, 0), input: daily.reduce((s, d) => s + d.input, 0), output: daily.reduce((s, d) => s + d.output, 0), activeDays: daily.filter(d => d.requests).length, busiestDay: busiest.requests ? busiest.day : 0, busiestRequests: busiest.requests } };
}
// How each relay has done lately, from the per-day outcome counters (route_outcomes). A relay that has never worked while being refused, redirected or failing
// over several days is flagged, so a region OpenCode does not accept from can be replaced by one it does.
export function relayReport(days: number) {
  const first = Math.floor(Date.now() / 86400000) - days + 1;
  const counts = rows('SELECT route, outcome, SUM(n) n FROM route_outcomes WHERE day>=? GROUP BY route, outcome', first);
  const seen = rows('SELECT route, COUNT(DISTINCT day) d FROM route_outcomes WHERE day>=? GROUP BY route', first);
  const relays = settings.routes.filter(r => r.kind === 'relay').map(r => {
    const n = (outcome: string) => Number(counts.find(c => c.route === r.id && c.outcome === outcome)?.n || 0);
    const ok = n('ok'), refused = n('refused'), usedUp = n('used_up'), redirected = n('redirected'), failed = n('failed'); const bad = refused + redirected + failed; const total = ok + usedUp + bad; const activeDays = Number(seen.find(s => s.route === r.id)?.d || 0);
    const region = r.deployed?.region || /^\w+ relay ([a-z]{3}\d) /.exec(r.name)?.[1] || '';
    let tone: 'good' | 'warn' | 'bad' | 'neutral' = 'good'; let advice = 'Working.';
    if (!total) { tone = 'neutral'; advice = 'Nothing has gone through it in this period.'; }
    else if (!ok && bad >= 5 && activeDays >= 2) { tone = 'bad'; advice = `It has never worked in this period (${bad} refused, redirected or failed over ${activeDays} days). Another region may be accepted.`; }
    else if (!ok && bad >= 3) { tone = 'warn'; advice = 'Nothing has worked through it yet. Give it a little longer, or try another region.'; }
    else if (!ok && usedUp && !bad) { tone = 'neutral'; advice = 'OpenCode returned limit/access errors with a retry time. This does not prove the relay failed or guarantee a daily reset.'; }
    else if (bad > ok) { tone = 'warn'; advice = 'It fails more often than it works.'; }
    return { id: r.id, name: r.name, region, platform: r.deployed?.platform || '', enabled: r.enabled, ok, refused, usedUp, redirected, failed, activeDays, tone, advice };
  });
  return { days, relays };
}

import { db, settings, models } from './state';
import { queue, readiness } from './gateway';
type Row = Record<string, number | string | null>;
const rows = (sql: string, ...args: (number | string)[]) => db.query(sql).all(...args) as Row[];
const one = (sql: string, ...args: (number | string)[]) => (db.query(sql).get(...args) || {}) as Row;
const percentile = (sorted: number[], p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
// Everything the dashboard charts come from the request log, so the numbers survive restarts and match the Requests page.
export function metrics() {
  const now = Date.now(); const day = now - 86400000; const minute = now - 60000;
  const total = one('SELECT COUNT(*) n, SUM(CASE WHEN status<400 THEN 1 ELSE 0 END) ok, COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output, COALESCE(AVG(ms),0) avg FROM requests WHERE time>?', day);
  const latencies = rows('SELECT ms FROM requests WHERE time>? AND status<400 ORDER BY ms', day).map(r => Number(r.ms)); const live = one('SELECT COUNT(*) n, COALESCE(SUM(input+output),0) tokens FROM requests WHERE time>?', minute);
  const speed = one('SELECT COALESCE(SUM(output),0) out, COALESCE(SUM(ms),0) ms FROM requests WHERE time>? AND status<400 AND output>0', day);
  const hourly = rows('SELECT (time/3600000) h, COUNT(*) n, SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END) errors, COALESCE(SUM(input+output),0) tokens, COALESCE(AVG(ms),0) avg FROM requests WHERE time>? GROUP BY h ORDER BY h', now - 24 * 3600000);
  const byModel = rows('SELECT model, COUNT(*) n, SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END) errors, COALESCE(SUM(input+output),0) tokens, COALESCE(AVG(ms),0) avg FROM requests WHERE time>? GROUP BY model ORDER BY n DESC LIMIT 12', day);
  const byRoute = rows("SELECT CASE WHEN route='' THEN '—' ELSE route END route, COUNT(*) n, SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END) errors, COALESCE(AVG(ms),0) avg FROM requests WHERE time>? GROUP BY route ORDER BY n DESC LIMIT 12", day);
  const byStatus = rows('SELECT status, COUNT(*) n FROM requests WHERE time>? GROUP BY status ORDER BY n DESC LIMIT 8', day);
  const n = Number(total.n) || 0;
  return {
    uptimeSeconds: Math.round(process.uptime()), requests: n, successRate: n ? Math.round(Number(total.ok) / n * 1000) / 10 : null, errors: n - Number(total.ok || 0),
    inputTokens: Number(total.input), outputTokens: Number(total.output), avgMs: Math.round(Number(total.avg)), p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99),
    rpm: Number(live.n), tpm: Number(live.tokens), tokensPerSecond: Number(speed.ms) ? Math.round(Number(speed.out) / (Number(speed.ms) / 1000) * 10) / 10 : 0,
    hourly: hourly.map(r => ({ hour: Number(r.h) * 3600000, requests: Number(r.n), errors: Number(r.errors), tokens: Number(r.tokens), avgMs: Math.round(Number(r.avg)) })),
    byModel: byModel.map(r => ({ model: r.model, requests: Number(r.n), errors: Number(r.errors), tokens: Number(r.tokens), avgMs: Math.round(Number(r.avg)) })),
    byRoute: byRoute.map(r => ({ route: r.route, requests: Number(r.n), errors: Number(r.errors), avgMs: Math.round(Number(r.avg)) })),
    byStatus: byStatus.map(r => ({ status: Number(r.status), requests: Number(r.n) })),
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

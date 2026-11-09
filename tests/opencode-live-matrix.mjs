// Live OpenCode free-tier shape matrix. Diagnostic only: imports nothing from
// the gateway, edits nothing, changes no config.
//
//   bun tests/opencode-live-matrix.mjs --direct --tag ip1
//   bun tests/opencode-live-matrix.mjs --relay --tag relay1
//   RELAY_URL=https://x.vercel.app RELAY_KEY=... bun tests/opencode-live-matrix.mjs --relay
//   bun tests/opencode-live-matrix.mjs --compare .state/oc-ip1.json .state/oc-ip2.json
//
// Every variant changes ONE thing from the reference v2 shape. A variant that
// returns 200 while the reference returns 429/403 means that field is not the
// cause. A reference that 200s means the shape is fine and the gateway, not the
// upstream, is losing the request.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const MODEL = process.env.MODEL || 'deepseek-v4.1-flash-free';
const CHAT_PATH = '/inference/openai/v1/chat/completions';
const HOST = 'opencode.ai';
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const rnd = (n, set) => Array.from({ length: n }, () => set[Math.floor(Math.random() * set.length)]).join('');

let ctr = 0;
function sessionId(len = 30, counterCap = 15) {
  const ms = BigInt(Date.now());
  const c = BigInt(++ctr % counterCap);
  const v = ~((ms << 12n) | c) & ((1n << 48n) - 1n);
  const hex = v.toString(16).padStart(12, '0');
  return `ses_${hex}${rnd(Math.max(0, len - 16), B62)}`;
}
function oldSession(len = 26) {
  return `ses_${crypto.randomBytes(16).toString('hex').slice(0, 12)}${rnd(len - 16, B62)}`;
}
function traceHeaders() {
  const t = crypto.randomBytes(16).toString('hex');
  const s = crypto.randomBytes(8).toString('hex');
  const p = crypto.randomBytes(8).toString('hex');
  return { b3: `${t}-${s}-1-${p}`, traceparent: `00-${t}-${s}-01` };
}
function projectHash() {
  return crypto.createHash('sha1').update(`directory:${root}`).digest('hex');
}

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'opencode-2.2.5-windows-tools.json'), 'utf8'));
const FULL_TOOLS = fixture.tools;
const tool = (name) => ({ type: 'function', function: { name, description: 't', parameters: { type: 'object', properties: {} } } });
const CORE6 = ['edit', 'glob', 'grep', 'read', 'shell', 'write'];

const ENV_BLOCK = `<env>\n  Working directory: ${root}\n  Platform: win32\n  Shell: pwsh\n</env>`;

function build({ base = '/' + CHAT_PATH.replace(/^\//, ''), ua = 'opencode/latest/2.2.5/cli', session = sessionId(), sessionHeaders = 'four', tools = FULL_TOOLS, stream = true, env = true, project = projectHash(), tracing = true, streamOptions = true, maxField = 'max_completion_tokens' } = {}) {
  const headers = {
    authorization: 'Bearer public',
    'content-type': 'application/json',
    accept: '*/*',
    'user-agent': ua,
    'x-opencode-client': 'cli',
    'x-opencode-project': project,
  };
  if (sessionHeaders === 'four') {
    headers['x-opencode-session'] = session;
    headers['x-opencode-session-id'] = session;
    headers['x-session-affinity'] = session;
    headers['x-session-id'] = session;
  } else if (sessionHeaders === 'pair') {
    headers['x-opencode-session'] = session;
    headers['x-opencode-session-id'] = session;
  } else if (sessionHeaders === 'affinity') {
    headers['x-opencode-session'] = session;
    headers['x-session-affinity'] = session;
  } else if (sessionHeaders === 'none') {
    // nothing
  }
  if (tracing) Object.assign(headers, traceHeaders());

  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: 'You are a coding agent.' + (env ? '\n' + ENV_BLOCK : '') },
      { role: 'user', content: 'Reply with exactly: OK' },
    ],
    tools,
    stream,
    ...(streamOptions && stream ? { stream_options: { include_usage: true } } : {}),
    [maxField]: maxField === 'max_completion_tokens' ? 32000 : 16,
  };
  return { url: `https://${HOST}${base}`, headers, body: JSON.stringify(body) };
}

const variants = [
  ['00 reference v2', {}],
  ['01 polygate-current', { base: '/inference/v1/chat/completions', ua: 'opencode/latest/2.0.32/cli', session: oldSession(), tools: [tool('read')], streamOptions: false, maxField: 'max_tokens' }],
  ['02 old base only', { base: '/inference/v1/chat/completions' }],
  ['03 UA 2.0.32', { ua: 'opencode/latest/2.0.32/cli' }],
  ['04 session 26 chars', { session: oldSession() }],
  ['05 tools read only', { tools: [tool('read')] }],
  ['06 tools core6', { tools: CORE6.map(tool) }],
  ['07 no tracing headers', { tracing: false }],
  ['08 project global', { project: 'global' }],
  ['09 no env block', { env: false }],
  ['10 stream false', { stream: false }],
  ['11 session pair only', { sessionHeaders: 'pair' }],
  ['12 affinity only', { sessionHeaders: 'affinity' }],
  ['13 no session headers', { sessionHeaders: 'none' }],
  ['14 no stream_options', { streamOptions: false }],
];

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const TAG = val('--tag', 'run');
const RUNS = Number(val('--runs', '0'));
const RELAY_URL = process.env.RELAY_URL || val('--relay-url', '');
const RELAY_KEY = process.env.RELAY_KEY || val('--relay-key', '');

if (has('--compare')) {
  const a = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--compare') + 1], 'utf8'));
  const b = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--compare') + 2], 'utf8'));
  console.log(`A=${a.tag} egress=${a.egress}\nB=${b.tag} egress=${b.egress}\n`);
  console.log('variant'.padEnd(24), 'A'.padEnd(34), 'B');
  for (const v of a.rows) {
    const m = b.rows.find((x) => x.name === v.name) || {};
    console.log(v.name.padEnd(24), `${v.status} ${v.type}`.padEnd(34), `${m.status ?? '-'} ${m.type ?? ''}`);
  }
  process.exit(0);
}

async function send(built, relay) {
  const started = Date.now();
  try {
    let res;
    if (relay) {
      const h = { ...built.headers, 'x-relay-key': RELAY_KEY, 'x-relay-target': `https://${HOST}`, 'x-relay-path': new URL(built.url).pathname };
      res = await fetch(RELAY_URL, { method: 'POST', headers: h, body: built.body, signal: AbortSignal.timeout(120000) });
    } else {
      res = await fetch(built.url, { method: 'POST', headers: built.headers, body: built.body, signal: AbortSignal.timeout(60000) });
    }
    const text = (await res.text()).slice(0, 600);
    let type = '', msg = text.slice(0, 80).replace(/\s+/g, ' ');
    let ok = false;
    try {
      const j = JSON.parse(text);
      type = j.error?.type || j.type || '';
      msg = j.error?.message || j.message || msg;
      ok = !j.error && (j.choices || j.output || j.id);
    } catch { ok = /^data:/.test(text) || text.includes('"choices"'); }
    return {
      status: res.status,
      type,
      msg: String(msg).slice(0, 180),
      retryAfter: res.headers.get('retry-after') || '',
      logId: res.headers.get('x-opencode-log-id') || '',
      gate: res.headers.get('x-opencode-gate') || '',
      relayEgress: res.headers.get('x-relay-egress') || '',
      relayRuntime: res.headers.get('x-relay-runtime') || '',
      ms: Date.now() - started,
      ok,
    };
  } catch (e) {
    return { status: 'ERR', type: String(e?.name || ''), msg: String(e?.message || e).slice(0, 180), ms: Date.now() - started, ok: false };
  }
}

async function egress() {
  try {
    const r = await fetch(`https://${HOST}/cdn-cgi/trace`, { signal: AbortSignal.timeout(8000) });
    const t = await r.text();
    return {
      ip: (t.match(/^ip=(.+)$/m) || [])[1] || '',
      loc: (t.match(/^loc=(.+)$/m) || [])[1] || '',
      colo: (t.match(/^colo=(.+)$/m) || [])[1] || '',
    };
  } catch { return { ip: 'unknown' }; }
}

function classify(r) {
  if (r.ok) return 'OK';
  if (r.gate === 'ip-abuse' || /abusive|ip-abuse|current network/i.test(r.msg)) return 'IP-ABUSE';
  if (/not available in your country|regione/i.test(r.msg)) return 'REGION';
  if (r.status === 429 || /FreeUsageLimitError|usage limit/i.test(r.type + r.msg)) return 'QUOTA-or-SHAPE(429)';
  if (/can only be used from within opencode|FreeTierError/i.test(r.type + r.msg)) return 'SHAPE(403)';
  if (r.status === 401) return 'AUTH';
  if (r.status === 426) return 'STALE-CLI';
  return r.status === 'ERR' ? 'ERROR' : `HTTP ${r.status}`;
}

if (has('--preflight')) {
  const e = has('--relay') && RELAY_URL ? { ip: 'via-relay' } : await egress();
  const r = await send(build({}), has('--relay') && Boolean(RELAY_URL));
  const v = classify(r);
  console.log(`egress=${JSON.stringify(e)}`);
  console.log(`${r.status} ${v} type=${r.type || '-'} ra=${r.retryAfter || '-'} ${r.relayEgress || ''}`);
  console.log(
    r.ok
      ? 'CLEAN — shape accepted. Run the full matrix with --tag <new>.'
      : v === 'IP-ABUSE'
        ? 'IP BLOCKED — egress reputation, change IP.'
        : r.status === 429
          ? 'AMBIGUOUS — run the official CLI control: opencode run --format json -m opencode/beam-free "Reply with exactly: OK". If it also says free-limit, the IP is burnt; if it answers, our shape is the problem.'
          : 'NOT CLEAN — inspect the row above before spending a matrix.'
  );
  process.exit(r.ok ? 0 : 1);
}

const modes = [];
if (has('--direct') || (!has('--relay') && !RELAY_URL)) modes.push('direct');
if (has('--relay') || RELAY_URL) modes.push('relay');

const out = { tag: TAG, model: MODEL, at: new Date().toISOString(), runtime: typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`, modes: {} };

for (const mode of modes) {
  const relay = mode === 'relay';
  const e = relay ? { ip: 'via-relay' + (RELAY_URL ? ` ${RELAY_URL}` : ' (not configured)') } : await egress();
  console.log(`\n=== ${mode} === egress=${JSON.stringify(e)} model=${MODEL}`);
  if (relay && !RELAY_URL) { console.log('  RELAY_URL not set — skipping'); continue; }
  const rows = [];
  for (const [name, over] of variants) {
    const r = await send(build(over), relay);
    const verdict = classify(r);
    rows.push({ name, ...r, verdict });
    console.log(
      `${name.padEnd(22)} ${String(r.status).padEnd(4)} ${verdict.padEnd(20)} ${(r.type || '').slice(0, 28).padEnd(28)} ra=${(r.retryAfter || '-').padEnd(8)} ${r.logId ? 'log=' + r.logId + ' ' : ''}${r.ms}ms ${r.msg.slice(0, 60)}`
    );
    await new Promise((res) => setTimeout(res, 900));
  }
  if (RUNS > 0) {
    console.log(`\n--- quota meter: ${RUNS} identical reference requests (fresh session each) ---`);
    let firstFail = -1;
    const attempts = [];
    for (let i = 1; i <= RUNS; i++) {
      const r = await send(build({}), relay);
      attempts.push({ i, status: r.status, verdict: classify(r), retryAfter: r.retryAfter, egress: r.relayEgress });
      console.log(`  ${String(i).padStart(3)} ${r.status} ${classify(r)} ra=${r.retryAfter || '-'} ${r.relayEgress || ''}`);
      if (firstFail < 0 && !r.ok) firstFail = i;
      if (firstFail > 0 && i - firstFail >= 2) break;
      await new Promise((res) => setTimeout(res, 600));
    }
    out.modes[mode] = { egress: e, rows, quota: { firstFail, attempts } };
  } else {
    out.modes[mode] = { egress: e, rows };
  }
}

const dir = path.join(root, '.state');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `oc-${TAG}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`\nwrote ${file}`);

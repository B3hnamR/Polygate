import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { settings, persist, models, redactError, maskMcp, maskUrl } from './state';
import { networkFetch, testRoute } from './transport';
import { GatewayError } from './queue';
import { logEvent, queryEvents, type Level } from './logbook';
import { readiness, json } from './gateway';
import { authenticate } from './keys';
import { serverConfig, clientIp } from './auth';
import { version } from './version';
import type { ApiKey, McpServer, McpSettings } from './types';
// The MCP hub. Clients connect once to /mcp with a Polygate client API key and get the tools of every MCP server added on the MCP page,
// named "<server>__<tool>", plus Polygate's own tools (polygate__…). /mcp/<server> offers one server with its tools' own names.
// Remote servers are reached through a Polygate route (direct, a proxy, the proxy pool or WARP); local servers are programs started here.
// Local programs can only be added or changed from the Windows app or the server's own manager (sudo polygate mcp), never from a web
// dashboard: the dashboard password must not be enough to run commands on the server.

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MASK = '••••••••';
type Msg = { jsonrpc: '2.0'; id?: string | number | null; method?: string; params?: any; result?: any; error?: { code: number; message: string; data?: unknown } };
export type McpTool = { name: string; title?: string; description?: string; inputSchema?: any; outputSchema?: any; annotations?: any };
class RpcError extends Error { constructor(message: string, public code: number) { super(message); } }
class SessionExpired extends Error { constructor() { super('The server ended the session'); } }
export const mcpConfig = (): McpSettings => (settings.mcp ||= { enabled: true, builtin: true, servers: [] });
const allowed = (key: ApiKey | undefined, keys?: string[]) => !key || !keys?.length || keys.includes(key.id);
// The route for a remote server: its own, else Direct. Relays only forward OpenCode and Kilo, so they cannot carry MCP traffic.
const routeOf = (s: McpServer) => s.routeId && settings.routes.some(r => r.id === s.routeId && r.kind !== 'relay') ? s.routeId : 'direct';
const plain = (e: any) => redactError(String(e?.message || e)).replace(/^Error: /, '');

// ------------------------------------------------------------------------------------------------------------------- transports
// Server-sent events: calls onEvent for each event until it returns true or the stream ends.
async function readSse(body: ReadableStream<Uint8Array>, onEvent: (e: { event: string; data: string }) => boolean | void) {
  const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) return;
      buffer += decoder.decode(value, { stream: true }); let i;
      while ((i = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, i); buffer = buffer.slice(i).replace(/^\r?\n\r?\n/, '');
        let event = 'message'; const data: string[] = [];
        for (const line of block.split(/\r?\n/)) { if (line.startsWith('event:')) event = line.slice(6).trim(); else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, '')); }
        if (onEvent({ event, data: data.join('\n') })) { await reader.cancel().catch(() => {}); return; }
      }
    }
  } finally { reader.releaseLock?.(); }
}
interface Channel { open(): Promise<void>; send(m: Msg, signal?: AbortSignal): Promise<void>; close(): void; onMessage?: (m: Msg) => void; onClose?: (why: string) => void; protocolVersion?: string }
const each = (x: any, fn: (m: Msg) => void) => { for (const m of Array.isArray(x) ? x : [x]) if (m && typeof m === 'object') fn(m); };
// Streamable HTTP (MCP 2025-03-26 and later): every message is a POST; the answer comes back as JSON or as a short event stream.
class HttpChannel implements Channel {
  session = ''; protocolVersion?: string; onMessage?: (m: Msg) => void; onClose?: (why: string) => void;
  constructor(private s: McpServer) {}
  async open() { new URL(this.s.url || ''); }
  private headers() { return { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(this.s.headers || {}), ...(this.session ? { 'mcp-session-id': this.session } : {}), ...(this.protocolVersion ? { 'mcp-protocol-version': this.protocolVersion } : {}) }; }
  async send(m: Msg, signal?: AbortSignal) {
    const r = await networkFetch(this.s.url!, { method: 'POST', headers: this.headers(), body: JSON.stringify(m), signal }, routeOf(this.s));
    const sid = r.headers.get('mcp-session-id'); if (sid) this.session = sid;
    if (r.status === 404 && this.session && m.method !== 'initialize') { await r.body?.cancel().catch(() => {}); this.session = ''; throw new SessionExpired(); }
    if (!r.ok) { const t = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 240); throw new Error(r.status === 401 || r.status === 403 ? `The server refused the credentials (HTTP ${r.status}). Check the headers or the address.${t ? ' ' + t : ''}` : `The server answered HTTP ${r.status}${t ? ': ' + t : ''}`); }
    if (r.status === 202 || m.id === undefined || m.id === null) { await r.body?.cancel().catch(() => {}); return; }
    if ((r.headers.get('content-type') || '').includes('text/event-stream')) {
      // The answer may follow other messages on the stream; reading continues in the background until it arrives.
      void (async () => {
        let answered = false;
        try { await readSse(r.body!, ev => { if (!ev.data) return; try { each(JSON.parse(ev.data), x => { if (x.id === m.id && !x.method) answered = true; this.onMessage?.(x); }); } catch { /* not JSON */ } return answered; }); } catch { /* stream broke */ }
        if (!answered) this.onMessage?.({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'The server closed the answer stream before answering' } });
      })();
      return;
    }
    const text = await r.text(); if (text.trim()) each(JSON.parse(text), x => this.onMessage?.(x));
  }
  close() { if (this.session && this.s.url) void networkFetch(this.s.url, { method: 'DELETE', headers: this.headers(), signal: AbortSignal.timeout(5000) }, routeOf(this.s)).then(r => r.body?.cancel()).catch(() => {}); this.session = ''; }
}
// The older HTTP+SSE transport (MCP 2024-11-05): one long event stream for answers, messages POSTed to the address it announces.
class SseChannel implements Channel {
  endpoint = ''; protocolVersion?: string; onMessage?: (m: Msg) => void; onClose?: (why: string) => void; private abort = new AbortController();
  constructor(private s: McpServer) {}
  async open() {
    const r = await networkFetch(this.s.url!, { headers: { accept: 'text/event-stream', ...(this.s.headers || {}) }, signal: this.abort.signal }, routeOf(this.s));
    if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new Error(r.status === 401 || r.status === 403 ? `The server refused the credentials (HTTP ${r.status})` : `The server answered HTTP ${r.status}`); }
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      readSse(r.body!, ev => {
        if (ev.event === 'endpoint') {
          const target = new URL(ev.data.trim(), this.s.url);
          // The headers carry the server's credentials, so they are only sent back to the same origin.
          if (target.origin !== new URL(this.s.url!).origin) { reject(new Error('The server asked for messages on another site; refused')); return true; }
          this.endpoint = target.toString(); ready = true; resolve(); return;
        }
        if (ev.data) try { each(JSON.parse(ev.data), x => this.onMessage?.(x)); } catch { /* not JSON */ }
      }).then(() => { if (!ready) reject(new Error('The server closed the event stream before it was ready')); this.onClose?.('The server closed the event stream'); },
        e => { if (!ready) reject(e); if (!this.abort.signal.aborted) this.onClose?.(plain(e)); });
    });
  }
  async send(m: Msg, signal?: AbortSignal) {
    const r = await networkFetch(this.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(this.s.headers || {}) }, body: JSON.stringify(m), signal }, routeOf(this.s));
    await r.body?.cancel().catch(() => {}); if (!r.ok) throw new Error(`The server answered HTTP ${r.status}`);
  }
  close() { this.abort.abort(); }
}
// A local program speaking MCP on its standard input and output. Its own error output goes to the log (a few lines a minute at most).
class StdioChannel implements Channel {
  proc?: ChildProcess; protocolVersion?: string; onMessage?: (m: Msg) => void; onClose?: (why: string) => void; private buffer = ''; private noise = { at: 0, n: 0 };
  constructor(private s: McpServer) {}
  async open() {
    const win = process.platform === 'win32'; const args = this.s.args || [];
    // Polygate's own secrets (admin token, settings paths) are not passed on to the program.
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('POLYGATE_'))), ...(this.s.env || {}) } as Record<string, string>;
    // Windows starts npx, uvx and friends through cmd (they are .cmd files); arguments are quoted for it.
    const quote = (a: string) => /[\s"&|<>^%]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a;
    const proc = win ? spawn([this.s.command!, ...args].map(quote).join(' '), [], { shell: true, cwd: this.s.cwd || undefined, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      : spawn(this.s.command!, args, { cwd: this.s.cwd || undefined, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.proc = proc;
    proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8'); let i;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i).trim(); this.buffer = this.buffer.slice(i + 1); if (!line) continue;
        try { each(JSON.parse(line), x => this.onMessage?.(x)); } catch { this.noisy(line); }
      }
    });
    proc.stderr!.on('data', (chunk: Buffer) => { for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line.trim()) this.noisy(line.trim()); });
    proc.on('exit', (code, signal) => this.onClose?.(`The program exited (${code ?? signal})`));
    await new Promise<void>((resolve, reject) => { proc.once('spawn', () => resolve()); proc.once('error', e => reject(new Error(`Could not start "${this.s.command}": ${e.message}`))); });
  }
  private noisy(line: string) { const now = Date.now(); if (now - this.noise.at > 60000) this.noise = { at: now, n: 0 }; if (++this.noise.n <= 20) logEvent('info', 'mcp', `${this.s.name}: ${line.slice(0, 500)}`, { server: this.s.name, stream: 'output' }); }
  async send(m: Msg) { if (!this.proc?.stdin?.writable) throw new Error('The program is not running'); this.proc.stdin.write(JSON.stringify(m) + '\n'); }
  close() {
    const p = this.proc; this.proc = undefined; if (!p || p.exitCode !== null || !p.pid) return;
    if (process.platform === 'win32') { const r = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }); if (r.error || r.status) p.kill(); }
    else { try { process.kill(-p.pid, 'SIGTERM'); } catch { p.kill(); } }
  }
}
const channelFor = (s: McpServer): Channel => s.transport === 'stdio' ? new StdioChannel(s) : s.transport === 'sse' ? new SseChannel(s) : new HttpChannel(s);

// ------------------------------------------------------------------------------------------------------------------- client
class McpClient {
  private pending = new Map<string | number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private next = 1; info: any; closed = false;
  constructor(public channel: Channel, onToolsChanged: () => void, onClosed: (why: string) => void) {
    channel.onMessage = m => {
      if (m.id !== undefined && m.id !== null && !m.method) {
        const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); clearTimeout(p.timer);
        if (m.error) p.reject(new RpcError(m.error.message || 'The server reported an error', m.error.code)); else p.resolve(m.result); return;
      }
      // Requests from the server: Polygate answers pings and has no folders (roots) to offer; sampling and questions are not supported.
      if (m.method && m.id !== undefined && m.id !== null) {
        const reply: Msg = m.method === 'ping' ? { jsonrpc: '2.0', id: m.id, result: {} } : m.method === 'roots/list' ? { jsonrpc: '2.0', id: m.id, result: { roots: [] } } : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Polygate does not support ${m.method}` } };
        channel.send(reply).catch(() => {}); return;
      }
      if (m.method === 'notifications/tools/list_changed') onToolsChanged();
    };
    channel.onClose = why => { this.failAll(new Error(why)); if (!this.closed) onClosed(why); };
  }
  private failAll(e: Error) { for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(e); this.pending.delete(id); } }
  request(method: string, params: any, timeoutMs: number): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return; reject(new Error(`No answer within ${Math.round(timeoutMs / 1000)} s`));
        this.channel.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Timed out in Polygate' } }).catch(() => {});
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.channel.send({ jsonrpc: '2.0', id, method, params }, AbortSignal.timeout(timeoutMs)).catch(e => { const p = this.pending.get(id); if (!p) return; this.pending.delete(id); clearTimeout(timer); reject(e); });
    });
  }
  async connect(timeoutMs: number) {
    const opened = this.channel.open(); let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([opened, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Not ready within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs); })]).finally(() => clearTimeout(timer));
    this.info = await this.request('initialize', { protocolVersion: PROTOCOLS[0], capabilities: { roots: { listChanged: false } }, clientInfo: { name: 'Polygate', title: 'Polygate MCP hub', version } }, timeoutMs);
    this.channel.protocolVersion = PROTOCOLS.includes(this.info?.protocolVersion) ? this.info.protocolVersion : PROTOCOLS[0];
    await this.channel.send({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {});
  }
  async listTools(timeoutMs: number) {
    const tools: McpTool[] = []; let cursor: string | undefined;
    for (let page = 0; page < 20; page++) { const r = await this.request('tools/list', cursor ? { cursor } : {}, timeoutMs); for (const t of r?.tools || []) if (t && typeof t.name === 'string') tools.push(t); cursor = r?.nextCursor; if (!cursor) break; }
    return tools;
  }
  close() { this.closed = true; this.failAll(new Error('Disconnected')); this.channel.close(); }
}

// ------------------------------------------------------------------------------------------------------------------- the hub's servers
type Live = { state: 'off' | 'connecting' | 'ready' | 'error'; error: string; tools: McpTool[]; client?: McpClient; connecting?: Promise<void>; signature: string; serverInfo?: { name?: string; version?: string }; protocol?: string; connectedAt?: number; retryAt: number; calls: number; failures: number; totalMs: number; lastCallAt?: number };
const live = new Map<string, Live>();
const signature = (s: McpServer) => JSON.stringify([s.transport, s.url, s.headers, s.command, s.args, s.env, s.cwd, routeOf(s)]);
const blank = (s: McpServer, state: Live['state'] = 'off'): Live => ({ state, error: '', tools: [], signature: signature(s), retryAt: 0, calls: 0, failures: 0, totalMs: 0 });
const timeoutOf = (s: McpServer) => Math.max(5, Math.min(600, s.timeoutSec || 60)) * 1000;
function connect(s: McpServer): Promise<void> {
  let l = live.get(s.id); if (!l) { l = blank(s); live.set(s.id, l); }
  if (l.connecting) return l.connecting;
  const entry = l; entry.client?.close(); entry.client = undefined; entry.state = 'connecting'; entry.error = ''; entry.signature = signature(s);
  const started = Date.now();
  entry.connecting = (async () => {
    const client = new McpClient(channelFor(s), () => { void refreshTools(s.id).catch(() => {}); }, why => {
      if (entry.client !== client) return; entry.client = undefined; entry.state = 'error'; entry.error = why; entry.retryAt = Date.now() + 15000;
      logEvent('warn', 'mcp', `${s.name} disconnected: ${why}`, { server: s.name });
    });
    try {
      // npx and uvx may download the server the first time, so local programs get longer to start.
      const wait = s.transport === 'stdio' ? 120000 : 30000;
      await client.connect(wait); const tools = await client.listTools(wait);
      if (live.get(s.id) !== entry) { client.close(); return; }
      Object.assign(entry, { client, tools, state: 'ready', error: '', serverInfo: client.info?.serverInfo, protocol: client.info?.protocolVersion, connectedAt: Date.now(), retryAt: 0 });
      logEvent('info', 'mcp', `${s.name} connected: ${tools.length} tool(s) in ${Date.now() - started} ms`, { server: s.name, transport: s.transport, route: s.transport === 'stdio' ? undefined : routeOf(s), serverInfo: client.info?.serverInfo, protocol: client.info?.protocolVersion });
    } catch (e) {
      client.close(); entry.state = 'error'; entry.error = plain(e); entry.retryAt = Date.now() + 30000;
      logEvent('warn', 'mcp', `${s.name} could not connect: ${entry.error}`, { server: s.name, transport: s.transport });
      throw e;
    } finally { entry.connecting = undefined; }
  })();
  return entry.connecting;
}
async function refreshTools(id: string) {
  const s = mcpConfig().servers.find(x => x.id === id); const l = live.get(id); if (!s || !l?.client) return;
  l.tools = await l.client.listTools(timeoutOf(s)); logEvent('info', 'mcp', `${s.name} now offers ${l.tools.length} tool(s)`, { server: s.name });
}
// Ready to use, connecting first when needed. A server that just failed is not retried for 30 seconds, so a dead one does not slow every client.
async function ready(s: McpServer, waitMs: number) {
  if (!s.enabled || !mcpConfig().enabled) throw new Error(`${s.name} is switched off`);
  const l = live.get(s.id);
  if (l?.state === 'ready' && l.client) return l;
  if (l?.state === 'error' && l.retryAt > Date.now() && !l.connecting) throw new Error(l.error || `${s.name} is not connected`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([connect(s), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${s.name} is still connecting`)), waitMs); })]).finally(() => clearTimeout(timer));
  return live.get(s.id)!;
}
// Brings the running connections in line with the settings: new and changed servers (re)connect, removed and switched-off ones close.
export function syncMcp() {
  const cfg = mcpConfig(); const ids = new Set(cfg.servers.map(s => s.id));
  for (const [id, l] of live) if (!ids.has(id)) { l.client?.close(); live.delete(id); }
  for (const s of cfg.servers) {
    const l = live.get(s.id);
    if (!s.enabled || !cfg.enabled) { if (l) { l.client?.close(); l.client = undefined; l.state = 'off'; l.error = ''; } else live.set(s.id, blank(s)); continue; }
    if (!l || l.state === 'off' || l.signature !== signature(s)) { if (!l) live.set(s.id, blank(s, 'connecting')); connect(s).catch(() => {}); }
  }
}
export function stopMcp() { for (const l of live.values()) { l.client?.close(); l.client = undefined; } live.clear(); }

// ------------------------------------------------------------------------------------------------------------------- tools
// Tool names may hold letters, digits, _ and - and at most 64 characters (what Claude, OpenAI and Cursor accept).
const hubName = (server: string, tool: string) => { const n = `${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, '_'); return n.length <= 64 ? n : n.slice(0, 57) + '_' + createHash('sha1').update(n).digest('hex').slice(0, 6); };
const asResult = (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data && typeof data === 'object' && !Array.isArray(data) ? data : { items: data } });
const since = (minutes: unknown, fallback: number) => Date.now() - Math.max(1, Math.min(10080, Number(minutes) || fallback)) * 60000;
const limitOf = (v: unknown, fallback: number, max: number) => Math.max(1, Math.min(max, Math.floor(Number(v) || fallback)));
const logRows = (levels: Level[] | undefined, a: any) => queryEvents({ levels, sources: a.source ? [String(a.source).toLowerCase()] : undefined, q: a.search ? String(a.search).slice(0, 200) : undefined, from: since(a.minutes, 60), limit: limitOf(a.limit, 30, 100) }).entries.map(e => ({ time: new Date(e.time).toISOString(), level: e.level, source: e.source, message: e.message, ...(e.detail ? { detail: e.detail } : {}) }));
const object = (properties: Record<string, unknown> = {}, required?: string[]) => ({ type: 'object', properties, ...(required ? { required } : {}) });
const BUILTIN: { def: McpTool; run: (a: any) => Promise<unknown> | unknown }[] = [
  { def: { name: 'gateway_status', title: 'Gateway status', description: 'Polygate at a glance: version, whether it can serve a request right now, the queue, and how many models, routes and MCP servers are usable.', inputSchema: object(), annotations: { readOnlyHint: true } },
    run: () => { const now = Date.now(); const ms = [...models.values()]; const count = (st: string) => ms.filter(m => m.state === st).length;
      const { models: usable, routes: open, ...state } = readiness();
      return { version, ...state, usableModels: usable, usableRoutes: open, uptimeSeconds: Math.round(process.uptime()), models: { available: count('available'), resting: ms.filter(m => m.cooldownUntil > now).length, unchecked: count('unchecked'), unavailable: count('unavailable') }, routes: { enabled: settings.routes.filter(r => r.enabled).length, paused: settings.routes.filter(r => r.enabled && (r.cooldownUntil || 0) > now).length, default: settings.routeId }, mcpServers: { ready: [...live.values()].filter(l => l.state === 'ready').length, total: mcpConfig().servers.length } }; } },
  { def: { name: 'list_models', title: 'List models', description: 'The models Polygate knows, best first, with their health. Filter by state or provider.', inputSchema: object({ state: { type: 'string', enum: ['available', 'cooldown', 'unchecked', 'unavailable'], description: 'Only models in this state' }, provider: { type: 'string', description: 'Only this provider, for example opencode or kilo' }, limit: { type: 'integer', minimum: 1, maximum: 500, description: 'At most this many (default 100)' } }), annotations: { readOnlyHint: true } },
    run: a => [...models.values()].filter(m => (!a.state || m.state === a.state) && (!a.provider || m.providerId === a.provider) && settings.providers.some(p => p.id === m.providerId && p.enabled)).sort((x, y) => x.priority - y.priority || y.score - x.score).slice(0, limitOf(a.limit, 100, 500))
      .map(m => ({ id: m.id, provider: m.providerId, state: m.state, latencyMs: m.latency || undefined, restingUntil: m.cooldownUntil > Date.now() ? new Date(m.cooldownUntil).toISOString() : undefined, context: m.context || undefined, tools: m.tools, reasoning: m.reasoning, error: m.error || undefined })) },
  { def: { name: 'list_routes', title: 'List network routes', description: 'The network routes requests can take (direct, proxies, proxy pool, WARP, relays) and their health.', inputSchema: object(), annotations: { readOnlyHint: true } },
    run: () => settings.routes.map(r => ({ id: r.id, name: r.name, kind: r.kind, enabled: r.enabled, default: r.id === settings.routeId, status: r.status || undefined, latencyMs: r.latency || undefined, pausedUntil: (r.cooldownUntil || 0) > Date.now() ? new Date(r.cooldownUntil!).toISOString() : undefined })) },
  { def: { name: 'test_route', title: 'Test a route', description: 'Sends a real test request through one network route and reports whether it reached the provider and how fast.', inputSchema: object({ route: { type: 'string', description: 'Route id or name, as list_routes shows' }, provider: { type: 'string', description: 'Provider to test against (default: the first that route serves)' } }, ['route']), annotations: { readOnlyHint: false, openWorldHint: true } },
    run: async a => { const r = settings.routes.find(x => x.id === a.route || x.name.toLowerCase() === String(a.route || '').toLowerCase()); if (!r) throw new Error('No route with that id or name. Call list_routes to see them.'); return { route: r.name, ...(await testRoute(r.id, a.provider ? String(a.provider) : undefined)) }; } },
  { def: { name: 'recent_errors', title: 'Recent errors', description: 'Warnings and errors from the Polygate log, newest first: refused requests, models resting, routes failing, MCP servers disconnecting.', inputSchema: object({ minutes: { type: 'integer', minimum: 1, maximum: 10080, description: 'How far back (default 60)' }, source: { type: 'string', description: 'Only this part, for example requests, models, routes, warp, mcp' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }), annotations: { readOnlyHint: true } },
    run: a => logRows(['warn', 'error'], a) },
  { def: { name: 'read_logs', title: 'Read the log', description: 'Searches the Polygate log (the same entries as the Logs page).', inputSchema: object({ search: { type: 'string', description: 'Text to look for' }, level: { type: 'string', enum: ['info', 'warn', 'error'] }, source: { type: 'string' }, minutes: { type: 'integer', minimum: 1, maximum: 10080, description: 'How far back (default 60)' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }), annotations: { readOnlyHint: true } },
    run: a => logRows(a.level ? [a.level] : undefined, a) },
  { def: { name: 'list_mcp_servers', title: 'List MCP servers', description: 'The MCP servers this hub connects to, whether each is connected, and its tools.', inputSchema: object(), annotations: { readOnlyHint: true } },
    run: () => mcpConfig().servers.map(s => { const l = live.get(s.id); return { name: s.name, transport: s.transport, enabled: s.enabled, state: l?.state || 'off', error: l?.error || undefined, tools: (l?.tools || []).filter(t => !s.disabledTools?.includes(t.name)).map(t => t.name) }; }) },
];
async function hubTools(key: ApiKey | undefined, scope: string) {
  const cfg = mcpConfig(); const out: McpTool[] = [];
  if ((!scope || scope === 'polygate') && cfg.builtin && allowed(key, cfg.builtinKeys)) for (const t of BUILTIN) out.push({ ...t.def, name: scope ? t.def.name : `polygate__${t.def.name}` });
  const servers = cfg.servers.filter(s => s.enabled && (!scope || s.name === scope) && allowed(key, s.keys));
  await Promise.all(servers.map(s => ready(s, 15000).catch(() => {})));
  for (const s of servers) { const l = live.get(s.id); if (l?.state !== 'ready') continue; for (const t of l.tools) if (!s.disabledTools?.includes(t.name)) out.push({ ...t, name: scope ? t.name : hubName(s.name, t.name) }); }
  return out;
}
// Runs one tool. A failure inside the tool is reported to the model as a tool error (isError), so it can react; an unknown tool is a protocol error.
export async function callTool(name: string, args: any, key: ApiKey | undefined, scope: string, via: 'client' | 'dashboard') {
  const cfg = mcpConfig(); const started = Date.now(); args = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const who = key ? key.name : 'dashboard';
  const builtinName = scope === 'polygate' ? name : !scope && name.startsWith('polygate__') ? name.slice(10) : '';
  if (builtinName) {
    const t = BUILTIN.find(b => b.def.name === builtinName);
    if (!t || !cfg.builtin || !allowed(key, cfg.builtinKeys)) throw new RpcError(`Unknown tool: ${name}`, -32602);
    try { const result = asResult(await t.run(args)); logEvent('info', 'mcp', `polygate/${builtinName} · ${Date.now() - started} ms`, { server: 'polygate', tool: builtinName, key: who, via, durationMs: Date.now() - started, arguments: Object.keys(args) }); return result; }
    catch (e) { logEvent('warn', 'mcp', `polygate/${builtinName} failed: ${plain(e)}`, { server: 'polygate', tool: builtinName, key: who, via }); return { content: [{ type: 'text', text: plain(e) }], isError: true }; }
  }
  let server: McpServer | undefined, tool = name;
  if (scope) server = cfg.servers.find(s => s.name === scope);
  else for (const s of cfg.servers) { const l = live.get(s.id); const t = l?.tools.find(x => hubName(s.name, x.name) === name); if (t) { server = s; tool = t.name; break; } if (name.startsWith(s.name + '__')) { server = s; tool = name.slice(s.name.length + 2); } }
  if (!server || !server.enabled || !allowed(key, server.keys) || server.disabledTools?.includes(tool)) throw new RpcError(`Unknown tool: ${name}`, -32602);
  const s = server; const timeout = timeoutOf(s);
  const finish = (ok: boolean, result: any, error?: string) => {
    const l = live.get(s.id); const ms = Date.now() - started;
    if (l) { l.calls++; l.totalMs += ms; l.lastCallAt = Date.now(); if (!ok || result?.isError) l.failures++; }
    logEvent(ok && !result?.isError ? 'info' : 'warn', 'mcp', `${s.name}/${tool} · ${ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s'}${error ? ` · ${error}` : result?.isError ? ' · the tool reported an error' : ''}`, { server: s.name, tool, key: who, via, durationMs: ms, arguments: Object.keys(args), isError: !ok || !!result?.isError || undefined });
    return result;
  };
  for (let attempt = 0; ; attempt++) {
    try { const l = await ready(s, Math.min(timeout, 60000)); return finish(true, await l.client!.request('tools/call', { name: tool, arguments: args }, timeout)); }
    catch (e) {
      // An HTTP server that forgot the session gets one fresh connection.
      if (e instanceof SessionExpired && attempt === 0) { await connect(s).catch(() => {}); continue; }
      const message = e instanceof RpcError ? `${s.name} answered: ${e.message}` : plain(e);
      return finish(false, { content: [{ type: 'text', text: message }], isError: true }, message);
    }
  }
}

// ------------------------------------------------------------------------------------------------------------------- the /mcp endpoint
const sessions = new Map<string, { keyId: string; client: string; last: number }>();
const rpcError = (id: Msg['id'], code: number, message: string): Msg => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
async function readBody(req: IncomingMessage) {
  let size = 0; const chunks: Buffer[] = [];
  for await (const c of req) { size += c.length; if (size > 4 * 1024 * 1024) throw new GatewayError('Request exceeds 4 MiB', 413, 'request_too_large'); chunks.push(Buffer.from(c)); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || 'null'); } catch { return undefined; }
}
export async function handleMcp(req: IncomingMessage, res: ServerResponse, p: string) {
  res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', 'authorization, content-type, x-api-key, mcp-session-id, mcp-protocol-version, last-event-id'); res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS'); res.setHeader('access-control-expose-headers', 'mcp-session-id');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const cfg = mcpConfig();
  if (!cfg.enabled) throw new GatewayError('The MCP hub is turned off. Turn it on in Polygate, on the MCP page.', 404, 'mcp_disabled');
  const scope = p === '/mcp' || p === '/mcp/' ? '' : decodeURIComponent(p.slice(5)).replace(/\/$/, '');
  if (scope && scope !== 'polygate' && !cfg.servers.some(s => s.name === scope)) throw new GatewayError(`No MCP server named "${scope}" on this hub`, 404, 'not_found');
  let key: ApiKey;
  try { key = authenticate(req, false); }
  catch (e: any) { logEvent('warn', 'mcp', `MCP client refused from ${clientIp(req)}: ${e.message}`); throw e; }
  // No server-initiated stream: tools changes are picked up when the client lists them again.
  if (req.method === 'GET') { res.writeHead(405, { allow: 'POST, DELETE' }); res.end(); return; }
  if (req.method === 'DELETE') { sessions.delete(String(req.headers['mcp-session-id'] || '')); res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST, DELETE' }); res.end(); return; }
  const body = await readBody(req);
  if (body === undefined || body === null || typeof body !== 'object') return json(res, 400, rpcError(null, -32700, 'The body is not JSON'));
  const out: Msg[] = []; let sessionId = '';
  for (const m of (Array.isArray(body) ? body : [body]) as Msg[]) {
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') { if (m && m.id !== undefined) out.push(rpcError(m.id, -32600, 'Invalid request')); continue; }
    if (m.id === undefined || m.id === null) continue;   // a notification needs no answer
    try {
      if (m.method === 'initialize') {
        const asked = String(m.params?.protocolVersion || ''); const client = [m.params?.clientInfo?.name, m.params?.clientInfo?.version].filter(Boolean).join(' ') || 'An MCP client';
        sessionId = randomUUID(); sessions.set(sessionId, { keyId: key.id, client, last: Date.now() });
        if (sessions.size > 2000) for (const [id, x] of sessions) if (Date.now() - x.last > 86400000 || sessions.size > 2000) sessions.delete(id);
        logEvent('info', 'mcp', `${client} connected to ${scope ? `/mcp/${scope}` : 'the hub'} with key "${key.name}"`, { client: m.params?.clientInfo, key: key.name, ip: clientIp(req), protocol: asked });
        out.push({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: scope ? `polygate-${scope}` : 'polygate', title: scope ? `${scope} via Polygate` : 'Polygate MCP hub', version },
          instructions: scope ? undefined : 'Tools from the MCP servers connected to Polygate. Each name starts with its server, as in server__tool; polygate__ tools report on the gateway itself.' } });
      }
      else if (m.method === 'ping') out.push({ jsonrpc: '2.0', id: m.id, result: {} });
      else if (m.method === 'tools/list') out.push({ jsonrpc: '2.0', id: m.id, result: { tools: await hubTools(key, scope) } });
      else if (m.method === 'tools/call') {
        const name = String(m.params?.name || ''); if (!name) { out.push(rpcError(m.id, -32602, 'Tool name missing')); continue; }
        const s = sessions.get(String(req.headers['mcp-session-id'] || '')); if (s) s.last = Date.now();
        out.push({ jsonrpc: '2.0', id: m.id, result: await callTool(name, m.params?.arguments, key, scope, 'client') });
      }
      else out.push(rpcError(m.id, -32601, `Polygate does not offer ${m.method}`));
    } catch (e: any) { out.push(rpcError(m.id, e instanceof RpcError ? e.code : -32603, plain(e))); }
  }
  if (!out.length) { res.writeHead(202); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) });
  res.end(JSON.stringify(Array.isArray(body) ? out : out[0]));
}

// ------------------------------------------------------------------------------------------------------------------- management
// Local programs can be added or changed only where whoever does it could run them anyway: the Windows app on this computer,
// or the server's manager (sudo polygate mcp …), which signs in with the root-only admin token instead of the dashboard password.
export const canManageLocal = (req: IncomingMessage) => serverConfig().desktop || (req as any).polygateManager === true;
const NAME = /^[a-z][a-z0-9-]{0,23}$/;
export function slug(raw: string, taken: string[] = []) {
  let base = String(raw || 'server').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+/g, '-').replace(/-$/, '').slice(0, 24) || 'server';
  if (base === 'polygate') base = 'polygate-tools';
  let name = base; for (let i = 2; taken.includes(name); i++) name = `${base.slice(0, 24 - String(i).length - 1)}-${i}`;
  return name;
}
const strings = (v: unknown, max: number) => Array.isArray(v) ? v.map(x => String(x)).filter(x => x.length <= 4000).slice(0, max) : [];
// Header and environment values shown masked in the dashboard keep their saved value when sent back unchanged.
function secrets(input: unknown, saved: Record<string, string> | undefined, kind: 'header' | 'env') {
  if (!input || typeof input !== 'object') return undefined; const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>).slice(0, 50)) {
    const name = k.trim(); if (!name) continue;
    if (kind === 'header' ? !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name) : !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new GatewayError(`"${name}" is not a valid ${kind === 'header' ? 'header' : 'variable'} name`, 400);
    const value = String(v ?? ''); out[name] = value === MASK ? saved?.[name] ?? '' : value;
  }
  return Object.keys(out).length ? out : undefined;
}
export function cleanServer(input: any, saved: McpServer | undefined, local: boolean): McpServer {
  if (!input || typeof input !== 'object') throw new GatewayError('Server details are missing', 400);
  const cfg = mcpConfig(); const transport = (saved?.transport || input.transport) as McpServer['transport'];
  if (!['http', 'sse', 'stdio'].includes(transport)) throw new GatewayError('Choose how to connect: remote (HTTP), remote (SSE) or a local program', 400);
  const name = String(input.name ?? saved?.name ?? '').trim().toLowerCase();
  if (!NAME.test(name)) throw new GatewayError('Name: 1–24 lowercase letters, digits or dashes, starting with a letter. Tool names start with it.', 400);
  if (name === 'polygate') throw new GatewayError('The name "polygate" is used by Polygate\'s own tools', 400);
  if (cfg.servers.some(s => s.name === name && s.id !== saved?.id)) throw new GatewayError(`Another server is already named "${name}"`, 400);
  const keys = Array.isArray(input.keys) ? input.keys.map(String).filter((id: string) => settings.keys.some(k => k.id === id)) : saved?.keys;
  const disabledTools = Array.isArray(input.disabledTools) ? strings(input.disabledTools, 500) : saved?.disabledTools;
  const timeoutSec = input.timeoutSec === undefined ? saved?.timeoutSec : Math.max(5, Math.min(600, Math.floor(Number(input.timeoutSec) || 60)));
  const base: McpServer = { id: saved?.id || randomUUID(), name, title: String(input.title ?? saved?.title ?? '').trim().slice(0, 80) || undefined, enabled: input.enabled === undefined ? saved?.enabled ?? true : !!input.enabled, transport, keys: keys?.length ? keys : undefined, disabledTools: disabledTools?.length ? disabledTools : undefined, timeoutSec, created: saved?.created || Date.now() };
  if (transport === 'stdio') {
    const command = String(input.command ?? saved?.command ?? '').trim(); const args = input.args === undefined ? saved?.args || [] : strings(input.args, 100);
    const env = input.env === undefined ? saved?.env : secrets(input.env, saved?.env, 'env'); const cwd = String(input.cwd ?? saved?.cwd ?? '').trim() || undefined;
    if (!command) throw new GatewayError('Enter the program to start, for example npx', 400);
    const changed = !saved || saved.command !== command || JSON.stringify(saved.args || []) !== JSON.stringify(args) || JSON.stringify(saved.env || {}) !== JSON.stringify(env || {}) || (saved.cwd || undefined) !== cwd;
    if (changed && !local) throw new GatewayError('Local programs can only be added or changed in the Windows app, or on the server with: sudo polygate mcp add-local', 403, 'local_mcp_not_allowed');
    return { ...base, command, args, env, cwd };
  }
  let url = String(input.url ?? saved?.url ?? '').trim(); if (saved?.url && url === maskUrl(saved.url)) url = saved.url;
  try { const u = new URL(url); if (!['http:', 'https:'].includes(u.protocol)) throw new Error(); } catch { throw new GatewayError('Enter the server\'s full address, starting with https://', 400); }
  const routeId = String(input.routeId ?? saved?.routeId ?? 'direct');
  if (!settings.routes.some(r => r.id === routeId)) throw new GatewayError('That route does not exist', 400);
  if (settings.routes.find(r => r.id === routeId)?.kind === 'relay') throw new GatewayError('Relays only forward OpenCode and Kilo traffic. Choose Direct, a proxy, the proxy pool or WARP.', 400);
  return { ...base, url, headers: input.headers === undefined ? saved?.headers : secrets(input.headers, saved?.headers, 'header'), routeId };
}
// Reads the MCP settings other tools use: Claude Desktop, Claude Code and Cursor ({"mcpServers": …}), VS Code ({"servers": …}) and OpenCode ({"mcp": …}).
export function parseImport(raw: unknown) {
  let data: any = raw; if (typeof raw === 'string') { try { data = JSON.parse(raw); } catch { throw new GatewayError('That is not valid JSON', 400); } }
  const table = data?.mcpServers || data?.servers || data?.mcp || (data && typeof data === 'object' && !Array.isArray(data) ? data : undefined);
  if (!table || typeof table !== 'object') throw new GatewayError('No servers found. Paste a block with "mcpServers", "servers" or "mcp".', 400);
  return Object.entries(table as Record<string, any>).filter(([, v]) => v && typeof v === 'object').map(([name, v]) => {
    const command = Array.isArray(v.command) ? v.command : v.command ? [v.command, ...(v.args || [])] : undefined;
    const remote = v.url || v.serverUrl || v.httpUrl;
    if (remote) return { name, transport: v.type === 'sse' || v.transport === 'sse' || /\/sse\/?(\?|$)/.test(remote) ? 'sse' : 'http', url: remote, headers: v.headers, enabled: v.enabled !== false && v.disabled !== true };
    if (command?.length) return { name, transport: 'stdio', command: String(command[0]), args: command.slice(1).map(String), env: v.env || v.environment, cwd: v.cwd, enabled: v.enabled !== false && v.disabled !== true };
    return { name, invalid: 'It has neither an address nor a command' };
  });
}
export function serverStatus(s: McpServer) {
  const l = live.get(s.id);
  return { ...maskMcp(s), status: { state: !mcpConfig().enabled || !s.enabled ? 'off' : l?.state || 'connecting', error: l?.error || undefined, serverInfo: l?.serverInfo, protocol: l?.protocol, connectedAt: l?.connectedAt, calls: l?.calls || 0, failures: l?.failures || 0, avgMs: l?.calls ? Math.round(l.totalMs / l.calls) : 0, lastCallAt: l?.lastCallAt,
    tools: (l?.tools || []).map(t => ({ name: t.name, hubName: hubName(s.name, t.name), title: t.title || t.annotations?.title, description: t.description, inputSchema: t.inputSchema, readOnly: t.annotations?.readOnlyHint, disabled: !!s.disabledTools?.includes(t.name) })) } };
}
export function mcpState(req: IncomingMessage) {
  const cfg = mcpConfig();
  return { enabled: cfg.enabled, builtin: cfg.builtin, builtinKeys: cfg.builtinKeys || [], canAddLocal: canManageLocal(req), mode: serverConfig().desktop ? 'desktop' : 'server',
    builtinTools: BUILTIN.map(t => ({ name: t.def.name, hubName: `polygate__${t.def.name}`, title: t.def.title, description: t.def.description, inputSchema: t.def.inputSchema, readOnly: t.def.annotations?.readOnlyHint })),
    servers: cfg.servers.map(serverStatus) };
}
// Connects to a server that is not saved yet (or saved with changes) and lists its tools, then disconnects.
export async function testServer(s: McpServer) {
  const started = Date.now(); const client = new McpClient(channelFor(s), () => {}, () => {});
  try { const wait = s.transport === 'stdio' ? 120000 : 30000; await client.connect(wait); const tools = await client.listTools(wait); return { ok: true, ms: Date.now() - started, serverInfo: client.info?.serverInfo, protocol: client.info?.protocolVersion, tools: tools.map(t => ({ name: t.name, description: t.description })) }; }
  catch (e) { return { ok: false, ms: Date.now() - started, error: plain(e) }; }
  finally { client.close(); }
}
export function saveServers(servers: McpServer[]) { mcpConfig().servers = servers; persist(); syncMcp(); }
// After a save the page shows how connecting went; a slow first start (npx downloading) keeps going in the background.
export async function settle(id: string, waitMs = 20000) {
  const pending = live.get(id)?.connecting; if (!pending) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([pending.catch(() => {}), new Promise(r => { timer = setTimeout(r, waitMs); })]).finally(() => clearTimeout(timer));
}
export async function reconnect(id: string) { const s = mcpConfig().servers.find(x => x.id === id); if (!s) throw new GatewayError('No such server', 404); if (!s.enabled) throw new GatewayError('Switch the server on first', 400); live.get(s.id)!.retryAt = 0; await connect(s).catch(() => {}); return serverStatus(s); }

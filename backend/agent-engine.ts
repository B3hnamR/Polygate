import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, type Hash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, watch, writeSync, type FSWatcher } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createGunzip } from 'node:zlib';
import { models, settings, stateDir, writeFileAtomic } from './state';
import { GatewayError } from './queue';
import { ensureAgentKey } from './keys';
import { logEvent } from './logbook';
// The agent's engine (docs/agent/PLAN.md, Phase 1): OpenCode's official CLI, pinned, downloaded from npm on first use and checked, run as
// its own process on 127.0.0.1 with a random password and a configuration Polygate writes. Desktop only. The gateway never depends on
// it: a crash, an update or a missing engine only affects agent sessions, never model requests from other clients.

// The version Polygate's OpenCode Free identity presents (vendor/bridge/identity.js), so the agent's own tools pass the bridge untouched.
// The integrity values are the ones npm published for these exact packages.
export const ENGINE_VERSION = '2.0.32';
export const ENGINE_PACKAGES: Record<string, { name: string; integrity: string }> = {
  x64: { name: '@opencode/cli-windows-x64', integrity: 'sha512-5VdKolj2/NkSk3BuM4qeiYpnNnGRT7szmd2RIv3+aSDPMwD9yRySYkJ2f1WIM7dTDfO5lZHAXVoipt6+i6AD4A==' },
  arm64: { name: '@opencode/cli-windows-arm64', integrity: 'sha512-T1UGNtrcgDoovpRD3nLqpfZoUh8+pDPlEewALD3QIUOLvuHyy4kUAFra6lLl5kitzqHN5Lm+2iQKX5F81A5hGw==' },
};
const REGISTRY = 'registry.npmjs.org';
const MAX_DOWNLOAD = 300 * 1024 * 1024;
// OpenCode keeps file snapshots (diffs, undo) at <data>\opencode\snapshot\<40 hex>\<40 hex>, about 100 characters more, and Git for
// Windows refuses a GIT_DIR over 220 characters: past that every snapshot fails and undo silently does nothing.
export const MAX_DATA_PATH = 110;
const HEALTH_TIMEOUT_MS = 30000;
const RESTART_DELAYS = [1000, 2000, 5000, 10000, 30000];
const CRASH_WINDOW_MS = 10 * 60000, MAX_CRASHES = 5;

export const tarballUrl = (name: string, version = ENGINE_VERSION) => `https://${REGISTRY}/${name}/-/${name.split('/').pop()}-${version}.tgz`;
export function assertRegistry(raw: string) {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || u.hostname !== REGISTRY || u.port || u.username || u.password) throw new GatewayError('The agent engine is downloaded from the npm registry only. Nothing was installed.', 502, 'agent_engine_source');
}

export function enginePaths(root = process.env.POLYGATE_AGENT_DIR || path.join(stateDir, 'agent')) {
  const home = path.join(root, 'home'), config = path.join(home, 'config'), bin = path.join(root, 'engine', ENGINE_VERSION);
  let data = path.join(root, 'data');
  if (data.length > MAX_DATA_PATH) data = path.join(process.env.LOCALAPPDATA || os.homedir(), 'PolygateAgent');
  if (data.length > MAX_DATA_PATH) data = path.join(path.parse(root).root, 'PolygateAgent');
  return { root, bin, exe: path.join(bin, 'opencode.exe'), manifest: path.join(bin, 'manifest.json'), home, config, configDir: path.join(config, 'opencode'),
    cache: path.join(home, 'cache'), state: path.join(home, 'state'), userhome: path.join(home, 'userhome'), data, log: path.join(root, 'engine.log') };
}
type Paths = ReturnType<typeof enginePaths>;
type Manifest = { version: string; package: string; integrity: string; exeSha256: string; installedAt: number };
function readManifest(p: Paths): Manifest | undefined {
  try { const m = JSON.parse(readFileSync(p.manifest, 'utf8')); return m?.version === ENGINE_VERSION && existsSync(p.exe) ? m : undefined; } catch { return undefined; }
}

// --- Status ---
export type EngineState = 'not_installed' | 'installing' | 'installed' | 'starting' | 'running' | 'restarting' | 'stopping' | 'failed';
type Status = { state: EngineState | 'idle'; message: string; problems: string[]; progress?: number; port?: number; pid?: number; startedAt?: number; restarts: number; snapshots?: { ok: boolean; reason?: string } };
let status: Status = { state: 'idle', message: '', problems: [], restarts: 0 };
const setStatus = (next: Partial<Status>) => { status = { ...status, ...next }; };
// What the dashboard sees. The engine's password never leaves this module except through engineConnection().
export function engineStatus() {
  const installed = !!readManifest(enginePaths());
  const { state, ...rest } = status;
  return { ...rest, state: (state === 'idle' ? (installed ? 'installed' : 'not_installed') : state) as EngineState, installed, version: ENGINE_VERSION };
}

// --- Install ---
// A .tgz from npm, read as it downloads. Only the entries in `wanted` are written, under the names given there; every other entry is
// skipped whatever its name says, so an archive cannot place a file anywhere else. Pax headers may set the next entry's name and size.
class TarPicker {
  private buf: Buffer = Buffer.alloc(0); private left = 0; private pad = 0; private ended = false;
  private out?: { fd: number; name: string; hash: Hash; size: number; head: Buffer };
  private paxParts?: Buffer[]; private pax: Record<string, string> = {};
  found = new Map<string, { file: string; size: number; sha256: string; head: Buffer }>();
  constructor(private wanted: Record<string, string>, private dir: string) {}
  write(chunk: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.left > 0) {
        const n = Math.min(this.left, this.buf.length); if (!n) return;
        this.take(this.buf.subarray(0, n)); this.buf = this.buf.subarray(n); this.left -= n;
        if (!this.left) this.close(); continue;
      }
      if (this.pad > 0) { const n = Math.min(this.pad, this.buf.length); if (!n) return; this.buf = this.buf.subarray(n); this.pad -= n; continue; }
      if (this.ended || this.buf.length < 512) { if (this.ended) this.buf = Buffer.alloc(0); return; }
      const h = this.buf.subarray(0, 512); this.buf = this.buf.subarray(512);
      if (h.every(b => b === 0)) { this.ended = true; continue; }
      const text = (a: number, b: number) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
      if (h[124] & 0x80) throw new Error('The engine archive has an entry too large to be the engine.');
      let size = parseInt(text(124, 136).trim() || '0', 8); const type = String.fromCharCode(h[156] || 48);
      const prefix = text(257, 263).startsWith('ustar') ? text(345, 500) : '';
      let name = prefix ? `${prefix}/${text(0, 100)}` : text(0, 100);
      if (!Number.isFinite(size) || size < 0) throw new Error('The engine archive is damaged.');
      if (type === 'x' || type === 'g') { this.left = size; this.pad = (512 - size % 512) % 512; this.paxParts = type === 'x' ? [] : undefined; if (!size) this.close(); continue; }
      if (this.pax.path) name = this.pax.path; if (this.pax.size) size = Number(this.pax.size); this.pax = {};
      this.left = size; this.pad = (512 - size % 512) % 512;
      const target = (type === '0' || type === '\0') ? this.wanted[name] : undefined;
      if (target && !this.found.has(target)) this.out = { fd: openSync(path.join(this.dir, target), 'wx'), name: target, hash: createHash('sha256'), size: 0, head: Buffer.alloc(0) };
      if (!size) this.close();
    }
  }
  private take(bytes: Buffer) {
    if (this.out) { writeSync(this.out.fd, bytes); this.out.hash.update(bytes); this.out.size += bytes.length; if (this.out.head.length < 2) this.out.head = Buffer.concat([this.out.head, bytes]).subarray(0, 2); }
    else if (this.paxParts) this.paxParts.push(Buffer.from(bytes));
  }
  private close() {
    if (this.out) { closeSync(this.out.fd); this.found.set(this.out.name, { file: path.join(this.dir, this.out.name), size: this.out.size, sha256: this.out.hash.digest('hex'), head: this.out.head }); this.out = undefined; }
    if (this.paxParts) {
      for (const line of Buffer.concat(this.paxParts).toString('utf8').split('\n')) { const m = /^\d+ ([^=]+)=(.*)$/.exec(line); if (m && (m[1] === 'path' || m[1] === 'size')) this.pax[m[1]] = m[2]; }
      this.paxParts = undefined;
    }
  }
  finish() { if (this.out) { closeSync(this.out.fd); this.out = undefined; } if (this.left) throw new Error('The engine download ended in the middle of a file.'); }
}

export type InstallOptions = { arch?: string; fetcher?: typeof fetch; source?: { url: string; integrity: string } };
let installing: Promise<void> | undefined;
// Downloads and checks the pinned engine. `source` replaces the npm address in tests only; it is not reachable from the admin API.
export function installEngine(o: InstallOptions = {}) {
  installing ||= doInstall(o).finally(() => { installing = undefined; });
  return installing;
}
async function doInstall(o: InstallOptions) {
  const p = enginePaths(); if (readManifest(p)) return;
  if (!o.source && process.platform !== 'win32') throw new GatewayError('The agent runs in the Windows desktop app.', 404, 'agent_desktop_only');
  const arch = o.arch || process.arch; const pkg = ENGINE_PACKAGES[arch];
  if (!pkg) throw new GatewayError(`The agent engine is not available for Windows on ${arch}.`, 501, 'agent_engine_unsupported');
  const src = o.source || { url: tarballUrl(pkg.name), integrity: pkg.integrity };
  if (!o.source) assertRegistry(src.url);
  const [algorithm, expected] = [src.integrity.slice(0, src.integrity.indexOf('-')), src.integrity.slice(src.integrity.indexOf('-') + 1)];
  if (algorithm !== 'sha512' || !expected) throw new GatewayError('The pinned engine checksum is not a sha512 integrity value.', 500);
  setStatus({ state: 'installing', progress: 0, message: `Downloading OpenCode ${ENGINE_VERSION}`, problems: [] });
  const staging = path.join(path.dirname(p.bin), `.download-${randomBytes(4).toString('hex')}`); mkdirSync(staging, { recursive: true });
  try {
    const r = await (o.fetcher || fetch)(src.url, { redirect: 'error', signal: AbortSignal.timeout(15 * 60000) });
    if (!o.source) assertRegistry(r.url || src.url);
    if (!r.ok || !r.body) throw new Error(`The engine download failed (${r.status}). Try again.`);
    const total = Number(r.headers.get('content-length')) || 0;
    if (total > MAX_DOWNLOAD) throw new Error('The engine download is larger than any engine package.');
    const hash = createHash('sha512'); const gunzip = createGunzip();
    const picker = new TarPicker({ 'package/bin/opencode.exe': 'opencode.exe', 'package/package.json': 'package.json' }, staging);
    let failure: unknown;
    gunzip.on('data', (c: Buffer) => { if (failure) return; try { picker.write(c); } catch (e) { failure = e; } });
    const ended = new Promise<void>((resolve, reject) => { gunzip.once('end', resolve); gunzip.once('error', reject); });
    let bytes = 0, shown = 0;
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength; if (bytes > MAX_DOWNLOAD) throw new Error('The engine download is larger than any engine package.');
      if (failure) break;
      hash.update(chunk); if (!gunzip.write(chunk)) await once(gunzip, 'drain');
      if (total && Date.now() - shown > 250) { shown = Date.now(); setStatus({ progress: Math.min(99, Math.round(bytes / total * 100)) }); }
    }
    gunzip.end(); await ended; if (failure) throw failure; picker.finish();
    if (hash.digest('base64') !== expected) throw new Error('The engine download did not match the checksum npm published. Nothing was installed.');
    const exe = picker.found.get('opencode.exe'); const meta = picker.found.get('package.json');
    if (!exe || !meta) throw new Error('The engine package has no program in it. Nothing was installed.');
    if (exe.head.toString('latin1') !== 'MZ') throw new Error('The engine package does not hold a Windows program. Nothing was installed.');
    const info = JSON.parse(readFileSync(meta.file, 'utf8'));
    if (info.name !== pkg.name || info.version !== ENGINE_VERSION) throw new Error(`The engine package is ${info.name}@${info.version}, not ${pkg.name}@${ENGINE_VERSION}. Nothing was installed.`);
    writeFileAtomic(path.join(staging, 'manifest.json'), JSON.stringify({ version: ENGINE_VERSION, package: pkg.name, integrity: src.integrity, exeSha256: exe.sha256, installedAt: Date.now() } satisfies Manifest));
    rmSync(p.bin, { recursive: true, force: true }); renameSync(staging, p.bin);
    setStatus({ state: 'idle', progress: undefined, message: '' });
    logEvent('info', 'agent', `Agent engine OpenCode ${ENGINE_VERSION} installed (${pkg.name}, checksum verified)`);
  } catch (e: any) {
    rmSync(staging, { recursive: true, force: true });
    const message = e?.name === 'TimeoutError' ? 'The engine download took too long. Try again.' : e?.message || String(e);
    setStatus({ state: 'idle', progress: undefined, message });
    logEvent('warn', 'agent', `Agent engine install failed: ${message}`);
    throw e instanceof GatewayError ? e : new GatewayError(message, 502, 'agent_engine_install');
  }
}
// The installed program is checked against the hash recorded at install before every start.
function verifiedExe(p: Paths) {
  const m = readManifest(p); if (!m) throw new GatewayError('Install the agent engine first.', 409, 'agent_engine_not_installed');
  const h = createHash('sha256'); const fd = openSync(p.exe, 'r'); const chunk = Buffer.alloc(4 * 1024 * 1024);
  try { let n; while ((n = readSync(fd, chunk, 0, chunk.length, null)) > 0) h.update(chunk.subarray(0, n)); } finally { closeSync(fd); }
  if (h.digest('hex') !== m.exeSha256) throw new GatewayError('The agent engine program has changed since it was installed. Remove it and install it again.', 409, 'agent_engine_changed');
  return p.exe;
}

// --- Configuration ---
// Ask for approval, the default mode (docs/agent/PERMISSIONS.md). Later rules win in OpenCode 2.x, and these come after the agent's
// built-in allow-everything rule. Phase 1 writes this one mode; the other modes come with the agent controller.
export const ENGINE_PERMISSIONS = [
  { action: '*', resource: '*', effect: 'ask' },
  { action: 'read', resource: '*', effect: 'allow' }, { action: 'read', resource: '*.env', effect: 'ask' }, { action: 'read', resource: '*.env.*', effect: 'ask' },
  { action: 'glob', resource: '*', effect: 'allow' }, { action: 'grep', resource: '*', effect: 'allow' },
  { action: 'question', resource: '*', effect: 'allow' }, { action: 'skill', resource: '*', effect: 'allow' },
  { action: 'edit', resource: '*', effect: 'ask' }, { action: 'shell', resource: '*', effect: 'ask' },
  { action: 'external_directory', resource: '*', effect: 'ask' }, { action: 'webfetch', resource: '*', effect: 'ask' }, { action: 'websearch', resource: '*', effect: 'ask' },
  { action: 'subagent', resource: '*', effect: 'ask' },
] as const;
type Rule = { action: string; resource: string; effect: 'allow' | 'ask' | 'deny' };
// The Phase 1 modes (docs/agent/PERMISSIONS.md), one engine agent each; a session runs as the agent of its mode. Each agent's rules come
// after the shared ones above. Rules-based approvals and Full access come in Phase 3.
export const ENGINE_MODES: Record<'ask' | 'accept-edits' | 'plan', { agent: string; description: string; permissions: Rule[] }> = {
  ask: { agent: 'polygate-ask', description: 'Ask for approval: reading is allowed; edits, commands and anything outside the working folder ask first.', permissions: [] },
  'accept-edits': { agent: 'polygate-accept-edits', description: 'Accept edits: reading and edits are allowed; commands and anything outside the working folder ask first.',
    permissions: [{ action: 'edit', resource: '*', effect: 'allow' }] },
  plan: { agent: 'polygate-plan', description: 'Plan: reading only; no edits and no commands until the plan is approved.',
    permissions: [{ action: 'edit', resource: '*', effect: 'deny' }, { action: 'shell', resource: '*', effect: 'deny' }, { action: 'execute', resource: '*', effect: 'deny' }, { action: 'subagent', resource: '*', effect: 'deny' }] },
};
const PLUGIN = 'polygate-scrub';
// Commands the agent runs inherit the engine's environment; this engine plugin drops the engine password and the agent key from it.
const PLUGIN_SOURCE = `// Written by Polygate. Commands the agent runs must not inherit the engine's password or the agent's key.
const SECRETS = ["OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD", "POLYGATE_AGENT_KEY"];
export default {
  id: "polygate.scrub-env",
  setup(context) {
    return context.shell.hook("create.before", (input) => { for (const name of SECRETS) input.env[name] = undefined; })
      .then((registration) => () => registration.dispose());
  },
};
`;
type EngineModel = { id: string; name: string; context: number; output: number };
// The agent's shell, chosen by Polygate rather than left to the engine (which follows the environment: Git Bash when SHELL is set).
// PowerShell 7 when it is installed, Windows PowerShell otherwise; both come with every Windows the desktop app supports.
export function chooseShell(which: (name: string) => string | null = name => Bun.which(name)) {
  return which('pwsh') || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
// OpenCode Free must see the agent's tools exactly as the CLI sends them, and the bridge passes them untouched only while it presents the
// OpenCode version the engine runs. When the gate has made the bridge move on, the agent's OpenCode Free requests are refused with this
// reason (other providers still work) until Polygate updates its engine. An unknown version is not a reason to refuse.
export function freeIdentityProblem(presented: string) {
  return presented && presented !== ENGINE_VERSION ? `OpenCode Free now expects OpenCode ${presented}, and the agent runs OpenCode ${ENGINE_VERSION}, so its tools would be changed on the way. Choose a model from another provider for the agent until Polygate updates its engine.` : '';
}
// File tools never reach Polygate's own folders (its vault, keys, logs and the engine's files) in these modes; a command can, since
// permissions are consent and not a sandbox. OpenCode names a folder outside the working one as `C:/path/*` (forward slashes), and
// these rules come last, after a mode's own, so Accept edits does not reopen them.
export const protectedRules = (folders: string[]): Rule[] => [...new Set(folders.map(f => path.resolve(f).replace(/\\/g, '/').replace(/\/+$/, '')))]
  .flatMap(f => (['external_directory', 'read', 'edit'] as const).map(action => ({ action, resource: `${f}/*`, effect: 'deny' as const })));
export function engineConfig(o: { gatewayUrl: string; models: EngineModel[]; protect?: string[]; shell?: string }) {
  // A model whose limits Polygate does not know yet gets conservative ones; OpenCode needs both to plan its context.
  const entries = o.models.map(m => [m.id, { name: m.name || m.id, limit: { context: m.context > 0 ? m.context : 32000, output: m.output > 0 ? m.output : 4096 }, capabilities: { tools: true } }]);
  const guard = protectedRules(o.protect || []);
  return {
    $schema: 'https://opencode.ai/config.json', update: 'disable', share: 'disabled', snapshots: true, ...(o.shell ? { shell: o.shell } : {}),
    providers: { polygate: { name: 'Polygate', package: '@ai-sdk/openai-compatible', env: ['POLYGATE_AGENT_KEY'], settings: { baseURL: o.gatewayUrl.replace(/\/+$/, '') + '/v1', apiKey: '{env:POLYGATE_AGENT_KEY}' }, models: Object.fromEntries(entries) } },
    policies: [{ action: 'provider.use', resource: '*', effect: 'deny' }, { action: 'provider.use', resource: 'polygate', effect: 'allow' }],
    permissions: [...ENGINE_PERMISSIONS, ...guard].map(r => ({ ...r })),
    agents: Object.fromEntries(Object.values(ENGINE_MODES).map(m => [m.agent, { description: m.description, mode: 'primary', permissions: [...m.permissions, ...guard].map(r => ({ ...r })) }])),
    plugins: [`./${PLUGIN}`],
  } as any;
}
// The rules each engine agent must end with: the shared ones, then the agent's own.
const expectedRules = (cfg: any): Record<string, Rule[]> => ({ build: cfg.permissions, ...Object.fromEntries(Object.entries<any>(cfg.agents).map(([id, a]) => [id, [...cfg.permissions, ...a.permissions]])) });
// Models the agent can use: from enabled providers, able to call tools, not known to be gone.
const agentModels = (): EngineModel[] => [...models.values()]
  .filter(m => m.tools && m.state !== 'unavailable' && settings.providers.some(x => x.id === m.providerId && x.enabled))
  .map(m => ({ id: m.id, name: m.name, context: m.context, output: m.output }));
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
// Writes the engine's configuration and returns it, with the hash of every file written (the configuration watch compares against them).
function writeEngineFiles(p: Paths, gatewayUrl: string) {
  for (const dir of [p.configDir, path.join(p.configDir, PLUGIN), p.cache, p.state, p.userhome, p.data]) mkdirSync(dir, { recursive: true });
  const cfg = engineConfig({ gatewayUrl, models: agentModels(), protect: [stateDir, p.root, p.data], shell: process.platform === 'win32' ? chooseShell() : undefined });
  const files: [string, string][] = [
    [path.join(p.configDir, 'opencode.json'), JSON.stringify(cfg, null, 1)],
    [path.join(p.configDir, PLUGIN, 'package.json'), JSON.stringify({ name: PLUGIN, version: '1.0.0', type: 'module', main: 'index.js', exports: { '.': './index.js' } }, null, 1)],
    [path.join(p.configDir, PLUGIN, 'index.js'), PLUGIN_SOURCE],
  ];
  // Anything else in the configuration folder would be read by the engine too (an agent, a command, another plugin): it goes.
  for (const dir of [p.configDir, path.join(p.configDir, PLUGIN)]) for (const name of readdirSync(dir)) {
    const f = path.join(dir, name); if (!(dir === p.configDir && name === PLUGIN) && !files.some(([w]) => w === f)) rmSync(f, { recursive: true, force: true });
  }
  for (const [f, text] of files) writeFileAtomic(f, text);
  return { cfg, written: new Map(files.map(([f, text]) => [f, sha256(text)])) };
}
// The files in the configuration folder that are not exactly what Polygate wrote: changed, removed or added.
function configChanges(p: Paths, written: Map<string, string>) {
  const out: string[] = [];
  for (const dir of [p.configDir, path.join(p.configDir, PLUGIN)]) {
    let names: string[] = []; try { names = readdirSync(dir); } catch { out.push(`${dir} was removed`); continue; }
    for (const name of names) { const f = path.join(dir, name); if (!(dir === p.configDir && name === PLUGIN) && !written.has(f)) out.push(`${f} was added`); }
  }
  for (const [f, hash] of written) { let now = ''; try { now = sha256(readFileSync(f)); } catch { /* removed */ } if (now !== hash) out.push(`${f} was ${now ? 'changed' : 'removed'}`); }
  return out;
}
// Undo depends on OpenCode's Git snapshots. Checked at each start with a repository at the same depth OpenCode uses; the answer goes in
// the status, so the workspace can hide Undo rather than offer one that silently does nothing.
export function snapshotCheck(p: Paths, gitExe = 'git'): { ok: boolean; reason?: string } {
  const parent = path.join(p.data, 'opencode', 'snapshot', 'polygate-check' + '0'.repeat(26)); const dir = path.join(parent, '0'.repeat(40));
  try {
    mkdirSync(parent, { recursive: true });
    const git = (args: string[]) => spawnSync(gitExe, args, { windowsHide: true, encoding: 'utf8', timeout: 15000, env: process.env });
    const init = git(['init', '--bare', '--quiet', dir]);
    if (init.error) return { ok: false, reason: 'Git is not installed, so the agent cannot undo its changes.' };
    const rev = git(['--git-dir', dir, 'rev-parse', '--is-bare-repository']);
    if (rev.status === 0 && rev.stdout.trim() === 'true') return { ok: true };
    return { ok: false, reason: `Git cannot use the snapshot folder: ${String(rev.stderr || init.stderr || '').trim().split('\n')[0]}` };
  } catch (e: any) { return { ok: false, reason: `The snapshot folder could not be prepared: ${e?.message || e}` }; }
  finally { rmSync(parent, { recursive: true, force: true }); }
}
// The engine's environment: the user's own (commands the agent runs need PATH, the user's home and tools), minus everything of
// Polygate's and any OpenCode setting the user has, plus the engine's folders, its password, the agent key and the switches the spike
// proved necessary: no project or user OpenCode configuration, no Claude Code files, no self-update, no model-list download.
export function engineEnv(p: Paths, password: string, agentKey: string) {
  const own = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/^(POLYGATE_|OPENCODE_|XDG_)/i.test(k))) as Record<string, string>;
  return { ...own, XDG_CONFIG_HOME: p.config, XDG_DATA_HOME: p.data, XDG_CACHE_HOME: p.cache, XDG_STATE_HOME: p.state, OPENCODE_TEST_HOME: p.userhome,
    OPENCODE_PASSWORD: password, POLYGATE_AGENT_KEY: agentKey,
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1' } as Record<string, string>;
}

// --- Self-test ---
// After every start: the right version, configuration read only from Polygate's folder, Polygate as the only provider, and Polygate's
// rules in force for every agent of a mode (nothing allows more after them). Any problem stops the engine; it is never used with a
// configuration it was not given. `cfg` is the configuration Polygate wrote.
export async function selfTest(url: string, auth: string, p: Paths, cfg: any, directory = p.home) {
  const get = async (route: string) => {
    const r = await fetch(`${url}${route}?directory=${encodeURIComponent(directory)}`, { headers: { authorization: auth }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`${route} answered ${r.status}`); return r.json() as Promise<any>;
  };
  const problems: string[] = [];
  const info = await get('/api/info'); if (info?.version !== ENGINE_VERSION) problems.push(`it is OpenCode ${info?.version}, not ${ENGINE_VERSION}`);
  const norm = (f: string) => path.resolve(String(f || '')).toLowerCase(); const ours = new Set([p.configDir, path.join(p.configDir, 'opencode.json')].map(norm));
  for (const doc of (await get('/api/config')) as any[]) if (!ours.has(norm(doc?.path))) problems.push(`it read configuration from ${doc?.path}`);
  for (const m of ((await get('/api/model')).data || []) as any[]) if (m?.providerID !== 'polygate') problems.push(`it offers ${m?.providerID}/${m?.id}, a provider Polygate did not configure`);
  const agents = ((await get('/api/agent')).data || []) as any[];
  const key = (r: any) => `${r?.action} ${r?.resource} ${r?.effect}`;
  for (const [id, expected] of Object.entries(expectedRules(cfg))) {
    const rules = (agents.find(a => a?.id === id)?.permissions || []) as Rule[]; const want = expected.map(key);
    let end = -1;
    for (let i = rules.length - want.length; i >= 0 && end < 0; i--) if (want.every((k, j) => key(rules[i + j]) === k)) end = i + want.length;
    if (end < 0 || rules.slice(end).some(r => r.effect === 'allow')) problems.push(`the permission rules of its ${id} agent are not the ones Polygate wrote`);
  }
  return problems;
}

// --- Run ---
let child: ChildProcess | undefined; let connection: { url: string; auth: string } | undefined;
let gatewayUrl = ''; let wanted = false; let lastStart: StartOptions = {};
let crashes: number[] = []; let restartTimer: ReturnType<typeof setTimeout> | undefined; let starting: Promise<ReturnType<typeof engineStatus>> | undefined;
// Set by main.ts once the gateway listens (and again after it moves): the engine sends its model requests there.
export const setEngineGateway = (url: string) => { gatewayUrl = url; };
// For the agent controller: where the running engine listens and how to sign in. Never sent to the dashboard.
export const engineConnection = () => connection;
// OpenCode 2.x reloads its configuration file the moment it changes, so a change Polygate did not make is acted on as it happens: the
// configuration folder is watched while the engine runs, and anything that is not exactly what Polygate wrote stops the engine.
let guard: { watchers: FSWatcher[]; timer?: ReturnType<typeof setTimeout> } | undefined;
function stopWatching() { if (!guard) return; clearTimeout(guard.timer); for (const w of guard.watchers) { try { w.close(); } catch { /* closed */ } } guard = undefined; }
function watchConfig(p: Paths, written: Map<string, string>) {
  stopWatching();
  const check = () => { if (!guard) return; clearTimeout(guard.timer); guard.timer = setTimeout(() => { const changes = configChanges(p, written); if (changes.length) tampered(changes); }, 200); };
  guard = { watchers: [] };
  for (const dir of [p.configDir, path.join(p.configDir, PLUGIN)]) { const w = watch(dir, check); w.on('error', check); guard.watchers.push(w); }
}
function tampered(changes: string[]) {
  const proc = child; stopWatching(); wanted = false; connection = undefined; child = undefined;
  setStatus({ state: 'failed', problems: changes, message: `The agent engine was stopped: its configuration was changed outside Polygate (${changes.join('; ')}).`, port: undefined, pid: undefined });
  logEvent('error', 'agent', `Agent engine stopped: its configuration was changed outside Polygate (${changes.join('; ')})`);
  if (proc) killTree(proc);
}
// `command` replaces the engine program in tests (a stand-in that answers the same endpoints).
export type StartOptions = { command?: string[] };
export function startEngine(o: StartOptions = {}, restart = false) {
  if (starting) return starting;
  if (child && status.state === 'running') return Promise.resolve(engineStatus());
  // A start the user asks for begins a fresh count; a restart after a crash keeps counting.
  if (!restart) { crashes = []; setStatus({ restarts: 0 }); }
  starting = launch(o).finally(() => { starting = undefined; });
  return starting;
}
const freePort = () => new Promise<number>((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const port = (s.address() as net.AddressInfo).port; s.close(() => resolve(port)); }); });
function killTree(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode) return;
  if (process.platform === 'win32' && proc.pid) { const r = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }); if (!r.error && !r.status) return; }
  try { proc.kill(); } catch { /* already gone */ }
}
function openLog(p: Paths) {
  mkdirSync(p.root, { recursive: true });
  try { if (statSync(p.log).size > 5 * 1024 * 1024) renameSync(p.log, p.log + '.1'); } catch { /* no log yet */ }
  return openSync(p.log, 'a');
}
async function launch(o: StartOptions) {
  const p = enginePaths(); wanted = true; lastStart = o; stopWatching();
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = undefined; }
  try {
    const exe = o.command ? o.command[0] : verifiedExe(p);
    if (p.data.length > MAX_DATA_PATH) throw new GatewayError(`The agent's data folder path is too long for Git snapshots (${p.data}).`, 409, 'agent_engine_path');
    if (!gatewayUrl) throw new GatewayError('The gateway address is not known yet. Try again in a moment.', 503);
    const key = ensureAgentKey();
    if (!key.enabled) throw new GatewayError(`The agent's client key "${key.name}" is turned off. Turn it on under Keys to start the agent.`, 409, 'agent_key_disabled');
    const { cfg, written } = writeEngineFiles(p, gatewayUrl);
    const snapshots = snapshotCheck(p);
    if (!snapshots.ok) logEvent('warn', 'agent', `Agent undo is unavailable: ${snapshots.reason}`);
    const port = await freePort(); const password = randomBytes(24).toString('base64url');
    const auth = 'Basic ' + Buffer.from('opencode:' + password).toString('base64'); const url = `http://127.0.0.1:${port}`;
    setStatus({ state: status.state === 'restarting' ? 'restarting' : 'starting', message: 'Starting the agent engine', problems: [], port: undefined, pid: undefined });
    const log = openLog(p); let proc: ChildProcess;
    try { proc = spawn(exe, [...(o.command?.slice(1) || []), 'serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: p.home, env: engineEnv(p, password, key.value), windowsHide: true, stdio: ['ignore', log, log] }); }
    finally { closeSync(log); }
    child = proc; let exited = ''; proc.once('error', e => { exited ||= e.message; }); proc.once('exit', (code, signal) => { exited ||= `it exited (${signal || code})`; onExit(proc, code, signal); });
    try {
      const end = Date.now() + HEALTH_TIMEOUT_MS; let ready = false;
      while (!ready) {
        if (exited) throw new GatewayError(`The agent engine did not start: ${exited}. See ${p.log}.`, 502, 'agent_engine_start');
        if (Date.now() > end) throw new GatewayError(`The agent engine did not answer within ${HEALTH_TIMEOUT_MS / 1000} s. See ${p.log}.`, 504, 'agent_engine_start');
        ready = await fetch(url + '/api/info', { headers: { authorization: auth }, signal: AbortSignal.timeout(2000) }).then(r => r.ok, () => false);
        if (!ready) await Bun.sleep(150);
      }
      const problems = [...await selfTest(url, auth, p, cfg), ...configChanges(p, written)];
      if (problems.length) { setStatus({ problems }); throw new GatewayError(`The agent engine was stopped: ${problems.join('; ')}.`, 502, 'agent_engine_self_test'); }
      watchConfig(p, written);
    // Forgotten before it is killed, so its exit is not taken for a crash (it can arrive while the next start is already under way).
    } catch (e) { wanted = false; stopWatching(); if (child === proc) child = undefined; killTree(proc); throw e; }
    connection = { url, auth };
    setStatus({ state: 'running', message: '', problems: [], port, pid: proc.pid, startedAt: Date.now(), snapshots });
    logEvent('info', 'agent', `Agent engine OpenCode ${ENGINE_VERSION} started on 127.0.0.1:${port}`);
    return engineStatus();
  } catch (e: any) {
    wanted = false; connection = undefined;
    setStatus({ state: 'failed', message: e?.message || String(e), port: undefined, pid: undefined });
    logEvent('error', 'agent', `Agent engine could not start: ${e?.message || e}`);
    throw e instanceof GatewayError ? e : new GatewayError(e?.message || String(e), 502, 'agent_engine_start');
  }
}
function onExit(proc: ChildProcess, code: number | null, signal: NodeJS.Signals | null) {
  if (proc !== child) return;
  child = undefined; connection = undefined; stopWatching();
  if (status.state === 'starting' || status.state === 'restarting') return; // launch() reports it
  if (!wanted) { if (status.state !== 'failed') setStatus({ state: 'idle', message: '', port: undefined, pid: undefined }); return; }
  // It stopped by itself: started again after a growing pause, until it has stopped too often.
  crashes = crashes.filter(t => Date.now() - t < CRASH_WINDOW_MS); crashes.push(Date.now());
  if (crashes.length > MAX_CRASHES) {
    wanted = false; setStatus({ state: 'failed', message: `The agent engine stopped ${crashes.length} times in 10 minutes and was left off.`, port: undefined, pid: undefined });
    logEvent('error', 'agent', `Agent engine stopped ${crashes.length} times in 10 minutes; not restarting`); return;
  }
  const delay = RESTART_DELAYS[Math.min(crashes.length - 1, RESTART_DELAYS.length - 1)];
  setStatus({ state: 'restarting', message: `The agent engine stopped (${signal || `exit code ${code}`}); starting it again in ${delay / 1000} s`, restarts: status.restarts + 1, port: undefined, pid: undefined });
  logEvent('warn', 'agent', `Agent engine stopped (${signal || `exit code ${code}`}); restarting in ${delay / 1000} s`);
  restartTimer = setTimeout(() => { restartTimer = undefined; if (wanted) startEngine(lastStart, true).catch(() => { /* launch() logged it and set the status */ }); }, delay);
  restartTimer.unref?.();
}
export async function stopEngine() {
  wanted = false; stopWatching(); if (restartTimer) { clearTimeout(restartTimer); restartTimer = undefined; }
  if (starting) await starting.catch(() => {});
  stopWatching();
  const proc = child; connection = undefined;
  if (!proc) { if (status.state !== 'failed') setStatus({ state: 'idle', message: '' }); return; }
  setStatus({ state: 'stopping', message: '' });
  const exited = proc.exitCode !== null || proc.signalCode ? Promise.resolve() : once(proc, 'exit').then(() => {});
  killTree(proc);
  await Promise.race([exited, Bun.sleep(5000)]);
  child = undefined; setStatus({ state: 'idle', message: '', port: undefined, pid: undefined });
  logEvent('info', 'agent', 'Agent engine stopped');
}

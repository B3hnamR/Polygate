// WireGuard as one route. Each imported .conf file is started by the bundled wireproxy-awg (resources/wireguard, ISC licence), a userspace
// WireGuard and AmneziaWG client that offers the tunnel as a local SOCKS port: no network adapter, route or DNS change on this computer, and
// only the gateway's own requests use it. Together the configs are the route "wireguard", an exit group like Psiphon and Surfshark
// (backend/exit-group.ts): taking turns or staying on one, used-up exits skipped per provider, new addresses checked first.
//
// The uploaded file is kept as it was written. Polygate writes it beside a small wrapper that points wireproxy-awg at it (WGConfig) and
// gives it the local SOCKS port, so the [Interface] and [Peer] sections, AmneziaWG fields included, reach the client untouched. Both files
// are deleted as soon as the tunnel is up (or the start failed).
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants as fsConstants, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { settings, persist, stateDir, redactError } from './state';
import { GatewayError } from './queue';
import { freePort, traceVia } from './warp';
import { logEvent } from './logbook';
import { notify } from './notifications';
import { detached, isCancelled, cancelledError } from './cancel';
import { registerExitGroup, type ExitScope, type ExitCheck, type ExitChecker } from './exit-group';
import type { Route, WireguardConfig, WireguardSettings } from './types';

const isWin = process.platform === 'win32';
const appDir = process.env.POLYGATE_APP_DIR || process.cwd();
const dataDir = path.join(stateDir, 'wireguard');
// Each config is its own client on its own port, counted up from here (every port is checked free first; Psiphon starts at 47100,
// Surfshark at 47400).
const BASE_PORT = 47700;
export const ROUTE_ID = 'wireguard';
const MAX_IMPORT = 200;
const MAX_TEXT = 256 * 1024;
const defaults: WireguardSettings = { enabled: true, autoStart: false, mode: 'spread', pinned: '', skip: true, renew: true, configs: [] };

// One imported configuration, checked for what the client needs before it reaches the settings: a broken file is refused at import with a
// reason, not left to fail silently when it is connected.
export type Parsed = { privateKey: string; addresses: string[]; dns: string[]; mtu: number; endpoint: string; peers: number; amnezia: boolean;
  allowedIPs: string; keepalive: string };

// go-ini strips a comment that starts after whitespace. Keys and sections are case-insensitive in wireproxy-awg (ini.LoadOptions
// Insensitive), and a repeated key keeps the first value (AllowShadows, then GetKey).
function sectionsOf(text: string) {
  const out: { name: string; values: Map<string, string> }[] = []; let cur: { name: string; values: Map<string, string> } | undefined;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([^\]]*)\]\s*(?:[;#].*)?$/.exec(line);
    if (header) { cur = { name: header[1].trim().toLowerCase(), values: new Map() }; out.push(cur); continue; }
    if (!cur) continue; // root keys, such as wireproxy's own WGConfig
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    let value = line.slice(eq + 1).trim();
    const comment = /(^|[ \t])[;#]/.exec(value);
    if (comment) value = value.slice(0, comment.index).trim();
    if (!cur.values.has(key)) cur.values.set(key, value);
  }
  return out;
}
const key = (value: string) => /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, 'base64').length === 32;
const uint = (value: string) => /^\d+$/.test(value) && Number(value) <= 0xffffffff ? Number(value) : undefined;
function range(value: string): { min: number; max: number } | undefined {
  const m = /^(\d+)(?:-(\d+))?$/.exec(value.trim()); if (!m) return undefined;
  const min = uint(m[1]); const max = m[2] === undefined ? min : uint(m[2]);
  return min === undefined || max === undefined || min > max ? undefined : { min, max };
}
function cidr(value: string, plain: boolean) {
  const slash = value.indexOf('/');
  if (slash < 0) return plain && net.isIP(value) > 0;
  const ip = value.slice(0, slash); const bits = value.slice(slash + 1); const version = net.isIP(ip);
  if (version === 0 || !/^\d{1,3}$/.test(bits)) return false;
  return Number(bits) <= (version === 4 ? 32 : 128);
}
// host:port, with an IPv6 host in brackets and a hostname or IPv4 outside them (as wireproxy resolves it).
function endpoint(value: string): { host: string; port: number } | undefined {
  let host = '', port = '';
  if (value.startsWith('[')) {
    const end = value.indexOf(']'); if (end < 2) return undefined;
    host = value.slice(1, end); if (value[end + 1] !== ':') return undefined; port = value.slice(end + 2);
    if (net.isIP(host) !== 6) return undefined;
  } else {
    const i = value.lastIndexOf(':'); if (i < 1) return undefined;
    host = value.slice(0, i); port = value.slice(i + 1);
    if (host.includes(':') || (net.isIP(host) !== 4 && !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host))) return undefined;
  }
  return /^\d{1,5}$/.test(port) && Number(port) > 0 && Number(port) <= 65535 ? { host, port: Number(port) } : undefined;
}
const bool = (value: string) => /^(true|false|1|0|yes|no|on|off|t|f)$/i.test(value.trim());

// What wireproxy-awg itself checks in an AmneziaWG [Interface] (awg_config.go), so an import fails here with the same reason the client
// would give later, and the import report can name the file.
function checkAmnezia(v: Map<string, string>) {
  const ints: Record<string, number | undefined> = {};
  for (const name of ['jc', 'jmin', 'jmax', 's1', 's2', 's3', 's4']) {
    if (!v.has(name)) continue;
    const n = uint(v.get(name)!);
    if (n === undefined) throw new GatewayError(`The AmneziaWG setting ${name.toUpperCase()} must be a whole number.`, 400, 'wireguard_config');
    ints[name] = n;
  }
  if (ints.jc !== undefined && (ints.jc < 1 || ints.jc > 128)) throw new GatewayError('The AmneziaWG setting Jc must be between 1 and 128.', 400, 'wireguard_config');
  if (ints.jmin !== undefined && ints.jmax !== undefined && ints.jmin > ints.jmax) throw new GatewayError('The AmneziaWG setting Jmin must be less than or equal to Jmax.', 400, 'wireguard_config');
  if (ints.jmax !== undefined && ints.jmax > 1280) throw new GatewayError('The AmneziaWG setting Jmax must be 1280 or less.', 400, 'wireguard_config');
  const sizes = [['s1', 148], ['s2', 92], ['s3', 64], ['s4', 32]] as const;
  const set = sizes.filter(([name]) => ints[name] !== undefined);
  for (let i = 0; i < set.length; i++) for (let j = i + 1; j < set.length; j++)
    if (ints[set[i][0]]! + set[i][1] === ints[set[j][0]]! + set[j][1]) throw new GatewayError(`The AmneziaWG padding values ${set[i][0].toUpperCase()} and ${set[j][0].toUpperCase()} give two packets the same size. Change one of them.`, 400, 'wireguard_config');
  const headers = ['h1', 'h2', 'h3', 'h4'].map((name, i) => {
    if (!v.has(name)) return { name, min: i + 1, max: i + 1 };
    const r = range(v.get(name)!);
    if (!r) throw new GatewayError(`The AmneziaWG setting ${name.toUpperCase()} must be a number or a range such as 1234-5678.`, 400, 'wireguard_config');
    return { name, ...r };
  });
  for (let i = 0; i < headers.length; i++) for (let j = i + 1; j < headers.length; j++) {
    const a = headers[i], b = headers[j];
    if (a.min <= b.max && b.min <= a.max) throw new GatewayError(`The AmneziaWG header ranges ${a.name.toUpperCase()} and ${b.name.toUpperCase()} overlap. The four ranges must not share a number.`, 400, 'wireguard_config');
  }
  if (v.has('headerprotectionkey')) {
    if (!key(v.get('headerprotectionkey')!)) throw new GatewayError('HeaderProtectionKey is not a 32-byte base64 key.', 400, 'wireguard_config');
    const short = set.find(([name]) => ints[name]! < 12);
    if (set.length < 4 || short) throw new GatewayError('With HeaderProtectionKey set, all four AmneziaWG padding values S1, S2, S3 and S4 are required and must each be at least 12.', 400, 'wireguard_config');
  }
  for (const name of ['contentpaddingaddition', 'rekeyaftertime', 'rekeytimeout', 'rejectaftertime', 'keepalivetimeout', 'maxhandshakeattempts'])
    if (v.has(name) && !range(v.get(name)!)) throw new GatewayError(`The AmneziaWG setting ${name} must be a number or a range such as 5-10.`, 400, 'wireguard_config');
  for (const name of ['randomtrailers', 'disablecookies'])
    if (v.has(name) && !bool(v.get(name)!)) throw new GatewayError(`The AmneziaWG setting ${name} must be on or off.`, 400, 'wireguard_config');
}

// Parses a .conf file into what the page shows and what a tunnel needs. Throws a message naming the section and key; never includes a key's
// value, so a bad private key cannot end up in a log line.
export function parseConfig(text: string): Parsed {
  const sections = sectionsOf(text);
  const ifaces = sections.filter(s => s.name === 'interface');
  const peers = sections.filter(s => s.name === 'peer');
  if (!ifaces.length) throw new GatewayError('This is not a WireGuard configuration: it has no [Interface] section.', 400, 'wireguard_config');
  if (ifaces.length > 1) throw new GatewayError('This configuration has more than one [Interface] section; it must have exactly one.', 400, 'wireguard_config');
  if (!peers.length) throw new GatewayError('This WireGuard configuration has no [Peer] section, so it has no server to connect to.', 400, 'wireguard_config');
  const iface = ifaces[0].values;

  const privateKey = iface.get('privatekey') || '';
  if (!privateKey) throw new GatewayError('The [Interface] section has no PrivateKey.', 400, 'wireguard_config');
  if (!key(privateKey)) throw new GatewayError('The [Interface] PrivateKey is not a 32-byte base64 WireGuard key. Copy the whole key line from the configuration you were given.', 400, 'wireguard_config');

  const addresses = (iface.get('address') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!addresses.length) throw new GatewayError('The [Interface] section has no Address (for example 10.0.0.2/32).', 400, 'wireguard_config');
  const badAddress = addresses.find(a => !cidr(a, true));
  if (badAddress) throw new GatewayError(`The [Interface] Address "${badAddress}" is not an IP address or CIDR.`, 400, 'wireguard_config');

  const dns = (iface.get('dns') || '').split(',').map(s => s.trim()).filter(Boolean);
  const badDns = dns.find(a => net.isIP(a) === 0);
  if (badDns) throw new GatewayError(`The [Interface] DNS entry "${badDns}" is not an IP address. This client takes DNS servers by IP, not by name.`, 400, 'wireguard_config');

  let mtu = 1420;
  if (iface.has('mtu')) {
    const n = uint(iface.get('mtu')!);
    if (n === undefined || n < 68 || n > 65535) throw new GatewayError('The [Interface] MTU must be a whole number between 68 and 65535.', 400, 'wireguard_config');
    mtu = n;
  }

  let allowedIPs = ''; let keepalive = ''; let firstEndpoint = '';
  for (const peer of peers) {
    const v = peer.values;
    const publicKey = v.get('publickey') || '';
    if (!publicKey) throw new GatewayError('A [Peer] section has no PublicKey.', 400, 'wireguard_config');
    if (!key(publicKey)) throw new GatewayError('A [Peer] PublicKey is not a 32-byte base64 WireGuard key.', 400, 'wireguard_config');
    if (v.has('presharedkey') && !key(v.get('presharedkey')!)) throw new GatewayError('A [Peer] PresharedKey is not a 32-byte base64 key.', 400, 'wireguard_config');
    if (v.has('endpoint')) {
      const value = v.get('endpoint')!;
      if (!endpoint(value)) throw new GatewayError(`The [Peer] Endpoint "${value}" is not a host and port, such as vpn.example.com:51820.`, 400, 'wireguard_config');
      if (!firstEndpoint) firstEndpoint = value;
    }
    if (v.has('allowedips')) {
      const list = v.get('allowedips')!.split(',').map(s => s.trim()).filter(Boolean);
      const bad = list.find(a => !cidr(a, false));
      if (bad) throw new GatewayError(`The [Peer] AllowedIPs entry "${bad}" is not a CIDR, such as 0.0.0.0/0.`, 400, 'wireguard_config');
      if (list.length) allowedIPs = list.join(', ');
    }
    if (v.has('persistentkeepalive')) {
      const value = v.get('persistentkeepalive')!.trim();
      if (!/^off$/i.test(value) && !range(value)) throw new GatewayError('The [Peer] PersistentKeepalive must be a number of seconds, a range, or off.', 400, 'wireguard_config');
      keepalive = value;
    }
  }
  if (!firstEndpoint) throw new GatewayError('No [Peer] has an Endpoint, so there is no server to connect to. Add Endpoint = host:port to the server\'s [Peer] section.', 400, 'wireguard_config');

  checkAmnezia(iface);
  const amnezia = ['jc', 'jmin', 'jmax', 's1', 's2', 's3', 's4', 'h1', 'h2', 'h3', 'h4', 'i1', 'i2', 'i3', 'i4', 'i5', 'headerprotectionkey', 'contentpaddingaddition', 'rekeyaftertime', 'rekeytimeout', 'rejectaftertime', 'keepalivetimeout', 'maxhandshakeattempts', 'randomtrailers', 'disablecookies'].some(k => iface.has(k));
  return { privateKey, addresses, dns, mtu, endpoint: firstEndpoint, peers: peers.length, amnezia, allowedIPs, keepalive };
}

// --- the bundled client ---
const binName = () => isWin ? (process.arch === 'x64' ? 'wireproxy-awg-windows-amd64.exe' : '') : process.platform === 'linux' ? (process.arch === 'x64' ? 'wireproxy-awg-linux-amd64' : process.arch === 'arm64' ? 'wireproxy-awg-linux-arm64' : '') : '';
const folders = () => [process.env.POLYGATE_WIREGUARD_DIR || '', path.join(appDir, 'wireguard'), path.join(appDir, 'resources', 'wireguard'), path.join(path.dirname(process.execPath), 'wireguard'), path.join(path.dirname(path.dirname(process.execPath)), 'wireguard')].filter(Boolean);
function runnable(file: string) { try { if (!statSync(file).isFile()) return false; if (!isWin) accessSync(file, fsConstants.X_OK); return true; } catch { return false; } }
export function findWireproxyAwg(): string | null { const name = binName(); if (!name) return null; for (const f of folders()) { const p = path.join(f, name); if (runnable(p)) return p; } return null; }
export function wireproxyMissing(): string {
  if (!binName()) return `WireGuard has no build for this platform (${process.platform} ${process.arch}). It runs on Windows x64 and Linux x64 and arm64.`;
  const present = folders().map(f => path.join(f, binName())).find(f => { try { return statSync(f).isFile() && !runnable(f); } catch { return false; } });
  return present ? `The WireGuard client at ${present} cannot be run (it has no execute permission). Fix it with: chmod +x ${present}` : 'The WireGuard client is not in this build. It belongs in the app\'s wireguard folder.';
}

// --- settings ---
export const wireguardConfig = (): WireguardSettings => {
  const c: any = { ...defaults, ...settings.wireguard };
  const ids = new Set<string>(); const names = new Set<string>();
  c.configs = Array.isArray(c.configs) ? c.configs.filter((x: any) => x && typeof x.id === 'string' && typeof x.config === 'string' && typeof x.name === 'string')
    .filter((x: any) => { if (ids.has(x.id)) return false; ids.add(x.id); return true; })
    .map((x: any) => {
      const base = String(x.name).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) || String(x.id).slice(0, 60);
      const name = uniqueName(base, names); names.add(name.toLowerCase());
      return { id: x.id, name, config: x.config, enabled: x.enabled !== false, addedAt: Number(x.addedAt) || 0 };
    }) : [];
  c.mode = c.mode === 'single' ? 'single' : 'spread';
  c.pinned = c.configs.some((x: WireguardConfig) => x.id === c.pinned) ? c.pinned : '';
  return c as WireguardSettings;
};
const save = (patch: Partial<WireguardSettings>) => { settings.wireguard = { ...wireguardConfig(), ...patch }; persist(); };
const configOf = (id: string) => wireguardConfig().configs.find(c => c.id === id);
const nameOf = (id: string) => configOf(id)?.name || id;
const enabledConfigs = () => wireguardConfig().configs.filter(c => c.enabled);

// --- instances ---
type State = 'starting' | 'ready' | 'failed';
type Instance = { id: string; name: string; port: number; proc?: ChildProcess; state: State; exitIp: string; location: string; startedAt: number; readyAt: number;
  failures: number; restarts: number; error: string; renewedAt: number[]; stopping?: boolean; output: string; handshake: boolean; checking?: ExitScope };
const instances = new Map<string, Instance>();
// The exit group names an exit by its config name (a stable id appears nowhere in the dashboard); internal maps stay keyed by id.
const instOf = (key: string) => instances.get(key) || [...instances.values()].find(i => i.name === key);
let rr = 0, monitor: ReturnType<typeof setInterval> | undefined, busy = '', lastError = '', lastNotified = '';
const configDir = (id: string) => path.join(dataDir, id);
const used = () => new Set([...instances.values()].map(i => i.port));
// What the client prints is kept for an error message, with anything that looks like a key taken out.
const clean = (s: string) => s.replace(/[A-Za-z0-9+/]{42,}={0,2}/g, '•••').replace(/\s+/g, ' ').trim().slice(-400);
const wrapperText = (configFile: string, port: number) => ['WGConfig = ' + configFile.replace(/\\/g, '/'), '', '[Socks5]', `BindAddress = 127.0.0.1:${port}`, ''].join('\n');
// The client reads the config, which holds the private key, from files in Polygate's own data folder, readable by this user only, and only
// while the client starts: they are deleted as soon as the tunnel is up (or the start failed).
const confOf = (id: string) => path.join(configDir(id), 'wireproxy.conf');
const clientOf = (id: string) => path.join(configDir(id), 'wireguard.conf');
const dropConf = (id: string) => { for (const f of [confOf(id), clientOf(id)]) { try { rmSync(f, { force: true }); } catch { /* already gone */ } } };
function writeConf(id: string, text: string, port: number): void {
  mkdirSync(configDir(id), { recursive: true, mode: 0o700 });
  const client = clientOf(id); const body = text.replace(/^\uFEFF/, '');
  writeFileSync(client, body.endsWith('\n') ? body : body + '\n', { mode: 0o600 });
  writeFileSync(confOf(id), wrapperText(client, port), { mode: 0o600 });
}
// The client's own check: the same parser that start uses, without opening a tunnel or a port. A config that fails here would have ended
// up as a process that exits at once, with a log line instead of a reason on the page.
async function coreCheck(text: string): Promise<void> {
  const bin = findWireproxyAwg(); if (!bin) return;
  const id = 'check-' + randomBytes(4).toString('hex'); const dir = configDir(id);
  try {
    writeConf(id, text, 1);
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(bin, ['-n', '-c', confOf(id)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; const data = (d: Buffer) => { output += d; if (output.length > 20000) output = output.slice(-20000); };
      proc.stdout!.on('data', data); proc.stderr!.on('data', data);
      const timer = setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } }, 15000); timer.unref?.();
      proc.once('error', e => { clearTimeout(timer); reject(new GatewayError(`The WireGuard client could not check this configuration: ${e.message}`, 500, 'wireguard_error')); });
      proc.once('exit', code => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new GatewayError(`The WireGuard client rejected this configuration: ${clean(output) || `the check exited with code ${code ?? '?'}`}`, 400, 'wireguard_config'));
      });
    });
  } finally {
    dropConf(id);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
}

async function launch(inst: Instance): Promise<ChildProcess> {
  const bin = findWireproxyAwg(); if (!bin) throw new GatewayError(wireproxyMissing(), 503, 'wireguard_not_installed');
  const c = configOf(inst.id); if (!c) throw new GatewayError(`The WireGuard config ${inst.name} was removed.`, 400, 'wireguard_config');
  writeConf(inst.id, c.config, inst.port);
  const proc = spawn(bin, ['-c', confOf(inst.id)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  const data = (d: Buffer) => { buf += d; if (buf.length > 1e6) buf = buf.slice(-2e5); let n; while ((n = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, n); buf = buf.slice(n + 1); onLine(inst, line); } };
  proc.stdout!.on('data', data); proc.stderr!.on('data', data);
  await new Promise<void>((resolve, reject) => { proc.once('spawn', () => resolve()); proc.once('error', e => { dropConf(inst.id); reject(new GatewayError(`The WireGuard client could not start: ${e.message}`, 502, 'wireguard_error')); }); });
  return proc;
}
function onLine(inst: Instance, line: string) {
  if (instances.get(inst.id) !== inst) return;
  if (/Received handshake response/i.test(line)) { if (!inst.handshake) { inst.handshake = true; dropConf(inst.id); void learnExit(inst, true); } }
  else if (/error|failed|could not|unable|lacks|invalid/i.test(line) && !/DEBUG/.test(line)) inst.output = clean(line);
}

// One start per config at a time, and none survives a stop: `epoch` moves on every stopAll (as in backend/psiphon.ts).
let epoch = 0; const starting = new Map<string, Promise<Instance>>();
function startInstance(id: string, fresh = false): Promise<Instance> {
  const running = starting.get(id); if (running) return running;
  // A client outlives the request that started it: it runs detached from that request, so a cancel never reaches its later checks.
  const job = detached(() => startOnce(id, fresh, epoch)).finally(() => { if (starting.get(id) === job) starting.delete(id); });
  starting.set(id, job); return job;
}
const stopped = () => new GatewayError('WireGuard was stopped', 409, 'wireguard_stopped');
function stopProcess(proc?: ChildProcess) { try { proc?.kill(); } catch { /* already gone */ } }
const exitOf = (proc: ChildProcess) => new Promise<void>(r => { if (proc.exitCode !== null || proc.signalCode) return r(); proc.once('exit', () => r()); setTimeout(r, 5000); });
async function startOnce(id: string, fresh: boolean, at: number): Promise<Instance> {
  const old = instances.get(id);
  if (old) { old.stopping = true; stopProcess(old.proc); if (old.proc) await exitOf(old.proc); }
  if (at !== epoch) throw stopped();
  const avoid = used(); if (old) avoid.delete(old.port);
  const port = old?.port && !fresh ? old.port : await freePort(BASE_PORT, avoid);
  if (at !== epoch) throw stopped();
  const c = configOf(id); if (!c || !c.enabled) throw new GatewayError(`The WireGuard config ${old?.name || id} is turned off.`, 400, 'wireguard_config');
  const inst: Instance = { id, name: c.name, port, state: 'starting', exitIp: '', location: '', startedAt: Date.now(), readyAt: 0, failures: 0, restarts: old?.restarts || 0, error: '', renewedAt: old?.renewedAt || [], output: '', handshake: false };
  instances.set(id, inst);
  try {
    inst.proc = await launch(inst);
    const exited = (code: number | null) => { dropConf(id); onExit(inst, code); };
    inst.proc.once('exit', exited);
    // The client can exit between the spawn event and this listener (a config the runtime rejects after the -n check passed);
    // without this, the exit is never handled and the config stays "connecting" until the 45 s timeout.
    if (inst.proc.exitCode !== null || inst.proc.signalCode) exited(inst.proc.exitCode);
    if (at !== epoch || instances.get(id) !== inst) { inst.stopping = true; stopProcess(inst.proc); if (instances.get(id) === inst) instances.delete(id); throw stopped(); }
    // No handshake within 45 s: the WireGuard packets (UDP to the endpoint) do not get through, or the keys are not accepted. The client is
    // stopped and started again later with a growing wait, like a client that stopped by itself.
    const t = setTimeout(() => { if (instances.get(id) === inst && inst.state === 'starting') { inst.error = inst.handshake ? 'Connected, but no request passed through the tunnel.' : 'The server did not answer: the WireGuard handshake never completed. UDP to the endpoint may be blocked on this network, or the config\'s keys were replaced or revoked.'; inst.state = 'failed'; stopProcess(inst.proc); } }, 45000);
    t.unref?.();
  } catch (e: any) { dropConf(id); inst.state = 'failed'; inst.error = redactError(String(e.message || e)); throw e; }
  return inst;
}
// The exit address is what OpenCode sees, and what its allowance belongs to. A reconnect can land on another server.
async function learnExit(inst: Instance, first: boolean) {
  let egress = null;
  for (let i = 0; i < 3 && !egress; i++) { egress = await traceVia('127.0.0.1', inst.port, 20000); if (instances.get(inst.id) !== inst) return; }
  if (!egress?.ip) { if (first) inst.output = inst.output || 'The tunnel is up but no request passed through it yet.'; return; }
  const wasReady = inst.state === 'ready';
  const changed = egress.ip !== inst.exitIp; inst.exitIp = egress.ip; inst.location = egress.loc || '';
  inst.state = 'ready'; inst.error = ''; inst.failures = 0; inst.restarts = 0; if (!wasReady) inst.readyAt = Date.now();
  dropConf(inst.id); // the tunnel is up: the files with the key are no longer needed
  const spent = spentUntil(egress.ip);
  if (!wasReady || changed) logEvent('info', 'wireguard', `WireGuard ${inst.name} is connected; exit ${egress.ip}${spent ? ' (used up today)' : ''}`, { config: inst.id, ip: egress.ip });
  const scope = recheck.get(inst.id);
  if (scope) {
    if (!wireguardConfig().renew) { recheck.delete(inst.id); return; }
    if (scope === 'opencode' ? spent : kiloUntil(egress.ip)) { if (!tryRenew(inst, scope)) recheck.delete(inst.id); return; }
    void checkExit(inst, scope);
  }
}
const recheck = new Map<string, ExitScope>();
function tryRenew(inst: Instance, scope: ExitScope) {
  const now = Date.now(); inst.renewedAt = inst.renewedAt.filter(t => now - t < 3600000);
  if (inst.renewedAt.length >= 3) return false;
  inst.renewedAt.push(now); recheck.set(inst.id, scope);
  const t = detached(() => setTimeout(() => { if (instances.get(inst.id) === inst && wireguardConfig().renew) void renewWireguard(inst.id, true).catch(() => recheck.delete(inst.id)); }, 3000)); t.unref?.(); return true;
}
let checker: ExitChecker | undefined;
export const setWireguardChecker = (fn?: ExitChecker) => { checker = fn; };
const scopeName = (scope: ExitScope) => scope === 'kilo' ? 'Kilo Free' : 'OpenCode Free';
async function checkExit(inst: Instance, scope: ExitScope) {
  if (inst.checking) return;
  if (!checker) { recheck.delete(inst.id); return; }
  inst.checking = scope;
  let r: ExitCheck; try { r = await checker(inst.id, scope); } catch (e: any) { r = { result: 'unknown', note: redactError(String(e?.message || e)) }; }
  if (instances.get(inst.id) !== inst) return;
  inst.checking = undefined;
  recheck.delete(inst.id);
  if (r.result === 'used-up') {
    logEvent('info', 'wireguard', `WireGuard ${inst.name}'s new address ${inst.exitIp} is used up for ${scopeName(scope)} too`, { config: inst.id, ip: inst.exitIp });
    if (scope === 'kilo') wireguardKiloLimited(inst.id, r.until || Date.now() + 30 * 60000); else wireguardSpent(inst.id, r.until || Date.now() + 3600000);
    return;
  }
  if (r.result === 'ok') { if (scope === 'opencode') wireguardClean(inst.id); logEvent('info', 'wireguard', `WireGuard ${inst.name}'s new address ${inst.exitIp} works for ${scopeName(scope)}; it is back in turn`, { config: inst.id, ip: inst.exitIp }); }
  else logEvent('info', 'wireguard', `WireGuard ${inst.name}'s new address ${inst.exitIp} could not be checked with ${scopeName(scope)}${r.note ? ` (${r.note.slice(0, 160)})` : ''}; real requests decide`, { config: inst.id });
}
function onExit(inst: Instance, code: number | null) {
  if (instances.get(inst.id) !== inst || inst.stopping) return;
  inst.state = 'failed'; inst.error = inst.error || inst.output || `The WireGuard client stopped (code ${code ?? '?'})`;
  if (!wireguardConfig().enabled || inst.restarts >= 5) return;
  const wait = Math.min(120000, 5000 * 2 ** inst.restarts); inst.restarts++;
  const t = detached(() => setTimeout(() => { if (instances.get(inst.id) === inst && !inst.stopping) void startInstance(inst.id).catch(() => {}); }, wait)); t.unref?.();
}

// --- used-up exits (as in backend/psiphon.ts) ---
export function spentUntil(ip: string): number { const until = (ip && wireguardConfig().spent?.[ip]) || 0; return until > Date.now() ? until : 0; }
const kiloLimits = new Map<string, number>();
export const kiloUntil = (ip: string) => { const until = (ip && kiloLimits.get(ip)) || 0; return until > Date.now() ? until : 0; };
function pruneSpent() {
  const c = wireguardConfig(); const now = Date.now(); const spent = Object.fromEntries(Object.entries(c.spent || {}).filter(([, until]) => until > now));
  if (Object.keys(spent).length !== Object.keys(c.spent || {}).length) save({ spent });
  for (const [ip, until] of kiloLimits) if (until <= now) kiloLimits.delete(ip);
}
export function wireguardSpent(key: string, until: number) {
  const inst = instOf(key); if (!inst?.exitIp) return;
  const c = wireguardConfig(); save({ spent: { ...(c.spent || {}), [inst.exitIp]: until } });
  logEvent('info', 'wireguard', `WireGuard ${inst.name} exit ${inst.exitIp} has used up its OpenCode Free allowance until ${new Date(until).toISOString().slice(0, 16).replace('T', ' ')} UTC`, { config: inst.id, ip: inst.exitIp });
  if (c.renew) tryRenew(inst, 'opencode');
}
export function wireguardKiloLimited(key: string, until: number) {
  const inst = instOf(key); if (!inst?.exitIp) return;
  kiloLimits.set(inst.exitIp, until);
  logEvent('info', 'wireguard', `WireGuard ${inst.name} exit ${inst.exitIp} reached Kilo's free limit for its address; Kilo uses the other configs until ${new Date(until).toISOString().slice(11, 16)} UTC`, { config: inst.id, ip: inst.exitIp });
  if (wireguardConfig().renew) tryRenew(inst, 'kilo');
}
export function wireguardClean(key: string) {
  const inst = instOf(key); const c = wireguardConfig(); if (!inst?.exitIp || !c.spent?.[inst.exitIp]) return;
  const { [inst.exitIp]: _gone, ...spent } = c.spent; save({ spent });
}
export function wireguardFailed(key: string) { const inst = instOf(key); if (!inst) return; if (++inst.failures >= 3 && inst.state === 'ready') { inst.failures = 0; void renewWireguard(inst.id, true).catch(() => {}); } }
export function wireguardOk(key: string) { const inst = instOf(key); if (inst) inst.failures = 0; }

// --- picking an exit for a request ---
const blocked = (i: Instance, scope: ExitScope, skip: boolean) => {
  if (!skip || scope === 'other') return false;
  if (recheck.get(i.id) === scope) return true;
  return scope === 'opencode' ? !!spentUntil(i.exitIp) : !!kiloUntil(i.exitIp);
};
const usable = (i: Instance, scope: ExitScope, skip: boolean) => i.state === 'ready' && !blocked(i, scope, skip);
// The configs a request can be sent to, in the order of the settings: the pinned one alone, or every enabled one.
const candidates = (c: WireguardSettings) => (c.mode === 'single' ? [c.pinned || c.configs.find(x => x.enabled)?.id || ''] : c.configs.filter(x => x.enabled).map(x => x.id)).map(id => instances.get(id)).filter((i): i is Instance => !!i);
export function pickWireguard(tried: Set<string> = new Set(), scope: ExitScope = 'other') {
  const c = wireguardConfig(); if (!c.enabled) return null;
  const live = candidates(c).filter(i => !tried.has(i.id) && !tried.has(i.name) && usable(i, scope, c.skip));
  if (!live.length) return null; const i = c.mode === 'single' ? live[0] : live[rr++ % live.length]; return { region: i.name, port: i.port };
}
export const wireguardSkips = () => wireguardConfig().skip;
export const wireguardLive = () => [...instances.values()].filter(i => i.state === 'ready').length;
export const wireguardReady = (scope: ExitScope = 'other') => { const c = wireguardConfig(); return c.enabled ? candidates(c).filter(i => usable(i, scope, c.skip)).length : 0; };
export function wireguardUnavailable(scope: ExitScope = 'other'): string {
  const c = wireguardConfig();
  if (!c.configs.some(x => x.enabled)) return 'No WireGuard config is turned on. Add .conf files under Routing → Relays.';
  if (!c.enabled) return 'WireGuard is turned off. Turn it on under Routing → Relays.';
  if (!instances.size) return 'WireGuard is not connected. Connect it under Routing → Relays.';
  const all = candidates(c); const ready = all.filter(i => i.state === 'ready');
  const limit = scope === 'kilo' ? "Kilo's free limit" : 'its OpenCode Free allowance';
  if (c.mode === 'single') {
    const id = c.pinned || c.configs.find(x => x.enabled)?.id || ''; const i = all[0];
    return `WireGuard ${nameOf(id)} can't take this request: ${!i || i.state !== 'ready' ? 'it is not connected' : `its exit has reached ${limit}`}. Choose another config, or let WireGuard take turns.`;
  }
  if (!ready.length) return `No WireGuard config is connected yet (${[...instances.values()].map(i => `${i.name}: ${i.state}`).join(', ')}).`;
  return `Every connected WireGuard exit has reached ${limit}.${c.renew ? ' Polygate is getting new addresses for them.' : ' Turn on "Get a new address when one is used up" to have Polygate try others.'}`;
}
export function wireguardVirtualRoute(key: string): Route | undefined {
  const i = instOf(key); return i ? { id: `${ROUTE_ID}:${i.id}`, name: `WireGuard ${i.name}`, kind: 'proxy', url: `socks5://127.0.0.1:${i.port}`, enabled: true, models: [] } : undefined;
}
export const wireguardRegionsReady = () => [...instances.values()].filter(i => i.state === 'ready').map(i => ({ region: i.name, exitIp: i.exitIp }));

// --- the managed route ---
function fallbackRoute(): string {
  const on = (id?: string) => !!id && id !== ROUTE_ID && settings.routes.some(r => r.id === id && r.enabled);
  return on(settings.previousRouteId) ? settings.previousRouteId! : on('direct') ? 'direct' : settings.routes.find(r => r.enabled && r.id !== ROUTE_ID)?.id || settings.routeId;
}
function ensureRoute(enabled: boolean) {
  let route = settings.routes.find(r => r.id === ROUTE_ID);
  if (!route) { if (!enabled) return; route = { id: ROUTE_ID, name: 'WireGuard', kind: 'proxy', url: 'wireguard://local', enabled: true, models: [], managed: true } satisfies Route; settings.routes.push(route); persist(); return; }
  if (route.enabled !== enabled) { route.enabled = enabled; if (enabled) { route.cooldownUntil = 0; route.failures = 0; route.opened = 0; } }
  if (!enabled && settings.routeId === ROUTE_ID) { const to = fallbackRoute(); if (to !== ROUTE_ID) { settings.routeId = to; logEvent('info', 'wireguard', `WireGuard stopped; requests now use ${settings.routes.find(r => r.id === to)?.name || to}`, { route: to }); } }
  persist();
}
// Makes the route match what is running: on while a client runs, off when none does (after a restart, or a restored backup).
export function reconcileWireguard() {
  const c = wireguardConfig();
  for (const [id, inst] of [...instances]) if (!c.configs.some(x => x.id === id && x.enabled)) { inst.stopping = true; stopProcess(inst.proc); instances.delete(id); dropConf(id); }
  ensureRoute(instances.size > 0 && c.enabled);
}

// --- names and import ---
function cleanName(raw: string) {
  const base = String(raw || '').split(/[\\/]/).pop() || '';
  return base.replace(/\.conf$/i, '').replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/\s+/g, ' ').slice(0, 60).trim();
}
// Duplicates are always added, never skipped or replaced: the second "home" becomes "home-2", the third "home-3". The suffix has to fit
// inside the 60-character limit, or sanitising a restored name would trim it away and two configs would end up with the same name.
function uniqueName(base: string, taken: Set<string>) {
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) { const suffix = `-${n}`; const candidate = `${base.slice(0, 60 - suffix.length).trimEnd()}${suffix}`; if (!taken.has(candidate.toLowerCase())) return candidate; }
}
export type ImportResult = { added: { id: string; name: string; renamedFrom?: string; amnezia: boolean; endpoint: string }[]; failed: { name: string; error: string }[]; summary: string };
export async function wireguardImport(input: unknown): Promise<ImportResult> {
  if (!Array.isArray(input) || !input.length) throw new GatewayError('Choose one or more WireGuard .conf files to import.', 400, 'wireguard_import');
  if (input.length > MAX_IMPORT) throw new GatewayError(`Import at most ${MAX_IMPORT} configs at a time.`, 400, 'wireguard_import');
  const c = wireguardConfig(); const added: ImportResult['added'] = []; const failed: ImportResult['failed'] = [];
  const taken = new Set(c.configs.map(x => x.name.toLowerCase()));
  const configs = [...c.configs];
  for (let i = 0; i < input.length; i++) {
    const item: any = input[i];
    const rawName = cleanName(String(item?.name || ''));
    const base = rawName || (input.length > 1 ? `WireGuard ${i + 1}` : 'WireGuard');
    const text = typeof item?.text === 'string' ? item.text : '';
    if (!text.trim()) { failed.push({ name: base, error: 'The file is empty.' }); continue; }
    if (text.length > MAX_TEXT) { failed.push({ name: base, error: 'The file is larger than 256 KiB, which is not a WireGuard configuration.' }); continue; }
    try {
      const parsed = parseConfig(text);
      await coreCheck(text);
      const name = uniqueName(base, taken); taken.add(name.toLowerCase());
      const id = 'wg-' + randomBytes(4).toString('hex');
      configs.push({ id, name, config: text.replace(/^\uFEFF/, ''), enabled: true, addedAt: Date.now() });
      added.push({ id, name, ...(name !== base ? { renamedFrom: base } : {}), amnezia: parsed.amnezia, endpoint: parsed.endpoint });
    } catch (e: any) {
      if (isCancelled()) throw cancelledError();
      failed.push({ name: base, error: redactError(String(e?.message || e)).slice(0, 400) });
    }
  }
  if (added.length) {
    settings.wireguard = { ...c, configs }; persist();
    logEvent('info', 'wireguard', `Imported ${added.length} WireGuard config${added.length === 1 ? '' : 's'}${added.some(a => a.amnezia) ? ` (${added.filter(a => a.amnezia).length} AmneziaWG)` : ''}${failed.length ? `; ${failed.length} could not be used` : ''}`);
    // A connected group follows its new configs at once.
    if (instances.size && c.enabled) for (const a of added) await startInstance(a.id).catch(() => {});
    reconcileWireguard();
  }
  const summary = added.length
    ? `Imported ${added.length} WireGuard config${added.length === 1 ? '' : 's'}${added.some(a => a.amnezia) ? ` (${added.filter(a => a.amnezia).length} AmneziaWG)` : ''}${failed.length ? `; ${failed.length} could not be used` : ''}.`
    : `No config was imported${failed.length ? `: ${failed.length} file${failed.length === 1 ? ' could not be used' : 's could not be used'}` : ''}.`;
  return { added, failed, summary };
}

// --- actions ---
const guard = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  if (busy) throw new GatewayError(`WireGuard is busy (${busy}). Try again in a moment.`, 409, 'wireguard_busy');
  busy = name; lastError = '';
  try { return await fn(); } catch (e: any) { if (isCancelled()) throw cancelledError(); lastError = redactError(String(e.message || e)); throw e instanceof GatewayError ? e : new GatewayError(lastError, 502, 'wireguard_error'); } finally { busy = ''; }
};
export function wireguardConnect() {
  return guard('connecting', async () => {
    const c = wireguardConfig();
    if (!c.enabled) throw new GatewayError('WireGuard is turned off. Turn it on first.', 400);
    if (!findWireproxyAwg()) throw new GatewayError(wireproxyMissing(), 503, 'wireguard_not_installed');
    const enabled = c.configs.filter(x => x.enabled);
    if (!enabled.length) throw new GatewayError('Import a WireGuard .conf file first, then connect.', 400);
    for (const [id, inst] of [...instances]) if (!enabled.some(x => x.id === id)) { inst.stopping = true; stopProcess(inst.proc); instances.delete(id); dropConf(id); }
    for (const x of enabled) { const i = instances.get(x.id); if (!i || i.state === 'failed') { if (i) i.restarts = 0; await startInstance(x.id); } }
    ensureRoute(true); startMonitor();
    return wireguardStatus();
  });
}
export function wireguardDisconnect() { return guard('disconnecting', async () => { await stopAll(); ensureRoute(false); return wireguardStatus(); }); }
// Reconnects one config: the endpoint is looked up again, which can land on another server, so another exit address.
export async function renewWireguard(id: string, auto = false) {
  const c = wireguardConfig(); const entry = c.configs.find(x => x.id === id); if (!entry) throw new GatewayError('No such WireGuard config', 404);
  if (!auto && busy) throw new GatewayError(`WireGuard is busy (${busy}). Try again in a moment.`, 409, 'wireguard_busy');
  if (!instances.has(id)) throw new GatewayError(`WireGuard ${entry.name} is not running. Connect WireGuard first.`, 409, 'wireguard_not_running');
  const before = instances.get(id)?.exitIp || '';
  await startInstance(id, true);
  logEvent('info', 'wireguard', `WireGuard ${entry.name} is reconnecting for a new address${before ? ` (was ${before})` : ''}`, { config: id, auto });
  return wireguardStatus();
}
// The full file for the editor. It stays in the encrypted settings; the page asks for it only when someone opens it.
export function wireguardConfigText(id: string): string {
  const c = configOf(id); if (!c) throw new GatewayError('No such WireGuard config', 404);
  return c.config;
}
export async function wireguardUpdate(input: { id?: unknown; name?: unknown; text?: unknown }) {
  const id = String(input.id || ''); const c = wireguardConfig(); const found = c.configs.find(x => x.id === id);
  if (!found) throw new GatewayError('No such WireGuard config', 404);
  const patch: Partial<WireguardConfig> = {};
  if (input.name !== undefined) {
    const name = cleanName(String(input.name));
    if (!name) throw new GatewayError('Give this config a name.', 400);
    const taken = new Set(c.configs.filter(x => x.id !== id).map(x => x.name.toLowerCase()));
    patch.name = uniqueName(name, taken);
  }
  if (input.text !== undefined) {
    const text = String(input.text);
    if (!text.trim()) throw new GatewayError('The configuration is empty.', 400);
    if (text.length > MAX_TEXT) throw new GatewayError('The file is larger than 256 KiB, which is not a WireGuard configuration.', 400);
    parseConfig(text); await coreCheck(text);
    patch.config = text.replace(/^\uFEFF/, '');
  }
  if (!Object.keys(patch).length) throw new GatewayError('Nothing to change.', 400);
  settings.wireguard = { ...c, configs: c.configs.map(x => x.id === id ? { ...x, ...patch } : x) }; persist();
  const inst = instances.get(id);
  if (inst) {
    if (patch.name) inst.name = patch.name;
    if (patch.config !== undefined) await startInstance(id, true).catch(() => {});
  }
  logEvent('info', 'wireguard', `WireGuard ${patch.name || found.name} was ${patch.config !== undefined ? 'updated' : 'renamed'}${patch.config !== undefined && patch.name ? ' and renamed' : ''}`, { config: id });
  return wireguardStatus();
}
export async function wireguardToggle(id: string, enabled: boolean) {
  const c = wireguardConfig(); const found = c.configs.find(x => x.id === id);
  if (!found) throw new GatewayError('No such WireGuard config', 404);
  if (found.enabled === enabled) return wireguardStatus();
  settings.wireguard = { ...c, configs: c.configs.map(x => x.id === id ? { ...x, enabled } : x) }; persist();
  if (!enabled) {
    const inst = instances.get(id); if (inst) { inst.stopping = true; stopProcess(inst.proc); instances.delete(id); dropConf(id); }
    if (c.pinned === id) { const next = enabledConfigs()[0]?.id || ''; save({ pinned: next }); }
  } else if (instances.size && c.enabled) await startInstance(id).catch(e => { lastError = redactError(String(e?.message || e)); });
  logEvent('info', 'wireguard', `WireGuard ${found.name} is ${enabled ? 'on' : 'off'}`);
  reconcileWireguard();
  return wireguardStatus();
}
export async function wireguardRemove(id: string) {
  const c = wireguardConfig(); const found = c.configs.find(x => x.id === id);
  if (!found) throw new GatewayError('No such WireGuard config', 404);
  const inst = instances.get(id); if (inst) { inst.stopping = true; stopProcess(inst.proc); instances.delete(id); dropConf(id); }
  settings.wireguard = { ...c, configs: c.configs.filter(x => x.id !== id), ...(c.pinned === id ? { pinned: '' } : {}) }; persist();
  logEvent('info', 'wireguard', `WireGuard ${found.name} was removed`);
  reconcileWireguard();
  return wireguardStatus();
}
export async function setWireguardSettings(patch: Partial<WireguardSettings>) {
  const c = wireguardConfig(); const next: WireguardSettings = { ...c };
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.autoStart !== undefined) next.autoStart = !!patch.autoStart;
  if (patch.skip !== undefined) next.skip = !!patch.skip;
  if (patch.renew !== undefined) { next.renew = !!patch.renew; if (!next.renew) recheck.clear(); }
  if (patch.mode !== undefined) { if (!['spread', 'single'].includes(String(patch.mode))) throw new GatewayError('Mode must be spread or single', 400); next.mode = patch.mode; }
  if (patch.pinned !== undefined) {
    const p = String(patch.pinned || '');
    if (p && !next.configs.some(x => x.id === p)) throw new GatewayError('That is not one of the imported WireGuard configs.', 400);
    next.pinned = p;
  }
  if (next.mode === 'single' && !next.configs.some(x => x.id === next.pinned && x.enabled)) next.pinned = next.configs.find(x => x.enabled)?.id || '';
  settings.wireguard = next; persist();
  if (!next.enabled) { await stopAll(); ensureRoute(false); }
  // Running clients follow the settings at once: disabled ones stop, re-enabled ones start.
  else if (instances.size) {
    for (const [id, inst] of [...instances]) if (!next.configs.some(x => x.id === id && x.enabled)) { inst.stopping = true; stopProcess(inst.proc); instances.delete(id); dropConf(id); }
    for (const x of next.configs) if (x.enabled && !instances.has(x.id)) await startInstance(x.id).catch(() => {});
  }
  reconcileWireguard();
  return wireguardStatus();
}
async function stopAll() {
  epoch++; const live = [...instances.values()]; instances.clear(); recheck.clear();
  for (const i of live) { i.stopping = true; stopProcess(i.proc); }
  await Promise.all(live.map(i => i.proc ? exitOf(i.proc) : undefined));
  for (const i of live) dropConf(i.id);
}
function startMonitor() {
  if (monitor) return;
  monitor = setInterval(() => {
    pruneSpent();
    for (const i of instances.values()) if (i.state !== 'failed' && i.handshake && !i.exitIp) void learnExit(i, false);
    const state = wireguardLive() ? 'up' : instances.size ? 'down' : 'off';
    if (state !== lastNotified && lastNotified) { if (state === 'up') notify('WireGuard connected', `${wireguardLive()} config${wireguardLive() === 1 ? '' : 's'} connected.`, 'success', 'wireguard-up'); else if (state === 'down') notify('WireGuard disconnected', 'No WireGuard config is connected. Polygate keeps trying.', 'warning', 'wireguard-down'); }
    lastNotified = state;
  }, 30000);
  monitor.unref?.();
}
// What the WireGuard section shows. The files themselves never go to the dashboard: only where each one connects, and what it carries.
export function wireguardStatus() {
  const c = wireguardConfig(); const bin = findWireproxyAwg(); const now = Date.now(); const route = settings.routes.find(r => r.id === ROUTE_ID);
  return {
    installed: !!bin, problem: bin ? '' : wireproxyMissing(), platform: `${process.platform}-${process.arch}`,
    busy, lastError, running: instances.size > 0, live: wireguardLive(),
    config: { enabled: c.enabled, autoStart: c.autoStart, mode: c.mode, pinned: c.pinned, skip: c.skip, renew: c.renew },
    configs: c.configs.map(entry => {
      const i = instances.get(entry.id); const until = i?.exitIp ? spentUntil(i.exitIp) : 0;
      let parsed: Parsed | null = null; try { parsed = parseConfig(entry.config); } catch { /* a restored backup may hold a file that no longer parses; the row still shows it */ }
      return { id: entry.id, name: entry.name, enabled: entry.enabled, addedAt: entry.addedAt,
        endpoint: parsed?.endpoint || '', address: parsed?.addresses.join(', ') || '', mtu: parsed?.mtu || 0, amnezia: !!parsed?.amnezia, peers: parsed?.peers || 0,
        state: i ? i.state : 'stopped', port: i?.port || 0, exitIp: i?.exitIp || '', since: i?.readyAt || 0,
        usedUpUntil: until, kiloUntil: i?.exitIp ? kiloUntil(i.exitIp) : 0, checking: i && recheck.get(entry.id) ? recheck.get(entry.id) : '',
        error: i?.state === 'failed' ? i.error : '' };
    }),
    spent: Object.entries(c.spent || {}).filter(([, until]) => until > now).length,
    route: { exists: !!route, enabled: !!route?.enabled, inUse: settings.routeId === ROUTE_ID },
  };
}
// At start: connect when asked to, or when WireGuard is the route in use. Otherwise the route is switched off to match, so nothing is sent
// into a WireGuard that is not running.
export async function startWireguard() {
  const c = wireguardConfig(); pruneSpent();
  const wanted = c.enabled && c.configs.some(x => x.enabled) && !!findWireproxyAwg() && (c.autoStart || settings.routeId === ROUTE_ID);
  if (wanted) await wireguardConnect().catch(e => console.warn('[wireguard] start:', redactError(String(e.message || e))));
  reconcileWireguard();
}
export async function stopWireguard() { if (monitor) clearInterval(monitor); monitor = undefined; await stopAll(); }
// WireGuard is one exit group: the route machinery (backend/transport.ts) reaches it through these.
registerExitGroup({ id: ROUTE_ID, label: 'WireGuard', unit: 'config', source: 'wireguard', pick: pickWireguard, ready: wireguardReady, live: wireguardLive, unavailable: wireguardUnavailable,
  virtualRoute: wireguardVirtualRoute, regionsReady: wireguardRegionsReady, spent: wireguardSpent, kiloLimited: wireguardKiloLimited, clean: wireguardClean,
  failed: wireguardFailed, ok: wireguardOk, skips: wireguardSkips, setChecker: setWireguardChecker });
export const __instances = instances;
export const __wrapperText = wrapperText;

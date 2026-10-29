import net from 'node:net';
import dns from 'node:dns/promises';
// Bun's fetch can use an HTTP proxy but not SOCKS. This bridge exposes a local HTTP proxy (CONNECT and absolute-form requests)
// whose upstream is a SOCKS4 or SOCKS5 server, so WARP and any socks4:// or socks5:// route work.
export type SocksUpstream = { host: string; port: number; username?: string; password?: string; version?: 4 | 5 };
const bridges = new Map<string, Promise<string>>();
const servers = new Set<net.Server>();
// Each distinct SOCKS upstream gets its own local listener. Pool tests and warm-up touch thousands of them over days, so the number is capped and
// listeners nobody has used for a while are closed (a new one starts on demand).
type Bridge = { key: string; server: net.Server; active: number; last: number };
const meta = new Map<string, Bridge>(); const MAX_BRIDGES = 64; const IDLE_MS = 10 * 60000;
let sweeper: ReturnType<typeof setInterval> | undefined;
export const bridgeCount = () => meta.size;
function dropBridge(b: Bridge) { b.server.close(); servers.delete(b.server); bridges.delete(b.key); meta.delete(b.key); }
function sweep(idleFor: number) { const now = Date.now(); for (const b of [...meta.values()]) if (b.active === 0 && now - b.last >= idleFor) dropBridge(b); }
const HEADER_LIMIT = 16 * 1024;
const keyOf = (u: SocksUpstream) => `${u.version || 5}|${u.username || ''}:${u.password || ''}@${u.host}:${u.port}`;
const socksReply = ['succeeded', 'general failure', 'connection not allowed', 'network unreachable', 'host unreachable', 'connection refused', 'TTL expired', 'command not supported', 'address type not supported'];
// Opens a SOCKS5 tunnel to host:port through the upstream. The target is sent as a domain name so the proxy resolves it (no DNS leak).
export function socksConnect(up: SocksUpstream, host: string, port: number, timeoutMs = 15000): Promise<net.Socket> {
  if (up.version === 4) return socks4Connect(up, host, port, timeoutMs);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: up.host, port: up.port }); socket.setNoDelay(true);
    let state: 'method' | 'auth' | 'connect' = 'method'; let buffer = Buffer.alloc(0); let done = false;
    const fail = (error: Error) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); reject(error); };
    const timer = setTimeout(() => fail(new Error(`SOCKS5 ${up.host}:${up.port} timed out after ${timeoutMs}ms`)), timeoutMs);
    const sendConnect = () => {
      state = 'connect'; const kind = net.isIP(host);
      const address = kind === 4 ? Buffer.concat([Buffer.from([0x01]), Buffer.from(host.split('.').map(Number))])
        : kind === 6 ? Buffer.concat([Buffer.from([0x04]), ipv6Bytes(host)])
        : Buffer.concat([Buffer.from([0x03, Buffer.byteLength(host)]), Buffer.from(host)]);
      socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), address, Buffer.from([(port >> 8) & 0xff, port & 0xff])]));
    };
    socket.once('connect', () => socket.write(up.username ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00])));
    socket.on('data', (chunk: Buffer) => {
      if (done) return; buffer = Buffer.concat([buffer, chunk]);
      if (state === 'method') {
        if (buffer.length < 2) return; if (buffer[0] !== 0x05) return fail(new Error('Not a SOCKS5 server'));
        const method = buffer[1]; buffer = buffer.subarray(2);
        if (method === 0x00) return sendConnect();
        if (method === 0x02 && up.username) { const u = Buffer.from(up.username), p = Buffer.from(up.password || ''); state = 'auth'; return void socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p])); }
        return fail(new Error(`SOCKS5 server refused every authentication method (${method})`));
      }
      if (state === 'auth') {
        if (buffer.length < 2) return; if (buffer[1] !== 0x00) return fail(new Error('SOCKS5 username/password rejected')); buffer = buffer.subarray(2); return sendConnect();
      }
      if (buffer.length < 4) return;
      if (buffer[1] !== 0x00) return fail(new Error(`SOCKS5 connect to ${host}:${port} failed: ${socksReply[buffer[1]] || 'code ' + buffer[1]}`));
      const atyp = buffer[3]; const length = atyp === 0x01 ? 10 : atyp === 0x04 ? 22 : atyp === 0x03 ? (buffer.length > 4 ? 7 + buffer[4] : 99) : 0;
      if (!length) return fail(new Error('SOCKS5 reply has an unknown address type')); if (buffer.length < length) return;
      done = true; clearTimeout(timer); socket.removeAllListeners('data'); socket.removeAllListeners('error');
      const rest = buffer.subarray(length); if (rest.length) socket.unshift(rest); resolve(socket);
    });
    socket.once('error', fail); socket.once('close', () => fail(new Error('SOCKS5 connection closed during handshake')));
  });
}
// SOCKS4 only carries an IPv4 address, so the target is resolved here (the user id is the proxy's username, if any).
async function socks4Connect(up: SocksUpstream, host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  const ip = net.isIPv4(host) ? host : (await dns.lookup(host, { family: 4 })).address;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: up.host, port: up.port }); socket.setNoDelay(true); let buffer = Buffer.alloc(0); let done = false;
    const fail = (error: Error) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); reject(error); };
    const timer = setTimeout(() => fail(new Error(`SOCKS4 ${up.host}:${up.port} timed out after ${timeoutMs}ms`)), timeoutMs);
    socket.once('connect', () => socket.write(Buffer.concat([Buffer.from([0x04, 0x01, (port >> 8) & 0xff, port & 0xff]), Buffer.from(ip.split('.').map(Number)), Buffer.from(up.username || ''), Buffer.from([0x00])])));
    socket.on('data', (chunk: Buffer) => {
      if (done) return; buffer = Buffer.concat([buffer, chunk]); if (buffer.length < 8) return;
      if (buffer[1] !== 0x5a) return fail(new Error(`SOCKS4 connect to ${host}:${port} was refused (code ${buffer[1]})`));
      done = true; clearTimeout(timer); socket.removeAllListeners('data'); socket.removeAllListeners('error');
      const rest = buffer.subarray(8); if (rest.length) socket.unshift(rest); resolve(socket);
    });
    socket.once('error', fail); socket.once('close', () => fail(new Error('SOCKS4 connection closed during handshake')));
  });
}
function ipv6Bytes(address: string) {
  const [head, tail = ''] = address.split('::'); const h = head ? head.split(':') : []; const t = tail ? tail.split(':') : [];
  const parts = address.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h; const out = Buffer.alloc(16);
  parts.forEach((p, i) => out.writeUInt16BE(parseInt(p || '0', 16), i * 2)); return out;
}
function handle(client: net.Socket, up: SocksUpstream) {
  client.setNoDelay(true); let head = Buffer.alloc(0);
  const refuse = (status: string) => { try { client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { client.destroy(); } };
  const onData = async (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]); const end = head.indexOf('\r\n\r\n');
    if (end < 0) { if (head.length > HEADER_LIMIT) { client.off('data', onData); refuse('431 Request Header Fields Too Large'); } return; }
    client.off('data', onData); client.pause();
    const text = head.subarray(0, end).toString('latin1'); const rest = head.subarray(end + 4); const lines = text.split('\r\n'); const [method, target, version] = lines[0].split(' ');
    try {
      if (method === 'CONNECT') {
        const i = target.lastIndexOf(':'); const host = target.slice(0, i).replace(/^\[|\]$/g, ''); const port = Number(target.slice(i + 1));
        if (!host || !(port > 0)) return refuse('400 Bad Request');
        const upstream = await socksConnect(up, host, port);
        if (client.destroyed) { upstream.destroy(); return; } // the client left while the tunnel was being made
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (rest.length) upstream.write(rest); link(client, upstream); return;
      }
      const url = new URL(target); const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
      if (url.protocol !== 'http:') return refuse('400 Bad Request');
      const upstream = await socksConnect(up, url.hostname.replace(/^\[|\]$/g, ''), port);
      if (client.destroyed) { upstream.destroy(); return; }
      // One request per connection: a kept-alive client connection could otherwise send its next request (to another host) down this tunnel.
      const headers = [...lines.slice(1).filter(l => !/^(proxy-|connection:|keep-alive:)/i.test(l)), 'Connection: close'];
      upstream.write(Buffer.concat([Buffer.from(`${method} ${url.pathname}${url.search} ${version}\r\n${headers.join('\r\n')}\r\n\r\n`, 'latin1'), rest])); link(client, upstream);
    } catch { refuse('502 Bad Gateway'); }
  };
  client.on('data', onData); client.on('error', () => client.destroy());
}
function link(a: net.Socket, b: net.Socket) {
  a.on('error', () => b.destroy()); b.on('error', () => a.destroy()); a.on('close', () => b.destroy()); b.on('close', () => a.destroy());
  a.pipe(b); b.pipe(a); a.resume();
}
// Returns the local HTTP proxy URL for a SOCKS5 upstream, starting the bridge on first use.
export function socksBridge(up: SocksUpstream): Promise<string> {
  const key = keyOf(up); const existing = bridges.get(key); if (existing) return existing;
  const started = new Promise<string>((resolve, reject) => {
    if (meta.size >= MAX_BRIDGES) { const idle = [...meta.values()].filter(b => b.active === 0).sort((a, b) => a.last - b.last)[0]; if (idle) dropBridge(idle); }
    const entry: Bridge = { key, server: undefined as unknown as net.Server, active: 0, last: Date.now() };
    const server = net.createServer(client => { entry.active++; client.once('close', () => { entry.active--; entry.last = Date.now(); }); handle(client, up); }); servers.add(server);
    entry.server = server; meta.set(key, entry);
    if (!sweeper) { sweeper = setInterval(() => sweep(IDLE_MS), 5 * 60000); sweeper.unref?.(); }
    server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`));
  });
  bridges.set(key, started); started.catch(() => bridges.delete(key)); return started;
}
export function closeSocksBridges() { for (const s of servers) s.close(); servers.clear(); bridges.clear(); meta.clear(); if (sweeper) { clearInterval(sweeper); sweeper = undefined; } }
export function parseSocksUrl(raw: string): SocksUpstream | null {
  try { const u = new URL(raw); if (!/^socks(4a?|5h?):$/.test(u.protocol)) return null; return { version: u.protocol.startsWith('socks4') ? 4 as const : 5 as const, host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) || 1080, username: decodeURIComponent(u.username) || undefined, password: decodeURIComponent(u.password) || undefined }; } catch { return null; }
}

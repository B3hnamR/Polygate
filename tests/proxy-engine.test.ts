import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
const dir = mkdtempSync(path.join(os.tmpdir(), 'polygate-engine-'));
process.env.POLYGATE_STATE = dir; process.env.POLYGATE_NO_DISCOVERY = '1';
const engine = await import('../backend/proxy-engine');
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* the state folder is in the temp directory */ } });
// A target that answers like the OpenCode model list, and three tiny proxies in front of it.
const target = Bun.serve({ port: 0, hostname: '127.0.0.2', fetch: req => new URL(req.url).pathname === '/models' ? Response.json({ data: [{ id: 'x' }] }) : new Response('nope', { status: 404 }) });
const API = `http://127.0.0.2:${target.port}/models`;
const listen = (handler: (c: net.Socket) => void) => new Promise<net.Server>(r => { const s = net.createServer(c => { c.on('error', () => {}); handler(c); }); s.listen(0, '127.0.0.1', () => r(s)); });
const port = (s: net.Server) => (s.address() as net.AddressInfo).port;
const pipe = (c: net.Socket, host: string, p: number, ok: () => void) => { const up = net.connect(p, host, () => { ok(); up.pipe(c); c.pipe(up); }); up.on('error', () => c.destroy()); c.on('close', () => up.destroy()); };
const httpProxy = (auth?: string) => listen(c => c.once('data', (d: Buffer) => {
  const text = d.toString(); const m = /^CONNECT ([^:]+):(\d+)/.exec(text);
  if (!m || (auth && !text.includes('Proxy-Authorization: Basic ' + Buffer.from(auth).toString('base64')))) { c.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
  pipe(c, m[1], Number(m[2]), () => c.write('HTTP/1.1 200 Connection established\r\n\r\n'));
}));
const socks5Proxy = () => listen(c => c.once('data', () => { c.write(Buffer.from([5, 0])); c.once('data', (d: Buffer) => {
  const host = d[3] === 3 ? d.subarray(5, 5 + d[4]).toString() : d.subarray(4, 8).join('.'); const at = d[3] === 3 ? 5 + d[4] : 8;
  pipe(c, host, d.readUInt16BE(at), () => c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])));
}); }));
const socks4Proxy = () => listen(c => c.once('data', (d: Buffer) => pipe(c, d.subarray(4, 8).join('.'), d.readUInt16BE(2), () => c.write(Buffer.from([0, 0x5a, 0, 0, 0, 0, 0, 0])))));
const cand = (proto: 'http' | 'socks4' | 'socks5', p: number, userinfo = '') => ({ url: `${proto}://127.0.0.1:${p}`, proxy: `${proto}://${userinfo}127.0.0.1:${p}`, proto, host: '127.0.0.1', port: p });

test('A pasted list is read in every common shape, private addresses are dropped, and a bare address is tried under each protocol', () => {
  const text = ['# comment', '8.8.4.4:3128', 'socks5://1.1.1.1:1080', 'http://user:p%40ss@9.9.9.9:8080', '1.0.0.1:80 US 120ms', '127.0.0.1:8080', '192.168.1.5:3128', '10.0.0.1:80', 'localhost:80', 'junk', '8.8.4.4:3128', '1.2.3.4:99999'].join('\r\n');
  const list = engine.parseProxyText(text);
  expect(list.filter(c => c.host === '8.8.4.4').map(c => c.proto)).toEqual(['http', 'socks5', 'socks4']);
  expect(list.find(c => c.url === 'socks5://1.1.1.1:1080')).toBeTruthy(); expect(list.filter(c => c.host === '1.1.1.1').length).toBe(1);
  const auth = list.find(c => c.host === '9.9.9.9')!; expect(auth.url).toBe('http://9.9.9.9:8080'); expect(auth.proxy).toBe('http://user:p%40ss@9.9.9.9:8080');
  expect(list.some(c => ['127.0.0.1', '192.168.1.5', '10.0.0.1', 'localhost', '1.2.3.4'].includes(c.host))).toBe(false);
  expect(engine.parseProxyText('5.5.5.5:80', 'socks4').map(c => c.url)).toEqual(['socks4://5.5.5.5:80']); expect(engine.parseProxyText('5.5.5.5:80', 'https').map(c => c.url)).toEqual(['http://5.5.5.5:80']);
});
test('A proxy is checked by loading the API through it: HTTP CONNECT (with a login), SOCKS5 and SOCKS4 all pass, a refusing proxy and a dead one do not', async () => {
  const servers = [await httpProxy(), await httpProxy('me:secret'), await socks5Proxy(), await socks4Proxy()];
  try {
    const [plain, login, s5, s4] = servers.map(port);
    for (const c of [cand('http', plain), cand('http', login, 'me:secret@'), cand('socks5', s5), cand('socks4', s4)]) { const r = await engine.checkApi(c, 4000, API); expect(r?.status).toBe(200); expect(r!.latency).toBeGreaterThanOrEqual(0); }
    expect(await engine.checkApi(cand('http', login), 3000, API)).toBeNull();                    // wrong credentials
    expect(await engine.checkApi(cand('http', plain), 3000, `http://127.0.0.2:${target.port}/other`)).toBeNull();   // the API answered something else
    expect(await engine.checkApi(cand('socks5', 1), 1500, API)).toBeNull();                      // nothing listens
    const found = await engine.verify([cand('http', plain), cand('socks5', 1), cand('socks4', s4)], { api: API, timeoutMs: 3000 }); expect([...found.keys()].sort()).toEqual([`http://127.0.0.1:${plain}`, `socks4://127.0.0.1:${s4}`]);
  } finally { for (const s of servers) s.close(); }
});
test('Proxies that passed are saved fastest first, can be removed, and a check job reports its outcome', async () => {
  engine.__resetEngine();
  const a = cand('http', 1111), b = cand('http', 2222), c = cand('http', 3333);
  engine.addVerified([a, b, c], new Map([[a.url, { latency: 900, status: 200 }], [b.url, { latency: 100, status: 200 }]]));
  expect(engine.storedProxies().map(s => s.port)).toEqual([2222, 1111]);
  engine.removeProxies([b.url]); expect(engine.storedProxies().map(s => s.port)).toEqual([1111]); engine.removeProxies(); expect(engine.storedProxies()).toEqual([]);
  // Nothing at these public test addresses answers, so every check times out and nothing is saved.
  let followed = 0; engine.startImport('203.0.113.7:8080', { api: API, timeoutSec: 1, gateMs: 2500, after: () => { followed++; } });
  expect(engine.engineJob().running).toBe(true);
  for (let i = 0; i < 60 && engine.engineJob().running; i++) await Bun.sleep(100);
  const job = engine.engineJob(); expect(job.running).toBe(false); expect(job.phase).toBe('done'); expect(job.total).toBe(3); expect(job.passed).toBe(0); expect(job.message).toContain('0 of 3'); expect(followed).toBe(1);
  expect(engine.storedProxies()).toEqual([]);
});
test('SOCKS4 and SOCKS5 proxy URLs are both understood by the bridge', async () => {
  const { parseSocksUrl } = await import('../backend/socks-bridge');
  expect(parseSocksUrl('socks4://1.2.3.4:1081')).toMatchObject({ version: 4, host: '1.2.3.4', port: 1081 }); expect(parseSocksUrl('socks4a://u@1.2.3.4')).toMatchObject({ version: 4, port: 1080, username: 'u' });
  expect(parseSocksUrl('socks5h://u:p@1.2.3.4:1')).toMatchObject({ version: 5, username: 'u', password: 'p' }); expect(parseSocksUrl('http://1.2.3.4:80')).toBeNull();
});
test('Downloaded lists keep only IP addresses, so a host name cannot point the scan at this machine\'s network', () => {
  const text = ['8.8.4.4:3128', 'proxy.example.com:8080', 'socks5://evil.example.net:1080', '[2606:4700::1111]:3128'].join('\n');
  expect(engine.parseProxyText(text, 'http', true).map(c => c.host)).toEqual(['8.8.4.4', '[2606:4700::1111]']);
  expect(engine.parseProxyText(text, 'http').map(c => c.host)).toEqual(['8.8.4.4', 'proxy.example.com', 'evil.example.net', '[2606:4700::1111]']);
});

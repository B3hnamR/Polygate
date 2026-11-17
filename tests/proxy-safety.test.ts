import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { gzipSync } from 'node:zlib';

// Evaluate the real module with deny-by-default imports and inert state, never the application bootstrap.
function isolated(file: string, deps: Record<string, any>, names: string[]) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    .replace(/^import .*;\r?$/gm, '').replace(/^export \{[^\n]*\};\r?$/gm, '')
    .replace(/\bexport /g, '').replace(/\bimport\(/g, 'loadModule(');
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
  const loadModule = async (name: string) => { throw new Error('Unexpected module: ' + name); };
  const values = { loadModule, ...deps };
  return new Function('deps', `const { ${Object.keys(values).join(', ')} } = deps;\n${code}\nreturn { ${names.join(', ')} };`)(values);
}
const timer = () => ({ unref() {} });
const base = (settings: any = {}) => ({
  settings, net, path, stateDir: '/fixture', PROXY_SOURCES: [], existsSync: () => false,
  persist() {}, mkdirSync() {}, writeFileAtomic() {}, notify() {}, redactError: String,
  setTimeout: timer, clearTimeout() {}, setInterval: timer, clearInterval() {},
  fetch: async () => { throw new Error('Unexpected fetch'); },
});
const fixtureUrl = 'https://8.8.8.8/proxies.txt'; // Passed only to the stubbed fetch; never contacted.

test('explicit HTTPS URLs cannot reappear as plaintext candidates; list HTTPS hints remain compatible', () => {
  const { parseProxyText, splitLinks } = isolated('../backend/proxy-engine.ts', base(), ['parseProxyText', 'splitLinks']);
  for (const text of [
    'https://alice:secret@8.8.4.4:443', 'HTTPS://8.8.4.4:443',
    'https://alice:secret@proxy.example:443', 'https://[2606:4700::1111]:443',
    `https://${'a'.repeat(100)}:secret@8.8.4.4:443`,
    '<td>https://alice:secret@8.8.4.4:443</td>',
    '<td>https://alice:secret@8.8.4.4</td><td>443</td>',
    'https://alice:secret@proxy.example',
    JSON.stringify({ proxy: 'https://alice:secret@8.8.4.4:443' }),
    JSON.stringify({ proxy: 'https://alice:secret@8.8.4.4:443', ip: '8.8.4.4', port: 443, protocol: 'https' }),
    '{"proxy":"https:\\/\\/alice:secret@8.8.4.4:443"}',
  ]) {
    const warnings: string[] = [];
    expect(parseProxyText(text, 'https', false, (m: string) => warnings.push(m))).toEqual([]);
    expect(warnings.length).toBe(1); expect(warnings[0]).toContain('TLS-to-proxy');
    expect(warnings[0]).not.toContain('secret'); expect(warnings[0]).not.toContain('alice');
  }
  expect(parseProxyText('https://alice:secret@8.8.4.4:443\n9.9.9.9:80', 'https').map((c: any) => c.proxy)).toEqual(['http://9.9.9.9:80']);
  expect(parseProxyText('{"ip":"9.9.9.9","port":80,"protocol":"https"}', 'all').map((c: any) => c.proxy)).toEqual(['http://9.9.9.9:80']);
  const literal = parseProxyText(JSON.stringify({ ip: '9.9.9.9', port: 80, protocol: 'http', username: 'user', password: 'https://literal-password' }));
  expect(decodeURIComponent(new URL(literal[0].proxy).password)).toBe('https://literal-password');
  expect(splitLinks('https://u:p@[2606:4700::1111]:443').links).toEqual([]);
  expect(splitLinks('https://u:p@proxy.example').links).toEqual([]);
  expect(splitLinks('https://lists.example:443/list.txt').links).toEqual(['https://lists.example:443/list.txt']);
});

test('JSON decoding precedes scanning and a rejected TLS record suppresses aliases and descendants only', () => {
  const { parseProxyText } = isolated('../backend/proxy-engine.ts', base(), ['parseProxyText']);
  const records = [
    String.raw`{"proxy":"https:\u002f\u002falice:secret@8.8.4.4:443"}`,
    String.raw`{"proxy":"https:\/\/alice:secret@8.8.4.4:443"}`,
    String.raw`{"proxy":"https://alice:secret@8.8.4.4:443\nhttp://8.8.4.4:443"}`,
    JSON.stringify({ proxy: 'https://alice:secret@8.8.4.4:443', address: '8.8.4.4:443:alice:secret' }),
    JSON.stringify({ proxy: 'https://alice:secret@8.8.4.4:443', endpoint: { ip: '8.8.4.4', port: 443, username: 'alice', password: 'secret' } }),
    JSON.stringify({ url: 'https://[2606:4700::1111]:443', endpoint: [{ address: '8.8.4.4:443:alice:secret' }] }),
  ];
  for (const record of records) {
    const warnings: string[] = [];
    expect(parseProxyText(record, 'https', false, (s: string) => warnings.push(s))).toEqual([]);
    expect(warnings.length).toBe(1); expect(warnings[0]).not.toContain('alice'); expect(warnings[0]).not.toContain('secret');
    const siblings = `{"data":[${record},{"ip":"9.9.9.9","port":80,"protocol":"https"},{"proxy":"socks4a://1.1.1.1:1080"}]}`;
    expect(parseProxyText(siblings, 'https').map((c: any) => c.proxy)).toEqual(['http://9.9.9.9:80', 'socks4a://1.1.1.1:1080']);
  }
  const password = 'https://literal:8@8.8.4.4:443,;|%40\nraw';
  const literal = parseProxyText(JSON.stringify({ ip: '9.9.9.9', port: 80, protocol: 'http', username: 'raw%40user', password }));
  expect(literal.length).toBe(1);
  expect(decodeURIComponent(new URL(literal[0].proxy).username)).toBe('raw%40user');
  expect(decodeURIComponent(new URL(literal[0].proxy).password)).toBe(password);
  expect(parseProxyText(JSON.stringify(['https://alice:secret@8.8.4.4:443', 'http://[2606:4700::1111]:80']), 'https').map((c: any) => c.proxy)).toEqual(['http://[2606:4700::1111]:80']);
  expect(parseProxyText(String.raw`["http:\/\/9.9.9.9:80\nsocks4a:\/\/1.1.1.1:1080"]`).map((c: any) => c.proxy)).toEqual(['http://9.9.9.9:80', 'socks4a://1.1.1.1:1080']);
});

test('generic JSON string fields retain proxy-list compatibility without scanning credentials or rejected records', () => {
  const { parseProxyText } = isolated('../backend/proxy-engine.ts', base(), ['parseProxyText']);
  expect(parseProxyText('[{"endpoint":"http://9.9.9.9:80"}]').map((c: any) => c.proxy)).toEqual(['http://9.9.9.9:80']);
  expect(parseProxyText('[{"value":"9.9.9.9:80"}]', 'https').map((c: any) => c.proxy)).toEqual(['http://9.9.9.9:80']);
  expect(parseProxyText(JSON.stringify({ metadata: 'US proxy 9.9.9.9:80' }), 'http').map((c: any) => c.proxy)).toEqual(['http://9.9.9.9:80']);
  for (const key of ['endpoint', 'value', 'metadata', 'arbitraryField']) {
    const rejected = { [key]: 'https://alice:secret@8.8.4.4:443', address: '8.8.4.4:443:alice:secret', nested: { ip: '8.8.4.4', port: 443, username: 'alice', password: 'secret' } };
    const warnings: string[] = [];
    const result = parseProxyText(JSON.stringify([rejected, { value: 'http://9.9.9.9:80' }]), 'http', false, (s: string) => warnings.push(s));
    expect(result.map((c: any) => c.proxy)).toEqual(['http://9.9.9.9:80']);
    expect(warnings.length).toBe(1); expect(warnings[0]).not.toContain('secret');
  }
  for (const key of ['username', 'user', 'login', 'password', 'pass', 'pwd', 'auth', 'authorization', 'Proxy-Authorization', 'token', 'access_token', 'refreshToken', 'api_key', 'secret', 'credentials']) {
    for (const value of ['http://8.8.4.4:443', 'https://alice:secret@8.8.4.4:443', { value: 'http://8.8.4.4:443' }]) {
      const warnings: string[] = [];
      const result = parseProxyText(JSON.stringify({ endpoint: 'http://9.9.9.9:80', [key]: value }), 'http', false, (s: string) => warnings.push(s));
      expect(result.map((c: any) => c.proxy)).toEqual(['http://9.9.9.9:80']); expect(warnings).toEqual([]);
    }
  }
});

test('same-line URL separators preserve valid entries but do not expose a TLS credential tail', () => {
  const { parseProxyText, splitLinks } = isolated('../backend/proxy-engine.ts', base(), ['parseProxyText', 'splitLinks']);
  for (const delimiter of [',', ';', '|', '\n', '\r\n']) {
    const text = `https://8.8.4.4:443${delimiter}http://9.9.9.9:80`;
    expect(parseProxyText(text, 'https').map((c: any) => c.proxy)).toEqual(['http://9.9.9.9:80']);
    expect(splitLinks(text).links).toEqual([]);
    expect(parseProxyText(`https://alice:secret@8.8.4.4:443${delimiter}http://[2606:4700::1111]:80`, 'https').map((c: any) => c.proxy)).toEqual(['http://[2606:4700::1111]:80']);
  }
  for (const delimiter of [',', ';', '|']) {
    expect(parseProxyText(`https://u:123${delimiter}http://9.9.9.9:80@8.8.4.4:443`, 'http')).toEqual([]);
    expect(parseProxyText(`https://u:secret${delimiter}8.8.4.4:443@1.1.1.1:443`, 'http')).toEqual([]);
  }
  expect(parseProxyText('https://8.8.4.4:443\nhttp://bob:other@9.9.9.9:80', 'https').map((c: any) => c.proxy)).toEqual(['http://bob:other@9.9.9.9:80']);
  expect(parseProxyText('https://8.8.4.4:443,http://9.9.9.9:80;socks4a://1.1.1.1:1080', 'https').map((c: any) => c.proxy)).toEqual(['http://9.9.9.9:80', 'socks4a://1.1.1.1:1080']);
});

test('unsupported or mismatched proxy schemes are rejected before sockets or credential handling', async () => {
  let sockets = 0, socks = 0;
  const engine = isolated('../backend/proxy-engine.ts', {
    ...base(), net: { ...net, connect() { sockets++; throw new Error('must not connect'); } },
    socksConnect() { socks++; throw new Error('must not connect'); },
  }, ['checkApi', 'openTunnel']);
  for (const c of [
    { proto: 'http', proxy: 'https://alice:secret@8.8.8.8:443' },
    { proto: 'socks5', proxy: 'https://alice:bad%ZZ@8.8.8.8:443' },
    { proto: 'http', proxy: 'http://alice:secret@8.8.8.8:80', url: 'https://8.8.8.8:80' },
    { proto: 'http', proxy: 'socks4a://alice:secret@8.8.8.8:1080' },
    { proto: 'https', proxy: 'http://alice:secret@8.8.8.8:80' },
  ]) expect(await engine.checkApi(c, 100, 'http://example.invalid/models')).toBeNull();
  expect(() => engine.openTunnel({ proto: 'http', proxy: 'https://alice:secret@8.8.8.8:443' }, 'example.invalid', 443, 100)).toThrow('TLS-to-proxy');
  expect(sockets).toBe(0); expect(socks).toBe(0);
});

test('import jobs report TLS rejection without credentials and keep valid mixed entries', async () => {
  let connects = 0;
  const engine = isolated('../backend/proxy-engine.ts', {
    ...base(), net: { ...net, connect() { connects++; throw new Error('fixture refusal'); } },
  }, ['startImport', 'engineJob']);
  for (const mixed of [false, true]) {
    engine.startImport('https://alice:secret@8.8.8.8:443' + (mixed ? '\n9.9.9.9:80' : ''), { api: 'http://example.invalid/models', timeoutSec: 1, gateMs: 100 }, 'http');
    for (let i = 0; i < 40 && engine.engineJob().running; i++) await Promise.resolve();
    const job = engine.engineJob();
    expect(job.running).toBe(false); expect(job.total).toBe(mixed ? 1 : 0);
    expect(job.message).toContain('TLS-to-proxy'); expect(job.message).not.toContain('secret');
  }
  expect(connects).toBe(1);
});

test('SOCKS4a survives parsing and stored-pool loading without changing legacy SOCKS4 rows', async () => {
  const rows = ['http', 'socks4', 'socks5', 'socks4a'].map(proto => ({ proto, url: `${proto}://8.8.8.8:1080`, proxy: `${proto}://8.8.8.8:1080`, host: '8.8.8.8', port: 1080, addedAt: 123 }));
  let upstream: any;
  const engine = isolated('../backend/proxy-engine.ts', {
    ...base(), existsSync: () => true, readFileSync: () => JSON.stringify(rows),
    socksConnect(up: any) { upstream = up; return Promise.resolve({}); },
  }, ['storedProxies', 'parseProxyText', 'openTunnel']);
  expect(engine.storedProxies()).toEqual(rows);
  const parsed = engine.parseProxyText('socks4a://u:p@8.8.8.8:1080\nsocks4://8.8.8.8:1080');
  expect(parsed.map((c: any) => c.proto)).toEqual(['socks4a', 'socks4']);
  await engine.openTunnel(parsed[0], 'example.invalid', 443, 100);
  expect(upstream).toMatchObject({ version: 4, remoteDns: true, username: 'u', password: 'p' });
  await engine.openTunnel(parsed[1], 'example.invalid', 443, 100);
  expect(upstream).toMatchObject({ version: 4, remoteDns: false });
});

test('SOCKS4a wire encoding does not perform local DNS; legacy SOCKS4 still does', async () => {
  const requests: Buffer[] = []; let lookups = 0, sockets = 0;
  const socks = isolated('../backend/socks-bridge.ts', {
    ...base(), dns: { async lookup() { lookups++; return { address: '203.0.113.7' }; } },
    net: { ...net, connect() {
      sockets++; const socket: any = new EventEmitter(); socket.setNoDelay = () => {}; socket.destroy = () => {}; socket.unshift = () => {};
      socket.write = (b: Buffer) => { requests.push(b); queueMicrotask(() => socket.emit('data', Buffer.from([0, 90, 0, 0, 0, 0, 0, 0]))); };
      queueMicrotask(() => socket.emit('connect')); return socket;
    } },
  }, ['socksConnect', 'parseSocksUrl', 'keyOf']);
  const remote = socks.parseSocksUrl('socks4a://user@127.0.0.1:1080');
  const local = socks.parseSocksUrl('socks4://user@127.0.0.1:1080');
  expect(socks.keyOf(remote)).not.toBe(socks.keyOf(local));
  await socks.socksConnect(remote, 'service.invalid', 443);
  expect(lookups).toBe(0);
  expect(requests[0]).toEqual(Buffer.concat([Buffer.from([4, 1, 1, 187, 0, 0, 0, 1]), Buffer.from('user\0service.invalid\0')]));
  await socks.socksConnect(local, 'service.invalid', 80);
  expect(lookups).toBe(1); expect(requests[1].subarray(4, 8)).toEqual(Buffer.from([203, 0, 113, 7]));
  await socks.socksConnect(remote, '203.0.113.8', 80);
  expect(lookups).toBe(1); expect(requests[2].subarray(4, 8)).toEqual(Buffer.from([203, 0, 113, 8]));
  expect(requests[2].subarray(8).toString()).toBe('user\0');
  for (const host of ['bad\0host', '::1', '[::1]', '', 'bad host', 'bad/host', 'a'.repeat(254), '999.1.1.1', '0.0.0.1']) await expect(socks.socksConnect(remote, host, 443)).rejects.toThrow();
  await expect(socks.socksConnect({ ...remote, username: 'bad\0user' }, 'service.invalid', 443)).rejects.toThrow();
  await expect(socks.socksConnect(remote, 'service.invalid', 65536)).rejects.toThrow();
  expect(sockets).toBe(3); expect(lookups).toBe(1);
});

function listEngine(response: Response) {
  let signal: AbortSignal | undefined;
  const engine = isolated('../backend/proxy-engine.ts', {
    ...base(), fetch: async (_: unknown, init: RequestInit) => { signal = init.signal as AbortSignal; return response; },
  }, ['fetchList']);
  return { engine, aborted: () => signal?.aborted };
}

test('download cap counts decoded bytes, accepts exactly the ceiling, and rejects all partial results on overflow', async () => {
  const limit = 8_000_000;
  for (const over of [false, true]) {
    let cancelled = 0, reads = 0;
    const first = new TextEncoder().encode('8.8.8.8:80\n');
    const chunks = [first, new Uint8Array(limit - first.length).fill(32), new Uint8Array([32])];
    const response = new Response(new ReadableStream({
      pull(c) { reads++; if (chunks.length && (over || reads <= 2)) c.enqueue(chunks.shift()!); else c.close(); },
      cancel() { cancelled++; },
    }, { highWaterMark: 0 }), { headers: { 'content-length': '1', 'content-encoding': 'gzip' } });
    // A fetch Response body contains decoded bytes even if compressed metadata remains.
    const h = listEngine(response); const result = await h.engine.fetchList(fixtureUrl, 'http');
    if (over) { expect(result.found).toEqual([]); expect(result.error).toContain('8,000,000 decoded bytes'); expect(cancelled).toBe(1); expect(h.aborted()).toBe(true); expect(reads).toBe(3); }
    else { expect(result.error).toBeUndefined(); expect(result.found.length).toBe(1); expect(cancelled).toBe(0); }
  }
});

test('stream decoding retains split UTF-8 credentials and downloaded TLS warnings', async () => {
  const bytes = new TextEncoder().encode('http://user:p\u00e4ss@8.8.8.8:80\nhttps://alice:secret@9.9.9.9:443');
  let i = 0;
  const h = listEngine(new Response(new ReadableStream({ pull(c) { if (i === bytes.length) c.close(); else c.enqueue(bytes.subarray(i, ++i)); } })));
  const r = await h.engine.fetchList(fixtureUrl, 'https');
  expect(r.found.map((c: any) => c.proxy)).toEqual(['http://user:p%C3%A4ss@8.8.8.8:80']);
  expect(r.error).toContain('TLS-to-proxy'); expect(r.error).not.toContain('secret');
});

test('an actually decompressed list is bounded by expanded bytes, not compressed size', async () => {
  const zipped = gzipSync(Buffer.alloc(8_000_001, 32));
  expect(zipped.length).toBeLessThan(100_000);
  const body = new Blob([Uint8Array.from(zipped)]).stream().pipeThrough(new DecompressionStream('gzip'));
  const h = listEngine(new Response(body));
  const result = await h.engine.fetchList(fixtureUrl, 'http');
  expect(result.found).toEqual([]); expect(result.error).toContain('decoded bytes'); expect(h.aborted()).toBe(true);
});

test('a failed body read returns no partial list and cancels the download', async () => {
  let read = false;
  const h = listEngine(new Response(new ReadableStream({ pull(c) {
    if (!read) { read = true; c.enqueue(new TextEncoder().encode('8.8.8.8:80\n')); }
    else c.error(new Error('fixture interrupted'));
  } }, { highWaterMark: 0 })));
  const result = await h.engine.fetchList(fixtureUrl, 'http');
  expect(result.found).toEqual([]); expect(result.error).toBe('fixture interrupted'); expect(h.aborted()).toBe(true);
});

test('pool deep tests never select custom providers, even when explicitly routed through the pool', async () => {
  for (const free of ['absent', 'disabled', 'no-model', 'enabled']) {
    let calls = 0; const custom = { id: 'paid', kind: 'openai', enabled: true, apiKey: 'dummy-secret', routes: { ids: ['proxy-pool'] } };
    const provider = { id: 'free', kind: 'free', enabled: free !== 'disabled' };
    const settings = { providers: [custom, ...(free === 'absent' ? [] : [provider])] };
    const models = [{ providerId: 'paid', state: 'available', cooldownUntil: 0 }, ...(free === 'no-model' ? [] : [{ providerId: 'free', state: 'available', cooldownUntil: 0 }])];
    const p = isolated('../backend/pool.ts', {
      ...base(settings), takeExhaustion() {},
      loadModule: async (name: string) => {
        if (name === './transport') return { networkFetch: async () => new Response('catalog') };
        if (name === './protocols') return { collect: async (r: Response) => r.text() };
        if (name === './providers') return { rankedModels: () => models, sessionFor: () => 'fixture', providerChat: async (chosen: any) => { calls++; expect(chosen.id).toBe('free'); return new Response('ok'); } };
        throw new Error('Unexpected module: ' + name);
      },
    }, ['testOne', '__poolHealth']);
    await p.testOne({ url: 'http://8.8.8.8:80' }, true);
    const h = p.__poolHealth.get('http://8.8.8.8:80');
    expect(calls).toBe(free === 'enabled' ? 1 : 0);
    expect(h.status).toBe(free === 'enabled' ? 'ready' : 'reachable'); expect(h.deep).toBe(free === 'enabled');
    if (free !== 'enabled') expect(h.error).toContain('other providers are not used');
  }
});

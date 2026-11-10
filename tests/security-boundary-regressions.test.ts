import { expect, spyOn, test } from 'bun:test';
import { cleanServer } from '../backend/mcp';
import { httpsDisable, startHttps, stopHttps } from '../backend/https';
import { settings } from '../backend/state';
import * as state from '../backend/state';
import type { McpServer } from '../backend/types';

test('remote MCP updates cannot inherit saved headers across origins by omitting them', () => {
  const routes = settings.routes;
  settings.routes = [{ id: 'security-fixture', name: 'Fixture', kind: 'direct', url: '', enabled: true, models: [] }];
  try {
    for (const transport of ['http', 'sse'] as const) {
      const saved: McpServer = { id: 'origin-fixture', name: 'origin-fixture', transport, enabled: true, url: 'https://original.example/mcp', headers: { Authorization: 'fixture-secret' }, routeId: 'security-fixture' };
      expect(() => cleanServer({ url: 'https://replacement.example/mcp' }, saved, false)).toThrow('Enter its header values again');
      expect(cleanServer({ url: 'https://original.example/other' }, saved, false).headers).toEqual(saved.headers);
      expect(cleanServer({ url: 'https://replacement.example/mcp', headers: {} }, saved, false).headers).toBeUndefined();
      expect(cleanServer({ url: 'https://replacement.example/mcp', headers: { Authorization: 'replacement-secret' } }, saved, false).headers).toEqual({ Authorization: 'replacement-secret' });
    }
  } finally { settings.routes = routes; }
});

test('failed HTTPS disable retains the previous configuration before auxiliary services change', async () => {
  const previous = settings.https;
  settings.https = { mode: 'off', httpPort: 80, redirect: true };
  await startHttps(async () => { throw new Error('fixture bind failure'); }, { port: 4317, host: '127.0.0.1' });
  const configured = { mode: 'custom' as const, domain: 'fixture.example', port: 8443, httpPort: 80, redirect: true, lastError: 'previous status' };
  settings.https = configured;
  try {
    await expect(httpsDisable()).rejects.toThrow('fixture bind failure');
    expect(settings.https).toBe(configured);
    // A failed transition must release its lock so recovery can be attempted again.
    await expect(httpsDisable()).rejects.toThrow('fixture bind failure');
  } finally { stopHttps(); settings.https = previous; }
});

test('HTTPS disable persistence failure restores missing-certificate recovery on loopback only', async () => {
  const previous = settings.https;
  settings.https = { mode: 'off', httpPort: 80, redirect: true };
  const bindings: Array<{ port: number; host: string; tls?: unknown }> = [];
  await startHttps(async options => { bindings.push(options); return options.port; }, { port: 4317, host: '0.0.0.0' });
  const configured = { mode: 'custom' as const, domain: 'missing-certificate.example', port: 8443, httpPort: 80, redirect: true };
  settings.https = configured;
  const persist = spyOn(state, 'persist').mockImplementationOnce(() => { throw new Error('fixture persistence failure'); }).mockImplementation(() => {});
  try {
    await expect(httpsDisable()).rejects.toThrow('fixture persistence failure');
    expect(settings.https).toBe(configured);
    expect(bindings).toEqual([{ port: 4317, host: '0.0.0.0', tls: undefined }, { port: 4317, host: '127.0.0.1' }]);
  } finally { persist.mockRestore(); stopHttps(); settings.https = previous; }
});

test('successful HTTPS disable serializes listener changes and commits HTTP settings only after binding', async () => {
  const previous = settings.https, publicIp = process.env.POLYGATE_PUBLIC_IP;
  process.env.POLYGATE_PUBLIC_IP = '198.51.100.20';
  settings.https = { mode: 'off', httpPort: 80, redirect: true };
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const bindings: Array<{ port: number; host: string; tls?: unknown }> = [];
  await startHttps(async options => { bindings.push(options); await waiting; return options.port; }, { port: 4317, host: '127.0.0.1' });
  const configured = { mode: 'custom' as const, domain: 'fixture.example', port: 8443, httpPort: 80, redirect: true };
  settings.https = configured;
  const persist = spyOn(state, 'persist').mockImplementation(() => {});
  try {
    const disabling = httpsDisable();
    expect(settings.https).toBe(configured);
    await expect(httpsDisable()).rejects.toThrow('already running');
    release();
    const result = await disabling;
    expect(result.mode).toBe('off');
    expect(settings.https?.mode).toBe('off');
    expect(persist).toHaveBeenCalledTimes(1);
    expect(bindings).toEqual([{ port: 4317, host: '127.0.0.1', tls: undefined }]);
  } finally {
    release(); persist.mockRestore(); stopHttps(); settings.https = previous;
    if (publicIp === undefined) delete process.env.POLYGATE_PUBLIC_IP; else process.env.POLYGATE_PUBLIC_IP = publicIp;
  }
});

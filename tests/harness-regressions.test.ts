import { expect, test } from 'bun:test';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { isFixtureHost, preserveTestState } from './setup';

test('network guard accepts only literal loopback fixtures', () => {
  for (const host of ['127.0.0.1', '127.0.0.2', '::1', '[::1]']) expect(isFixtureHost(host)).toBe(true);
  for (const host of ['localhost', '127.0.0.1.evil.test', '203.0.113.7', '10.0.0.1', 'example.org']) expect(isFixtureHost(host)).toBe(false);
});

test('external fetches, external proxies and raw sockets are denied before connecting', async () => {
  await expect(fetch('https://unconfigured.invalid/test')).rejects.toThrow('External network denied');
  await expect(fetch('http://127.0.0.1:9/', { proxy: 'http://203.0.113.7:8080' } as any)).rejects.toThrow('External network denied');
  expect(() => net.connect({ host: '203.0.113.7', port: 8080 })).toThrow('External network denied');
  expect(() => tls.connect({ host: 'unconfigured.invalid', port: 443 })).toThrow('External network denied');
  await expect(dns.lookup('unconfigured.invalid')).rejects.toThrow('External network denied');
  await expect(dns.resolve4('unconfigured.invalid')).rejects.toThrow('External network denied');
});

test('IP and release checks return deterministic fixtures without live calls', async () => {
  expect(await (await fetch('https://1.1.1.1/cdn-cgi/trace')).text()).toBe('ip=198.51.100.20\nloc=US\n');
  const release = await (await fetch('https://api.github.com/repos/B3hnamR/Polygate/releases/latest')).json() as any;
  expect(release).toMatchObject({ tag_name: 'v0.0.0', draft: false, prerelease: false, assets: [] });
});

test('a loopback redirect cannot escape through native fetch', async () => {
  const fixture = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.redirect('https://unconfigured.invalid/escape') });
  try { await expect(fetch(`http://127.0.0.1:${fixture.port}/`)).rejects.toThrow('automatic redirect'); }
  finally { fixture.stop(true); }
});

test('file state restoration removes additions as well as restoring changed values', async () => {
  const { settings, models, saveModel } = await import('../backend/state');
  const enabled = settings.enabled, notify = settings.notify;
  const restore = preserveTestState();
  settings.enabled = !enabled; settings.notify = { webhookUrl: 'https://unconfigured.invalid' };
  saveModel({ id: 'harness/restoration-fixture', upstreamId: 'restoration-fixture', providerId: 'harness', name: 'Fixture', context: 0, output: 0, tools: false, reasoning: false, state: 'unchecked', latency: 0, score: 50, priority: 100, failCount: 0, cooldownUntil: 0, checkedAt: 0, error: '' });
  try {
    restore();
    expect(settings.enabled).toBe(enabled); expect(JSON.stringify(settings.notify)).toBe(JSON.stringify(notify));
    expect(models.has('harness/restoration-fixture')).toBe(false);
  } finally { restore(); }
});

test('UI harnesses fail closed and the crawler does not select controls by index', () => {
  const crawl = readFileSync(new URL('../scripts/ui-crawl.mjs', import.meta.url), 'utf8');
  const scenarios = readFileSync(new URL('../scripts/ui-scenarios.mjs', import.meta.url), 'utf8');
  expect(crawl).not.toContain('.nth(');
  expect(crawl).toContain('safeButtons'); expect(crawl).toContain('control.identity');
  expect(crawl).toContain("control.label === 'New key'");
  expect(crawl).toContain("name: 'Create key'");
  expect(crawl).toContain('tabName(control.label)');
  expect(crawl).toContain('process.exitCode = problems.length ? 1 : 0');
  expect(scenarios).toContain('process.exitCode = failures ? 1 : 0');
  expect(scenarios).toContain('expectRefusal');
  expect(scenarios).toContain("request.method() !== 'GET'");
  expect(scenarios).toContain("name: 'My proxies and lists'");
  expect(scenarios).not.toContain('Add my own list');
  for (const source of [crawl, scenarios]) expect(source).not.toContain('process.exit(0)');
});

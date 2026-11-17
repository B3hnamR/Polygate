import { expect, test } from 'bun:test';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { isFixtureHost, preserveTestState } from './setup';
import { navigateUI } from '../scripts/ui-navigation.mjs';

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
  for (const file of ['verify-ui.mjs', 'ui-crawl.mjs', 'ui-scenarios.mjs']) {
    const source = readFileSync(new URL(`../scripts/${file}`, import.meta.url), 'utf8');
    expect(source).toContain("from './ui-navigation.mjs'");
    expect(source).toContain("'Chains'");
    expect(source).toContain("'WARP'");
    expect(source).toContain("'Surfshark'");
    expect(source).toContain("'.surfshark-panel'");
    expect(source).toMatch(/name:\s*'Surfshark',\s*exact:\s*true,\s*level:\s*2/);
    expect(source).toContain(".startsWith('/admin/surfshark/')");
    expect(source).toContain("'/admin/surfshark/status'");
  }
});

test('UI harnesses allow local Surfshark status only and fail closed on actions', async () => {
  for (const file of ['verify-ui.mjs', 'ui-crawl.mjs', 'ui-scenarios.mjs']) {
    const source = readFileSync(new URL(`../scripts/${file}`, import.meta.url), 'utf8');
    const callback = source.match(/await context\.route\('\*\*\/\*',\s*((?:async\s+)?route\s*=>\s*\{[\s\S]*?\})\);/)?.[1];
    if (!callback) throw new Error(`Request guard not found in ${file}`);
    const { guard, failed } = new Function(`const port=4321,base='http://127.0.0.1:'+port,current='Surfshark',errors=[],problems=[];let failures=0;return {guard:(${callback}),failed:()=>errors.length+problems.length+failures};`)();
    const request = async (method: string, pathname: string, origin = 'http://127.0.0.1:4321') => guard({
      request: () => ({ method: () => method, url: () => origin + pathname }),
      abort: (reason: string) => { expect(reason).toBe('blockedbyclient'); return 'blocked'; },
      continue: () => 'allowed',
    });
    expect(await request('GET', '/admin/surfshark/status')).toBe('allowed');
    expect(failed()).toBe(0);
    for (const action of ['keys', 'keys/remove', 'update', 'settings', 'connect', 'disconnect', 'renew']) {
      for (const method of ['GET', 'POST']) expect(await request(method, `/admin/surfshark/${action}`)).toBe('blocked');
    }
    expect(await request('POST', '/admin/surfshark/status')).toBe('blocked');
    expect(await request('GET', '/admin/surfshark/status', 'https://unconfigured.invalid')).toBe('blocked');
    expect(failed()).toBe(16);
  }
});

function navigationFixture(initial = 'Overview', open = false) {
  const state = { current: initial, open, clicks: [] as string[] };
  const children = ['Proxies', 'Relays', 'WARP', 'Psiphon', 'Surfshark'];
  const buttons = (scope: string) => ({
    getByRole(role: string, options: { name: string; exact: boolean }) {
      expect(role).toBe('button'); expect(options.exact).toBe(true);
      const name = options.name;
      expect(scope).toBe(name === 'Settings' ? '.sidebar-bottom' : 'Workspace');
      const visible = () => { if (children.includes(name) && !state.open) throw new Error('Routing submenu is collapsed'); };
      return {
        async getAttribute(key: string) {
          visible();
          if (key === 'aria-expanded') return String(state.open);
          if (key === 'aria-current') return state.current === name ? 'page' : null;
          throw new Error(`Unexpected attribute ${key}`);
        },
        async click() {
          visible(); state.clicks.push(name);
          if (name === 'Routing') state.open = state.current === name ? !state.open : true;
          state.current = name;
        },
      };
    },
  });
  const page = {
    getByRole(role: string, options: { name: string; exact: boolean; level?: number }) {
      expect(options.exact).toBe(true);
      if (role === 'navigation') { expect(options.name).toBe('Workspace'); return buttons('Workspace'); }
      expect(role).toBe('heading'); expect(options.level).toBe(1);
      return { async waitFor() { expect(state.current).toBe(options.name); } };
    },
    locator(selector: string) { expect(selector).toBe('.sidebar-bottom'); return buttons(selector); },
  };
  return { page, state };
}

test('navigation opens Routing children from a collapsed workspace and does not collapse on revisits', async () => {
  for (const child of ['Relays', 'Proxies', 'WARP', 'Psiphon']) {
    const { page, state } = navigationFixture();
    await navigateUI(page, child);
    expect(state.clicks).toEqual(['Routing', child]);
    await navigateUI(page, child);
    await navigateUI(page, 'Routing');
    await navigateUI(page, 'Routing');
    expect(state.open).toBe(true);
    expect(state.clicks).toEqual(['Routing', child, 'Routing']);
  }
});

test('navigation reuses an expanded submenu and scopes exact Settings and Chains destinations', async () => {
  const { page, state } = navigationFixture('Routing', true);
  for (const name of ['Relays', 'Settings', 'Chains', 'WARP']) await navigateUI(page, name);
  expect(state.clicks).toEqual(['Relays', 'Settings', 'Chains', 'WARP']);
  const collapsed = navigationFixture('Routing', false);
  await navigateUI(collapsed.page, 'Proxies');
  expect(collapsed.state.clicks).toEqual(['Routing', 'Proxies']);
});

test('passive Surfshark visits follow WARP to open the Routing submenu', async () => {
  for (const initial of ['Overview', 'Routing']) {
    const { page, state } = navigationFixture(initial);
    await navigateUI(page, 'WARP');
    await navigateUI(page, 'Surfshark');
    await navigateUI(page, 'Surfshark');
    expect(state.clicks).toEqual(['Routing', 'WARP', 'Surfshark']);
    expect(state.open).toBe(true);
  }
});

// Extract only the actual crawler action function: importing the entrypoint would launch a gateway/browser.
const crawlSource = readFileSync(new URL('../scripts/ui-crawl.mjs', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const actionSource = crawlSource.match(/^async function exerciseControl\(page, loc, control\) \{\n[\s\S]*?^\}/m)?.[0];
if (!actionSource) throw new Error('Crawler action helper not found');
const exerciseControl = new Function(`return (${actionSource});`)();

function controlFixture(kind: 'tab' | 'inline' | 'dialog', selected = true, dialogName = 'New chain') {
  const calls: string[] = [];
  let opened = false;
  const page = {
    locator(selector: string) {
      if (selector === '[role=alert]:visible') return { async allTextContents() { return opened ? ['existing', 'new failure'] : ['existing']; } };
      expect(kind).toBe('inline'); expect(selector).toBe('section');
      return { filter() { return { getByRole(role: string, { name, exact }: any) {
        expect(role).toBe('button'); expect(exact).toBe(true);
        return {
          async waitFor() { calls.push(`wait ${name}`); },
          async click() { expect(name).toBe('Cancel'); calls.push('cancel'); },
        };
      } }; } };
    },
    getByRole(role: string, { name, exact }: any) {
      expect(exact).toBe(true);
      if (role === 'heading') { expect(kind).toBe('inline'); expect(name).toBe('Client API keys'); return {}; }
      expect(kind).toBe('dialog'); expect(role).toBe('dialog'); expect(name).toBe(dialogName);
      return {
        async waitFor(options?: { state: string }) { calls.push(options?.state === 'hidden' ? 'dialog hidden' : 'dialog visible'); },
        locator(selector: string) { expect(selector).toBe('.preview-result'); return { async waitFor() { calls.push('preview ready'); } }; },
      };
    },
    keyboard: { async press(key: string) { expect(kind).toBe('dialog'); expect(key).toBe('Escape'); calls.push('escape'); } },
  };
  const loc = {
    async click() { opened = true; calls.push('click'); },
    async evaluate(fn: (e: any) => void) { fn({ getAttribute: () => String(selected) }); },
  };
  return { page, loc, calls };
}

test('crawler selects tabs without treating them as dialogs or waiting for their disappearance', async () => {
  const f = controlFixture('tab');
  expect(await exerciseControl(f.page, f.loc, { role: 'tab', label: 'Map' })).toEqual(['new failure']);
  expect(f.calls).toEqual(['click']);
  const broken = controlFixture('tab', false);
  await expect(exerciseControl(broken.page, broken.loc, { role: 'tab', label: 'Map' })).rejects.toThrow('Tab was not selected');
});

test('crawler cancels inline key forms and closes only named dialogs, preserving alerts', async () => {
  const inline = controlFixture('inline');
  expect(await exerciseControl(inline.page, inline.loc, { role: 'button', label: 'New key' })).toEqual(['new failure']);
  expect(inline.calls).toEqual(['click', 'wait Create key', 'cancel', 'wait New key']);
  const dialog = controlFixture('dialog');
  expect(await exerciseControl(dialog.page, dialog.loc, { role: 'button', label: 'New chain' })).toEqual(['new failure']);
  expect(dialog.calls).toEqual(['click', 'dialog visible', 'escape', 'dialog hidden']);
});

test('crawler waits for routing preview results and does not swallow action failures', async () => {
  const preview = controlFixture('dialog', true, 'Preview routing');
  await exerciseControl(preview.page, preview.loc, { role: 'button', label: 'Preview routing' });
  expect(preview.calls).toEqual(['click', 'dialog visible', 'preview ready', 'escape', 'dialog hidden']);
  const broken = controlFixture('inline');
  broken.loc.click = async () => { throw new Error('fixture click failed'); };
  await expect(exerciseControl(broken.page, broken.loc, { role: 'button', label: 'New key' })).rejects.toThrow('fixture click failed');
});

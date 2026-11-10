// Read-only UI crawl. Controls are explicitly allowlisted, never selected by a stale index.
// Usage: node scripts/ui-crawl.mjs (requires a built UI and Playwright Chromium).
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const state = mkdtempSync(path.join(os.tmpdir(), 'polygate-crawl-'));
const token = 'crawl-admin-token';
const problems = [], log = [];
let child, browser, current = 'Sign in';
const pages = ['Overview', 'Models', 'Providers', 'Relays', 'Routing', 'Playground', 'Requests', 'Proxies', 'Settings'];
const safeButtons = new Set(['New key', 'New chain', 'Preview routing']);
const safeTabs = new Set(['List', 'Map', 'Model-ready', 'Failed', 'All', 'Server IP address', 'My domain', 'Own certificate']);
const tabName = label => new RegExp('^' + label + '(?:\\s+\\d[\\d,]*)?$');
const identity = loc => loc.evaluate(e => JSON.stringify([e.tagName, e.getAttribute('role'), e.getAttribute('aria-label'), e.textContent?.replace(/\s+/g, ' ').trim(), e.getAttribute('type')]));
try {
  child = spawn(process.env.BUN_EXE || 'bun', ['--preload', './tests/setup.ts', 'backend/main.ts'], { env: { ...process.env, POLYGATE_HARNESS: '1', POLYGATE_STATE: state, POLYGATE_NO_DISCOVERY: '1', POLYGATE_ADMIN_TOKEN: token, POLYGATE_PORT: '0', POLYGATE_HOST: '127.0.0.1', POLYGATE_UI_DIST: path.resolve('dist') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const port = await new Promise((resolve, reject) => {
    let buf = ''; const timer = setTimeout(() => reject(new Error('gateway did not start')), 30000);
    const fail = error => { clearTimeout(timer); reject(error); };
    child.on('error', fail); child.on('exit', () => fail(new Error('gateway exited')));
    child.stdout.on('data', d => { buf += d; const m = /"polygateReady":true,"port":(\d+)/.exec(buf); if (m) { clearTimeout(timer); resolve(Number(m[1])); } });
  });
  const base = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, serviceWorkers: 'block' });
  // Defense in depth: even an accidentally allowlisted button cannot issue a
  // certificate, deploy, scan public proxies, or submit another mutating action.
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== base || (!['GET', 'HEAD'].includes(req.method()) && !['/admin/login', '/admin/session', '/admin/route-preview'].includes(url.pathname))) {
      problems.push(`[${current}] blocked unsafe request: ${req.method()} ${url.pathname}`);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', e => problems.push(`[${current}] PAGE ERROR: ${String(e).slice(0, 200)}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`[${current}] console error: ${m.text().slice(0, 200)}`); });
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) problems.push(`[${current}] ${r.status()} ${r.request().method()} ${r.url().replace(base, '')}`); });
  await page.goto(base);
  await page.getByLabel('Password', { exact: true }).fill(token);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  const nav = name => page.locator('.sidebar').getByRole('button', { name: name === 'Proxies' ? /^Proxies(?:\s|$)/ : name, exact: name !== 'Proxies' });
  for (const name of pages) {
    current = name;
    await nav(name).click();
    await page.getByRole('heading', { name, exact: true }).waitFor();
    const controls = [];
    for (const label of safeButtons) {
      const loc = page.locator('main').getByRole('button', { name: label, exact: true });
      if (await loc.count() === 1 && await loc.isVisible()) controls.push({ role: 'button', label, identity: await identity(loc) });
    }
    for (const label of safeTabs) {
      const loc = page.locator('main').getByRole('tab', { name: tabName(label) });
      if (await loc.count() === 1 && await loc.isVisible()) controls.push({ role: 'tab', label, identity: await identity(loc) });
    }
    let clicked = 0;
    for (const control of controls) {
      const loc = page.locator('main').getByRole(control.role, { name: control.role === 'tab' ? tabName(control.label) : control.label, exact: control.role !== 'tab' });
      // Re-resolve by semantic identity after each prior action. A changed or
      // ambiguous control is a failure, not a reason to click its replacement.
      if (await loc.count() !== 1 || !await loc.isVisible() || await identity(loc) !== control.identity) {
        problems.push(`[${name}] control changed: ${control.role} ${control.label}`); continue;
      }
      if (!await loc.isEnabled()) continue;
      const alerts = new Set(await page.locator('[role=alert]:visible').allTextContents());
      await loc.click(); clicked++;
      if (control.role === 'tab') await loc.evaluate(e => { if (e.getAttribute('aria-selected') !== 'true') throw new Error('Tab was not selected'); });
      else if (control.label === 'New key') await page.getByRole('button', { name: 'Create key', exact: true }).waitFor();
      else await page.getByRole('dialog').waitFor();
      for (const error of await page.locator('[role=alert]:visible').allTextContents()) if (!alerts.has(error)) problems.push(`[${name}] ${control.label}: ${error}`);
      if (control.label === 'New key') await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      else { await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' }); }
      await nav(name).click();
      await page.getByRole('heading', { name, exact: true }).waitFor();
    }
    log.push(`${name}: ${clicked} allowlisted controls exercised`);
  }
} catch (error) { problems.push(`[${current}] ${error.stack || error}`); }
finally {
  try { await browser?.close(); } catch (error) { problems.push(`browser cleanup: ${error}`); }
  if (child && child.exitCode === null) {
    await new Promise(resolve => { child.once('exit', resolve); child.kill(); setTimeout(resolve, 5000).unref(); });
  }
  try { rmSync(state, { recursive: true, force: true }); } catch (error) { problems.push(`state cleanup: ${error}`); }
}
console.log(log.join('\n'));
console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n${[...new Set(problems)].join('\n')}` : '\nno problems found');
process.exitCode = problems.length ? 1 : 0;

// Starts a throwaway gateway, signs in, visits every page and clicks every button, switch and tab on it, and reports what broke:
// page errors, console errors, failed requests (4xx/5xx), error banners and buttons that do nothing visible.
// Buttons that would change the outside world are skipped (deploys, WARP set-up, proxy scans, HTTPS issuance, sign-out everywhere).
// Usage: node scripts/ui-crawl.mjs   (needs `bun run build:ui` first and Playwright's Chromium)
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const state = mkdtempSync(path.join(os.tmpdir(), 'polygate-crawl-')); const token = 'crawl-admin-token';
const child = spawn('bun', ['backend/main.ts'], { env: { ...process.env, POLYGATE_STATE: state, POLYGATE_NO_DISCOVERY: '1', POLYGATE_ADMIN_TOKEN: token, POLYGATE_PORT: '0', POLYGATE_HOST: '127.0.0.1', POLYGATE_UI_DIST: path.resolve('dist') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
const port = await new Promise((resolve, reject) => { let buf = ''; const t = setTimeout(() => reject(new Error('gateway did not start')), 30000); child.stdout.on('data', d => { buf += d; const m = /"polygateReady":true,"port":(\d+)/.exec(buf); if (m) { clearTimeout(t); resolve(Number(m[1])); } }); child.on('exit', () => reject(new Error('gateway exited'))); });
const base = `http://127.0.0.1:${port}`;
const SKIP = /sign out|everywhere|install|reconnect|set up|connect$|find working|re-test|check these|deploy|apply|renew|remove all|delete|shutdown|new identity|disconnect|rotate|scan|get a token|open cloudflare|copy|download/i;
const problems = []; const log = []; let current = '';
const browser = await chromium.launch({ headless: true }); const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
page.on('pageerror', e => problems.push(`[${current}] PAGE ERROR: ${String(e).slice(0, 200)}`));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`[${current}] console error: ${m.text().slice(0, 200)}`); });
page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) problems.push(`[${current}] ${r.status()} ${r.request().method()} ${r.url().replace(base, '')}`); });
await page.goto(base); await page.waitForLoadState('networkidle').catch(() => {});
const pw = page.locator('input[type=password]').first(); if (await pw.count()) { await pw.fill(token); await page.keyboard.press('Enter'); await page.waitForTimeout(1500); }
const navItems = await page.locator('nav button, .sidebar button').evaluateAll(els => els.map(e => (e.textContent || e.getAttribute('aria-label') || '').trim()).filter(Boolean));
const pages = [...new Set(navItems.filter(t => !/sign out|pause|resume|reconnect/i.test(t)).map(t => t.replace(/Built in$/, '').trim()))];
log.push('pages: ' + pages.join(' | '));
async function visit(name) {
  current = name; await page.locator('nav button, .sidebar button', { hasText: name }).first().click().catch(() => {}); await page.waitForTimeout(900);
  const labels = await page.locator('main button:visible, .page-content button:visible, [role=switch]:visible, [role=tab]:visible, select:visible').evaluateAll(els => els.map((e, i) => ({ i, tag: e.tagName, text: (e.getAttribute('aria-label') || e.textContent || e.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 60), role: e.getAttribute('role') })));
  let clicked = 0, skipped = 0; const idle = [];
  for (const l of labels) {
    if (SKIP.test(l.text)) { skipped++; continue; }
    const loc = page.locator('main button:visible, .page-content button:visible, [role=switch]:visible, [role=tab]:visible, select:visible').nth(l.i);
    if (!(await loc.count())) continue;
    const before = await page.evaluate(() => document.body.innerText.length + '|' + document.querySelectorAll('[role=dialog],dialog,.dialog').length);
    try { if (l.tag === 'SELECT') { await loc.selectOption({ index: 1 }).catch(() => {}); } else await loc.click({ timeout: 2500 }); clicked++; } catch (e) { problems.push(`[${name}] could not click "${l.text}": ${String(e).split('\n')[0].slice(0, 100)}`); continue; }
    await page.waitForTimeout(350);
    const banner = await page.locator('[role=alert]:visible, .error-banner:visible, .dialog-note.error:visible').allInnerTexts(); if (banner.length) problems.push(`[${name}] "${l.text}" -> error shown: ${banner.join(' / ').replace(/\s+/g, ' ').slice(0, 160)}`);
    const after = await page.evaluate(() => document.body.innerText.length + '|' + document.querySelectorAll('[role=dialog],dialog,.dialog').length);
    if (before === after && !/^(|Try .*|Check|Test|Use route|Selected)$/.test(l.text)) idle.push(l.text);
    await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(120);
    // a click may have navigated or opened a dialog: get back to this page
    if (!(await page.locator('nav button, .sidebar button', { hasText: name }).first().evaluate(e => e.className + e.getAttribute('aria-current')).catch(() => '')).match(/active|on|page|true/i)) await page.locator('nav button, .sidebar button', { hasText: name }).first().click().catch(() => {});
  }
  log.push(`${name}: ${labels.length} controls, clicked ${clicked}, skipped ${skipped}${idle.length ? ', no visible change: ' + [...new Set(idle)].join(', ') : ''}`);
}
for (const p of pages) await visit(p);
console.log(log.join('\n')); console.log(problems.length ? '\nPROBLEMS (' + problems.length + '):\n' + [...new Set(problems)].join('\n') : '\nno problems found');
await browser.close(); child.kill(); try { rmSync(state, { recursive: true, force: true }); } catch {} process.exit(0);

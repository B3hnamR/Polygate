import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Evaluate the actual component/handler source without importing browser-only api.ts,
// installing a DOM package, or booting the gateway. No network is used by these tests.
const source = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
const between = (text: string, start: string, end: string) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
const transpiler = new Bun.Transpiler({ loader: 'tsx', tsconfig: { compilerOptions: { jsx: 'react', jsxFactory: 'createElement', jsxFragmentFactory: 'Fragment' } } });
function evaluate(code: string, bindings: Record<string, unknown>) {
  return new Function(...Object.keys(bindings), transpiler.transformSync(`function run() {\n${code}\n}`) + '\nreturn run();')(...Object.values(bindings));
}
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('removing the final provider line invokes the existing follow confirmation, not an empty route policy', () => {
  const code = between(source('routing-map.tsx'), '  const disconnect=', '  // A line');
  const saved: unknown[][] = [], followed: unknown[] = [];
  const disconnect = evaluate(code + '\nreturn disconnect;', { routesOf: (p: any) => p.routes, follow: (p: unknown) => followed.push(p), saveRoutes: (...args: unknown[]) => saved.push(args) });
  const p = { name: 'Provider', routes: { ids: ['direct'], paused: ['direct'] } };
  disconnect(p, 'direct');
  expect(followed).toEqual([p]); expect(saved).toEqual([]);
  const multiple = { routes: { ids: ['direct', 'proxy'], paused: ['direct'], backups: true } };
  disconnect(multiple, 'direct');
  expect(saved[0]).toEqual([multiple, { ids: ['proxy'], paused: [], backups: true }, 'Line removed']);
  const followCode = between(source('routing-map.tsx'), '  const follow=async', '  const toggleProvider=');
  expect(followCode).toContain('await confirm('); expect(followCode).toContain('saveRoutes(p,null,');
});

function dialogHarness() {
  const listeners: Record<string, Set<(e: any) => void>> = {};
  let currentBox: any;
  let effects: (() => void | (() => void))[] = [];
  const document: any = { activeElement: null, addEventListener: (name: string, fn: any) => (listeners[name] ||= new Set()).add(fn), removeEventListener: (name: string, fn: any) => listeners[name]?.delete(fn) };
  const dispatch = (name: string, event: any) => { for (const fn of [...(listeners[name] || [])]) fn(event); };
  const element = (name: string, parent?: any, extra: Record<string, unknown> = {}) => ({ name, parent, isConnected: true, tabIndex: 0, hidden: false, disabled: false, visibility: 'visible', autofocus: false,
    focus() { document.activeElement = this; dispatch('focusin', { target: this }); },
    matches(selector: string) { return selector === ':disabled' ? this.disabled : selector.includes('input') && name === 'input'; },
    closest() { return this.hidden; }, getClientRects() { return [1]; }, hasAttribute() { return this.autofocus; }, ...extra });
  const makeBox = () => { const box: any = element('dialog', undefined, { parentElement: { style: {} }, children: [] }); box.contains = (el: any): boolean => el === box || !!el && box.contains(el.parent); box.querySelectorAll = () => box.children; return box; };
  const code = between(source('mcp.tsx'), 'const dialogs:', 'function Pairs(').replace('export function Dialog', 'function Dialog') + '\nreturn Dialog;';
  const Dialog = evaluate(code, { createElement, X: () => null, document, getComputedStyle: (el: any) => ({ visibility: el.visibility }), useRef: (value: unknown) => ({ current: value === null ? currentBox : value }), useEffect: (effect: any) => effects.push(effect) });
  return { document, element, makeBox, dispatch,
    mount(box: any, onClose: () => void, busy = false) { currentBox = box; effects = []; const tree = Dialog({ title: 'Test', icon: null, children: null, onClose, busy }); const cleanup = effects.map(effect => effect()); return { tree, unmount: () => { tree.props.children.props.ref.current = null; cleanup.forEach(fn => fn?.()); } }; },
    key(key: string, shiftKey = false) { const e = { key, shiftKey, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} }; dispatch('keydown', e); return e; } };
}

test('only the topmost dialog handles Escape/Tab, busy dialogs contain focus, and openers are restored', () => {
  const h = dialogHarness(), opener = h.element('opener'); opener.focus();
  const lower = h.makeBox(), first = h.element('input', lower), last = h.element('button', lower);
  lower.children = [first, last]; let lowerClosed = 0, upperClosed = 0;
  const a = h.mount(lower, () => lowerClosed++); expect(h.document.activeElement).toBe(first);
  const upper = h.makeBox(), cancel = h.element('cancel', upper, { autofocus: true }), action = h.element('action', upper);
  const disabledByFieldset = h.element('input', upper, { disabled: true }), hidden = h.element('hidden', upper, { hidden: true }), negativeTab = h.element('negative', upper, { tabIndex: -1 });
  upper.children = [disabledByFieldset, hidden, negativeTab, cancel, action];
  const b = h.mount(upper, () => upperClosed++);
  expect(h.document.activeElement).toBe(cancel);
  expect(Number(upper.parentElement.style.zIndex)).toBeGreaterThan(Number(lower.parentElement.style.zIndex));
  action.focus(); expect(h.key('Tab').defaultPrevented).toBe(true); expect(h.document.activeElement).toBe(cancel);
  h.key('Tab', true); expect(h.document.activeElement).toBe(action);
  opener.focus(); expect(h.document.activeElement).toBe(cancel);
  h.key('Escape'); expect(upperClosed).toBe(1); expect(lowerClosed).toBe(0);
  b.unmount(); expect(h.document.activeElement).toBe(first);
  const busyBox = h.makeBox(); const busy = h.mount(busyBox, () => upperClosed++, true);
  h.key('Escape'); expect(upperClosed).toBe(1); expect(lowerClosed).toBe(0);
  h.key('Tab'); expect(h.document.activeElement).toBe(busyBox);
  busy.unmount(); a.unmount(); expect(h.document.activeElement).toBe(opener);
});

test('removing an underlying dialog first still restores the original connected opener', () => {
  const h = dialogHarness(), opener = h.element('opener'); opener.focus();
  const lower = h.makeBox(), input = h.element('input', lower); lower.children = [input];
  const a = h.mount(lower, () => {}), upper = h.makeBox(), b = h.mount(upper, () => {});
  a.unmount(); input.isConnected = false; b.unmount(); expect(h.document.activeElement).toBe(opener);
  const relay = source('relay-manage.tsx'); expect(relay).toContain("import {Dialog} from './mcp'"); expect(relay).not.toContain("addEventListener('keydown'");
});

function logsHarness() {
  const pending: ReturnType<typeof deferred<any>>[] = [];
  const generation = { current: 0 }, liveGeneration = { current: 0 }, newest = { current: 0 }, loadingNow = { current: false }, olderNow = { current: false };
  const state: any = { rows: [{ id: 10 }], data: { more: true }, error: '', loading: false, older: false };
  let tick: (() => Promise<void>) | undefined;
  const cleanups: (() => void)[] = [];
  const setter = (key: string) => (value: any) => { state[key] = typeof value === 'function' ? value(state[key]) : value; };
  const code = between(source('logs.tsx'), '  const load = useCallback', '  const clearAll =') + '\nreturn { load, loadOlder };';
  const handlers = evaluate(code, { generation, liveGeneration, newest, loadingNow, olderNow, rows: state.rows, params: () => '', PAGE: 200, MAX_ROWS: 2000, LIVE_MS: 2500, live: true, document: { hidden: false },
    api: () => { const request = deferred<any>(); pending.push(request); return request.promise; }, useCallback: (fn: any) => fn,
    useEffect: (fn: any) => { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); }, setInterval: (fn: any) => { tick = fn; return 1; }, clearInterval: () => {},
    setData: setter('data'), setRows: setter('rows'), setError: setter('error'), setLoading: setter('loading'), setOlder: setter('older'), setFresh: setter('fresh') });
  return { ...handlers, pending, state, generation, liveGeneration, tick: () => tick!(), unmount: () => cleanups.forEach(fn => fn()) };
}
const logResult = (id: number, more = false) => ({ entries: [{ id }], more, total: 1, levels: {}, sources: [] });

test('logs ignore older load successes/errors/finalizers after a new generation or unmount', async () => {
  const h = logsHarness(); // first load is started by its effect
  const latest = h.load(); h.pending[1].resolve(logResult(20)); await latest;
  h.pending[0].resolve(logResult(1)); await Promise.resolve();
  expect(h.state.rows).toEqual([{ id: 20 }]); expect(h.state.loading).toBe(false);
  const obsolete = h.load(), next = h.load();
  h.pending[2].reject(new Error('old error')); await obsolete;
  expect(h.state.error).toBe(''); expect(h.state.loading).toBe(true);
  h.pending[3].resolve(logResult(30)); await next;
  const removed = h.load(); h.unmount(); h.pending[4].resolve(logResult(40)); await removed;
  expect(h.state.rows).toEqual([{ id: 30 }]);
});

test('live responses cannot cross a refresh or pause, and stale older pages cannot append to new filters', async () => {
  const h = logsHarness(); h.pending[0].resolve(logResult(10, true)); await Promise.resolve();
  const live = h.tick(), refreshed = h.load(); h.pending[2].resolve(logResult(20, true)); await refreshed;
  h.pending[1].resolve(logResult(11)); await live; expect(h.state.rows).toEqual([{ id: 20 }]);
  const paused = h.tick(); h.liveGeneration.current++; h.pending[3].resolve(logResult(21)); await paused;
  expect(h.state.rows).toEqual([{ id: 20 }]);
  const older = h.loadOlder(), filtered = h.load(); h.pending[5].resolve(logResult(50)); await filtered;
  h.pending[4].resolve(logResult(9, true)); await older;
  expect(h.state.rows).toEqual([{ id: 50 }]); expect(h.state.data.more).toBe(false); expect(h.state.older).toBe(false);
  expect(source('logs.tsx')).toContain('liveGeneration.current++; setLive(!live)');
  h.unmount();
});

test('MCP connection snippets only choose enabled, unexpired, unspent client keys, matching App', () => {
  const mcp = source('mcp.tsx'); const start = mcp.indexOf('  const keys =', mcp.indexOf('function ConnectPanel('));
  const code = mcp.slice(start, mcp.indexOf('\n', start)) + '\nreturn keys;';
  const now = Date.now(); const key = { enabled: true, expiresAt: 0, budget: 0, used: 0 };
  const keys = [{ ...key, id: 'off', enabled: false }, { ...key, id: 'expired', expiresAt: now - 1 }, { ...key, id: 'spent', budget: 100, used: 100 }, { ...key, id: 'ready', expiresAt: now + 60_000, budget: 100, used: 99 }];
  expect(evaluate(code, { data: { settings: { keys } } }).map((k: any) => k.id)).toEqual(['ready']);
  expect(source('App.tsx')).toContain('!(k.budget&&(k.used||0)>=k.budget)');
});

test('HTTPS explicit handoff wins over a stale certificate job and initial-load errors expose retries', () => {
  const panels = source('panels.tsx');
  expect(panels).toContain('href={handoffUrl||s?.job.url}'); expect(panels).not.toContain('href={s?.job.url||handoffUrl}');
  expect(between(panels, 'export function WarpPanel', '// ---------- proxy pool')).toContain('error?<div className="error-banner" role="alert"');
  expect(between(panels, 'export function WarpPanel', '// ---------- proxy pool')).toContain('onClick={()=>void reload()}>Try again');
  const desktop = source('desktop.tsx'); expect(desktop).not.toContain('if (!bridge || !prefs) return null'); expect(desktop).toContain('!prefs && error && <Button'); expect(desktop).toContain('onClick={() => void load()}>Try again');
  expect(source('zai-accounts.tsx')).toContain("!list&&error&&<Button disabled={!!busy} onClick={()=>void run('load',()=>api('/admin/zai'))}>Try again");
});

test('daily usage values are available as exact text in a semantic keyboard-accessible table', () => {
  const daily = [{ day: Date.UTC(2026, 10, 8), requests: 12, errors: 2, input: 12345, output: 6789 }];
  const data = { days: 1, daily, models: [], totals: { requests: 12, errors: 2, input: 12345, output: 6789, activeDays: 1, busiestDay: daily[0].day, busiestRequests: 12 } };
  const code = source('usage.tsx').split('\n').filter(line => !line.startsWith('import ')).join('\n').replace('export function UsagePage', 'function UsagePage') + '\nreturn UsagePage;';
  const Usage = evaluate(code, { createElement, Fragment, useState: (value: unknown) => [value, () => {}], usePoll: () => ({ data }), Button: 'button', compact: String, ms: String });
  const html = renderToStaticMarkup(createElement(Usage));
  expect(html).toContain('<summary>Daily values</summary>'); expect(html).toContain('<caption class="sr-only">Daily usage in UTC</caption>');
  expect(html).toContain('scope="row"'); expect(html).toContain('Input tokens'); expect(html).toContain(daily[0].input.toLocaleString()); expect(html).toContain(daily[0].output.toLocaleString());
});

test('chain and request grids fit their container and rail focus uses contrasting rail ink', () => {
  const css = source('styles.css');
  expect(css).toContain('minmax(min(340px,100%),1fr)'); expect(css).toContain('minmax(min(320px,100%),1fr)');
  expect(css).toContain('.sidebar :is(button,a,input,select,textarea):focus-visible{outline:2px solid var(--rail-ink)');
  expect(css).toContain('.provider-row{flex-wrap:wrap}.provider-description{flex-basis:100%;min-width:0}');
});

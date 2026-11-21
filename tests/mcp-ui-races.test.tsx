import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Run the actual TSX handlers with deferred API responses, not a copy of their logic.
// No browser imports, network, gateway, or host integrations are executed.
const source = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
const between = (text: string, start: string, end: string) => {
  const a = text.indexOf(start), b = text.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`Missing source boundary: ${start} / ${end}`);
  return text.slice(a, b);
};
const transpiler = new Bun.Transpiler({ loader: 'tsx', tsconfig: { compilerOptions: { jsx: 'react', jsxFactory: 'createElement', jsxFragmentFactory: 'Fragment' } } });
function evaluate(code: string, bindings: Record<string, unknown> = {}) {
  const scope = { createElement, Fragment, ...bindings };
  return new Function(...Object.keys(scope), transpiler.transformSync(`function run() {\n${code}\n}`) + '\nreturn run();')(...Object.values(scope));
}
const deferred = () => { let resolve!: (value: any) => void, reject!: (reason: Error) => void; const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const server = (disabledTools: string[] = []) => ({ id: 'one', name: 'one', enabled: true, disabledTools, status: { state: 'ready', tools: ['a', 'b'].map(name => ({ name, disabled: disabledTools.includes(name) })) } });

const mcpSource = source('mcp.tsx');
const createPage = evaluate(between(mcpSource, 'let settingsQueue', 'export function McpPage') + `
  return ({ api, notice, hub, useRef, useCallback, useEffect, setHub, setError }) => {
    ${between(mcpSource, '  const generation =', '  if (!hub)')}
    return { load, changed, settingsChange };
  };`);
function mcpHarness() {
  const pending: { path: string; body: unknown; request: ReturnType<typeof deferred> }[] = [];
  const state: any = { hub: { enabled: true, builtin: true, builtinKeys: [], builtinTools: [{ name: 'status' }], canAddLocal: true, mode: 'desktop', servers: [server()] }, error: '', busy: '', notices: [] };
  const effects: (() => void | (() => void))[] = [];
  const setter = (key: string) => (value: any) => { state[key] = typeof value === 'function' ? value(state[key]) : value; };
  const api = (path: string, body?: unknown) => { const request = deferred(); pending.push({ path, body, request }); return request.promise; };
  const notice = (...args: unknown[]) => state.notices.push(args);
  const page = createPage({
    api, notice, hub: state.hub, useRef: (current: unknown) => ({ current }), useCallback: (fn: unknown) => fn, useEffect: (effect: () => void | (() => void)) => effects.push(effect), setHub: setter('hub'), setError: setter('error'),
  });
  const act = () => evaluate(between(source('mcp.tsx'), '  const act = async', '  const st =') + '\nreturn act;', { api, notice, s: state.hub.servers[0], setBusy: setter('busy'), onChanged: page.changed });
  return { state, pending, ...page, act, mount: () => { const cleanup = effects.map(effect => effect()); return () => cleanup.forEach(fn => fn?.()); } };
}

test('MCP mutations immediately replace parent state, await refresh, and defeat older polls', async () => {
  const h = mcpHarness(); const oldPoll = h.load();
  const action = h.act()('tools', '/admin/mcp/servers/tools', { id: 'one', disabledTools: ['a'] });
  expect(h.state.busy).toBe('tools');
  const accepted = server(['a']); h.pending[1].request.resolve(accepted); await settle();
  expect(h.state.hub.servers[0]).toBe(accepted); expect(h.state.busy).toBe('tools');
  expect(h.pending[2].path).toBe('/admin/mcp');
  h.pending[0].request.resolve({ enabled: true, servers: [server()] }); await oldPoll;
  expect(h.state.hub.servers[0]).toBe(accepted);
  h.pending[2].request.reject(new Error('Refresh offline')); await action;
  expect(h.state.busy).toBe(''); expect(h.state.error).toBe('Refresh offline'); expect(h.state.hub.servers[0]).toBe(accepted);

  // Evaluate the real ToolRows callback after the accepted parent state rerenders the card.
  const callback = between(source('mcp.tsx'), 'onToggle={(tool, on) => void act(', ' />}');
  // Strip only the JSX attribute wrapper, retaining the actual tool-toggle expression.
  const toggleCode = callback.slice('onToggle={'.length, -1);
  const onToggle = evaluate(`return (${toggleCode});`, { s: h.state.hub.servers[0], act: h.act() });
  onToggle('b', false);
  expect(h.pending[3].body).toEqual({ id: 'one', disabledTools: ['a', 'b'] });
  h.pending[3].request.resolve(server(['a', 'b'])); await settle();
  h.pending[4].request.resolve({ enabled: true, servers: [server(['a', 'b'])] }); await settle();
  expect(h.state.busy).toBe(''); expect(h.state.error).toBe('');
});

test('MCP delete ignores its non-server response and stale reads cannot resurrect the card', async () => {
  const h = mcpHarness(); const old = h.load();
  const action = h.act()('delete', '/admin/mcp/servers/delete', { id: 'one' });
  h.pending[1].request.resolve({ ok: true }); await settle();
  expect(h.state.hub.servers).toEqual([]); expect(h.state.busy).toBe('delete');
  h.pending[0].request.resolve({ servers: [server()] }); await old;
  h.pending[2].request.reject(new Error('Offline')); await action;
  expect(h.state.hub.servers).toEqual([]); expect(h.state.busy).toBe('');
});

test('MCP latest GET wins and failed mutations leave the accepted state untouched', async () => {
  const h = mcpHarness(), old = h.load(), latest = h.load();
  const authoritative = { servers: [server(['b'])] }; h.pending[1].request.resolve(authoritative); await latest;
  h.pending[0].request.reject(new Error('Stale error')); await old;
  expect(h.state.hub).toBe(authoritative); expect(h.state.error).toBe('');
  const action = h.act()('toggle', '/admin/mcp/servers/toggle', { id: 'one', enabled: false });
  h.pending[2].request.reject(new Error('Not saved')); await action;
  expect(h.state.hub).toBe(authoritative); expect(h.state.busy).toBe(''); expect(h.pending).toHaveLength(3);
  expect(h.state.notices).toEqual([['Not saved', 'error']]);
});

test('MCP accepts added servers and settings before stale GETs, even if refresh fails', async () => {
  const h = mcpHarness(), old = h.load(), added = { ...server(), id: 'two' };
  const saving = h.changed(added, 'two');
  expect(h.state.hub.servers).toHaveLength(2);
  h.pending[0].request.resolve({ servers: [] }); await old;
  h.pending[1].request.reject(new Error('Offline')); await saving;
  expect(h.state.hub.servers[1]).toBe(added);
  const poll = h.load(), settings = h.settingsChange({ enabled: false }, 'Hub off');
  const accepted = { ...h.state.hub, enabled: false };
  await settle(); h.pending[3].request.resolve(accepted); await settle();
  h.pending[2].request.resolve({ enabled: true, servers: [] }); await poll;
  expect(h.state.hub).toEqual(accepted); expect(h.state.error).toBe('');
  h.pending[4].request.reject(new Error('Refresh offline')); await settings;
  expect(h.state.hub).toEqual(accepted);
});

test('delayed settings snapshots cannot resurrect deleted servers or replace accepted tool changes', async () => {
  for (const what of ['delete', 'tools']) {
    const h = mcpHarness(), stale = { ...h.state.hub, builtin: false, canAddLocal: false, builtinTools: [] };
    const settings = h.settingsChange({ builtin: false }, 'Tools off'); await settle();
    const action = h.act()(what, '/admin/mcp/servers/' + what, { id: 'one' });
    const accepted = server(['a']); h.pending[1].request.resolve(what === 'delete' ? { ok: true } : accepted); await settle();
    const current = { ...h.state.hub, enabled: false, builtinKeys: ['new-key'] };
    h.pending[2].request.resolve(current); await action;
    h.pending[0].request.resolve(stale); await settle();
    expect(h.state.hub).toEqual({ ...current, builtin: false });
    expect(h.state.hub.servers).toEqual(what === 'delete' ? [] : [accepted]);
    h.pending[3].request.reject(new Error('Offline')); await settings;
    expect(h.state.hub).toEqual({ ...current, builtin: false });
  }
});

test('settings writes serialize different fields and opposite toggles, retaining normalized values and recovering after failure', async () => {
  const h = mcpHarness(), initial = h.state.hub;
  const off = h.settingsChange({ enabled: false }, 'Off');
  const builtin = h.settingsChange({ builtin: false, builtinKeys: ['missing', 'valid'] }, 'Builtin off');
  const on = h.settingsChange({ enabled: true }, 'On');
  await settle(); expect(h.pending).toHaveLength(1);
  h.pending[0].request.resolve({ ...initial, enabled: false }); await settle();
  expect(h.pending).toHaveLength(2); expect(h.pending[1].path).toBe('/admin/mcp');
  h.pending[1].request.reject(new Error('Offline')); await off; await settle();
  expect(h.pending[2].body).toEqual({ builtin: false, builtinKeys: ['missing', 'valid'] });
  h.pending[2].request.resolve({ ...initial, builtin: false, builtinKeys: ['valid'] }); await settle();
  expect(h.state.hub).toEqual({ ...initial, enabled: false, builtin: false, builtinKeys: ['valid'] });
  h.pending[3].request.reject(new Error('Offline')); await builtin; await settle();
  expect(h.pending[4].body).toEqual({ enabled: true });
  h.pending[4].request.reject(new Error('Write failed')); await on;
  const retry = h.settingsChange({ enabled: true }, 'On again'); await settle();
  h.pending[5].request.resolve({ ...initial, enabled: true }); await settle();
  expect(h.state.hub).toEqual({ ...initial, enabled: true, builtin: false, builtinKeys: ['valid'] });
  h.pending[6].request.resolve(h.state.hub); await retry;
  expect(h.state.error).toBe('');
  expect(h.state.notices).toEqual([['Off'], ['Builtin off'], ['Write failed', 'error'], ['On again']]);
});

test('opposite settings toggles cannot dispatch or apply out of order', async () => {
  const h = mcpHarness(), initial = h.state.hub;
  const off = h.settingsChange({ enabled: false }, 'Off'), on = h.settingsChange({ enabled: true }, 'On');
  await settle(); expect(h.pending).toHaveLength(1);
  h.pending[0].request.resolve({ ...initial, enabled: false }); await settle();
  expect(h.state.hub.enabled).toBe(false); expect(h.pending).toHaveLength(2);
  h.pending[1].request.resolve(h.state.hub); await off; await settle();
  expect(h.pending[2].body).toEqual({ enabled: true });
  h.pending[2].request.resolve(initial); await settle();
  expect(h.state.hub.enabled).toBe(true);
  h.pending[3].request.reject(new Error('Offline')); await on;
  expect(h.state.hub.enabled).toBe(true);
});

test('accepted settings POSTs finish in order after unmount, before a reopened page reads them', async () => {
  const h = mcpHarness(), initial = h.state.hub, unmount = h.mount();
  const settings = h.settingsChange({ enabled: false }, 'Off'), queued = h.settingsChange({ builtin: false }, 'Builtin off');
  await settle(); expect(h.pending).toHaveLength(2);
  expect(h.pending[1]).toMatchObject({ path: '/admin/mcp/settings', body: { enabled: false } });
  unmount();
  const reopened = mcpHarness(), close = reopened.mount();
  await h.settingsChange({ enabled: true }, 'Too late');
  await settle(); expect(reopened.pending).toHaveLength(0);
  h.pending[0].request.resolve({ servers: [] });
  const persisted = { ...initial };
  h.pending[1].request.resolve(Object.assign(persisted, h.pending[1].body));
  await settings; await settle();
  expect(h.pending[2]).toMatchObject({ path: '/admin/mcp/settings', body: { builtin: false } });
  expect(reopened.pending).toHaveLength(0);
  h.pending[2].request.resolve(Object.assign(persisted, h.pending[2].body));
  await queued; await settle();
  await h.changed(null, 'one'); await h.load();
  expect(h.pending).toHaveLength(3); expect(h.state.hub).toBe(initial); expect(h.state.notices).toEqual([]);
  expect(reopened.pending).toHaveLength(1); expect(reopened.pending[0].path).toBe('/admin/mcp');
  reopened.pending[0].request.resolve(persisted); await settle();
  expect(reopened.state.hub).toMatchObject({ enabled: false, builtin: false });
  close();
});

test('Button forwards native aria, form, data and event props while preserving defaults and styling', () => {
  const Button = evaluate(between(source('ui.tsx'), 'export function Button', '// Says when').replace('export function', 'function') + '\nreturn Button;');
  const events: unknown[] = [], click = (e: unknown) => events.push(e), key = (e: unknown) => events.push(e);
  const node = Button({ children: 'Run', variant: 'primary', className: 'custom', onClick: click, onKeyDown: key, 'aria-label': 'Run task', 'aria-expanded': true, 'aria-controls': 'panel', 'data-testid': 'run', form: 'settings', name: 'action', value: 'run', tabIndex: -1 });
  expect(node.props.type).toBe('button'); expect(node.props.className).toBe('button primary custom');
  expect(node.props.onClick).toBe(click); expect(node.props.onKeyDown).toBe(key);
  const event = {}; node.props.onClick(event); node.props.onKeyDown(event); expect(events).toEqual([event, event]);
  const html = renderToStaticMarkup(node);
  for (const attribute of ['aria-label="Run task"', 'aria-expanded="true"', 'aria-controls="panel"', 'data-testid="run"', 'form="settings"', 'tabindex="-1"']) expect(html).toContain(attribute);
  expect(Button({ type: 'reset', disabled: true }).props).toMatchObject({ type: 'reset', disabled: true });
});

test('tabKeys wraps, supports Home/End, skips native and aria disabled tabs, and leaves other keys alone', () => {
  const tabKeys = evaluate(between(source('ui.tsx'), 'export const tabKeys=', '// A dropdown').replace('export const', 'const') + '\nreturn tabKeys;');
  const selected: number[] = [], focused: number[] = [];
  const tabs = [{}, { disabled: true }, {}, { ariaDisabled: true }, {}].map((props: { disabled?: boolean; ariaDisabled?: boolean }, i) => ({ matches: (selector: string) => selector.split(',').some(s => s === ':disabled' ? props.disabled : s === '[aria-disabled="true"]' ? props.ariaDisabled : false), focus: () => focused.push(i), click: () => selected.push(i) }));
  const key = (key: string, index: number, defaultPrevented = false) => {
    const event = { key, target: tabs[index], currentTarget: { querySelectorAll: (selector: string) => { expect(selector).toBe('[role=tab]'); return tabs; } }, defaultPrevented, preventDefault() { this.defaultPrevented = true; } };
    tabKeys(event); return event;
  };
  key('ArrowRight', 0); key('ArrowLeft', 0); key('ArrowRight', 4); key('Home', 4); key('End', 0);
  expect(selected).toEqual([2, 4, 0, 0, 4]); expect(focused).toEqual(selected);
  expect(key('Tab', 0).defaultPrevented).toBe(false); key('Home', 0, true); key('End', 1); key('Home', -1);
  expect(selected).toHaveLength(5);
});

test('MCP, server kind, Playground snippets and workspace callers render one tab stop and share keyboard navigation', () => {
  const tabKeys = () => {}, Icon = () => null;
  const cases = [
    { file: 'mcp.tsx', start: '<div className="seg mcp-kind"', scope: { local: false, set: () => {}, Globe: Icon, Terminal: Icon } },
    { file: 'mcp.tsx', start: '<div className="seg mcp-clients"', scope: { list: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], current: { id: 'b' }, setTab: () => {} } },
    { file: 'playground.tsx', start: '<div className="seg" role="tablist"', scope: { tab: 'python', setTab: () => {} } },
    { file: 'agent-workspace.tsx', start: '<div className="ag-workspace-tabs"', scope: { tab: 'rules', count: 0, setTab: () => {}, Files: Icon, ListChecks: Icon, ShieldCheck: Icon, FileText: Icon, GitBranch: Icon, Terminal: Icon, Hammer: Icon } },
  ];
  for (const c of cases) {
    const jsx = between(source(c.file), c.start, '</div>') + '</div>';
    const tree = evaluate(`return (${jsx});`, { ...c.scope, tabKeys });
    expect(tree.props.onKeyDown).toBe(tabKeys);
    const children = [tree.props.children].flat(Infinity).filter(Boolean);
    expect(children.filter((tab: any) => tab.props.tabIndex === 0)).toHaveLength(1);
    for (const tab of children) { expect(tab.props.role).toBe('tab'); expect(tab.props.tabIndex).toBe(tab.props['aria-selected'] ? 0 : -1); expect(tab.props.type).toBe('button'); }
  }
});

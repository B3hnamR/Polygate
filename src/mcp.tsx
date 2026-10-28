import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, ChevronRight, Copy, Download, Globe, Loader2, Play, Plug, Plus, RefreshCw, Server, Terminal, Trash2, Upload, X, Pencil, Wrench } from 'lucide-react';
import { api, BASE } from './api';
import { Button, Empty, Field, Select, Toggle, type Snapshot } from './ui';
import type { McpServer } from '../backend/types';

type ToolInfo = { name: string; hubName: string; title?: string; description?: string; inputSchema?: any; readOnly?: boolean; disabled?: boolean };
type Status = { state: 'off' | 'connecting' | 'ready' | 'error'; error?: string; serverInfo?: { name?: string; version?: string }; protocol?: string; connectedAt?: number; calls: number; failures: number; avgMs: number; lastCallAt?: number; tools: ToolInfo[] };
type ServerView = McpServer & { status: Status };
type HubState = { enabled: boolean; builtin: boolean; builtinKeys: string[]; canAddLocal: boolean; mode: 'desktop' | 'server'; builtinTools: ToolInfo[]; servers: ServerView[] };
type Draft = { id?: string; name: string; title: string; transport: 'http' | 'sse' | 'stdio'; url: string; headers: [string, string][]; command: string; args: string; env: [string, string][]; cwd: string; routeId: string; timeoutSec: number; keys: string[]; enabled: boolean };
const MASK = '••••••••';
const STATE_LABEL: Record<Status['state'], string> = { ready: 'Connected', connecting: 'Connecting', error: 'Not connected', off: 'Off' };
const KIND_LABEL = { http: 'Remote', sse: 'Remote (SSE)', stdio: 'Local program' };
// Ready-made entries: remote ones work anywhere; local programs need the Windows app or the server's manager.
const PRESETS: { title: string; blurb: string; draft: Partial<Draft>; local?: boolean; needs?: string }[] = [
  { title: 'Context7', blurb: 'Up-to-date documentation and examples for code libraries.', draft: { name: 'context7', transport: 'http', url: 'https://mcp.context7.com/mcp' } },
  { title: 'DeepWiki', blurb: 'Ask questions about any public GitHub repository.', draft: { name: 'deepwiki', transport: 'http', url: 'https://mcp.deepwiki.com/mcp' } },
  { title: 'Exa search', blurb: 'Web and code search made for AI agents.', draft: { name: 'exa', transport: 'http', url: 'https://mcp.exa.ai/mcp' } },
  { title: 'GitHub', blurb: 'Issues, pull requests and code on GitHub.', needs: 'a GitHub token', draft: { name: 'github', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: [['Authorization', 'Bearer YOUR_GITHUB_TOKEN']] } },
  { title: 'Files', blurb: 'Read and write files in one folder of this computer.', local: true, draft: { name: 'files', transport: 'stdio', command: 'npx', args: '-y\n@modelcontextprotocol/server-filesystem\nC:\\Users\\you\\Documents' } },
  { title: 'Playwright', blurb: 'A real browser the agent can drive.', local: true, draft: { name: 'playwright', transport: 'stdio', command: 'npx', args: '-y\n@playwright/mcp@latest' } },
];
const blankDraft = (): Draft => ({ name: '', title: '', transport: 'http', url: '', headers: [], command: '', args: '', env: [], cwd: '', routeId: 'direct', timeoutSec: 60, keys: [], enabled: true });
const toDraft = (s: ServerView): Draft => ({ id: s.id, name: s.name, title: s.title || '', transport: s.transport, url: s.url || '', headers: Object.entries(s.headers || {}), command: s.command || '', args: (s.args || []).join('\n'), env: Object.entries(s.env || {}), cwd: s.cwd || '', routeId: s.routeId || 'direct', timeoutSec: s.timeoutSec || 60, keys: s.keys || [], enabled: s.enabled });
const fromDraft = (d: Draft) => ({ id: d.id, name: d.name.trim().toLowerCase(), title: d.title, transport: d.transport, enabled: d.enabled, keys: d.keys, timeoutSec: d.timeoutSec,
  ...(d.transport === 'stdio' ? { command: d.command, args: d.args.split('\n').map(a => a.trim()).filter(Boolean), env: Object.fromEntries(d.env.filter(([k]) => k.trim())), cwd: d.cwd } : { url: d.url.trim(), routeId: d.routeId, headers: Object.fromEntries(d.headers.filter(([k]) => k.trim())) }) });
// A starting point for a tool's arguments, from its input schema.
function skeleton(schema: any): unknown {
  if (!schema || typeof schema !== 'object') return {};
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === 'object' || schema.properties) return Object.fromEntries(Object.entries(schema.properties || {}).map(([k, v]) => [k, skeleton(v)]));
  return type === 'string' ? '' : type === 'number' || type === 'integer' ? 0 : type === 'boolean' ? false : type === 'array' ? [] : null;
}
export function Dialog({ title, icon, onClose, busy, wide, children }: { title: string; icon: ReactNode; onClose: () => void; busy?: boolean; wide?: boolean; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null); const closing = useRef(onClose);
  useEffect(() => { closing.current = onClose; });
  useEffect(() => { const opener = document.activeElement as HTMLElement | null; box.current?.querySelector<HTMLElement>('input,textarea,button.select-trigger')?.focus(); return () => opener?.focus(); }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (!busy && !e.defaultPrevented) closing.current(); }
      else if (e.key === 'Tab' && box.current) { const f = [...box.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled])')]; const i = f.indexOf(document.activeElement as HTMLElement); if (!f.length) e.preventDefault(); else if (e.shiftKey ? i <= 0 : (i < 0 || i === f.length - 1)) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); } }
    };
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, [busy]);
  return <div className="dialog-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <div ref={box} className={`dialog${wide ? ' dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
      <header className="dialog-head">{icon}<h2>{title}</h2><span className="toolbar-spacer" /><button type="button" className="icon-button" aria-label="Close" disabled={busy} onClick={onClose}><X size={16} /></button></header>
      <div className="dialog-body">{children}</div>
    </div>
  </div>;
}
function Pairs({ label, hint, rows, onChange, keyLabel, valueLabel, secret }: { label: string; hint: string; rows: [string, string][]; onChange: (rows: [string, string][]) => void; keyLabel: string; valueLabel: string; secret?: boolean }) {
  return <div className="pairs"><span className="pairs-label">{label}</span><small className="subtle">{hint}</small>
    {rows.map(([k, v], i) => <div className="pair-row" key={i}>
      <input aria-label={`${keyLabel} ${i + 1}`} placeholder={keyLabel} value={k} onChange={e => onChange(rows.map((r, j) => j === i ? [e.target.value, r[1]] : r))} />
      <input aria-label={`${valueLabel} ${i + 1}`} placeholder={valueLabel} type={secret && v !== MASK ? 'password' : 'text'} value={v} onFocus={e => { if (v === MASK) e.target.select(); }} onChange={e => onChange(rows.map((r, j) => j === i ? [r[0], e.target.value] : r))} />
      <button type="button" className="icon-button" aria-label={`Remove ${keyLabel.toLowerCase()} ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}><X size={14} /></button>
    </div>)}
    <button type="button" className="text-button" onClick={() => onChange([...rows, ['', '']])}><Plus size={13} />Add {keyLabel.toLowerCase()}</button>
  </div>;
}
function ServerDialog({ initial, hub, data, onClose, onSaved }: { initial: Draft; hub: HubState; data: Snapshot; onClose: () => void; onSaved: (s: ServerView) => void }) {
  // A route that is switched off (Direct, when the user turned it off) is not offered: a new server starts on one that can carry it.
  const usable = data.settings.routes.filter(r => r.kind !== 'relay' && r.enabled);
  const [d, setD] = useState(initial.routeId && !usable.some(r => r.id === initial.routeId) && usable.length ? { ...initial, routeId: usable[0].id } : initial); const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  const [test, setTest] = useState<{ ok: boolean; ms: number; error?: string; tools?: { name: string; description?: string }[]; serverInfo?: { name?: string; version?: string } } | null>(null);
  const editing = !!initial.id; const local = d.transport === 'stdio'; const lockedLocal = local && !hub.canAddLocal;
  const set = (patch: Partial<Draft>) => { setD({ ...d, ...patch }); setTest(null); };
  const routes = data.settings.routes.filter(r => r.kind !== 'relay' && r.enabled);
  const run = async (what: 'test' | 'save') => {
    setBusy(what); setError('');
    try {
      if (what === 'test') setTest(await api('/admin/mcp/test', fromDraft(d)));
      else onSaved(await api('/admin/mcp/servers', fromDraft(d)));
    } catch (e: any) { setError(e?.message || 'That did not work'); } finally { setBusy(''); }
  };
  return <Dialog title={editing ? `Edit ${initial.name}` : 'Add an MCP server'} icon={<Plug size={16} />} onClose={onClose} busy={!!busy} wide>
    {!editing && <div className="seg mcp-kind" role="tablist" aria-label="Kind of server">
      <button role="tab" aria-selected={!local} className={!local ? 'on' : ''} onClick={() => set({ transport: 'http' })}><Globe size={14} />Remote server</button>
      <button role="tab" aria-selected={local} className={local ? 'on' : ''} onClick={() => set({ transport: 'stdio' })}><Terminal size={14} />Local program</button>
    </div>}
    {lockedLocal && <div className="dialog-note warn"><AlertTriangle size={16} /><p>{editing ? 'This program runs on the server. Its command can only be changed there:' : 'For safety, programs can only be added on the server itself, never from a web page:'} <code>sudo polygate mcp add-local NAME COMMAND ARGS</code>. You can still switch it on or off, limit its keys and choose its tools here.</p></div>}
    <div className="form-grid">
      <Field label="Name" hint="Lowercase letters, digits and dashes. Its tools are named name__tool."><input value={d.name} maxLength={24} placeholder="docs" onChange={e => set({ name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} /></Field>
      <Field label="Display name (optional)"><input value={d.title} maxLength={80} placeholder="Team documentation" onChange={e => set({ title: e.target.value })} /></Field>
    </div>
    {!local ? <>
      <Field label="Address" hint="The server's MCP address, usually ending in /mcp (or /sse for older servers)."><input value={d.url} placeholder="https://example.com/mcp" inputMode="url" onChange={e => set({ url: e.target.value, transport: /\/sse\/?(\?|$)/.test(e.target.value) ? 'sse' : d.transport })} /></Field>
      <div className="form-grid">
        <Field label="Connection type"><Select aria-label="Connection type" value={d.transport} onChange={v => set({ transport: v as Draft['transport'] })}><option value="http">Streamable HTTP (current servers)</option><option value="sse">HTTP + SSE (older servers)</option></Select></Field>
        <Field label="Network route" hint="How Polygate reaches this server. Relays only carry OpenCode and Kilo."><Select aria-label="Network route" value={d.routeId} onChange={v => set({ routeId: v })}>{routes.map(r => <option key={r.id} value={r.id}>{r.name}{r.enabled ? '' : ' (off)'}</option>)}</Select></Field>
      </div>
      <Pairs label="Headers" hint="Sign-in for this server, for example Authorization: Bearer … Stored encrypted; never shown again." rows={d.headers} keyLabel="Header" valueLabel="Value" secret onChange={headers => set({ headers })} />
    </> : <fieldset className="plain-fieldset" disabled={lockedLocal}>
      <Field label="Program" hint="For example npx, uvx, node, python or a full path."><input value={d.command} placeholder="npx" onChange={e => set({ command: e.target.value })} /></Field>
      <Field label="Arguments" hint="One per line."><textarea rows={4} value={d.args} placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:\\Users\\you\\Documents'} onChange={e => set({ args: e.target.value })} /></Field>
      <Pairs label="Environment variables" hint="Keys the program needs. Stored encrypted; never shown again." rows={d.env} keyLabel="Variable" valueLabel="Value" secret onChange={env => set({ env })} />
      <Field label="Working folder (optional)"><input value={d.cwd} placeholder="Leave empty for the default" onChange={e => set({ cwd: e.target.value })} /></Field>
    </fieldset>}
    <div className="form-grid">
      <Field label="Tool time limit (seconds)"><input type="number" min={5} max={600} value={d.timeoutSec} onChange={e => set({ timeoutSec: Math.max(5, Math.min(600, Number(e.target.value) || 60)) })} /></Field>
      <Field label="Who can use it"><Select aria-label="Who can use it" value={d.keys.length ? 'some' : 'all'} onChange={v => set({ keys: v === 'all' ? [] : data.settings.keys.slice(0, 1).map(k => k.id) })}><option value="all">Every client API key</option><option value="some">Only the keys I choose</option></Select></Field>
    </div>
    {d.keys.length > 0 && <div className="key-picks" role="group" aria-label="Client API keys">{data.settings.keys.map(k => <label key={k.id} className="key-pick"><input type="checkbox" checked={d.keys.includes(k.id)} onChange={e => set({ keys: e.target.checked ? [...d.keys, k.id] : d.keys.filter(x => x !== k.id).length ? d.keys.filter(x => x !== k.id) : d.keys })} />{k.name}</label>)}</div>}
    {test && <div className={`dialog-note ${test.ok ? 'good' : 'warn'}`} role="status">{test.ok ? <Check size={16} /> : <AlertTriangle size={16} />}<div>
      <p>{test.ok ? `Connected to ${test.serverInfo?.name || 'the server'}${test.serverInfo?.version ? ' ' + test.serverInfo.version : ''} in ${test.ms} ms. ${test.tools?.length || 0} tool(s):` : `Could not connect: ${test.error}`}</p>
      {test.ok && !!test.tools?.length && <p className="mcp-tool-names">{test.tools.map(t => <code key={t.name} title={t.description}>{t.name}</code>)}</p>}
    </div></div>}
    {error && <div className="dialog-note error" role="alert"><AlertTriangle size={16} /><p>{error}</p></div>}
    <div className="dialog-actions">
      <Button variant="primary" disabled={!!busy} onClick={() => void run('save')}>{busy === 'save' ? <Loader2 size={14} className="spin" /> : <Check size={14} />}{busy === 'save' ? 'Saving and connecting…' : editing ? 'Save' : 'Add server'}</Button>
      <Button disabled={!!busy || lockedLocal && !editing} onClick={() => void run('test')}>{busy === 'test' ? <Loader2 size={14} className="spin" /> : <Plug size={14} />}{busy === 'test' ? 'Connecting…' : 'Test connection'}</Button>
      <Button disabled={!!busy} onClick={onClose}>Cancel</Button>
    </div>
  </Dialog>;
}
function TryDialog({ server, tool, onClose }: { server: { id: string; name: string }; tool: ToolInfo; onClose: () => void }) {
  // Only the required arguments are filled in; the optional ones are listed above.
  const [args, setArgs] = useState(() => { const required: string[] = tool.inputSchema?.required || []; const all = skeleton(tool.inputSchema) as Record<string, unknown>; return JSON.stringify(Object.fromEntries(Object.entries(all || {}).filter(([k]) => required.includes(k))), null, 2); });
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [result, setResult] = useState<{ content?: any[]; isError?: boolean; structuredContent?: unknown; ms: number } | null>(null);
  const run = async () => {
    let parsed: unknown; try { parsed = JSON.parse(args || '{}'); } catch { setError('The arguments are not valid JSON'); return; }
    setBusy(true); setError(''); setResult(null); const started = performance.now();
    try { const r = await api('/admin/mcp/call', { server: server.id, tool: tool.name, arguments: parsed }); setResult({ ...r, ms: Math.round(performance.now() - started) }); }
    catch (e: any) { setError(e?.message || 'The tool could not be run'); } finally { setBusy(false); }
  };
  const props = Object.entries((tool.inputSchema?.properties || {}) as Record<string, any>);
  return <Dialog title={`Try ${server.name === 'polygate' ? 'polygate' : server.name} · ${tool.name}`} icon={<Wrench size={16} />} onClose={onClose} busy={busy} wide>
    {tool.description && <p className="subtle mcp-tool-description">{tool.description}</p>}
    {props.length > 0 && <dl className="log-facts mcp-args">{props.map(([k, v]) => <Fragment key={k}><dt>{k}{tool.inputSchema?.required?.includes(k) ? ' *' : ''}</dt><dd>{[Array.isArray(v?.type) ? v.type.join(' or ') : v?.type, v?.description].filter(Boolean).join(' · ') || '—'}</dd></Fragment>)}</dl>}
    <Field label="Arguments (JSON)"><textarea rows={Math.min(14, Math.max(4, args.split('\n').length + 1))} className="mono" value={args} spellCheck={false} onChange={e => setArgs(e.target.value)} /></Field>
    {result && <div className={`dialog-note ${result.isError ? 'warn' : 'good'}`} role="status">{result.isError ? <AlertTriangle size={16} /> : <Check size={16} />}<div className="mcp-result">
      <p>{result.isError ? 'The tool reported an error' : 'Done'} in {result.ms} ms</p>
      {(result.content || []).map((c, i) => c.type === 'text' ? <pre key={i}>{c.text}</pre> : c.type === 'image' ? <img key={i} alt={`Image ${i + 1} from the tool`} src={`data:${c.mimeType};base64,${c.data}`} /> : <pre key={i}>{JSON.stringify(c, null, 2)}</pre>)}
    </div></div>}
    {error && <div className="dialog-note error" role="alert"><AlertTriangle size={16} /><p>{error}</p></div>}
    <div className="dialog-actions"><Button variant="primary" disabled={busy} onClick={() => void run()}>{busy ? <Loader2 size={14} className="spin" /> : <Play size={14} />}{busy ? 'Running…' : result ? 'Run again' : 'Run tool'}</Button><Button disabled={busy} onClick={onClose}>Close</Button></div>
  </Dialog>;
}
function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: (added: string[]) => void }) {
  const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [result, setResult] = useState<{ added: string[]; skipped: { name: string; reason: string }[] } | null>(null);
  const run = async () => { setBusy(true); setError(''); try { const r = await api('/admin/mcp/import', { config: text }); setResult(r); if (r.added.length) onDone(r.added); } catch (e: any) { setError(e?.message || 'Nothing was imported'); } finally { setBusy(false); } };
  return <Dialog title="Import MCP servers" icon={<Upload size={16} />} onClose={onClose} busy={busy} wide>
    <p className="subtle">Paste the MCP part of another tool's settings: Claude Desktop, Claude Code or Cursor (<code>"mcpServers"</code>), VS Code (<code>"servers"</code>) or OpenCode (<code>"mcp"</code>).</p>
    <textarea className="mono" rows={12} spellCheck={false} value={text} placeholder={'{\n  "mcpServers": {\n    "context7": { "url": "https://mcp.context7.com/mcp" }\n  }\n}'} onChange={e => { setText(e.target.value); setResult(null); }} />
    {result && <div className={`dialog-note ${result.added.length ? 'good' : 'warn'}`} role="status">{result.added.length ? <Check size={16} /> : <AlertTriangle size={16} />}<div>
      <p>{result.added.length ? `Added ${result.added.join(', ')}.` : 'Nothing was added.'}</p>{result.skipped.map(s => <p key={s.name} className="subtle">Skipped {s.name}: {s.reason}</p>)}</div></div>}
    {error && <div className="dialog-note error" role="alert"><AlertTriangle size={16} /><p>{error}</p></div>}
    <div className="dialog-actions"><Button variant="primary" disabled={busy || !text.trim()} onClick={() => void run()}>{busy ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}{busy ? 'Importing…' : 'Import'}</Button><Button disabled={busy} onClick={onClose}>{result ? 'Done' : 'Cancel'}</Button></div>
  </Dialog>;
}
// What to paste into each client. Every one connects to the same address with a client API key.
function snippets(url: string, key: string) {
  const header = `Bearer ${key}`;
  return [
    { id: 'claude', label: 'Claude Code', where: 'Run in a terminal', text: `claude mcp add --transport http polygate ${url} --header "Authorization: ${header}"` },
    { id: 'cursor', label: 'Cursor', where: '~/.cursor/mcp.json (or .cursor/mcp.json in a project)', text: JSON.stringify({ mcpServers: { polygate: { url, headers: { Authorization: header } } } }, null, 2) },
    { id: 'codex', label: 'Codex', where: '~/.codex/config.toml', text: `[mcp_servers.polygate]\nurl = "${url}"\nhttp_headers = { "Authorization" = "${header}" }` },
    { id: 'opencode', label: 'OpenCode', where: 'opencode.json', text: JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { polygate: { type: 'remote', url, headers: { Authorization: header }, enabled: true } } }, null, 2) },
    { id: 'vscode', label: 'VS Code', where: '.vscode/mcp.json', text: JSON.stringify({ servers: { polygate: { type: 'http', url, headers: { Authorization: header } } } }, null, 2) },
    { id: 'desktop', label: 'Claude Desktop', where: 'claude_desktop_config.json (needs Node.js)', text: JSON.stringify({ mcpServers: { polygate: { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', `Authorization:${header}`] } } }, null, 2) },
  ];
}
function ConnectPanel({ hub, data, copy, onToggle }: { hub: HubState; data: Snapshot; copy: (s: string) => void; onToggle: (v: boolean) => void }) {
  const keys = data.settings.keys.filter(k => k.enabled);
  const [keyId, setKeyId] = useState(keys[0]?.id || ''); const [tab, setTab] = useState(() => { try { return localStorage.getItem('polygate-mcp-client') || 'claude'; } catch { return 'claude'; } });
  const key = keys.find(k => k.id === keyId) || keys[0]; const url = location.origin + BASE + '/mcp';
  const list = snippets(url, key?.value || 'YOUR_CLIENT_KEY'); const current = list.find(s => s.id === tab) || list[0];
  return <section className="section-block form-section mcp-connect" aria-labelledby="mcp-connect-heading">
    <h2 id="mcp-connect-heading">Connect your AI client</h2><p className="muted mcp-intro">One address gives your client the tools of every server below, plus Polygate's own. Tools are named <code>server__tool</code>.</p>
    <Toggle checked={hub.enabled} onChange={onToggle} label="MCP hub" detail={hub.enabled ? 'Clients with a Polygate client API key can connect.' : 'Off: the address answers "turned off" and no server is connected.'} />
    <div className="mcp-endpoint">
      <div><span className="pairs-label">Address</span><div className="mcp-copy-line"><code>{url}</code><button className="icon-button" aria-label="Copy the MCP address" onClick={() => copy(url)}><Copy size={14} /></button></div></div>
      <div><span className="pairs-label">Client API key</span>{keys.length ? <Select aria-label="Client API key" value={key?.id} onChange={setKeyId}>{keys.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}</Select> : <p className="subtle">Create a client API key in Settings first.</p>}</div>
    </div>
    <div className="seg mcp-clients" role="tablist" aria-label="Client">{list.map(s => <button key={s.id} role="tab" aria-selected={s.id === current.id} className={s.id === current.id ? 'on' : ''} onClick={() => { setTab(s.id); try { localStorage.setItem('polygate-mcp-client', s.id); } catch { /* storage can be disabled */ } }}>{s.label}</button>)}</div>
    <div className="mcp-snippet"><div className="mcp-snippet-head"><span className="subtle">{current.where}</span><Button onClick={() => copy(current.text)}><Copy size={14} />Copy</Button></div><pre><code>{current.text}</code></pre></div>
    <p className="subtle">The key is included in what you copy: keep it private. One server alone (with its tools' own names) is at <code>{url}/NAME</code>.</p>
  </section>;
}
function ToolRows({ server, tools, onToggle, onTry, busy }: { server: { id: string; name: string }; tools: ToolInfo[]; onToggle?: (tool: string, on: boolean) => void; onTry: (t: ToolInfo) => void; busy?: boolean }) {
  return <ul className="mcp-tools">{tools.map(t => <li key={t.name} className={t.disabled ? 'off' : ''}>
    <div className="mcp-tool-text"><code>{t.hubName}</code>{t.readOnly && <span className="mcp-tag">read-only</span>}<p>{t.description || t.title || 'No description'}</p></div>
    <div className="mcp-tool-actions">
      <Button onClick={() => onTry(t)} disabled={t.disabled}><Play size={13} />Try</Button>
      {onToggle && <input type="checkbox" role="switch" aria-label={`Offer ${t.name} to clients`} title={t.disabled ? 'Hidden from clients' : 'Offered to clients'} checked={!t.disabled} disabled={busy} onChange={e => onToggle(t.name, e.target.checked)} />}
    </div>
  </li>)}</ul>;
}
function ServerCard({ s, data, hub, onEdit, onChanged, onTry, notice }: { s: ServerView; data: Snapshot; hub: HubState; onEdit: () => void; onChanged: () => void; onTry: (t: ToolInfo) => void; notice: (m: string, kind?: 'ok' | 'error') => void }) {
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState('');
  const act = async (what: string, path: string, body: unknown, done?: string) => { setBusy(what); try { await api(path, body); if (done) notice(done); onChanged(); } catch (e: any) { notice(e?.message || 'That did not work', 'error'); } finally { setBusy(''); } };
  const st = s.status; const route = data.settings.routes.find(r => r.id === (s.routeId || 'direct'));
  const where = s.transport === 'stdio' ? [s.command, ...(s.args || [])].join(' ') : s.url;
  const offered = st.tools.filter(t => !t.disabled).length;
  return <article className={`mcp-server state-${st.state}`} aria-label={s.name}>
    <div className="mcp-server-head">
      <span className={`mcp-dot ${st.state}`} aria-hidden="true" />
      <div className="mcp-server-title">
        <h3>{s.title || s.name}{s.title && <code>{s.name}</code>}</h3>
        <p className="subtle"><span className="mcp-tag">{KIND_LABEL[s.transport]}</span>{s.transport !== 'stdio' && route && <span>via {route.name}</span>}<span className="mcp-where" title={where}>{where}</span></p>
      </div>
      <div className="mcp-server-actions">
        <input type="checkbox" role="switch" aria-label={`${s.name} on`} checked={s.enabled} disabled={!!busy || !hub.enabled} onChange={e => void act('toggle', '/admin/mcp/servers/toggle', { id: s.id, enabled: e.target.checked }, e.target.checked ? `${s.name} switched on` : `${s.name} switched off`)} />
        <Button onClick={() => void act('reconnect', '/admin/mcp/servers/reconnect', { id: s.id }, `${s.name} reconnected`)} disabled={!!busy || !s.enabled || !hub.enabled} title="Reconnect and reload its tools"><RefreshCw size={13} className={busy === 'reconnect' ? 'spin' : ''} /></Button>
        <Button onClick={onEdit} disabled={!!busy} title="Edit"><Pencil size={13} /></Button>
        <Button onClick={() => { if (confirm(`Remove ${s.name}? Clients lose its tools.`)) void act('delete', '/admin/mcp/servers/delete', { id: s.id }, `${s.name} removed`); }} disabled={!!busy} title="Remove"><Trash2 size={13} /></Button>
      </div>
    </div>
    <div className="mcp-server-meta">
      <span className={`mcp-state ${st.state}`}>{st.state === 'connecting' && <Loader2 size={12} className="spin" />}{STATE_LABEL[st.state]}{st.serverInfo?.name && st.state === 'ready' ? ` · ${st.serverInfo.name}${st.serverInfo.version ? ' ' + st.serverInfo.version : ''}` : ''}</span>
      <span>{st.tools.length ? `${offered} of ${st.tools.length} tools offered` : 'No tools yet'}</span>
      <span>{st.calls ? `${st.calls.toLocaleString()} call(s) · ${st.failures} failed · ${st.avgMs} ms average` : 'Not used yet'}</span>
      {s.keys?.length ? <span>{s.keys.length} key(s) only</span> : null}
    </div>
    {st.error && st.state === 'error' && <p className="mcp-error" role="alert"><AlertTriangle size={14} />{st.error}</p>}
    {st.tools.length > 0 && <button className="mcp-expand text-button" aria-expanded={open} onClick={() => setOpen(!open)}><ChevronRight size={14} className={open ? 'turned' : ''} />{open ? 'Hide tools' : `Show tools (${st.tools.length})`}</button>}
    {open && <ToolRows server={s} tools={st.tools} busy={!!busy} onTry={onTry} onToggle={(tool, on) => void act('tools', '/admin/mcp/servers/tools', { id: s.id, disabledTools: on ? (s.disabledTools || []).filter(t => t !== tool) : [...(s.disabledTools || []), tool] })} />}
  </article>;
}
export function McpPage({ data, copy, notice }: { data: Snapshot; copy: (s: string) => void; notice: (m: string, kind?: 'ok' | 'error') => void }) {
  const [hub, setHub] = useState<HubState | null>(null); const [error, setError] = useState('');
  const [editing, setEditing] = useState<Draft | null>(null); const [importing, setImporting] = useState(false);
  const [trying, setTrying] = useState<{ server: { id: string; name: string }; tool: ToolInfo } | null>(null); const [builtinOpen, setBuiltinOpen] = useState(false);
  const load = useCallback(async () => { try { setHub(await api('/admin/mcp')); setError(''); } catch (e: any) { setError(e?.message || 'Could not read the MCP settings'); } }, []);
  useEffect(() => { void load(); }, [load]);
  // While a server is still connecting (a first npx start can take a minute), the page checks back every few seconds.
  useEffect(() => { if (!hub?.servers.some(s => s.status.state === 'connecting')) return; const t = setTimeout(() => void load(), 3000); return () => clearTimeout(t); }, [hub, load]);
  const settingsChange = async (patch: Record<string, unknown>, done: string) => { try { setHub(await api('/admin/mcp/settings', patch)); notice(done); } catch (e: any) { notice(e?.message || 'Not saved', 'error'); } };
  if (!hub) return error ? <section className="section-block"><Empty icon={Plug} title="MCP is unavailable" action={<Button onClick={() => void load()}>Try again</Button>}>{error}</Empty></section> : <section className="section-block"><div className="logs-loading"><Loader2 size={18} className="spin" />Loading MCP…</div></section>;
  const ready = hub.servers.filter(s => s.status.state === 'ready').length;
  const toolCount = hub.servers.reduce((n, s) => n + (s.enabled ? s.status.tools.filter(t => !t.disabled).length : 0), 0) + (hub.builtin ? hub.builtinTools.length : 0);
  return <>
    <ConnectPanel hub={hub} data={data} copy={copy} onToggle={v => void settingsChange({ enabled: v }, v ? 'MCP hub on' : 'MCP hub off')} />
    <section className="section-block mcp-servers" aria-labelledby="mcp-servers-heading">
      <div className="section-toolbar">
        <div><h2 id="mcp-servers-heading">Servers</h2><p className="subtle">{hub.servers.length ? `${ready} of ${hub.servers.length} connected · ${toolCount} tools offered` : 'Add the MCP servers your clients should reach through Polygate.'}</p></div>
        <span className="toolbar-spacer" />
        <Button onClick={() => void load()} title="Refresh"><RefreshCw size={14} />Refresh</Button>
        <Button onClick={() => setImporting(true)}><Download size={14} />Import</Button>
        <Button variant="primary" onClick={() => setEditing(blankDraft())}><Plus size={14} />Add server</Button>
      </div>
      {hub.servers.length ? <div className="mcp-server-list">{hub.servers.map(s => <ServerCard key={s.id} s={s} data={data} hub={hub} notice={notice} onChanged={() => void load()} onEdit={() => setEditing(toDraft(s))} onTry={tool => setTrying({ server: s, tool })} />)}</div>
        : <Empty icon={Server} title="No MCP servers yet">Add one below, paste the settings from another tool with Import, or start with a ready-made one.</Empty>}
      <div className="mcp-presets"><h3>Ready-made servers</h3><div className="mcp-preset-grid">{PRESETS.map(p => {
        const blocked = p.local && !hub.canAddLocal; const taken = hub.servers.some(s => s.name === p.draft.name);
        return <button key={p.title} className="mcp-preset" disabled={blocked || taken} title={blocked ? 'Local programs can be added in the Windows app, or on the server with sudo polygate mcp add-local' : taken ? 'Already added' : `Add ${p.title}`} onClick={() => setEditing({ ...blankDraft(), title: p.title, ...p.draft })}>
          <span className="mcp-preset-head">{p.local ? <Terminal size={15} /> : <Globe size={15} />}<strong>{p.title}</strong>{taken ? <span className="mcp-tag">added</span> : p.local ? <span className="mcp-tag">local</span> : null}</span>
          <span className="subtle">{p.blurb}{p.needs ? ` Needs ${p.needs}.` : ''}</span>
        </button>;
      })}</div>{!hub.canAddLocal && <p className="subtle">Local programs run on the server, so they are added there: <code>sudo polygate mcp add-local NAME COMMAND ARGS</code>. In the Windows app you can add them here.</p>}</div>
    </section>
    <section className="section-block form-section" aria-labelledby="mcp-own-heading">
      <h2 id="mcp-own-heading">Polygate's own tools</h2>
      <Toggle checked={hub.builtin} onChange={v => void settingsChange({ builtin: v }, v ? "Polygate's tools on" : "Polygate's tools off")} label="Offer Polygate's own tools" detail="Let an agent check the gateway: its status, models, routes, recent errors and the log. Only test_route sends anything." />
      <button className="mcp-expand text-button" aria-expanded={builtinOpen} onClick={() => setBuiltinOpen(!builtinOpen)}><ChevronRight size={14} className={builtinOpen ? 'turned' : ''} />{builtinOpen ? 'Hide tools' : `Show tools (${hub.builtinTools.length})`}</button>
      {builtinOpen && <ToolRows server={{ id: 'polygate', name: 'polygate' }} tools={hub.builtinTools.map(t => ({ ...t, disabled: !hub.builtin }))} onTry={tool => setTrying({ server: { id: 'polygate', name: 'polygate' }, tool })} />}
    </section>
    {editing && <ServerDialog initial={editing} hub={hub} data={data} onClose={() => setEditing(null)} onSaved={s => { setEditing(null); notice(s.status.state === 'ready' ? `${s.name} connected with ${s.status.tools.length} tool(s)` : s.status.state === 'error' ? `${s.name} saved, but it could not connect` : `${s.name} saved`, s.status.state === 'error' ? 'error' : 'ok'); void load(); }} />}
    {importing && <ImportDialog onClose={() => setImporting(false)} onDone={() => void load()} />}
    {trying && <TryDialog server={trying.server} tool={trying.tool} onClose={() => setTrying(null)} />}
  </>;
}

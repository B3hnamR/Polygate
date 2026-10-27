import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, AlertTriangle, Check, ChevronDown, ChevronRight, Copy, Info, Loader2, Play, RefreshCw, ScrollText, Search, Trash2, X } from 'lucide-react';
import { api, at } from './api';
import { Button, Empty, Select } from './ui';
import type { Level, LogEntry } from '../backend/logbook';

type Result = { entries: LogEntry[]; more: boolean; levels: Partial<Record<Level, number>>; sources: { source: string; count: number }[]; total: number };
const LEVEL_INFO: Record<Level, { label: string; icon: typeof Info }> = { error: { label: 'Errors', icon: AlertCircle }, warn: { label: 'Warnings', icon: AlertTriangle }, info: { label: 'Info', icon: Info } };
const SOURCE_LABELS: Record<string, string> = { requests: 'Requests', models: 'Models', routes: 'Routes', proxies: 'Proxies', warp: 'WARP', https: 'HTTPS', auth: 'Sign-in', settings: 'Settings', keys: 'API keys', providers: 'Providers', relays: 'Relays', notify: 'Notifications', updates: 'Updates', gateway: 'Gateway', logs: 'Logs', catalog: 'Catalog', state: 'Storage' };
const sourceLabel = (s: string) => SOURCE_LABELS[s] || s.charAt(0).toUpperCase() + s.slice(1);
const RANGES = [['900000', 'Last 15 minutes'], ['3600000', 'Last hour'], ['86400000', 'Last 24 hours'], ['604800000', 'Last 7 days']] as const;
const PAGE = 200, LIVE_MS = 2500, MAX_ROWS = 2000;
const remembered = (key: string, fallback: string) => { try { return localStorage.getItem('polygate-logs-' + key) || fallback; } catch { return fallback; } };
const remember = (key: string, value: string) => { try { localStorage.setItem('polygate-logs-' + key, value); } catch { /* storage can be disabled */ } };
function stamp(t: number) {
  const d = new Date(t); const today = new Date().toDateString() === d.toDateString();
  const clock = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return today ? clock : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock}`;
}
// Search matches are highlighted in the message so a long log reads quickly.
function Marked({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'));
  return <>{parts.map((p, i) => i % 2 ? <mark key={i}>{p}</mark> : <Fragment key={i}>{p}</Fragment>)}</>;
}
function DetailValue({ value }: { value: unknown }): ReactNode {
  if (value === null || value === undefined) return <span className="subtle">—</span>;
  if (Array.isArray(value)) return value.length ? value.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)).join(', ') : <span className="subtle">none</span>;
  if (typeof value === 'object') return <code>{JSON.stringify(value)}</code>;
  if (typeof value === 'number' && value > 1e12 && value < 1e13) return new Date(value).toLocaleString();
  return String(value);
}
function Row({ entry, open, toggle, query, fresh }: { entry: LogEntry; open: boolean; toggle: () => void; query: string; fresh: boolean }) {
  const [copied, setCopied] = useState(false);
  const Icon = LEVEL_INFO[entry.level]?.icon || Info;
  const detail = entry.detail && typeof entry.detail === 'object' ? Object.entries(entry.detail as Record<string, unknown>).filter(([, v]) => v !== undefined) : [];
  const copy = async () => { try { await navigator.clipboard.writeText(JSON.stringify({ time: new Date(entry.time).toISOString(), level: entry.level, source: entry.source, message: entry.message, ...(entry.detail ? { detail: entry.detail } : {}) }, null, 2)); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setCopied(false); } };
  return <li className={`log-row level-${entry.level}${open ? ' open' : ''}${fresh ? ' fresh' : ''}`}>
    <button className="log-line" aria-expanded={open} onClick={toggle}>
      <ChevronRight size={14} className="log-caret" aria-hidden="true" />
      <time className="log-time" dateTime={new Date(entry.time).toISOString()} title={new Date(entry.time).toLocaleString()}>{stamp(entry.time)}</time>
      <span className="log-level"><Icon size={13} aria-hidden="true" />{entry.level === 'warn' ? 'Warning' : entry.level === 'error' ? 'Error' : 'Info'}</span>
      <span className="log-source">{sourceLabel(entry.source)}</span>
      <span className="log-message"><Marked text={entry.message} query={query} /></span>
    </button>
    {open && <div className="log-detail">
      <p className="log-full"><Marked text={entry.message} query={query} /></p>
      {detail.length > 0 && <dl className="log-facts">{detail.map(([k, v]) => <Fragment key={k}><dt>{k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}</dt><dd><DetailValue value={v} /></dd></Fragment>)}</dl>}
      <div className="log-detail-actions"><span className="subtle">{new Date(entry.time).toLocaleString()} · #{entry.id}</span><Button onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy entry'}</Button></div>
    </div>}
  </li>;
}
export function LogsPage() {
  const [levels, setLevels] = useState<Level[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [range, setRange] = useState(() => remembered('range', '86400000'));
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [live, setLive] = useState(() => remembered('live', '1') === '1');
  const [data, setData] = useState<Result | null>(null);
  const [rows, setRows] = useState<LogEntry[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [older, setOlder] = useState(false);
  const [error, setError] = useState('');
  const [exportFormat, setExportFormat] = useState('');
  const newest = useRef(0);
  // The search box waits for a pause in typing before asking the gateway.
  useEffect(() => { const t = setTimeout(() => setQuery(input.trim()), 250); return () => clearTimeout(t); }, [input]);
  const params = useCallback((extra: Record<string, string | number> = {}) => {
    const p = new URLSearchParams();
    if (levels.length) p.set('level', levels.join(','));
    if (sources.length) p.set('source', sources.join(','));
    if (query) p.set('q', query);
    p.set('from', String(Date.now() - Number(range)));
    for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
    return p;
  }, [levels, sources, query, range]);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { const r: Result = await api('/admin/events?' + params({ limit: PAGE })); setData(r); setRows(r.entries); newest.current = r.entries[0]?.id || 0; setFresh(new Set()); }
    catch (e: any) { setError(e?.message || 'Could not read the logs.'); }
    finally { setLoading(false); }
  }, [params]);
  useEffect(() => { void load(); }, [load]);
  // Live view: only entries newer than the last one shown are fetched, then added on top.
  useEffect(() => {
    if (!live) return;
    let busy = false;
    const tick = async () => {
      if (busy || document.hidden) return; busy = true;
      try {
        const r: Result = await api('/admin/events?' + params({ after: newest.current, limit: 500 }));
        setData(prev => prev ? { ...prev, levels: r.levels, sources: r.sources, total: r.total } : r);
        if (r.entries.length) {
          newest.current = r.entries[0].id;
          setRows(prev => [...r.entries, ...prev].slice(0, MAX_ROWS));
          setFresh(new Set(r.entries.map(e => e.id)));
        }
      } catch { /* the next tick tries again */ } finally { busy = false; }
    };
    const id = setInterval(() => void tick(), LIVE_MS);
    return () => clearInterval(id);
  }, [live, params]);
  const loadOlder = async () => {
    const last = rows[rows.length - 1]; if (!last) return;
    setOlder(true);
    try { const r: Result = await api('/admin/events?' + params({ before: last.id, limit: PAGE })); setRows(prev => [...prev, ...r.entries].slice(0, MAX_ROWS + PAGE)); setData(prev => prev ? { ...prev, more: r.more } : r); }
    catch (e: any) { setError(e?.message || 'Could not read older entries.'); }
    finally { setOlder(false); }
  };
  const clearAll = async () => {
    if (!confirm('Delete every log entry? This cannot be undone.')) return;
    try { await api('/admin/events/clear', {}); await load(); } catch (e: any) { setError(e?.message || 'Could not clear the logs.'); }
  };
  const download = (format: string) => {
    setExportFormat('');
    const a = document.createElement('a'); a.href = at('/admin/events/export?' + params({ format })); a.download = ''; document.body.appendChild(a); a.click(); a.remove();
  };
  const toggleIn = <T,>(list: T[], value: T) => list.includes(value) ? list.filter(x => x !== value) : [...list, value];
  const filtered = levels.length > 0 || sources.length > 0 || !!query;
  const resetFilters = () => { setLevels([]); setSources([]); setInput(''); setQuery(''); };
  const counts = data?.levels || {};
  const sourceList = useMemo(() => { const list = [...(data?.sources || [])]; for (const s of sources) if (!list.some(x => x.source === s)) list.push({ source: s, count: 0 }); return list; }, [data, sources]);
  const rangeLabel = RANGES.find(([v]) => v === range)?.[1].toLowerCase() || '';
  return <section className="section-block logs-page" aria-label="Logs">
    <div className="section-top logs-head">
      <p className="muted">Requests, model and route changes, dashboard actions, sign-ins, WARP, proxies and HTTPS in one timeline. Secrets are removed before anything is saved; entries are kept for 7 days.</p>
      <div className="logs-head-actions">
        <button className={`live-toggle${live ? ' on' : ''}`} aria-pressed={live} title={live ? 'New entries appear as they happen. Click to pause.' : 'Click to show new entries as they happen.'} onClick={() => { setLive(!live); remember('live', live ? '0' : '1'); if (!live) void load(); }}>
          {live ? <i aria-hidden="true" /> : <Play size={13} />}{live ? 'Live' : 'Paused'}
        </button>
        <Button onClick={() => void load()} disabled={loading} title="Reload"><RefreshCw size={14} className={loading ? 'spin' : ''} />Refresh</Button>
      </div>
    </div>
    <div className="section-toolbar logs-toolbar">
      <div className="search"><Search size={16} /><input aria-label="Search logs" placeholder="Search messages and details…" value={input} onChange={e => setInput(e.target.value)} />{input && <button className="icon-button" aria-label="Clear search" onClick={() => setInput('')}><X size={14} /></button>}</div>
      <Select aria-label="Time range" value={range} onChange={v => { setRange(v); remember('range', v); }}>{RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
      <span className="toolbar-spacer" />
      <Select aria-label="Export logs" value={exportFormat} onChange={download}><option value="" disabled>Export…</option><option value="txt">Download as text (.log)</option><option value="json">Download as JSON lines (.ndjson)</option></Select>
      <Button onClick={() => void clearAll()}><Trash2 size={14} />Clear logs</Button>
    </div>
    <div className="logs-filters">
      <div className="filter-group" role="group" aria-label="Level">
        {(['error', 'warn', 'info'] as Level[]).map(l => { const I = LEVEL_INFO[l].icon; const on = levels.includes(l); return <button key={l} className={`filter-chip level-${l}${on ? ' on' : ''}`} aria-pressed={on} onClick={() => setLevels(toggleIn(levels, l))}><I size={13} aria-hidden="true" />{LEVEL_INFO[l].label}<span className="filter-count">{(counts[l] || 0).toLocaleString()}</span></button>; })}
      </div>
      <div className="filter-group sources" role="group" aria-label="Source">
        {sourceList.map(s => { const on = sources.includes(s.source); return <button key={s.source} className={`filter-chip${on ? ' on' : ''}`} aria-pressed={on} onClick={() => setSources(toggleIn(sources, s.source))}>{sourceLabel(s.source)}<span className="filter-count">{s.count.toLocaleString()}</span></button>; })}
      </div>
      {filtered && <button className="text-button" onClick={resetFilters}><X size={13} />Clear filters</button>}
    </div>
    {error && <p className="update-error logs-error" role="alert">{error}</p>}
    {!data && loading ? <div className="logs-loading"><Loader2 size={18} className="spin" />Loading logs…</div>
      : rows.length === 0 ? <Empty icon={ScrollText} title={filtered ? 'No entries match these filters' : `Nothing logged in the ${rangeLabel}`} action={filtered ? <Button onClick={resetFilters}>Clear filters</Button> : undefined}>{filtered ? 'Try a wider time range, another level or source, or a shorter search.' : 'Entries appear here as Polygate serves requests, checks models and routes, and as settings change.'}</Empty>
      : <>
        <div className="log-columns" aria-hidden="true"><span /><span>Time</span><span>Level</span><span>Source</span><span>Message</span></div>
        <ol className="log-list" aria-label="Log entries">{rows.map(e => <Row key={e.id} entry={e} open={open === e.id} toggle={() => setOpen(open === e.id ? null : e.id)} query={query} fresh={fresh.has(e.id)} />)}</ol>
        <div className="logs-foot">
          <span className="subtle">Showing {rows.length.toLocaleString()} of {(data?.total ?? rows.length).toLocaleString()} {filtered ? 'matching ' : ''}entries from the {rangeLabel}</span>
          {data?.more && rows.length < MAX_ROWS + PAGE && <Button onClick={() => void loadOlder()} disabled={older}>{older ? <Loader2 size={14} className="spin" /> : <ChevronDown size={14} />}Load older</Button>}
        </div>
      </>}
  </section>;
}

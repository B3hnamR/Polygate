import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, CheckCircle2, Download, Link2, Loader2, Plus, Save, Trash2, Zap } from 'lucide-react';
import { api } from './api';
import { Button, Select, Toggle, when } from './ui';
import type { Notice } from './panels';
import type { ProxySource } from '../backend/types';

type Sources = { builtin: boolean; builtinCount: number; sources: ProxySource[] };
type Proto = ProxySource['proto'];
const PROTOS: [Proto, string][] = [['all', 'Any type'], ['http', 'HTTP'], ['https', 'HTTPS'], ['socks5', 'SOCKS5'], ['socks4', 'SOCKS4']];
const protoLabel = (p: Proto) => PROTOS.find(([v]) => v === p)?.[1] || p;
// A line that is only a web address (and not a proxy written as one) is a link to a list, as the gateway reads it.
const linksIn = (text: string) => [...new Set(text.split(/[\r\n]+/).map(l => l.trim()).filter(l => /^https?:\/\/\S+$/i.test(l) && !/^https?:\/\/(?:[^\s:@/]+:[^\s@/]*@)?[^\s/:]+:\d{1,5}\/?$/i.test(l)))];
// Your own proxies and lists: check a pasted list (proxies and links mixed) once, or keep list links that every "Find working proxies" run downloads.
export function ProxyLists({ select, disabled, notice, onStarted }: { select: boolean; disabled: boolean; notice: Notice; onStarted: () => void }) {
  const [text, setText] = useState(''); const [proto, setProto] = useState<Proto>('all'); const [busy, setBusy] = useState('');
  const [lists, setLists] = useState<Sources | null>(null); const [newUrl, setNewUrl] = useState(''); const [newProto, setNewProto] = useState<Proto>('all');
  const [preview, setPreview] = useState<{ url: string; count: number; byProtocol: Record<string, number>; error?: string } | null>(null);
  const files = useRef<HTMLInputElement>(null);
  // A load that failed is not an empty list: saving from it would replace the links stored on the gateway with nothing.
  const [loadFailed, setLoadFailed] = useState(false);
  const loadLists = () => { setLoadFailed(false); api('/admin/proxies/sources').then(setLists).catch(() => { setLists(null); setLoadFailed(true); }); };
  useEffect(loadLists, []);
  const links = linksIn(text);
  const save = async (next: Partial<Sources>, done: string) => {
    if (!lists) return false; setBusy('save');
    try { setLists(await api('/admin/proxies/sources', { builtin: next.builtin ?? lists.builtin, sources: next.sources ?? lists.sources })); notice(done); return true; }
    catch (e: any) { notice(e?.message || 'Not saved', 'error'); return false; } finally { setBusy(''); }
  };
  const check = async () => {
    setBusy('check');
    try { await api('/admin/proxies/import', { text, proto, select }); notice(links.length ? `Downloading ${links.length} list(s) and checking the proxies` : 'Checking your proxies'); setText(''); onStarted(); }
    catch (e: any) { notice(e?.message || 'Could not start', 'error'); } finally { setBusy(''); }
  };
  const keepLinks = async () => {
    if (!lists) return; const fresh = links.filter(u => !lists.sources.some(s => s.url.replace(/\/$/, '') === u.replace(/\/$/, '')));
    if (!fresh.length) { notice('Those links are already saved'); return; }
    if (await save({ sources: [...lists.sources, ...fresh.map(url => ({ id: '', url, proto, enabled: true }))] }, `${fresh.length} link(s) saved. Every search downloads them.`)) setText(text.split(/[\r\n]+/).filter(l => !fresh.includes(l.trim())).join('\n'));
  };
  const test = async (url: string, p: Proto) => {
    setBusy('test:' + url); setPreview(null);
    try { setPreview({ url, ...(await api('/admin/proxies/sources/test', { url, proto: p })) }); } catch (e: any) { setPreview({ url, count: 0, byProtocol: {}, error: e?.message || 'Could not download it' }); } finally { setBusy(''); }
  };
  const add = async () => {
    const url = newUrl.trim(); if (!url || !lists) return;
    if (await save({ sources: [...lists.sources, { id: '', url, proto: newProto, enabled: true }] }, 'List link saved. Every search downloads it.')) { setNewUrl(''); setPreview(null); }
  };
  const update = (id: string, patch: Partial<ProxySource>, done: string) => lists && void save({ sources: lists.sources.map(s => s.id === id ? { ...s, ...patch } : s) }, done);
  return <div className="proxy-lists">
    <div className="section-block form-section">
      <h3>Check a list now</h3>
      <p className="muted">Paste proxies, links to lists, or both. Proxies can be <code>ip:port</code>, <code>socks5://ip:port</code>, <code>user:password@ip:port</code> or <code>ip:port:user:password</code>; web pages with a table and JSON lists work too. Only proxies that reach the OpenCode API in time are kept.</p>
      <textarea aria-label="Proxies or links to lists" rows={6} className="mono" spellCheck={false} value={text} onChange={e => setText(e.target.value)} placeholder={'1.2.3.4:8080\nsocks5://user:password@5.6.7.8:1080\nhttps://example.com/proxies/socks5.txt'} />
      <div className="form-actions proxy-list-actions">
        <span className="plain-type">A plain ip:port is <Select aria-label="What a plain ip:port is" value={proto} onChange={v => setProto(v as Proto)}>{PROTOS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></span>
        <Button onClick={() => files.current?.click()}><Download size={15} />Load file(s)</Button>
        <input ref={files} hidden type="file" multiple accept=".txt,.csv,.list,.json,.html,.htm" onChange={async e => { const picked = [...(e.target.files || [])]; e.target.value = ''; if (picked.length) setText([text, ...(await Promise.all(picked.map(f => f.text())))].filter(Boolean).join('\n')); }} />
        <span className="toolbar-spacer" />
        {links.length > 0 && <Button disabled={!!busy || !lists} onClick={() => void keepLinks()} title="Keep these links: every Find working proxies run downloads them"><Save size={15} />Save {links.length} link{links.length > 1 ? 's' : ''} for every search</Button>}
        <Button variant="primary" disabled={!text.trim() || !!busy || disabled} onClick={() => void check()}>{busy === 'check' ? <Loader2 size={15} className="spin" /> : <Zap size={15} />}Check these now</Button>
      </div>
    </div>
    <div className="section-block form-section">
      <h3>List links for every search</h3>
      <p className="muted">"Find working proxies" downloads these lists, then the built-in public ones. Yours are checked first.</p>
      {lists ? <>
        <Toggle checked={lists.builtin} onChange={v => void save({ builtin: v }, v ? 'Public lists on' : 'Public lists off: only your links are searched')} label={`Also search the ${lists.builtinCount} built-in public lists`} detail={lists.builtin ? 'Free lists published on GitHub and by proxy sites.' : 'Off: only your own links are downloaded.'} />
        {lists.sources.length > 0 && <ul className="source-list">{lists.sources.map(s => <li key={s.id} className={s.enabled ? '' : 'off'}>
          <input type="checkbox" role="switch" aria-label={`Use ${s.url}`} checked={s.enabled} disabled={!!busy} onChange={e => update(s.id, { enabled: e.target.checked }, e.target.checked ? 'Link on' : 'Link off')} />
          <div className="source-text"><span className="source-url" title={s.url}>{s.label || s.url}</span>
            <small className="subtle"><span className="protocol">{protoLabel(s.proto)}</span> {s.lastAt ? s.lastError && !s.lastCount ? <span className="bad-text"><AlertCircle size={12} /> {s.lastError} · {when(s.lastAt)}</span> : <span><CheckCircle2 size={12} /> {s.lastCount?.toLocaleString()} addresses · {when(s.lastAt)}</span> : 'Not downloaded yet'}</small></div>
          <Select aria-label={`Type of ${s.url}`} value={s.proto} onChange={v => update(s.id, { proto: v as Proto }, 'Type changed')}>{PROTOS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
          <Button disabled={!!busy} onClick={() => void test(s.url, s.proto)} title="Download it now and count what is inside">{busy === 'test:' + s.url ? <Loader2 size={13} className="spin" /> : <Link2 size={13} />}Test</Button>
          <button className="icon-button" aria-label={`Remove ${s.url}`} disabled={!!busy} onClick={() => { if (confirm(`Remove ${s.url}?`)) void save({ sources: lists.sources.filter(x => x.id !== s.id) }, 'Link removed'); }}><Trash2 size={14} /></button>
        </li>)}</ul>}
        <div className="source-add">
          <Select aria-label="Type of the new list" value={newProto} onChange={v => setNewProto(v as Proto)}>{PROTOS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
          <input aria-label="Link to a proxy list" inputMode="url" placeholder="https://example.com/proxies/socks5.txt" value={newUrl} onChange={e => { setNewUrl(e.target.value); setPreview(null); }} onKeyDown={e => { if (e.key === 'Enter') void add(); }} />
          <Button disabled={!newUrl.trim() || !!busy} onClick={() => void test(newUrl.trim(), newProto)}>{busy === 'test:' + newUrl.trim() ? <Loader2 size={14} className="spin" /> : <Link2 size={14} />}Test</Button>
          <Button variant="primary" disabled={!newUrl.trim() || !!busy} onClick={() => void add()}><Plus size={14} />Add link</Button>
        </div>
        {preview && <div className={`dialog-note ${preview.count ? 'good' : 'warn'}`} role="status">{preview.count ? <Check size={16} /> : <AlertCircle size={16} />}<p>{preview.count ? `${preview.count.toLocaleString()} proxies to try in it (${Object.entries(preview.byProtocol).map(([p, n]) => `${n.toLocaleString()} as ${p}`).join(', ')}).` : preview.error || 'No proxy addresses in it.'} <span className="subtle source-url">{preview.url}</span></p></div>}
      </> : loadFailed ? <p className="subtle">Could not load your saved links. <button className="text-button" onClick={loadLists}>Try again</button></p> : <p className="subtle"><Loader2 size={14} className="spin" /> Loading…</p>}
    </div>
  </div>;
}

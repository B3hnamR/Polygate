import { useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Eye, ListOrdered, Pencil, Plus, Terminal, Trash2, X } from 'lucide-react';
import { RoutePreview } from './route-preview';
import { api } from './api';
import { Badge, Button, Empty, Field, Select, Toggle, time, type Snapshot } from './ui';
import { Dialog } from './mcp';
import type { Chain } from '../backend/types';

type Draft = { id?: string; name: string; description: string; models: string[]; enabled: boolean };
export const AUTO_LABEL: Record<string, string> = { auto: 'Auto · best available', 'auto:smart': 'Auto · coding / reasoning', 'auto:fast': 'Auto · low latency' };
// Starting points for a first chain: the auto choices in an order that falls back to something that works.
const STARTERS: { title: string; blurb: string; draft: Draft }[] = [
  { title: 'Smart first, then anything', blurb: 'Reasoning and coding models first. If none can answer, whatever is ready.', draft: { name: 'my-coding', description: 'Coding models first, then anything ready.', models: ['auto:smart', 'auto'], enabled: true } },
  { title: 'Fastest first', blurb: 'The quickest models first, then the smart ones.', draft: { name: 'my-fast', description: 'Quick answers first.', models: ['auto:fast', 'auto:smart'], enabled: true } },
];
const toDraft = (c: Chain): Draft => ({ id: c.id, name: c.name, description: c.description || '', models: c.models, enabled: c.enabled });
// How a step looks right now, from the catalog the dashboard already has.
export function stepStatus(step: string, data: Snapshot): { state: string; text: string } {
  if (AUTO_LABEL[step]) return { state: 'neutral', text: 'Chosen when asked' };
  const m = data.models.find(x => x.id === step || x.upstreamId === step);
  if (!m) return { state: 'unavailable', text: 'Not in the catalog' };
  if (!data.settings.providers.some(p => p.id === m.providerId && p.enabled)) return { state: 'cooldown', text: 'Provider is off' };
  if (m.state === 'unavailable') return { state: 'unavailable', text: 'Unavailable' };
  if (m.cooldownUntil > Date.now()) return { state: 'cooldown', text: `Resting until ${time(m.cooldownUntil)}` };
  return { state: 'available', text: 'Ready' };
}
function ChainDialog({ initial, data, onClose, onSaved }: { initial: Draft; data: Snapshot; onClose: () => void; onSaved: (c: Chain) => void }) {
  const [d, setD] = useState(initial); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const editing = !!initial.id; const steps = d.models;
  const setSteps = (models: string[]) => { setD({ ...d, models }); setError(''); };
  const move = (i: number, by: number) => { const next = [...steps]; [next[i], next[i + by]] = [next[i + by], next[i]]; setSteps(next); };
  const models = [...data.models].sort((a, b) => a.id.localeCompare(b.id));
  async function save() {
    setBusy(true); setError('');
    try { const r: any = await api('/admin/chains/save', { id: d.id, name: d.name, description: d.description, enabled: d.enabled, models: steps.filter(Boolean) }); onSaved(r.chain); }
    catch (e: any) { setError(e?.message || 'Not saved'); } finally { setBusy(false); }
  }
  return <Dialog title={editing ? `Edit ${initial.name}` : 'New chain'} icon={<ListOrdered size={18} />} onClose={onClose} busy={busy} wide>
    <Field label="Name" hint="This is what a client puts in its model setting, for example my-coding."><input value={d.name} maxLength={40} placeholder="my-coding" onChange={e => { setD({ ...d, name: e.target.value }); setError(''); }} /></Field>
    <Field label="Note (optional)"><input value={d.description} maxLength={200} placeholder="What this chain is for" onChange={e => setD({ ...d, description: e.target.value })} /></Field>
    <div className="chain-editor"><span className="pairs-label">Models, in the order they are tried</span>
      {steps.map((step, i) => <div className="chain-edit-row" key={i}>
        <span className="chain-number">{i + 1}</span>
        <Select aria-label={`Step ${i + 1}`} value={step} onChange={v => setSteps(steps.map((s, j) => j === i ? v : s))}>
          <option value="" disabled>Choose a model…</option>
          {Object.entries(AUTO_LABEL).map(([id, label]) => <option key={id} value={id} disabled={steps.includes(id) && step !== id}>{label}</option>)}
          {step && !AUTO_LABEL[step] && !models.some(m => m.id === step) && <option value={step}>{step} (not in the catalog)</option>}
          {models.map(m => <option key={m.id} value={m.id} disabled={steps.includes(m.id) && step !== m.id}>{m.id}</option>)}
        </Select>
        <button type="button" className="icon-button" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></button>
        <button type="button" className="icon-button" aria-label={`Move step ${i + 1} down`} disabled={i === steps.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></button>
        <button type="button" className="icon-button" aria-label={`Remove step ${i + 1}`} onClick={() => setSteps(steps.filter((_, j) => j !== i))}><X size={14} /></button>
      </div>)}
      <button type="button" className="text-button" disabled={steps.length >= 8} onClick={() => setSteps([...steps, ''])}><Plus size={13} />Add a model</button>
      <small className="subtle">Polygate asks the first model. If it is resting, refuses the request or is full, it moves to the next. A request the client got wrong (a 400) is not retried elsewhere. Up to 8 steps.</small>
    </div>
    <Toggle checked={d.enabled} onChange={enabled => setD({ ...d, enabled })} label="Chain is on" detail="A chain that is off is not listed and answers 404." />
    {error && <div className="dialog-note error" role="alert"><p>{error}</p></div>}
    <div className="dialog-actions"><Button variant="primary" disabled={busy || !d.name.trim() || !steps.some(Boolean)} onClick={() => void save()}>{busy ? 'Saving…' : 'Save chain'}</Button><Button disabled={busy} onClick={onClose}>Cancel</Button></div>
  </Dialog>;
}
function ChainCard({ c, data, copy, onEdit, onToggle, onDelete, onTry, onPreview }: { onPreview: () => void; c: Chain; data: Snapshot; copy: (s: string) => void; onEdit: () => void; onToggle: (v: boolean) => void; onDelete: () => void; onTry: () => void }) {
  return <article className={`chain-card${c.enabled ? '' : ' off'}`} aria-label={`Chain ${c.name}`}>
    <header className="chain-head">
      <div className="chain-title"><code className="chain-name">{c.name}</code><button className="icon-button" aria-label={`Copy ${c.name}`} title="Copy the model name" onClick={() => copy(c.name)}><Copy size={13} /></button>{!c.enabled && <span className="mcp-tag">off</span>}</div>
      <span className="toolbar-spacer" />
      <input type="checkbox" role="switch" aria-label={`${c.name} is on`} title={c.enabled ? 'Switch off' : 'Switch on'} checked={c.enabled} onChange={e => onToggle(e.target.checked)} />
    </header>
    {c.description && <p className="subtle">{c.description}</p>}
    <ol className="chain-steps">{c.models.map((step, i) => { const s = stepStatus(step, data); return <li key={step}><span className="chain-number">{i + 1}</span><span className="chain-step-name truncate" title={step}>{AUTO_LABEL[step] || step}</span><Badge state={s.state}>{s.text}</Badge></li>; })}</ol>
    <footer className="chain-actions"><Button onClick={onTry}><Terminal size={14} />Try it</Button><Button onClick={onPreview}><Eye size={14} />Preview routing</Button><Button onClick={onEdit}><Pencil size={14} />Edit</Button><Button onClick={onDelete}><Trash2 size={14} />Delete</Button></footer>
  </article>;
}
export function ChainsPage({ data, copy, notice, refresh, tryChain }: { data: Snapshot; copy: (s: string) => void; notice: (m: string, kind?: 'ok' | 'error') => void; refresh: () => void; tryChain: (name: string) => void }) {
  const chains = data.settings.chains || []; const [editing, setEditing] = useState<Draft | null>(null); const [preview, setPreview] = useState<string | null>(null);
  const blank = (): Draft => ({ name: '', description: '', models: [''], enabled: true });
  async function toggle(c: Chain, enabled: boolean) { try { await api('/admin/chains/save', { ...c, enabled }); notice(enabled ? `${c.name} is on` : `${c.name} is off`); refresh(); } catch (e: any) { notice(e?.message || 'Not saved', 'error'); } }
  async function remove(c: Chain) { if (!confirm(`Delete the chain "${c.name}"? Clients that ask for it will get a 404.`)) return; try { await api('/admin/chains/delete', { id: c.id }); notice(`${c.name} deleted`); refresh(); } catch (e: any) { notice(e?.message || 'Not deleted', 'error'); } }
  return <>
    {preview && <RoutePreview data={data} model={preview} onClose={() => setPreview(null)} />}
    <section className="section-block form-section" aria-labelledby="chains-heading">
      <div className="section-toolbar"><div><h2 id="chains-heading">Model chains</h2><p className="subtle">A chain is a model name you define. Ask for it and Polygate tries its models in your order, moving on when one is resting, refuses the request or is full.</p></div><span className="toolbar-spacer" /><Button onClick={() => setPreview('auto')}><Eye size={14} />Preview routing</Button><Button variant="primary" onClick={() => setEditing(blank())}><Plus size={14} />New chain</Button></div>
      <div className="dialog-note info"><p>Put the chain's name where your tool asks for a model, for example <code>my-coding</code>. The answer says which model replied (the <code>x-polygate-model</code> header) and which were skipped (<code>x-polygate-skipped</code>); the Logs page shows it too.</p></div>
    </section>
    {chains.length ? <section className="chain-list" aria-label="Your chains">{chains.map(c => <ChainCard key={c.id} c={c} data={data} copy={copy} onEdit={() => setEditing(toDraft(c))} onToggle={v => void toggle(c, v)} onDelete={() => void remove(c)} onPreview={() => setPreview(c.name)} onTry={() => tryChain(c.name)} />)}</section>
      : <section className="section-block"><Empty icon={ListOrdered} title="No chains yet">Start from one of these, or press New chain and pick your own models.</Empty>
        <div className="mcp-presets"><div className="mcp-preset-grid">{STARTERS.map(s => <button key={s.title} className="mcp-preset" onClick={() => setEditing(s.draft)}><span className="mcp-preset-head"><ListOrdered size={15} /><strong>{s.title}</strong></span><span className="subtle">{s.blurb}</span></button>)}</div></div></section>}
    {editing && <ChainDialog initial={editing} data={data} onClose={() => setEditing(null)} onSaved={c => { setEditing(null); notice(`${c.name} saved`); refresh(); }} />}
  </>;
}

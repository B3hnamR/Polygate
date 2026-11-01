import { useState } from 'react';
import { Check, ListChecks } from 'lucide-react';
import { Button, type CheckItem, type Snapshot } from './ui';

// The recovery checklist: what is wrong, what it means, and the fix. The gateway works the list out from its current state on every look, so an item
// stays until its cause is gone. Items that go away while this page is open stay on the list marked as resolved (until dismissed), so it is clear that
// a fix worked; the others remain. A warning can be acknowledged: the gateway then leaves it off the list until its text changes (a new reset time,
// another error), and "Show again" brings every acknowledged one back. What stops requests cannot be acknowledged away.
type Seen = { item: CheckItem; resolvedAt?: number };
const seen = new Map<string, Seen>();
const acked = new Set<string>();
const KEEP_RESOLVED_MS = 30 * 60 * 1000;

export function RecoveryChecklist({ data, act, go }: { data: Snapshot; act: (name: string, path: string, body?: unknown, success?: string) => Promise<boolean>; go: (page: string) => void }) {
  const [, again] = useState(0); const [working, setWorking] = useState('');
  const items = data.ready?.checklist || []; const now = Date.now(); const current = new Set(items.map(i => i.id)); const hidden = data.ready?.acknowledged || 0;
  for (const i of items) seen.set(i.id, { item: i });
  // An acknowledged item left the list because of that, not because it was fixed: it is not shown as resolved.
  for (const [id, s] of seen) { if (!current.has(id)) { if (acked.has(id)) { seen.delete(id); acked.delete(id); continue; } s.resolvedAt ??= now; if (now - s.resolvedAt > KEEP_RESOLVED_MS) seen.delete(id); } }
  const resolved = [...seen.values()].filter(s => s.resolvedAt);
  // Everything left is acknowledged: one quiet line, so they can still be brought back.
  if (!items.length && !resolved.length) return hidden ? <p className="subtle recovery-hidden"><ListChecks size={15} /> {hidden} acknowledged checklist {hidden === 1 ? 'alert is' : 'alerts are'} hidden. <button type="button" className="text-button inline" onClick={() => void act('ack:clear', '/admin/checklist/ack', { clear: true }, 'Acknowledged alerts are shown again')}>Show again</button></p> : null;
  const blocking = items.filter(i => i.severity === 'blocking').length;
  async function fix(i: CheckItem) { if (!i.fix) return; setWorking(i.id); try { await act('fix:' + i.id, i.fix.endpoint, i.fix.body || {}, `${i.fix.label}: done`); } finally { setWorking(''); } }
  async function acknowledge(i: CheckItem) { setWorking('ack:' + i.id); acked.add(i.id); try { if (!await act('ack:' + i.id, '/admin/checklist/ack', { id: i.id }, 'Acknowledged: hidden until it changes')) acked.delete(i.id); } finally { setWorking(''); again(n => n + 1); } }
  return <section className="section-block recovery" aria-labelledby="recovery-heading">
    <div className="section-top"><div><h2 id="recovery-heading"><ListChecks size={18} /> Recovery checklist</h2>
      <p className="subtle">{items.length ? (blocking ? `${blocking} thing${blocking > 1 ? 's' : ''} stop${blocking > 1 ? '' : 's'} requests` : 'Requests can go through, but some things need a look') + '. Nothing here changes your settings by itself.' : 'Everything on this list is fixed.'}
        {hidden > 0 && <> {hidden} acknowledged {hidden === 1 ? 'alert is' : 'alerts are'} hidden. <button type="button" className="text-button inline" disabled={!!working} onClick={() => void act('ack:clear', '/admin/checklist/ack', { clear: true }, 'Acknowledged alerts are shown again')}>Show again</button></>}</p></div></div>
    <div className="table-wrap"><table><thead><tr><th>Problem</th><th>What it means</th><th>Action</th></tr></thead>
      <tbody>{items.map(i => <tr key={i.id} className={i.severity}>
        <td><span className={`sev ${i.severity}`}>{i.severity === 'blocking' ? 'Stops requests' : 'Affects some'}</span><strong>{i.title}</strong></td>
        <td>{i.detail}</td>
        <td className="recovery-actions">{i.fix && <Button variant="primary" disabled={!!working} onClick={() => void fix(i)}>{working === i.id ? 'Working…' : i.fix.label}</Button>}<button type="button" className="text-button" onClick={() => go(i.page)}>Open {i.page}</button>
          {i.severity === 'warning' && <button type="button" className="text-button" disabled={!!working} title="Hide this alert until it changes" onClick={() => void acknowledge(i)}><Check size={14} />Acknowledge</button>}</td>
      </tr>)}
      {resolved.map(s => <tr key={s.item.id} className="resolved"><td><Check size={15} aria-hidden="true" /> <span className="resolved-title">{s.item.title}</span></td><td>Resolved</td><td className="recovery-actions"><button type="button" className="text-button" onClick={() => { seen.delete(s.item.id); again(n => n + 1); }}>Dismiss</button></td></tr>)}</tbody></table></div>
  </section>;
}

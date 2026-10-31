import { useState } from 'react';
import { Check, ListChecks } from 'lucide-react';
import { Button, type CheckItem, type Snapshot } from './ui';

// The recovery checklist: what is wrong, what it means, and the fix. The gateway works the list out from its current state on every look, so an item
// stays until its cause is gone. Items that go away while this page is open stay on the list marked as resolved (until dismissed), so it is clear that
// a fix worked; the others remain.
type Seen = { item: CheckItem; resolvedAt?: number };
const seen = new Map<string, Seen>();
const KEEP_RESOLVED_MS = 30 * 60 * 1000;

export function RecoveryChecklist({ data, act, go }: { data: Snapshot; act: (name: string, path: string, body?: unknown, success?: string) => Promise<boolean>; go: (page: string) => void }) {
  const [, again] = useState(0); const [working, setWorking] = useState('');
  const items = data.ready?.checklist || []; const now = Date.now(); const current = new Set(items.map(i => i.id));
  for (const i of items) seen.set(i.id, { item: i });
  for (const [id, s] of seen) { if (!current.has(id)) { s.resolvedAt ??= now; if (now - s.resolvedAt > KEEP_RESOLVED_MS) seen.delete(id); } }
  const resolved = [...seen.values()].filter(s => s.resolvedAt);
  if (!items.length && !resolved.length) return null;
  const blocking = items.filter(i => i.severity === 'blocking').length;
  async function fix(i: CheckItem) { if (!i.fix) return; setWorking(i.id); try { await act('fix:' + i.id, i.fix.endpoint, i.fix.body || {}, `${i.fix.label}: done`); } finally { setWorking(''); } }
  return <section className="section-block recovery" aria-labelledby="recovery-heading">
    <div className="section-top"><div><h2 id="recovery-heading"><ListChecks size={18} /> Recovery checklist</h2>
      <p className="subtle">{items.length ? (blocking ? `${blocking} thing${blocking > 1 ? 's' : ''} stop${blocking > 1 ? '' : 's'} requests` : 'Requests can go through, but some things need a look') + '. Nothing here changes your settings by itself.' : 'Everything on this list is fixed.'}</p></div></div>
    <div className="table-wrap"><table><thead><tr><th>Problem</th><th>What it means</th><th>Action</th></tr></thead>
      <tbody>{items.map(i => <tr key={i.id} className={i.severity}>
        <td><span className={`sev ${i.severity}`}>{i.severity === 'blocking' ? 'Stops requests' : 'Affects some'}</span><strong>{i.title}</strong></td>
        <td>{i.detail}</td>
        <td className="recovery-actions">{i.fix && <Button variant="primary" disabled={!!working} onClick={() => void fix(i)}>{working === i.id ? 'Working…' : i.fix.label}</Button>}<button type="button" className="text-button" onClick={() => go(i.page)}>Open {i.page}</button></td>
      </tr>)}
      {resolved.map(s => <tr key={s.item.id} className="resolved"><td><Check size={15} aria-hidden="true" /> <span className="resolved-title">{s.item.title}</span></td><td>Resolved</td><td className="recovery-actions"><button type="button" className="text-button" onClick={() => { seen.delete(s.item.id); again(n => n + 1); }}>Dismiss</button></td></tr>)}</tbody></table></div>
  </section>;
}

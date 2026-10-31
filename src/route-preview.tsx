import { useEffect, useState } from 'react';
import { Eye, TriangleAlert } from 'lucide-react';
import { api } from './api';
import { Dialog } from './mcp';
import { Button, Field, Select, Toggle, type Snapshot } from './ui';

// Preview routing: which models a request would try, in order, and why each was skipped. Nothing is sent to a model.
type Step = { model: string; provider: string; status: 'try' | 'backup' | 'skip' | 'later'; reason: string; via?: string; from?: string };
type Plan = { request: string; kind: string; key: string | null; needs: { tools: boolean; images: boolean; tokens: number }; steps: Step[]; notes: string[]; summary: string; sent: false };
const LABEL = { try: 'Tried first', backup: 'Backup', skip: 'Skipped', later: 'Not reached' } as const;
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// With `request` (the Playground's), the preview is about that very request: its key, its conversation, its tools and images. Without it the person says what to ask about.
export function RoutePreview({ data, model: first = 'auto', tools: firstTools = false, request, keyId: firstKey = '', onClose }: { data: Snapshot; model?: string; tools?: boolean; request?: { protocol: string; body: unknown }; keyId?: string; onClose: () => void }) {
  const [model, setModel] = useState(first); const [keyId, setKeyId] = useState(firstKey); const [tools, setTools] = useState(firstTools); const [images, setImages] = useState(false); const [tokens, setTokens] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function run() {
    setBusy(true); setError('');
    try { setPlan(await api('/admin/route-preview', { model, keyId: keyId || undefined, ...(request ? { request: { ...(request.body as object), model }, protocol: request.protocol } : { tools, images, tokens: tokens ? Number(tokens) : undefined }) })); }
    catch (e: any) { setError(e?.message || 'Could not work out the route'); }
    finally { setBusy(false); }
  }
  useEffect(() => { void run(); /* a first look when it opens */ }, []);
  const chains = data.settings.chains || []; const known = data.models.filter(m => m.state !== 'unavailable').map(m => m.id);
  return <Dialog title="Preview routing" icon={<Eye size={18} />} onClose={onClose} busy={busy} wide>
    <p className="subtle">See which models a request would try and why, before anything is sent. Nothing is sent to a model, so no allowance is used.</p>
    <div className="form-grid">
      <Field label="Request for"><Select value={model} onChange={setModel}><option value="auto">auto</option><option value="auto:smart">auto:smart</option><option value="auto:fast">auto:fast</option>{chains.map(c => <option key={c.id} value={c.name}>{c.name} (chain)</option>)}{known.map(id => <option key={id} value={id}>{id}</option>)}</Select></Field>
      <Field label="Client key" hint="A key can be limited to some models."><Select value={keyId} onChange={setKeyId}><option value="">No key: skip the permission check</option>{data.settings.keys.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}</Select></Field>
    </div>
    {request ? <p className="subtle">Based on the request being composed in the Playground: its conversation, tools and images. {plan ? `It needs${plan.needs.tools ? ' tools,' : ''}${plan.needs.images ? ' image input,' : ''} about ${plan.needs.tokens.toLocaleString()} tokens of context.` : ''}</p> : <div className="preview-needs">
      <Toggle checked={tools} onChange={setTools} label="The request uses tools" detail="Coding assistants send tools so the model can read files and run commands." />
      <Toggle checked={images} onChange={setImages} label="The request includes an image" />
      <Field label="Prompt size in tokens (optional)" hint="Models whose context is smaller are skipped. Leave empty if you do not know."><input type="number" min="0" max="5000000" inputMode="numeric" value={tokens} onChange={e => setTokens(e.target.value)} placeholder="e.g. 30000" /></Field>
    </div>}
    <div className="dialog-actions"><Button variant="primary" disabled={busy} onClick={() => void run()}><Eye size={14} />{busy ? 'Working it out…' : 'Preview routing'}</Button><Button onClick={onClose}>Close</Button></div>
    {error && <div className="dialog-note error" role="alert"><TriangleAlert size={16} /><p>{error}</p></div>}
    {plan && <div className="preview-result" aria-live="polite">
      <p className="preview-summary"><strong>{plan.summary}</strong>{plan.key ? <small className="subtle"> Client key: {plan.key}.</small> : null}</p>
      {plan.notes.map(n => <div className="dialog-note" key={n}><TriangleAlert size={16} /><p>{n}</p></div>)}
      <ol className="preview-steps">{plan.steps.map((s, i) => <li key={i} className={`preview-step ${s.status}`}>
        <span className={`preview-chip ${s.status}`}>{LABEL[s.status]}</span>
        <div><strong className="mono">{s.model}</strong>{s.from && <small className="subtle"> from {s.from}</small>}<small className="subtle"> · {s.provider}</small>
          <p>{sentence(s.reason)}{s.via && (s.status === 'try' || s.status === 'backup') ? `. Would be sent through ${s.via}.` : '.'}</p></div>
      </li>)}</ol>
      <p className="subtle fine-print">No model request was sent. This is the plan from your current settings and the health Polygate already knows; it does not prove the provider will accept the next real request.</p>
    </div>}
  </Dialog>;
}

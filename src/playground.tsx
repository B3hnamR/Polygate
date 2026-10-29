import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Brain, BookmarkPlus, Code2, Columns2, Copy, Eraser, Loader2, RotateCcw, Send, Square, Terminal, Trash2, Wrench } from 'lucide-react';
import { at, BASE } from './api';
import { Button, Empty, Field, Select, Toggle, ms, type Snapshot } from './ui';
import { Dialog } from './mcp';
import { AUTO_LABEL } from './chains';

export type Protocol = 'chat' | 'responses' | 'anthropic';
type Stats = { model: string; route: string; chain: string; skipped: string; firstMs: number; totalMs: number; input: number; output: number; estimated: boolean };
type Turn = { role: 'user' | 'assistant'; content: string; reasoning?: string; tools?: { name: string; args: string }[]; stats?: Stats; error?: string; raw?: string };
type Params = { temperature: string; topP: string; maxTokens: number; tool: boolean; json: boolean };
type Pane = { id: number; model: string; turns: Turn[]; running: boolean };
const DEFAULTS: Params = { temperature: '', topP: '', maxTokens: 1024, tool: false, json: false };
const SAMPLE_TOOL = { type: 'function', function: { name: 'get_weather', description: 'Get the current weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } };
const QUICK: { label: string; prompt: string; tool?: boolean }[] = [
  { label: 'Hello', prompt: 'Say hello in five words.' },
  { label: 'Code', prompt: 'Write a TypeScript function that returns the n-th Fibonacci number, then explain it in two sentences.' },
  { label: 'Reasoning', prompt: 'A bat and a ball cost $1.10 together. The bat costs $1.00 more than the ball. How much is the ball? Explain briefly.' },
  { label: 'Long answer', prompt: 'Write about 400 words on why the sky is blue.' },
  { label: 'Tool call', prompt: "What's the weather in Paris?", tool: true },
];
const STORE = 'polygate-playground'; const PROMPTS = 'polygate-playground-prompts';
const load = <T,>(key: string, fallback: T): T => { try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch { return fallback; } };
const keep = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window or blocked storage */ } };
const number = (s: string) => s.trim() === '' || !Number.isFinite(Number(s)) ? undefined : Number(s);
const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

// What is sent for the conversation so far, in the shape of the protocol the user picked.
export function buildRequest(protocol: Protocol, model: string, system: string, history: { role: string; content: string }[], p: Params, stream: boolean) {
  const t = number(p.temperature), tp = number(p.topP); const sampling = { ...(t !== undefined && { temperature: t }), ...(tp !== undefined && { top_p: tp }) };
  if (protocol === 'responses') return { path: 'responses', body: { model, input: history, ...(system && { instructions: system }), stream, max_output_tokens: p.maxTokens, ...sampling } };
  if (protocol === 'anthropic') return { path: 'messages', body: { model, messages: history, ...(system && { system }), max_tokens: p.maxTokens, stream, ...sampling } };
  return { path: 'chat/completions', body: { model, messages: [...(system ? [{ role: 'system', content: system }] : []), ...history], max_tokens: p.maxTokens, stream, ...sampling, ...(p.tool && { tools: [SAMPLE_TOOL] }), ...(p.json && { response_format: { type: 'json_object' } }) } };
}
// Sends one request through the real gateway and reports the answer as it grows. Text, reasoning and tool calls are read from
// whichever protocol answered; token counts come from the answer when it has them and are estimated (about 4 characters each) when not.
async function execute(path: string, body: any, apiKey: string, signal: AbortSignal, onTurn: (t: Turn) => void) {
  const start = performance.now(); let first = 0; let usage = { input: 0, output: 0 }; let raw = '';
  const turn: Turn = { role: 'assistant', content: '' }; const push = () => onTurn({ ...turn, tools: turn.tools?.map(t => ({ ...t })) });
  const r = await fetch(at('/v1/' + path), { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey }, body: JSON.stringify(body), signal });
  if (!r.ok) { const text = await r.text(); let e: any; try { e = JSON.parse(text); } catch { /* an HTML error page from a proxy */ } throw new Error((typeof e?.error === 'string' ? e.error : e?.error?.message) || `Request failed (HTTP ${r.status})`); }
  const head = (n: string) => r.headers.get(n) || '';
  const add = (field: 'content' | 'reasoning', text: string) => { if (!text) return; if (!first) first = performance.now(); turn[field] = (turn[field] || '') + text; push(); };
  const tally = (u: any) => { if (!u) return; usage = { input: u.prompt_tokens ?? u.input_tokens ?? usage.input, output: u.completion_tokens ?? u.output_tokens ?? usage.output }; };
  const event = (e: any) => {
    if (e.error) throw new Error(typeof e.error === 'string' ? e.error : e.error.message || 'Request failed');
    const d = e.choices?.[0]?.delta;
    if (d) { add('content', d.content); add('reasoning', d.reasoning_content || d.reasoning);
      for (const t of d.tool_calls || []) { turn.tools ||= []; const cur = turn.tools[t.index ?? 0] ||= { name: '', args: '' }; cur.name += t.function?.name || ''; cur.args += t.function?.arguments || ''; if (!first) first = performance.now(); push(); } }
    tally(e.usage); tally(e.response?.usage); tally(e.type === 'message_start' ? e.message?.usage : e.type === 'message_delta' ? e.usage : undefined);
    if (e.type === 'response.output_text.delta') add('content', e.delta);
    if (e.type === 'response.reasoning_summary_text.delta' || e.type === 'response.reasoning_text.delta') add('reasoning', e.delta);
    if (e.type === 'content_block_delta') { if (e.delta?.type === 'text_delta') add('content', e.delta.text); if (e.delta?.type === 'thinking_delta') add('reasoning', e.delta.thinking); }
  };
  if (body.stream) {
    const reader = r.body!.getReader(); const decoder = new TextDecoder(); let buffer = '';
    // CRLF framing is normalised, and an event left without a closing blank line when the stream ends is still read.
    const consume = (block: string) => { for (const line of block.split('\n')) if (line.startsWith('data:')) { try { event(JSON.parse(line.slice(5))); } catch (err) { if (!(err instanceof SyntaxError)) throw err; } } };
    for (;;) { const x = await reader.read(); if (x.done) break; const chunk = decoder.decode(x.value, { stream: true }); if (raw.length < 200000) raw += chunk; buffer = (buffer + chunk).replace(/\r\n/g, '\n'); let i; while ((i = buffer.indexOf('\n\n')) >= 0) { consume(buffer.slice(0, i)); buffer = buffer.slice(i + 2); } }
    buffer += decoder.decode(); if (buffer.trim()) consume(buffer.replace(/\r\n/g, '\n'));
  } else {
    const x: any = await r.json(); raw = JSON.stringify(x, null, 2); first = performance.now(); tally(x.usage);
    const m = x.choices?.[0]?.message; const blocks = (type: string, pick: (b: any) => string) => (x.content || []).filter((c: any) => c.type === type).map(pick).join('') || undefined;
    if (m) { turn.content = m.content || ''; turn.reasoning = m.reasoning_content || m.reasoning || undefined; if (m.tool_calls?.length) turn.tools = m.tool_calls.map((t: any) => ({ name: t.function?.name || '', args: t.function?.arguments || '' })); }
    else if (Array.isArray(x.content)) { turn.content = blocks('text', c => c.text) || ''; turn.reasoning = blocks('thinking', c => c.thinking); }
    else if (Array.isArray(x.output)) { turn.content = x.output.filter((o: any) => o.type === 'message').flatMap((o: any) => o.content || []).map((c: any) => c.text || '').join(''); turn.reasoning = x.output.filter((o: any) => o.type === 'reasoning').flatMap((o: any) => o.summary || []).map((c: any) => c.text || '').join('') || undefined; }
  }
  const total = performance.now() - start; const estimated = !usage.output; const written = (turn.content || '') + (turn.reasoning || '') + (turn.tools || []).map(t => t.name + t.args).join('');
  turn.stats = { model: head('x-polygate-model'), route: decode(head('x-polygate-route')), chain: head('x-polygate-chain'), skipped: decode(head('x-polygate-skipped')), firstMs: first ? first - start : total, totalMs: total,
    input: usage.input || Math.ceil(JSON.stringify(body.messages || body.input).length / 4), output: usage.output || Math.ceil(written.length / 4), estimated };
  turn.raw = raw; onTurn({ ...turn });
}
const copyText = async (text: string, notice?: (m: string, kind?: 'ok' | 'error') => void) => { try { await navigator.clipboard.writeText(text); notice?.('Copied to clipboard'); } catch { notice?.('Clipboard unavailable. Select and copy the text.', 'error'); } };
const modelOptions = (data: Snapshot) => <>
  {Object.entries(AUTO_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
  {(data.settings.chains || []).filter(c => c.enabled).map(c => <option key={'chain-' + c.id} value={c.name}>{'Chain · ' + c.name}</option>)}
  {data.models.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}
</>;
// The request as a client would send it, with a placeholder key, in three common forms.
function ExportDialog({ request, onClose, notice }: { request: { path: string; body: unknown }; onClose: () => void; notice: (m: string, kind?: 'ok' | 'error') => void }) {
  const [tab, setTab] = useState<'curl' | 'python' | 'javascript' | 'body'>('curl');
  const url = location.origin + BASE + '/v1/' + request.path; const json = JSON.stringify(request.body, null, 2);
  // An apostrophe only occurs inside a JSON string, where its unicode escape (backslash, u, 0027) means the same thing: it keeps shell and Python quoting from breaking on the prompt.
  const safe = json.replace(/'/g, '\\u0027');
  const code = { curl: `curl ${url} \\\n  -H "Authorization: Bearer pg_your_key" \\\n  -H "Content-Type: application/json" \\\n  -d '${safe}'`,
    python: `import requests\n\nr = requests.post(\n    "${url}",\n    headers={"Authorization": "Bearer pg_your_key", "Content-Type": "application/json"},\n    data=r\'\'\'${safe}\'\'\',\n)\nprint(r.text)`,
    javascript: `const r = await fetch("${url}", {\n  method: "POST",\n  headers: { Authorization: "Bearer pg_your_key", "Content-Type": "application/json" },\n  body: JSON.stringify(${json.replace(/\n/g, '\n  ')}),\n});\nconsole.log(await r.text());`, body: json }[tab];
  return <Dialog title="Use this request in code" icon={<Code2 size={18} />} onClose={onClose} wide>
    <div className="seg" role="tablist" aria-label="Format">{(['curl', 'python', 'javascript', 'body'] as const).map(t => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t === 'body' ? 'JSON body' : t === 'curl' ? 'curl' : t === 'python' ? 'Python' : 'JavaScript'}</button>)}</div>
    <pre className="pg-code">{code}</pre>
    <p className="subtle">Replace <code>pg_your_key</code> with a client key from Overview. The key is never put in this snippet.</p>
    <div className="dialog-actions"><Button variant="primary" onClick={() => void copyText(code, notice)}><Copy size={14} />Copy</Button><Button onClick={onClose}>Close</Button></div>
  </Dialog>;
}
function Stat({ children, tone }: { children: string; tone?: 'warn' }) { return <span className={`pg-stat${tone ? ' ' + tone : ''}`}>{children}</span>; }
function MessageView({ turn, notice }: { turn: Turn; notice: (m: string, kind?: 'ok' | 'error') => void }) {
  const [raw, setRaw] = useState(false);
  if (turn.role === 'user') return <div className="pg-msg user"><pre>{turn.content}</pre></div>;
  const s = turn.stats; const speed = s && s.output > 1 && s.totalMs - s.firstMs > 200 ? Math.round(s.output / ((s.totalMs - s.firstMs) / 1000)) : 0; const approx = s?.estimated ? '≈ ' : '';
  return <div className={`pg-msg assistant${turn.error ? ' failed' : ''}`}>
    {turn.reasoning && <details className="pg-think"><summary><Brain size={13} />Thinking</summary><pre>{turn.reasoning}</pre></details>}
    {raw ? <pre>{turn.raw}</pre> : turn.content ? <pre>{turn.content}</pre> : !turn.error && !turn.tools?.length && !s && <span className="subtle"><Loader2 size={13} className="spin" /> Waiting for the answer…</span>}
    {turn.tools?.map((t, i) => <div className="pg-tool" key={i}><Wrench size={13} /><strong>{t.name || 'tool'}</strong><code>{t.args}</code></div>)}
    {turn.error && <div className="pg-error" role="alert">{turn.error}</div>}
    {s && <div className="pg-stats">
      {s.model && <Stat>{s.chain ? `${s.chain} → ${s.model}` : s.model}</Stat>}<Stat>{`first token ${ms(s.firstMs)}`}</Stat><Stat>{`total ${ms(s.totalMs)}`}</Stat><Stat>{`${approx}${s.input.toLocaleString()} in · ${approx}${s.output.toLocaleString()} out`}</Stat>
      {speed > 0 && <Stat>{`${approx}${speed} tok/s`}</Stat>}{s.route && <Stat>{s.route}</Stat>}{s.skipped && <Stat tone="warn">{`skipped ${s.skipped}`}</Stat>}
    </div>}
    {(turn.content || turn.raw) && <div className="pg-actions"><button className="text-button" onClick={() => void copyText(turn.content, notice)}><Copy size={13} />Copy</button>{turn.raw && <button className={'text-button' + (raw ? ' selected' : '')} onClick={() => setRaw(!raw)}><Code2 size={13} />{raw ? 'Show text' : 'Raw response'}</button>}</div>}
  </div>;
}
function PaneView({ turns, running, label, picker, notice }: { turns: Turn[]; running: boolean; label: string; picker?: ReactNode; notice: (m: string, kind?: 'ok' | 'error') => void }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [turns]);
  return <section className="pg-pane" aria-label={label}>
    <header className="pg-pane-head">{picker || <strong className="mono truncate" title={label}>{label}</strong>}<span className="toolbar-spacer" />{running && <Loader2 size={14} className="spin" />}</header>
    <div className="pg-thread" aria-live="polite">{turns.length ? turns.map((t, i) => <MessageView key={i} turn={t} notice={notice} />) : <Empty icon={Terminal} title="A response starts here">Pick a model and send a message through the actual gateway. No sample responses are generated.</Empty>}<div ref={end} /></div>
  </section>;
}
export function Playground({ data, apiKey, model, setModel, refresh, notice }: { data: Snapshot; apiKey: string; model: string; setModel: (x: string) => void; refresh: () => void; notice: (m: string, kind?: 'ok' | 'error') => void }) {
  const saved = useRef(load(STORE, { protocol: 'chat' as Protocol, system: '', stream: true, compare: false, model2: 'auto:smart', params: DEFAULTS })).current;
  const [protocol, setProtocol] = useState<Protocol>(saved.protocol); const [system, setSystem] = useState(saved.system); const [stream, setStream] = useState(saved.stream);
  const [compare, setCompare] = useState(saved.compare); const [model2, setModel2] = useState(saved.model2); const [params, setParams] = useState<Params>({ ...DEFAULTS, ...saved.params });
  const [draft, setDraft] = useState(''); const [turns, setTurns] = useState<Turn[][]>([[], []]); const [running, setRunning] = useState([false, false]); const [exporting, setExporting] = useState(false);
  const [prompts, setPrompts] = useState<{ name: string; system: string; prompt: string }[]>(() => load(PROMPTS, { list: [] as { name: string; system: string; prompt: string }[] }).list); const [picked, setPicked] = useState('');
  const controller = useRef<AbortController | null>(null); const busy = running.some(Boolean); const slots = compare ? 2 : 1;
  useEffect(() => keep(STORE, { protocol, system, stream, compare, model2, params }), [protocol, system, stream, compare, model2, params]);
  useEffect(() => () => controller.current?.abort(), []);
  const setParam = (patch: Partial<Params>) => setParams(p => ({ ...p, ...patch }));
  // `all` already ends with the user's message for every pane; each pane answers with its own model and its own history.
  async function start(all: Turn[][]) {
    const models = [model, model2]; const ctl = new AbortController(); controller.current = ctl;
    setTurns(all); setRunning([true, compare]);
    await Promise.all(Array.from({ length: slots }, async (_, k) => {
      const history = all[k].filter(t => !t.error && t.content).map(t => ({ role: t.role, content: t.content })); const req = buildRequest(protocol, models[k], system, history, params, stream);
      const index = all[k].length; let last: Turn = { role: 'assistant', content: '' };
      const put = (t: Turn) => { last = t; setTurns(cur => cur.map((list, j) => j === k ? [...list.slice(0, index), t] : list)); };
      put(last);
      try { await execute(req.path, req.body, apiKey, ctl.signal, put); }
      catch (e: any) {
        // New chat aborts the request on purpose and has already emptied the pane: nothing is left to mark as cancelled.
        if (e.name === 'AbortError' && controller.current !== ctl) return;
        put({ ...last, stats: undefined, error: e.name === 'AbortError' ? 'Cancelled' : e.message });
      }
      finally { setRunning(r => r.map((x, j) => j === k ? false : x)); }
    }));
    refresh();
  }
  function send() { const prompt = draft.trim(); if (!prompt || busy) return; setDraft(''); void start(turns.map(list => [...list, { role: 'user' as const, content: prompt }])); }
  function regenerate() { const next = turns.map(list => { const l = [...list]; while (l.length && l[l.length - 1].role === 'assistant') l.pop(); return l; }); if (next[0].length && !busy) void start(next); }
  function clear() { const ctl = controller.current; controller.current = null; ctl?.abort(); setTurns([[], []]); setRunning([false, false]); }
  function savePrompt() { const name = prompt('Name this prompt', draft.trim().slice(0, 40)); if (!name?.trim() || (!draft.trim() && !system.trim())) return; const list = [...prompts.filter(p => p.name !== name.trim()), { name: name.trim(), system, prompt: draft }]; setPrompts(list); keep(PROMPTS, { list }); setPicked(name.trim()); notice('Prompt saved'); }
  function removePrompt() { const list = prompts.filter(p => p.name !== picked); setPrompts(list); keep(PROMPTS, { list }); setPicked(''); }
  const history = turns[0].filter(t => !t.error && t.content).map(t => ({ role: t.role, content: t.content })); if (draft.trim()) history.push({ role: 'user', content: draft.trim() });
  const request = buildRequest(protocol, model, system, history.length ? history : [{ role: 'user', content: 'Say hello in five words.' }], params, stream);
  const chatOnly = protocol === 'chat';
  return <div className={`pg${compare ? ' compare' : ''}`}>
    <section className="section-block form-section pg-config">
      <div className="section-title"><Terminal size={19} /><h2>Request</h2></div>
      <Field label="Model"><Select value={model} onChange={setModel}>{modelOptions(data)}</Select></Field>
      <Toggle checked={compare} onChange={setCompare} label="Compare two models" detail="Send each message to a second model too, side by side." />
      {compare && <Field label="Second model"><Select value={model2} onChange={setModel2}>{modelOptions(data)}</Select></Field>}
      <Field label="Client protocol"><Select value={protocol} onChange={v => setProtocol(v as Protocol)}><option value="chat">Chat Completions</option><option value="responses">OpenAI Responses</option><option value="anthropic">Anthropic Messages</option></Select></Field>
      <Field label="System instruction (optional)"><textarea rows={2} value={system} onChange={e => setSystem(e.target.value)} placeholder="Instructions for the model" /></Field>
      <details className="pg-settings"><summary>Settings</summary>
        <div className="form-grid three">
          <Field label="Temperature" hint="Blank: the model's own."><input inputMode="decimal" value={params.temperature} onChange={e => setParam({ temperature: e.target.value })} placeholder="default" /></Field>
          <Field label="Top P"><input inputMode="decimal" value={params.topP} onChange={e => setParam({ topP: e.target.value })} placeholder="default" /></Field>
          <Field label="Max tokens"><input type="number" min="1" max="65536" value={params.maxTokens} onChange={e => setParam({ maxTokens: Math.max(1, Math.min(65536, +e.target.value || 1024)) })} /></Field>
        </div>
        <Toggle checked={stream} onChange={setStream} label="Stream the response" detail="Read text as it arrives. Upstream requests always use streaming." />
        <Toggle checked={chatOnly && params.tool} onChange={tool => setParam({ tool })} label="Offer a sample tool" detail={chatOnly ? 'Adds a get_weather function, to see whether a model asks to call it.' : 'Chat Completions only.'} />
        <Toggle checked={chatOnly && params.json} onChange={json => setParam({ json })} label="Ask for JSON" detail={chatOnly ? 'Sets response_format to a JSON object. Mention JSON in your message too.' : 'Chat Completions only.'} />
      </details>
      <div className="pg-quick" aria-label="Quick tests">{QUICK.map(q => <button key={q.label} type="button" className="filter-chip" onClick={() => { setDraft(q.prompt); if (q.tool) { setProtocol('chat'); setParam({ tool: true }); } }}>{q.label}</button>)}</div>
      <Field label={turns[0].length ? 'Next message' : 'Message'}><textarea className="prompt-input" rows={6} value={draft} onChange={e => setDraft(e.target.value)} placeholder="Ask your model something…" onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); } }} /></Field>
      <div className="form-actions"><span className="subtle">{apiKey ? 'Ctrl + Enter to send' : 'No usable client key. Add one in Settings.'}</span>{busy ? <Button onClick={() => controller.current?.abort()}><Square size={14} />Cancel</Button> : <Button variant="primary" disabled={!draft.trim() || !apiKey} onClick={send}><Send size={15} />Send</Button>}</div>
      <div className="pg-saved"><Select aria-label="Saved prompts" value={picked} onChange={v => { const p = prompts.find(x => x.name === v); if (p) { setPicked(v); setSystem(p.system); setDraft(p.prompt); } }}><option value="" disabled>{prompts.length ? 'Saved prompts' : 'No saved prompts yet'}</option>{prompts.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}</Select>
        <button className="icon-button" aria-label="Save this prompt" title="Save the system instruction and message" onClick={savePrompt}><BookmarkPlus size={15} /></button><button className="icon-button" aria-label="Delete the chosen saved prompt" title="Delete the chosen saved prompt" disabled={!picked} onClick={removePrompt}><Trash2 size={15} /></button></div>
    </section>
    <div className="pg-main">
      <div className="pg-toolbar"><Columns2 size={15} className={compare ? '' : 'muted'} /><span className="subtle">{compare ? 'Comparing two models' : turns[0].length ? 'Conversation' : 'New conversation'}</span><span className="toolbar-spacer" />
        <Button disabled={busy || !turns[0].some(t => t.role === 'user')} onClick={regenerate}><RotateCcw size={14} />Try again</Button><Button onClick={() => setExporting(true)}><Code2 size={14} />Code</Button><Button disabled={!turns[0].length && !turns[1].length} onClick={clear}><Eraser size={14} />New chat</Button></div>
      <div className="pg-panes">{Array.from({ length: slots }, (_, k) => <PaneView key={k} turns={turns[k]} running={running[k]} label={k ? model2 : model} notice={notice} picker={compare ? <Select aria-label={`Model for pane ${k + 1}`} value={k ? model2 : model} onChange={k ? setModel2 : setModel}>{modelOptions(data)}</Select> : undefined} />)}</div>
    </div>
    {exporting && <ExportDialog request={request} onClose={() => setExporting(false)} notice={notice} />}
  </div>;
}

// Some models name a tool argument after a common convention instead of the tool's own schema: DeepSeek writes read {"path": "a.ts"} where
// the tool asks for {"filePath": "a.ts"}. The client rejects that call, and after a few in a row an agent gives up. Polygate has the client's
// tool list, so it holds each streamed tool call until it is complete and renames a misnamed argument when the match is unambiguous.
// Only calls that would fail anyway are changed: a call whose required arguments are all present is passed on exactly as the model wrote it.

type Schema = { properties: Record<string, any>; required: string[] };
const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');
// Other names models use for the same argument, keyed by the normalized name the tool asks for. Spelling variants (file_path for filePath,
// old_string for oldString) already match by normalizing, so only true synonyms are listed.
const SYNONYMS: Record<string, string[]> = {
  filepath: ['path', 'file', 'filename', 'targetfile', 'absolutepath', 'fullpath'],
  path: ['filepath', 'file', 'dir', 'directory', 'folder'],
  command: ['cmd', 'shellcommand', 'script'],
  content: ['contents', 'text', 'filecontent'],
  pattern: ['glob', 'regex', 'query'],
  url: ['uri', 'link'],
  query: ['q', 'search', 'searchquery'],
  description: ['desc'],
};

function schemas(tools: unknown): Map<string, Schema> {
  const out = new Map<string, Schema>();
  if (!Array.isArray(tools)) return out;
  for (const t of tools as any[]) {
    const f = t?.function ?? t; const p = f?.parameters;
    if (typeof f?.name !== 'string' || !p || typeof p.properties !== 'object' || !Array.isArray(p.required) || !p.required.length) continue;
    out.set(f.name, { properties: p.properties, required: p.required.filter((r: unknown) => typeof r === 'string') });
  }
  return out;
}
const typeFits = (spec: any, v: unknown) => {
  const t = spec?.type; if (!t || Array.isArray(t)) return true;
  if (t === 'string') return typeof v === 'string';
  if (t === 'number' || t === 'integer') return typeof v === 'number';
  if (t === 'boolean') return typeof v === 'boolean';
  if (t === 'array') return Array.isArray(v);
  if (t === 'object') return !!v && typeof v === 'object' && !Array.isArray(v);
  return true;
};

// The repaired arguments, or undefined when the call is left as it is.
export function repairArgs(schema: Schema | undefined, raw: string): { args: string; renamed: string[] } | undefined {
  if (!schema) return;
  let a: any; try { a = JSON.parse(raw); } catch { return; }
  if (!a || typeof a !== 'object' || Array.isArray(a)) return;
  const missing = schema.required.filter(r => !(r in a));
  if (!missing.length) return;
  const extra = Object.keys(a).filter(k => !(k in schema.properties));
  const renamed: string[] = []; const taken = new Set<string>();
  for (const want of missing) {
    const w = norm(want); const alts = SYNONYMS[w] || [];
    const exact = extra.filter(k => !taken.has(k) && norm(k) === w);
    const found = exact.length ? exact : extra.filter(k => !taken.has(k) && alts.includes(norm(k)));
    if (found.length !== 1 || !typeFits(schema.properties[want], a[found[0]])) continue;
    taken.add(found[0]); renamed.push(`${found[0]} → ${want}`);
  }
  if (!renamed.length) return;
  const out: any = {};
  for (const [k, v] of Object.entries(a)) {
    if (!taken.has(k)) { out[k] = v; continue; }
    const want = missing.find(m => renamed.includes(`${k} → ${m}`))!; out[want] = v;
  }
  return { args: JSON.stringify(out), renamed };
}

// A transform over an OpenAI chat SSE stream (LF framed). Argument fragments are held back per tool call and sent in one piece, repaired if
// needed, just before the choice's finish event. Everything else passes through as it arrives, so text and reasoning still stream.
// Returns undefined when the request has no tool with required arguments: then nothing is held back.
export function toolArgRepair(tools: unknown, onRepair?: (tool: string, renamed: string[]) => void): TransformStream<Uint8Array, Uint8Array> | undefined {
  const byName = schemas(tools);
  if (!byName.size) return;
  const enc = new TextEncoder(); const dec = new TextDecoder();
  // choice index → tool index → the call so far
  const calls = new Map<number, Map<number, { name: string; args: string }>>();
  let scan = ''; let meta: Record<string, unknown> = {};
  const emit = (c: TransformStreamDefaultController<Uint8Array>, text: string) => c.enqueue(enc.encode(text));
  const release = (c: TransformStreamDefaultController<Uint8Array>, choice: number) => {
    const held = calls.get(choice); if (!held) return; calls.delete(choice);
    const tool_calls = [...held].filter(([, v]) => v.args).map(([index, v]) => {
      const fixed = repairArgs(byName.get(v.name), v.args);
      if (fixed) onRepair?.(v.name, fixed.renamed);
      return { index, function: { arguments: fixed ? fixed.args : v.args } };
    });
    if (tool_calls.length) emit(c, `data: ${JSON.stringify({ ...meta, choices: [{ index: choice, delta: { tool_calls }, finish_reason: null }] })}\n\n`);
  };
  const releaseAll = (c: TransformStreamDefaultController<Uint8Array>) => { for (const i of [...calls.keys()]) release(c, i); };
  const event = (c: TransformStreamDefaultController<Uint8Array>, block: string) => {
    const lines = block.split('\n'); const data = lines.filter(l => l.startsWith('data:'));
    if (data.length !== 1) { emit(c, block + '\n\n'); return; }
    const raw = data[0].slice(5).trim();
    if (raw === '[DONE]') { releaseAll(c); emit(c, block + '\n\n'); return; }
    let d: any; try { d = JSON.parse(raw); } catch { emit(c, block + '\n\n'); return; }
    if (!Array.isArray(d?.choices)) { emit(c, block + '\n\n'); return; }
    meta = { id: d.id, object: d.object ?? 'chat.completion.chunk', created: d.created, model: d.model };
    let changed = false; const finishing: number[] = [];
    for (const ch of d.choices) {
      const i = Number.isInteger(ch?.index) ? ch.index : 0;
      const tcs = ch?.delta?.tool_calls;
      if (Array.isArray(tcs)) {
        const held = calls.get(i) ?? new Map(); calls.set(i, held);
        const kept: any[] = [];
        for (const tc of tcs) {
          const ti = Number.isInteger(tc?.index) ? tc.index : held.size;
          const cur = held.get(ti) ?? { name: '', args: '' }; held.set(ti, cur);
          if (typeof tc?.function?.name === 'string') cur.name += tc.function.name;
          const args = tc?.function?.arguments;
          if (typeof args === 'string') { cur.args += args; changed = true; }
          else if (args && typeof args === 'object') { cur.args += JSON.stringify(args); changed = true; }
          // The start of a call (its id, type and name) goes on at once; only the argument text waits.
          const { arguments: _drop, ...fn } = tc?.function ?? {};
          if (tc?.id || tc?.type || fn.name !== undefined) kept.push({ ...tc, index: ti, function: fn });
          else if (args === undefined) kept.push(tc);
        }
        if (changed) { if (kept.length) ch.delta.tool_calls = kept; else delete ch.delta.tool_calls; }
      }
      if (ch?.finish_reason) finishing.push(i);
    }
    // A call can start and finish in one event (some providers send the whole call at once). Its start (id, name) must reach the client
    // before its arguments, and the arguments before the finish, so such an event goes out in three parts: the event without its finish,
    // the held arguments, then the finish (with usage, if the event carried it).
    const ending = finishing.filter(i => calls.has(i));
    if (ending.length) {
      const reasons = new Map<number, unknown>();
      for (const ch of d.choices) { const i = Number.isInteger(ch?.index) ? ch.index : 0; if (ending.includes(i)) { reasons.set(i, ch.finish_reason); ch.finish_reason = null; } }
      const usage = d.usage; delete d.usage;
      emit(c, `data: ${JSON.stringify(d)}\n\n`);
      for (const i of ending) release(c, i);
      emit(c, `data: ${JSON.stringify({ ...meta, choices: ending.map(i => ({ index: i, delta: {}, finish_reason: reasons.get(i) })), ...(usage ? { usage } : {}) })}\n\n`);
      return;
    }
    emit(c, changed ? `data: ${JSON.stringify(d)}\n\n` : block + '\n\n');
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, c) {
      scan += dec.decode(chunk, { stream: true });
      let i; while ((i = scan.indexOf('\n\n')) >= 0) { const block = scan.slice(0, i); scan = scan.slice(i + 2); if (block) event(c, block); }
    },
    // A stream that ends without a finish still hands over what it held, as the model wrote it so far.
    flush(c) { scan += dec.decode(); if (scan.trim()) event(c, scan.replace(/\n+$/, '')); releaseAll(c); },
  });
}

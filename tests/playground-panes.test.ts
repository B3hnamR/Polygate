import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
// The Playground's own send and regenerate handlers, run from the source: a prompt sent with one pane must not be added to the second pane,
// or turning Compare on later would send earlier prompts to the second model without the first model's replies.
const source = readFileSync(new URL('../src/playground.tsx', import.meta.url), 'utf8');
const between = (start: string, end: string) => { const a = source.indexOf(start), b = source.indexOf(end, a); if (a < 0 || b < 0) throw new Error(`Missing ${start}`); return source.slice(a, b); };
const transpiler = new Bun.Transpiler({ loader: 'ts' });
const handlers = (scope: Record<string, unknown>) => new Function(...Object.keys(scope), transpiler.transformSync(between('  function send()', '  function clear()')) + '\nreturn { send, regenerate };')(...Object.values(scope));
type Turn = { role: 'user' | 'assistant'; content: string };

test('a prompt goes only to the panes in use, and regenerate leaves an unused pane alone', () => {
  let sent: Turn[][] = [];
  const history: Turn[][] = [[{ role: 'user', content: 'first' }, { role: 'assistant', content: 'one' }], []];
  const solo = handlers({ draft: '  second  ', busy: false, setDraft: () => {}, start: (all: Turn[][]) => { sent = all; }, turns: history, slots: 1 });
  solo.send();
  expect(sent[0].map(t => t.content)).toEqual(['first', 'one', 'second']);
  expect(sent[1]).toEqual([]);
  const both = handlers({ draft: 'third', busy: false, setDraft: () => {}, start: (all: Turn[][]) => { sent = all; }, turns: [[...history[0]], [{ role: 'user', content: 'x' }]], slots: 2 });
  both.send();
  expect(sent[1].map(t => t.content)).toEqual(['x', 'third']);
  const regen = handlers({ draft: '', busy: false, setDraft: () => {}, start: (all: Turn[][]) => { sent = all; }, turns: [[...history[0]], [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]], slots: 1 });
  regen.regenerate();
  expect(sent[0].map(t => t.content)).toEqual(['first']);
  expect(sent[1].map(t => t.content)).toEqual(['q', 'a']);
});

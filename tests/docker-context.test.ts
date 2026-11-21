import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
// Each Docker build stage builds from the files it COPYs. An import that reaches a file the stage does not copy breaks `docker build`, and nothing
// else notices because these tests run on the full checkout.
const root = path.resolve(import.meta.dir, '..');
const posix = path.posix;

function dockerStage(runs: RegExp) {
  const lines = readFileSync(path.join(root, 'Dockerfile'), 'utf8').replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  const stages: string[][] = [];
  for (const raw of lines) { const line = raw.trim(); if (/^FROM\s/i.test(line)) stages.push([]); if (line && !line.startsWith('#') && stages.length) stages.at(-1)!.push(line); }
  const stage = stages.find(s => s.some(l => /^RUN\s/i.test(l) && runs.test(l)));
  if (!stage) throw new Error(`No Dockerfile stage runs ${runs}`);
  let workdir = '/';
  const copies: { src: string; dest: string }[] = [];
  for (const line of stage) {
    const [op, ...args] = line.split(/\s+/);
    if (/^WORKDIR$/i.test(op)) workdir = posix.resolve(workdir, args[0]);
    if (/^COPY$/i.test(op) && !args.some(a => a.startsWith('--from'))) {
      const paths = args.filter(a => !a.startsWith('--')); const last = paths.pop()!;
      for (const src of paths) copies.push({ src: posix.normalize(src).replace(/^\.\//, '').replace(/\/$/, ''), dest: posix.resolve(workdir, last) + (last.endsWith('/') || paths.length > 1 ? '/' : '') });
    }
  }
  return { workdir, copies };
}

const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '/index.ts', '/index.tsx', '/index.js'];
const resolveFile = (p: string) => EXTENSIONS.map(ext => p + ext).find(f => existsSync(path.join(root, f)) && statSync(path.join(root, f)).isFile());
// Runtime imports only: `import type` and `export type` are erased before bundling.
const SPECIFIER = /(?:\bimport\s+(?!type\b)[^'"]*?from\s*|\bexport\s+(?!type\b)[^'"]*?from\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/g;

// Every relative import reachable from the given entry files, followed through the project's own TypeScript (vendored bundles are copied whole).
function relativeImports(entries: string[]) {
  const found: { file: string; specifier: string; target: string }[] = [];
  const seen = new Set<string>(); const queue = [...entries];
  while (queue.length) {
    const file = queue.shift()!; if (seen.has(file)) continue; seen.add(file);
    if (!/^(?:backend|src)\/.*\.tsx?$/.test(file)) continue;
    for (const m of readFileSync(path.join(root, file), 'utf8').matchAll(SPECIFIER)) {
      const target = posix.join(posix.dirname(file), m[2]); found.push({ file, specifier: m[2], target });
      const resolved = resolveFile(target); if (resolved) queue.push(resolved);
    }
  }
  return found;
}

function problemsIn(stage: ReturnType<typeof dockerStage>, imports: ReturnType<typeof relativeImports>) {
  const { workdir, copies } = stage; const problems: string[] = [];
  for (const { file, specifier, target } of imports) {
    const resolved = resolveFile(target);
    if (!resolved) { problems.push(`${file} imports ${specifier}, which resolves to ${target} and does not exist`); continue; }
    const copy = copies.find(c => resolved === c.src || resolved.startsWith(c.src + '/'));
    if (!copy) { problems.push(`${file} imports ${specifier}, but the stage copies nothing that covers ${resolved}`); continue; }
    const rest = resolved.slice(copy.src.length);
    const placed = statSync(path.join(root, copy.src)).isDirectory() ? posix.join(copy.dest, rest) : copy.dest.endsWith('/') ? posix.join(copy.dest, posix.basename(copy.src)) : copy.dest;
    if (placed !== posix.join(workdir, resolved)) problems.push(`${file} imports ${specifier}, but COPY ${copy.src} puts it at ${placed}, not ${posix.join(workdir, resolved)}`);
  }
  return problems;
}

const filesIn = (dir: string): string[] => readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(e => e.isDirectory() ? filesIn(posix.join(dir, e.name)) : [posix.join(dir, e.name)]);

test('The Docker gateway stage copies every file that backend/ imports', () => {
  const imports = relativeImports(readdirSync(path.join(root, 'backend')).filter(n => n.endsWith('.ts')).map(n => 'backend/' + n));
  expect(imports.length).toBeGreaterThan(0);
  expect(problemsIn(dockerStage(/\bbun build backend\/main\.ts\b/), imports)).toEqual([]);
});

test('The Docker dashboard stage copies every file the dashboard imports, including shared backend modules', () => {
  const imports = relativeImports(filesIn('src').filter(f => /\.(?:tsx?|jsx?)$/.test(f)));
  expect(imports.some(i => i.target.startsWith('backend/'))).toBe(true);
  expect(problemsIn(dockerStage(/\bnpm run build:ui\b/), imports)).toEqual([]);
});

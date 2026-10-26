import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
// The gateway stage builds from the files it COPYs. An import that reaches a directory the stage does not copy breaks `docker build`, and nothing
// else notices because these tests run on the full checkout.
const root = path.resolve(import.meta.dir, '..');
const posix = path.posix;

function gatewayStage() {
  const lines = readFileSync(path.join(root, 'Dockerfile'), 'utf8').replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  const stages: string[][] = [];
  for (const raw of lines) { const line = raw.trim(); if (/^FROM\s/i.test(line)) stages.push([]); if (line && !line.startsWith('#') && stages.length) stages.at(-1)!.push(line); }
  const stage = stages.find(s => s.some(l => /^RUN\s.*\bbun build backend\/main\.ts\b/i.test(l)));
  if (!stage) throw new Error('No Dockerfile stage runs `bun build backend/main.ts`');
  let workdir = '/';
  const copies: { src: string; dest: string }[] = [];
  for (const line of stage) {
    const [op, ...args] = line.split(/\s+/);
    if (/^WORKDIR$/i.test(op)) workdir = posix.resolve(workdir, args[0]);
    if (/^COPY$/i.test(op) && !args.some(a => a.startsWith('--from'))) {
      const paths = args.filter(a => !a.startsWith('--')); const last = paths.pop()!;
      for (const src of paths) copies.push({ src: posix.normalize(src).replace(/^\.\//, '').replace(/\/$/, ''), dest: posix.resolve(workdir, last) + (last.endsWith('/') ? '/' : '') });
    }
  }
  return { workdir, copies };
}

const exists = (p: string) => ['', '.ts', '.js', '.mjs', '.json', '/index.ts', '/index.js'].some(ext => existsSync(path.join(root, p + ext)));
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/g;

function relativeImports() {
  const found: { file: string; specifier: string; target: string }[] = [];
  for (const name of readdirSync(path.join(root, 'backend')).filter(n => n.endsWith('.ts'))) {
    const file = 'backend/' + name;
    for (const m of readFileSync(path.join(root, file), 'utf8').matchAll(SPECIFIER)) found.push({ file, specifier: m[2], target: posix.join(posix.dirname(file), m[2]) });
  }
  return found;
}

test('The Docker gateway stage copies every directory that backend/ imports from', () => {
  const { workdir, copies } = gatewayStage(); const imports = relativeImports();
  expect(imports.length).toBeGreaterThan(0);
  const problems: string[] = [];
  for (const { file, specifier, target } of imports) {
    if (!exists(target)) { problems.push(`${file} imports ${specifier}, which resolves to ${target} and does not exist`); continue; }
    const copy = copies.find(c => target === c.src || target.startsWith(c.src + '/'));
    if (!copy) { problems.push(`${file} imports ${specifier}, but the gateway stage copies nothing that covers ${target}`); continue; }
    const rest = target.slice(copy.src.length);
    const placed = statSync(path.join(root, copy.src)).isDirectory() ? posix.join(copy.dest, rest) : copy.dest.endsWith('/') ? posix.join(copy.dest, posix.basename(copy.src)) : copy.dest;
    if (placed !== posix.join(workdir, target)) problems.push(`${file} imports ${specifier}, but COPY ${copy.src} puts it at ${placed}, not ${posix.join(workdir, target)}`);
  }
  expect(problems).toEqual([]);
});

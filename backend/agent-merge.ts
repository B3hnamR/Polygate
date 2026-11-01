import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const equal = (a: Buffer | null, b: Buffer | null) => a === null ? b === null : b !== null && a.equals(b);
// Invert one agent turn: merge its pre-turn bytes into the current file using its post-turn bytes as the common ancestor.
// Git operates only on private scratch files; it never reads project configuration, runs filters or writes conflict markers to the project.
export function mergeUndo(before: Buffer | null, after: Buffer | null, current: Buffer | null): Buffer | null {
  if (equal(after, current)) return before;
  if (equal(before, after)) return current;
  if (before === null || after === null || current === null) throw new Error('The created or deleted file changed after the agent turn.');
  for (const bytes of [before, after, current]) {
    if (bytes.length > 2 * 1024 * 1024 || bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new Error('A changed binary, non-UTF8 or large file cannot be safely merged.');
  }
  const git = Bun.which('git');
  if (!git) throw new Error('Git is needed to merge your edits. Nothing was undone.');
  const dir = mkdtempSync(path.join(tmpdir(), 'pg-undo-'));
  try {
    const ours = path.join(dir, 'current'), base = path.join(dir, 'after'), theirs = path.join(dir, 'before');
    writeFileSync(ours, current); writeFileSync(base, after); writeFileSync(theirs, before);
    const env: Record<string, string> = {};
    for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT']) if (process.env[name]) env[name] = process.env[name]!;
    Object.assign(env, { HOME: dir, USERPROFILE: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(dir, 'no-config'), GIT_ATTR_NOSYSTEM: '1' });
    const result = Bun.spawnSync([git, 'merge-file', '--', ours, base, theirs], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe', timeout: 10000 });
    if (result.exitCode !== 0) throw new Error('Your edits overlap the agent changes, or Git could not merge this file. Nothing was undone.');
    return readFileSync(ours);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export type GitEntry = { file: string; from?: string; index: string; worktree: string };
export function gitStatus(text: string) {
  const records = text.split('\0'), files: GitEntry[] = []; let branch = '';
  for (let i = 0; i < records.length; i++) {
    const line = records[i]; if (!line) continue;
    if (line.startsWith('## ')) { branch = line.slice(3); continue; }
    const entry: GitEntry = { file: line.slice(3), index: line[0], worktree: line[1] };
    if (/[RC]/.test(entry.index + entry.worktree)) entry.from = records[++i];
    files.push(entry);
  }
  return { branch, files };
}

// Explicit user consent is required: even read-only working-tree inspection can execute repository clean filters.
export async function inspectGit(folder: string, file?: string) {
  const git = Bun.which('git'); if (!git) throw new Error('Git is not installed or is not on PATH. Recorded Agent changes are still available.');
  if (file !== undefined) {
    const rel = path.relative(folder, path.resolve(folder, file));
    if (!file || file.includes('\0') || path.isAbsolute(file) || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Choose a file inside this working folder.');
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_|^POLYGATE_|^OPENCODE_|(?:TOKEN|PASSWORD|SECRET|API_KEY)/i.test(k)));
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_PAGER: 'cat' });
  const base = ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'interactive.diffFilter=', '-c', 'log.showSignature=false'];
  const run = async (args: string[]) => {
    try { return (await exec(git, [...base, ...args], { cwd: folder, env, windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' })).stdout; }
    catch (e: any) {
      if (String(e.stderr).includes('not a git repository')) return null;
      if (args[0] === 'log' && /does not have any commits|bad default revision|unknown revision/i.test(String(e.stderr))) return '';
      // Don't echo repository-configured command output or environment values into errors.
      throw new Error(e.killed ? 'Git inspection timed out after 15 seconds.' : e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'Git output exceeded 2 MiB. Inspect a smaller set of changes in your Git client.' : 'Git inspection failed. Check folder access and repository configuration in your Git client.');
    }
  };
  if (file !== undefined) {
    const worktree = await run(['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--no-renames', '--', file]);
    if (worktree === null) return { repository: false };
    const staged = await run(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--no-renames', '--', file]);
    const limit = 200000;
    return { repository: true, file, worktree: worktree.slice(0, limit), staged: (staged || '').slice(0, limit), truncated: worktree.length > limit || (staged || '').length > limit };
  }
  const status = await run(['status', '--porcelain=v1', '--branch', '-z', '--untracked-files=normal', '--ignore-submodules=all', '--', '.']);
  if (status === null) return { repository: false };
  // Porcelain paths are repository-relative even when this session works in a nested folder.
  const prefix = (await run(['rev-parse', '--show-prefix']) || '').trim();
  const parsed = gitStatus(status);
  parsed.files = parsed.files.filter(f => f.file.startsWith(prefix)).map(f => ({ ...f, file: f.file.slice(prefix.length), ...(f.from?.startsWith(prefix) ? { from: f.from.slice(prefix.length) } : {}) }));
  const log = await run(['log', '-n', '10', '--format=%h%x09%s', '--no-show-signature', '--no-decorate']);
  return { repository: true, ...parsed, commits: (log || '').trim().split('\n').filter(Boolean).map(line => { const at = line.indexOf('\t'); return { hash: line.slice(0, at), subject: line.slice(at + 1) }; }), at: Date.now() };
}

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const files = (dir: string, prefix = ''): string[] => {
  if (lstatSync(dir).isSymbolicLink()) throw new Error(`Untrusted resource entry: ${dir}`);
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const file = path.join(dir, e.name), entry = lstatSync(file);
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error(`Untrusted resource entry: ${file}`);
    return entry.isDirectory() ? files(file, prefix + e.name + '/') : [prefix + e.name];
  }).sort();
};

type Resource = { from: string; to: string };
export function resourceManifest(root: string, resources: Resource[]) {
  const manifest = new Map<string, string>();
  for (const { from, to } of resources) {
    if ([from, to].some(p => path.isAbsolute(p) || p.split(/[\\/]/).includes('..'))) throw new Error('Resource paths must remain inside the build');
    const source = path.join(root, from), entry = lstatSync(source);
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error(`Untrusted resource entry: ${source}`);
    for (const file of entry.isDirectory() ? files(source) : ['']) {
      const target = path.posix.join(to.replace(/\\/g, '/'), file);
      if (manifest.has(target)) throw new Error(`Duplicate resource: ${target}`);
      manifest.set(target, hash(file ? path.join(source, file) : source));
    }
  }
  return manifest;
}

export function verifyResources(resources: string, manifest: Map<string, string>) {
  const actual = files(resources);
  for (const [file, expected] of manifest) {
    if (!actual.includes(file) || hash(path.join(resources, file)) !== expected) throw new Error(`Packaged file differs: ${file}`);
  }
  // Electron/NSIS own these two files; every application resource must be declared.
  for (const file of actual) if (!['app.asar', 'elevate.exe'].includes(file) && !manifest.has(file)) throw new Error(`Unexpected packaged resource: ${file}`);
}

function buildDesktop() {
  const root = path.resolve(import.meta.dir, '..');
  const { version, build } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\.\d+Z$/, 'Z');
  const output = path.join(root, 'release', `Polygate-${version}-${stamp}`);
  if (process.platform !== 'win32') throw new Error('This command builds the Windows portable app.');
  if (process.env.POLYGATE_ALLOW_ANY_BUN === '1') throw new Error('Desktop artifacts require the pinned Bun runtime.');
  if (existsSync(output)) throw new Error(`Build folder already exists: ${output}`);
  for (const dir of ['release', 'build', 'dist']) if (existsSync(path.join(root, dir)) && lstatSync(path.join(root, dir)).isSymbolicLink()) throw new Error(`Untrusted build directory: ${dir}`);
  mkdirSync(output, { recursive: true });
  const runtime = path.join(root, 'build/runtime/1.4.4/windows-x64/bun.exe');
  const env = { ...process.env, ...(existsSync(runtime) && !process.env.POLYGATE_BUN_RUNTIME ? { POLYGATE_BUN_RUNTIME: runtime } : {}) };
  // Never package stale UI, gateway, or runtime files from an earlier invocation.
  for (const file of ['dist', 'build/gateway.js', 'build/bin']) rmSync(path.join(root, file), { recursive: true, force: true });
  const built = Bun.spawnSync([process.execPath, 'run', 'build'], { cwd: root, env, stdio: ['inherit', 'inherit', 'inherit'] });
  if (built.exitCode !== 0) process.exit(built.exitCode || 1);
  const manifest = resourceManifest(root, build.extraResources);
  if (!manifest.has('ui/index.html') || !manifest.has('bin/bun.exe') || !manifest.has('gateway.js') || !manifest.has('LICENSE') || !manifest.has('THIRD_PARTY_NOTICES.md')) throw new Error('Required desktop resources are missing.');
  const result = Bun.spawnSync(['node', 'node_modules/electron-builder/cli.js', '--win', 'portable', '--x64', `-c.directories.output=${output}`, '--publish', 'never'], { cwd: root, env, stdio: ['inherit', 'inherit', 'inherit'] });
  if (result.exitCode !== 0) process.exit(result.exitCode || 1);
  const resources = path.join(output, 'win-unpacked/resources');
  verifyResources(resources, manifest);
  for (const [source, packaged] of [['LICENSE', 'LICENSE.electron.txt'], ['LICENSES.chromium.html', 'LICENSES.chromium.html']]) {
    if (hash(path.join(root, 'node_modules/electron/dist', source)) !== hash(path.join(output, 'win-unpacked', packaged))) throw new Error(`Packaged Electron license differs: ${packaged}`);
  }
  const exe = path.join(output, `Polygate-${version}-Windows-x64.exe`);
  if (!lstatSync(exe).isFile() || lstatSync(exe).isSymbolicLink()) throw new Error('Portable executable must be a regular file.');
  if (statSync(exe).size < 100 * 1024 * 1024) throw new Error('Portable executable is unexpectedly small.');
  writeFileSync(exe + '.sha256', `${hash(exe)}  ${path.basename(exe)}\n`);
  // Publish only this successfully verified build, never a glob that can include an older release.
  if (process.env.GITHUB_OUTPUT) {
    const artifact = path.relative(root, exe).split(path.sep).join('/');
    appendFileSync(process.env.GITHUB_OUTPUT, `executable=${artifact}\nchecksum=${artifact}.sha256\n`);
  }
  console.log(`Verified ${manifest.size} declared resources including UI, runtime and licenses.\nPortable: ${exe}`);
}

if (import.meta.main) buildDesktop();

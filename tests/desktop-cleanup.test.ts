import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

const mainSource = readFileSync(path.join(import.meta.dir, '..', 'desktop', 'main.cjs'), 'utf8');
const helperSource = readFileSync(path.join(import.meta.dir, '..', 'desktop', 'apply-update.ps1'), 'utf8');
const win = path.win32;
const base = 'C:\\Local\\Polygate\\app', version = '0.6.6';
const temporaryExe = 'C:\\Temp\\incoming\\Polygate.exe';
type Entry = { kind: 'file' | 'dir' | 'link'; data?: string; real?: string; mtimeMs?: number };

// No Electron, gateway, native executable or real filesystem mutation: every startup operation is intercepted.
function fixture(options: { exe?: string; inherited?: boolean; failCopy?: boolean; packaged?: boolean; platform?: string } = {}) {
  const entries = new Map<string, Entry>(), removed: string[] = [], launches: any[] = [], errors: string[] = [];
  const key = (file: string) => win.resolve(file).toLowerCase();
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  const entry = (file: string) => { const value = entries.get(key(file)); if (!value) throw missing(); return value; };
  const mkdir = (file: string) => {
    const parent = win.dirname(file); if (parent !== file) mkdir(parent);
    if (!entries.has(key(file))) entries.set(key(file), { kind: 'dir' });
  };
  const put = (file: string, data: string) => { mkdir(win.dirname(file)); entries.set(key(file), { kind: 'file', data }); };
  const stats = (file: string) => {
    const value = entry(file);
    return { isSymbolicLink: () => value.kind === 'link', isFile: () => value.kind === 'file', isDirectory: () => value.kind === 'dir', size: value.data?.length || 0, mtimeMs: value.mtimeMs ?? 1234 };
  };
  const ofs = {
    lstatSync: stats, statSync: stats,
    realpathSync: (file: string) => entry(file).real || win.resolve(file),
    existsSync: (file: string) => entries.has(key(file)),
    readFileSync: (file: string) => entry(file).data,
    writeFileSync: put, mkdirSync: mkdir,
    mkdtempSync: (prefix: string) => { const file = prefix + 'unique'; mkdir(file); return file; },
    readdirSync: (folder: string) => {
      entry(folder);
      return [...entries.keys()].filter(file => key(win.dirname(file)) === key(folder) && file !== key(folder)).map(file => win.basename(file));
    },
    rmSync: (folder: string) => {
      removed.push(folder);
      for (const file of entries.keys()) if (file === key(folder) || file.startsWith(key(folder) + '\\')) entries.delete(file);
    },
    cpSync: (source: string, target: string) => {
      if (options.failCopy) throw new Error('disk full');
      for (const [file, value] of [...entries]) if (file.startsWith(key(source) + '\\')) entries.set(key(target) + file.slice(key(source).length), { ...value, mtimeMs: 5678 });
    },
    renameSync: (source: string, target: string) => {
      for (const [file, value] of [...entries]) if (file === key(source) || file.startsWith(key(source) + '\\')) {
        entries.set(key(target) + file.slice(key(source).length), value); entries.delete(file);
      }
    },
  };
  const copy = (name: string, root = base) => {
    const folder = win.join(root, name);
    put(win.join(folder, 'Polygate.exe'), 'inert exe');
    put(win.join(folder, 'resources', 'app.asar'), 'asar');
    put(win.join(folder, 'resources', 'gateway.js'), 'gateway');
    put(win.join(folder, 'resources', 'bin', 'bun.exe'), 'bun');
    put(win.join(folder, 'resources', 'ui', 'index.html'), 'ui');
    put(win.join(folder, '.polygate-copy'), `${name} 4 7 1234`);
    return folder;
  };
  const exe = options.exe || temporaryExe;
  put(exe, 'inert exe');
  put(win.join(win.dirname(exe), 'resources', 'app.asar'), 'asar');
  put(win.join(win.dirname(exe), 'resources', 'gateway.js'), 'gateway');
  put(win.join(win.dirname(exe), 'resources', 'bin', 'bun.exe'), 'bun');
  put(win.join(win.dirname(exe), 'resources', 'ui', 'index.html'), 'ui');
  const env: Record<string, string> = { LOCALAPPDATA: 'C:\\Local', PORTABLE_EXECUTABLE_DIR: 'C:\\Downloads', PORTABLE_EXECUTABLE_FILE: 'C:\\Downloads\\Portable.exe' };
  if (options.inherited !== false) env.POLYGATE_RELOCATED = '1';
  const app = {
    isPackaged: options.packaged !== false, getVersion: () => version, getPath: () => 'C:\\Roaming',
    requestSingleInstanceLock: () => true, releaseSingleInstanceLock() {}, exit() {}, quit() {}, on() {},
    whenReady: () => ({ then() {} }),
  };
  let now = Date.now();
  const context: any = {
    Date: { now: () => now }, setTimeout: (fn: () => void, ms: number) => { now += ms; fn(); },
    process: { platform: options.platform || 'win32', execPath: exe, resourcesPath: win.join(win.dirname(exe), 'resources'), env, argv: ['Polygate.exe'], pid: 123 },
    __dirname: 'C:\\app\\desktop', console: { error: (...args: unknown[]) => errors.push(args.join(' ')) },
    require: (name: string) => {
      if (name === 'electron') return { app };
      if (name === './updater.cjs') return { portableTarget: (target: string) => target };
      if (name === './window-mode.cjs') return {};
      if (name === 'original-fs') return ofs;
      if (name === 'node:fs') return { ...ofs, unlinkSync: ofs.rmSync, writeSync() {} };
      if (name === 'node:path') return win;
      if (name === 'node:crypto') return { randomBytes: () => Buffer.from('inert token') };
      if (name === 'node:child_process') return { spawn: (...args: unknown[]) => { launches.push(args); return { unref() {} }; } };
      throw new Error('Unexpected module: ' + name);
    },
  };
  const start = () => runInNewContext(mainSource, context);
  return { put, copy, entries, key, ofs, env, removed, launches, errors, start, prune: () => context.pruneCopies(0), confirm: (window: unknown, result: string) => context.confirmDashboardStartup(window, result) };
}

describe('portable cache ownership', () => {
  test('incoming temp executable ignores the flag inherited from the 0.6.5 helper', () => {
    const f = fixture();
    f.put('C:\\Temp\\incoming\\.polygate-copy', `${version} 4 7 1234`);
    f.put('C:\\Temp\\unrelated\\keep.txt', 'keep');
    f.start(); f.prune();
    expect(f.launches).toHaveLength(1);
    expect(f.launches[0][0]).toBe(win.join(base, version, 'Polygate.exe'));
    expect(f.launches[0][2].env.POLYGATE_RELOCATED).toBe('1');
    expect(f.env.POLYGATE_RELOCATED).toBeUndefined();
    expect(f.removed).toEqual([]);
    expect(f.ofs.existsSync(temporaryExe)).toBe(true);
    expect(f.ofs.readFileSync('C:\\Temp\\unrelated\\keep.txt')).toBe('keep');
  });

  test('an existing validated cache is reused without deleting or recopying it', () => {
    const f = fixture({ failCopy: true }); f.copy(version);
    f.entries.get(f.key(win.join(base, version, 'resources', 'gateway.js')))!.mtimeMs = 5678;
    f.start();
    expect(f.errors).toEqual([]); expect(f.removed).toEqual([]);
    expect(f.launches).toHaveLength(1);
    expect(f.launches[0][0]).toBe(win.join(base, version, 'Polygate.exe'));
  });

  for (const asset of ['resources\\bin\\bun.exe', 'resources\\ui\\index.html']) test(`a cache missing ${asset} is rebuilt before startup`, () => {
    const f = fixture(), folder = f.copy(version), file = win.join(folder, asset);
    f.entries.delete(f.key(file));
    f.start();
    expect(f.removed).toEqual([folder]);
    expect(f.ofs.existsSync(file)).toBe(true);
    expect(f.launches[0][0]).toBe(win.join(folder, 'Polygate.exe'));
  });

  test('a new copy lists every file it holds, and a copy that lost one listed file is made again', () => {
    const first = fixture(); first.start();
    const folder = win.join(base, version); const list = JSON.parse(String(first.ofs.readFileSync(win.join(folder, '.polygate-files'))));
    // (The stand-in file system keeps names in lower case.)
    expect(list.map(([rel]: [string]) => rel.toLowerCase())).toEqual(expect.arrayContaining(['polygate.exe', 'resources\\app.asar', 'resources\\bin\\bun.exe', 'resources\\ui\\index.html']));
    // A file outside the old fixed checks (here the gateway's WARP helper would do as well): gone from the copy, so the copy is not trusted.
    const f = fixture(), copy = f.copy(version), extra = win.join(copy, 'resources', 'ui', 'assets', 'index.js');
    f.ofs.writeFileSync(extra, 'js'); f.ofs.writeFileSync(win.join(copy, '.polygate-files'), JSON.stringify(f.ofs.readdirSync(copy).length ? [['resources\\ui\\assets\\index.js', 2], ['Polygate.exe', f.ofs.statSync(win.join(copy, 'Polygate.exe')).size]] : []));
    f.entries.delete(f.key(extra));
    f.start();
    expect(f.removed).toEqual([copy]);
    expect(f.launches[0][0]).toBe(win.join(copy, 'Polygate.exe'));
  });

  test('verified current cache skips relocation even without the flag; pruning deletes only owned old versions', () => {
    const f = fixture({ exe: win.join(base, version, 'Polygate.exe'), inherited: false });
    f.copy(version); const old = f.copy('0.6.5');
    f.put(win.join(base, 'notes.txt'), 'keep');
    f.put(win.join(base, '0.6.4', 'unrelated.txt'), 'keep');
    f.copy('not-a-version');
    f.copy('0.6.3'); f.put(win.join(base, '0.6.3', '.polygate-copy'), '0.6.2 4 7 1234');
    f.copy('0.6.2'); f.put(win.join(base, '0.6.2', '.polygate-copy'), '0.6.2 999 7 1234');
    f.put(win.join(base, '0.6.1.copy-abandoned', '.polygate-copy'), '0.6.1 4 7 1234');
    f.start(); f.prune();
    expect(f.launches).toEqual([]);
    expect(f.removed).toEqual([old]);
    expect(f.ofs.existsSync(win.join(base, version, 'Polygate.exe'))).toBe(true);
    expect(f.ofs.readFileSync(win.join(base, 'notes.txt'))).toBe('keep');
  });

  test('failed relocation stays in temp without pruning unrelated data or stale staging', () => {
    const f = fixture({ failCopy: true });
    f.copy('0.6.5');
    f.put(win.join(base, `${version}.copy-123`, 'keep.txt'), 'keep');
    f.put('C:\\Temp\\unrelated.txt', 'keep');
    f.start(); f.prune();
    expect(f.errors.join(' ')).toContain('disk full');
    expect(f.launches).toEqual([]);
    expect(f.env.POLYGATE_RELOCATED).toBeUndefined();
    expect(f.removed).toEqual([win.join(base, `${version}.copy-unique`)]);
    expect(f.ofs.existsSync(win.join(base, '0.6.5', 'Polygate.exe'))).toBe(true);
    expect(f.ofs.readFileSync('C:\\Temp\\unrelated.txt')).toBe('keep');
  });

  test('path and environment alone do not prove the running cache is owned', () => {
    const f = fixture({ exe: win.join(base, version, 'Polygate.exe') });
    f.copy('0.6.5'); f.start(); f.prune();
    expect(f.launches).toEqual([]); expect(f.removed).toEqual([]);
    expect(f.env.POLYGATE_RELOCATED).toBeUndefined();
  });

  test('unowned target folders are preserved rather than replaced', () => {
    const f = fixture(); f.put(win.join(base, version, 'keep.txt'), 'keep');
    f.start(); f.prune();
    expect(f.launches).toEqual([]); expect(f.removed).toEqual([]);
    expect(f.ofs.readFileSync(win.join(base, version, 'keep.txt'))).toBe('keep');
  });

  test('junctions, symlinked markers and resolved aliases are never pruned', () => {
    const f = fixture({ exe: win.join(base, version, 'Polygate.exe') }); f.copy(version);
    const linked = f.copy('0.6.5'), alias = f.copy('0.6.4'), marker = f.copy('0.6.3');
    f.entries.set(f.key(linked), { kind: 'link', real: 'C:\\Outside' });
    f.entries.set(f.key(alias), { kind: 'dir', real: 'C:\\Outside' });
    f.entries.set(f.key(win.join(marker, '.polygate-copy')), { kind: 'link', data: '0.6.3 4 7 1234' });
    f.start(); f.prune(); expect(f.removed).toEqual([]);
  });

  test('a junction or alias in the cache ancestry prevents relocation and pruning', () => {
    for (const kind of ['dir', 'link'] as const) {
      const f = fixture(); f.copy('0.6.5');
      f.entries.set(f.key('C:\\Local\\Polygate'), { kind, real: 'C:\\Outside' });
      f.start(); f.prune(); expect(f.launches).toEqual([]); expect(f.removed).toEqual([]);
    }
  });

  test('development and non-Windows starts cannot clean copies', () => {
    for (const options of [{ packaged: false }, { platform: 'linux' }]) {
      const f = fixture({ ...options, exe: win.join(base, version, 'Polygate.exe') });
      f.copy(version); f.copy('0.6.5'); f.start(); f.prune();
      expect(f.launches).toEqual([]); expect(f.removed).toEqual([]);
    }
  });

  test('case variants identify the current copy and relative cache roots fail closed', () => {
    const current = fixture({ exe: win.join(base, version, 'Polygate.exe').toUpperCase() });
    current.copy(version); current.start(); current.prune();
    expect(current.launches).toEqual([]); expect(current.removed).toEqual([]);
    const relative = fixture(); relative.env.LOCALAPPDATA = 'relative-cache';
    relative.start(); relative.prune();
    expect(relative.launches).toEqual([]); expect(relative.removed).toEqual([]);
  });
});

test('the update acknowledgement requires a rendered workspace and a session that can read this desktop version', async () => {
  const result = 'C:\\Profile\\update-result.json', ack = 'C:\\Profile\\update-started.json';
  for (const [view, status, mode, gatewayVersion, ready] of [
    ['.loading', 200, 'desktop', version, false], ['.login', 200, 'desktop', version, false],
    ['.page-content', 401, 'desktop', version, false], ['.mini', 503, 'desktop', version, false],
    ['.page-content', 200, 'server', version, false], ['.page-content', 200, 'desktop', '0.6.5', false],
    ['.page-content', 200, 'desktop', version, true], ['.mini', 200, 'desktop', version, true],
  ] as const) {
    const f = fixture(); f.start();
    const folder = f.env.PORTABLE_EXECUTABLE_DIR, suffix = 'a'.repeat(32) + '.exe';
    const backup = (stamp: string) => win.join(folder, '.polygate-backup-' + stamp + suffix);
    const fresh = backup(Date.now() + '-'), stale = backup((Date.now() - 8 * 86400000) + '-'), legacy = backup('');
    for (const file of [fresh, stale, legacy]) f.put(file, 'old exe'); // All mtimes predate this update.
    let calls = 0;
    const renderer = {
      document: { querySelector: (selectors: string) => selectors.split(', ').includes('#root ' + view) }, AbortSignal,
      fetch: async (url: string, init: RequestInit) => {
        if (url !== '/admin/state' || init.credentials !== 'same-origin' || init.headers) throw new Error('Not the dashboard session');
        calls++;
        return Response.json({ server: { mode }, version: gatewayVersion }, { status });
      },
    };
    await f.confirm({ isDestroyed: () => false, webContents: { executeJavaScript: (probe: string) => runInNewContext(probe, renderer) } }, result);
    expect(f.ofs.existsSync(ack)).toBe(ready);
    expect(calls > 0).toBe(!['.loading', '.login'].includes(view));
    if (ready) expect(JSON.parse(f.ofs.readFileSync(ack)!)).toMatchObject({ version, exe: f.env.PORTABLE_EXECUTABLE_FILE });
    expect(f.ofs.existsSync(fresh)).toBe(true); expect(f.ofs.existsSync(legacy)).toBe(true);
    expect(f.ofs.existsSync(stale)).toBe(!ready);
  }
});

const windowsTest = process.platform === 'win32' ? test : test.skip;
windowsTest('success and rollback helper launches clear only the inherited relocation flag', () => {
  // Execute the actual two launch statements, not the updater. Start-Process and Test-Path are inert stubs.
  const statements = helperSource.split(/\r?\n/).filter(line => line.includes('Start-Process -FilePath $final') || line.includes('Start-Process -FilePath $config.target'));
  expect(statements).toHaveLength(2);
  for (const statement of statements) {
    const code = `
      $ErrorActionPreference = 'Stop'
      $NoLaunch = $false; $final = 'fixture.exe'; $targetDir = 'C:\\fixture'
      $config = @{ target = 'C:\\fixture\\old.exe' }
      function Test-Path { return $true }
      function Start-Process {
        param($FilePath, $WorkingDirectory)
        @{ relocated = $env:POLYGATE_RELOCATED; portable = $env:PORTABLE_EXECUTABLE_FILE; unrelated = $env:POLYGATE_CLEANUP_TEST } | ConvertTo-Json -Compress
      }
      ${statement}
    `;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], {
      encoding: 'utf8', windowsHide: true, timeout: 30000,
      env: { ...process.env, POLYGATE_RELOCATED: '1', PORTABLE_EXECUTABLE_FILE: 'fixture portable.exe', POLYGATE_CLEANUP_TEST: 'keep' },
    });
    expect(result.error).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
    const launched = JSON.parse(result.stdout.trim());
    expect(launched.relocated || '').toBe(''); expect(launched.portable).toBe('fixture portable.exe'); expect(launched.unrelated).toBe('keep');
  }
}, 65000);

import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const installer = readFileSync(path.join(import.meta.dir, '..', 'install.sh'), 'utf8').replaceAll('\r\n', '\n');
const prune = installer.match(/^prune_releases\(\) \{\n[\s\S]*?^\}/m)?.[0];
if (!prune) throw new Error('Cannot locate the actual installer pruning function');
// GNU readlink and Linux path semantics are part of the installer contract; never launch WSL bash on Windows.
const shellTest = test.skipIf(process.platform !== 'linux' || !existsSync('/bin/bash'));
const names = ['20261117000100-100', '20261117000200-200', '20261117000300-300'];
const archiveTime = new Date('2026-01-01T00:00:00Z');
// This is the exact v0.6.5 cleanup rule. It is kept here as a regression fixture,
// not as a supported implementation: an installed v0.6.5 updater cannot be patched
// by changing this checkout.
const legacyPrune = `prune_releases() {
  local d
  ls -1dt /opt/polygate/releases/*/ 2>/dev/null | tail -n +3 | while read -r d; do case "$d" in /opt/polygate/releases/*) rm -rf -- "$d" ;; esac; done
}`;

function fixture(run: (f: {
  root: string;
  releases: string;
  release: (name: string, time?: Date) => string;
  prune: (old?: string) => void;
  pruneLegacy: (old?: string) => void;
}) => void) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'polygate-retention-'));
  const root = path.join(scratch, "install path 'quoted' $literal [glob]");
  const releases = path.join(root, 'releases');
  mkdirSync(releases, { recursive: true });
  try {
    run({
      root, releases,
      release(name, time = archiveTime) {
        const dir = path.join(releases, name);
        mkdirSync(path.join(dir, 'install'), { recursive: true });
        writeFileSync(path.join(dir, 'install', 'polygate'), '# polygate-cli\n');
        writeFileSync(path.join(dir, 'sentinel'), name);
        utimesSync(dir, time, time);
        return dir;
      },
      prune(old) {
        // Execute only the real function, relocating every install path to this test's scratch.
        const script = 'set -Eeuo pipefail\n' + prune!.replaceAll('/opt/polygate', '${FIXTURE_ROOT}')
          + '\nif [ "$#" -gt 0 ]; then old=$1; fi\nprune_releases\n';
        expect(script).not.toContain('/opt/polygate');
        const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', script, 'retention-test', ...(old === undefined ? [] : [old])], {
          cwd: scratch, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', FIXTURE_ROOT: root }, encoding: 'utf8', timeout: 10000,
        });
        expect({ status: result.status, signal: result.signal, error: result.error?.message, stderr: result.stderr })
          .toEqual({ status: 0, signal: null, error: undefined, stderr: '' });
      },
      pruneLegacy(old) {
        // Quote the scratch root because this fixture also exercises paths with
        // spaces; the installed /opt/polygate path itself has no spaces.
        const script = 'set -Eeuo pipefail\n' + legacyPrune.replaceAll('/opt/polygate', '"${FIXTURE_ROOT}"')
          + '\nif [ "$#" -gt 0 ]; then old=$1; fi\nprune_releases\n';
        expect(script).not.toContain('/opt/polygate');
        const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', script, 'retention-test', ...(old === undefined ? [] : [old])], {
          cwd: scratch, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', FIXTURE_ROOT: root }, encoding: 'utf8', timeout: 10000,
        });
        expect({ status: result.status, signal: result.signal, error: result.error?.message, stderr: result.stderr })
          .toEqual({ status: 0, signal: null, error: undefined, stderr: '' });
      },
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

shellTest('retains current and previous after three installs with identical archive mtimes', () => {
  fixture(f => {
    const dirs = names.map(name => f.release(name));
    symlinkSync(dirs[2], path.join(f.root, 'current'));
    f.prune(dirs[1]);
    expect(readdirSync(f.releases).sort()).toEqual(names.slice(1));
    expect(readFileSync(path.join(f.root, 'current', 'sentinel'), 'utf8')).toBe(names[2]);
    expect(readFileSync(path.join(dirs[1], 'sentinel'), 'utf8')).toBe(names[1]);
  });
});

shellTest('retains a downgrade with the oldest archive mtime rather than the two newest archives', () => {
  fixture(f => {
    f.release(names[0], new Date('2026-11-01T00:00:00Z'));
    const previous = f.release(names[1], new Date('2026-11-02T00:00:00Z'));
    const current = f.release(names[2], new Date('2025-01-01T00:00:00Z'));
    symlinkSync(current, path.join(f.root, 'current'));
    f.prune(previous);
    expect(readdirSync(f.releases).sort()).toEqual(names.slice(1));
    expect(existsSync(path.join(f.root, 'current', 'sentinel'))).toBe(true);
  });
});

shellTest('the v0.6.5 layout demonstrates why the new installer must be run locally', () => {
  fixture(f => {
    const rollback = f.release(names[0], new Date('2026-01-01T00:00:00Z'));
    f.release(names[1], new Date('2026-11-02T00:00:00Z'));
    const incoming = f.release(names[2], new Date('2026-11-03T00:00:00Z'));
    symlinkSync(incoming, path.join(f.root, 'current'));

    // The stock updater keeps the two newest directories and can remove the
    // active rollback target when an unrelated historical release is newer.
    f.pruneLegacy(rollback);
    expect(readdirSync(f.releases).sort()).toEqual(names.slice(1));
    expect(existsSync(rollback)).toBe(false);
  });
});

shellTest('canonicalizes relative current and previous targets relative to the installation, not cwd', () => {
  fixture(f => {
    names.forEach(name => f.release(name));
    symlinkSync(`releases/../releases/${names[2]}`, path.join(f.root, 'current'));
    f.prune(`releases/../releases/${names[1]}`);
    expect(readdirSync(f.releases).sort()).toEqual(names.slice(1));
  });
});

shellTest('without a previous target retains only current, and handles an empty releases directory', () => {
  fixture(f => {
    const current = f.release(names[2]);
    f.release(names[0]);
    symlinkSync(current, path.join(f.root, 'current'));
    f.prune();
    expect(readdirSync(f.releases)).toEqual([names[2]]);
    f.prune('');
    f.release(names[0]);
    f.prune(path.join(f.releases, 'missing'));
    expect(readdirSync(f.releases)).toEqual([names[2]]);
    f.release(names[0]);
    f.prune(current);
    expect(readdirSync(f.releases)).toEqual([names[2]]);
    rmSync(current, { recursive: true });
    f.prune();
    expect(readdirSync(f.releases)).toEqual([]);
  });
});

shellTest('ignores a previous target outside releases without touching it', () => {
  fixture(f => {
    const outside = path.join(f.root, 'releases-other');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'sentinel'), 'keep');
    f.release(names[0]);
    symlinkSync(f.release(names[2]), path.join(f.root, 'current'));
    f.prune(outside);
    expect(readdirSync(f.releases)).toEqual([names[2]]);
    expect(readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('keep');
  });
});

for (const target of ['missing', 'releases-other', 'releases', `releases/${names[0]}/install`]) {
  shellTest(`does not prune when current resolves to ${target} instead of a direct release`, () => {
    fixture(f => {
      names.forEach(name => f.release(name));
      mkdirSync(path.join(f.root, 'releases-other'));
      symlinkSync(target, path.join(f.root, 'current'));
      f.prune(path.join(f.releases, names[1]));
      expect(readdirSync(f.releases).sort()).toEqual(names);
    });
  });
}

shellTest('leaves foreign entries, symlink directories and symlink ownership markers untouched', () => {
  fixture(f => {
    const current = f.release(names[2]);
    symlinkSync(current, path.join(f.root, 'current'));
    const outside = path.join(f.root, 'foreign');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'polygate'), '# polygate-cli\n');
    writeFileSync(path.join(outside, 'sentinel'), 'keep');
    symlinkSync(outside, path.join(f.releases, names[0]));
    symlinkSync(current, path.join(f.releases, names[1]));
    mkdirSync(path.join(f.releases, '20261117000400-400')); // Installer-shaped name without ownership evidence.
    const linkedInstall = path.join(f.releases, '20261117000500-500');
    mkdirSync(linkedInstall);
    symlinkSync(outside, path.join(linkedInstall, 'install'));
    const linkedMarker = path.join(f.releases, '20261117000600-600');
    mkdirSync(path.join(linkedMarker, 'install'), { recursive: true });
    symlinkSync(path.join(outside, 'polygate'), path.join(linkedMarker, 'install', 'polygate'));
    const foreignMarker = f.release('20261117000700-700');
    writeFileSync(path.join(foreignMarker, 'install', 'polygate'), 'not owned');
    writeFileSync(path.join(f.releases, '20261117000800-800'), 'ordinary file');
    f.release('notes with spaces\nand newline');
    f.release('.hidden');
    const before = readdirSync(f.releases).sort();
    const stale = f.release('20261117000900-900');
    symlinkSync(outside, path.join(stale, 'external-data'));
    f.prune();
    expect(readdirSync(f.releases).sort()).toEqual(before);
    expect(lstatSync(path.join(f.releases, names[0])).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('keep');
  });
});

shellTest('does not traverse a symlinked releases root', () => {
  fixture(f => {
    rmSync(f.releases, { recursive: true });
    const outside = path.join(f.root, 'foreign');
    mkdirSync(outside);
    symlinkSync(outside, f.releases);
    names.forEach(name => f.release(name));
    symlinkSync(path.join(f.releases, names[2]), path.join(f.root, 'current'));
    f.prune(path.join(f.releases, names[1]));
    expect(readdirSync(outside).sort()).toEqual(names);
    expect(lstatSync(f.releases).isSymbolicLink()).toBe(true);
  });
});

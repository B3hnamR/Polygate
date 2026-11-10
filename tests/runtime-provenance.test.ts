import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const bytes = (path: string) => readFileSync(new URL(path, root));
const text = (path: string) => bytes(path).toString('utf8');
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const gitBlob = (data: Uint8Array) => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');

describe('retained runtime provenance (offline source contracts)', () => {
  test('retains the exact upstream license blobs, not guessed license templates', () => {
    const blobs = {
      'LICENSE.md': '3e1b37f1c940c9f37da76d82a38b1246b9952061',
      'JavaScriptCore-COPYING.LIB': '87c4a33dd850415a33a816146eaf09a07912c4d6',
      'TinyCC-COPYING': '223ede7de3ec74eb86253f9ce9ed7ba3c5aa9130',
    };
    for (const [file, expected] of Object.entries(blobs)) {
      // Git may convert LF to CRLF on Windows; preserve all other upstream bytes.
      expect(gitBlob(Buffer.from(text(`vendor/licenses/bun-1.4.4/${file}`).replace(/\r\n/g, '\n')))).toBe(expected);
    }
    const notices = text('THIRD_PARTY_NOTICES.md');
    for (const pin of ['38afee6c84fcf48c0edb2466aa4b27d287a59c30', 'd6375c72affe0f70222cdcb45012b10f0bf3a9d5', '05f0fafaa3be31e31d7b4b5c17dc60f62c991171']) expect(notices).toContain(pin);
    expect(notices).toContain('Unresolved before asserting complete binary redistribution compliance');
    expect(notices).toContain('does not make an unfulfilled three-year written offer');
  });

  test('all distribution sources recursively retain the versioned notice directory', () => {
    const pkg = JSON.parse(text('package.json'));
    expect(pkg.build.extraResources).toContainEqual({ from: 'vendor/licenses', to: 'licenses', filter: ['**/*'] });
    expect(pkg.build.extraResources).toContainEqual({ from: 'resources/warp/sha256.txt', to: 'warp/sha256.txt' });
    expect(text('scripts/build-linux.sh')).toContain('cp -R vendor/licenses "$pkg/vendor/licenses"');
    expect(text('scripts/build-linux.sh')).toContain('resources/warp/sha256.txt "$pkg/warp/"');
    expect(text('Dockerfile')).toContain('COPY vendor/licenses /app/vendor/licenses');
    expect(text('Dockerfile')).toContain('COPY resources/warp /app/warp');
    expect(text('scripts/build-linux.sh')).toContain('[ "$BUN_VERSION" = 1.4.4 ]');
  });

  test('supplied helper identity matches the manifest, without executing helpers', () => {
    const manifest = text('resources/warp/sha256.txt').trim().split(/\r?\n/);
    const expectedNames = ['usque-linux-amd64', 'usque-linux-arm64', 'usque-windows-amd64.exe'];
    const actualNames: string[] = [];
    for (const line of manifest) {
      const match = /^([a-f0-9]{64})\s+\*?(usque-(?:linux-(?:amd64|arm64)|windows-amd64\.exe))$/.exec(line);
      expect(match).not.toBeNull();
      if (!match) throw new Error('Unexpected helper manifest entry');
      actualNames.push(match[2]);
      expect(sha256(bytes(`resources/warp/${match[2]}`))).toBe(match[1]);
    }
    expect(actualNames.sort()).toEqual(expectedNames);
  });

  test('reproduction recipe compares safely and records controlled inputs', () => {
    const script = text('scripts/build-warp-helper.sh');
    for (const contract of [
      'USQUE_COMMIT=6aa03fc97d12848dce34eedbd187fb1077b5d1ea',
      'MODE=${1:---compare}', 'OUT=${OUT:-build/warp-reproduction}',
      'GOTOOLCHAIN=local GOENV=off GOFLAGS= GOWORK=off',
      'GOPROXY=${GOPROXY:-off}', 'SOURCE_DATE_EPOCH=',
      '-mod=readonly -trimpath -buildvcs=false', '-s -w -buildid=',
      'source_archive_sha256=', 'patch_sha256=', 'script_sha256=',
      'go_mod_sha256=', 'go_sum_sha256=', 'go version -m',
      'Comparison OUT must not be resources/warp.', 'exit "$status"',
      'Refusing symlink output:', 'Comparison output aliases a supplied file:',
    ]) expect(script).toContain(contract);
    expect(script).not.toContain('sha256sum usque-*');
    expect(script).not.toContain('shasum -a 256 usque-*');
    expect(text('resources/warp/README.md')).toContain('no patched\nsource rebuild or match was demonstrated');
  });
});

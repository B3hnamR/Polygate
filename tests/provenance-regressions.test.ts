import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Read-only contracts: never execute the app, helpers, installers or build scripts.
const root = path.resolve(import.meta.dir, '..');
const bytes = (file: string) => readFileSync(path.join(root, file));
const text = (file: string) => bytes(file).toString('utf8').replace(/\r\n/g, '\n');
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const notices = text('THIRD_PARTY_NOTICES.md');
const retained = [
  ['@fontsource/barlow', 'fontsource-barlow-LICENSE', '4877e0c1b66f0b16cc3ebc4801c4def24c06252f618b9229428b20c7387aa0c0'],
  ['@fontsource/barlow-condensed', 'fontsource-barlow-condensed-LICENSE', '046ee27d8bddc6b6ee08eee53c96dbf3ec1f6df561644e018507dd8ffcb11d31'],
  ['@fontsource/doto', 'fontsource-doto-LICENSE', '33cbb094aa3c5d82a2f2f80ae4c0310e6a4aedf54eac49c52662d5f77ee7265f'],
  ['react', 'react-LICENSE', 'da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93'],
  ['react-dom', 'react-LICENSE', 'da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93'],
  ['scheduler', 'react-LICENSE', 'da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93'],
  ['lucide-react', 'lucide-react-LICENSE', '1e7290b35280a048667bbf0ebabac1c7fd52a75300e8b2946ac165715997f2bc'],
] as const;

test('retained notices match complete installed upstream notices and recorded content', () => {
  for (const [pkg, file, digest] of retained) {
    const notice = text(`vendor/licenses/${file}`);
    expect(notice).toBe(text(`node_modules/${pkg}/LICENSE`));
    expect(sha256(notice)).toBe(digest);
    expect(notices).toContain(`vendor/licenses/${file}`);
  }
});

test('every Fontsource import in the dashboard entry point has a retained notice', () => {
  const fonts = [...new Set([...text('src/main.tsx').matchAll(/['"](@fontsource\/[^/]+)\//g)].map(match => match[1]))];
  expect(fonts.sort()).toEqual(['@fontsource/barlow', '@fontsource/barlow-condensed', '@fontsource/doto']);
  for (const font of fonts) expect(retained.some(([pkg]) => pkg === font)).toBe(true);
});

test('desktop, Linux and Docker packaging preserve the entire retained notice directory', () => {
  const pkg = JSON.parse(text('package.json'));
  expect(pkg.build.extraResources).toContainEqual({ from: 'vendor/licenses', to: 'licenses', filter: ['**/*'] });
  expect(pkg.build.extraResources).toContainEqual({ from: 'THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' });
  const linux = text('scripts/build-linux.sh');
  expect(linux).toContain('cp -R vendor/licenses "$pkg/vendor/licenses"');
  expect(linux).toContain('cp install.sh package.json README.md LICENSE THIRD_PARTY_NOTICES.md "$pkg/"');
  const docker = text('Dockerfile').slice(text('Dockerfile').lastIndexOf('\nFROM '));
  expect(docker).toContain('COPY vendor/licenses /app/vendor/licenses');
  expect(docker).toContain('COPY LICENSE THIRD_PARTY_NOTICES.md /app/');
});

test('supplied WARP helper hashes match their manifest without executing any helper', () => {
  const entries = text('resources/warp/sha256.txt').trim().split('\n').map(line => {
    const match = /^([a-f0-9]{64}) \*(usque-[a-z0-9.-]+)$/.exec(line);
    expect(match).not.toBeNull();
    return { digest: match![1], file: match![2] };
  });
  expect(entries.map(entry => entry.file).sort()).toEqual(['usque-linux-amd64', 'usque-linux-arm64', 'usque-windows-amd64.exe']);
  for (const { digest, file } of entries) {
    expect(sha256(bytes(`resources/warp/${file}`))).toBe(digest);
    expect(notices).toContain(digest);
  }
});

test('provenance distinguishes hash identity from unverified runtime notices and rebuilds', () => {
  expect(notices).toContain('Unresolved before asserting complete binary redistribution compliance');
  expect(notices).toContain('not that the patch reproduces them');
  expect(notices).toContain('no rebuild was performed');
});

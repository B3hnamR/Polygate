import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resourceManifest, verifyResources } from '../scripts/build-desktop';
import { expectedWindowsNativeTests, verifyWindowsNativeReport } from '../scripts/verify-windows-native-report';

// Importing the verifier never runs the desktop builder, Electron, or a runtime.
const root = path.resolve(import.meta.dir, '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const ci = read('.github/workflows/ci.yml');
const release = read('.github/workflows/release.yml');
const pkg = JSON.parse(read('package.json'));

test('the native gate selects exactly the seven Windows-only regression cases', () => {
  const command = pkg.scripts['test:windows-native'];
  const names = command.match(/--test-name-pattern "([^"]+)"/)![1].split('|');
  expect(names).toHaveLength(7);
  expect(new Set(names).size).toBe(7);
  expect(names).toEqual([...expectedWindowsNativeTests]);
  for (const name of names) expect(read(name.includes('case') || name.includes('Undo coalesces') ? 'tests/agent-integrity-regressions.test.ts' : 'tests/updates.test.ts')).toContain(name);
  expect(command).toContain('tests/updates.test.ts tests/agent-integrity-regressions.test.ts');
  expect(command).toContain('--reporter=junit --reporter-outfile=build/verification/windows-native.xml');
});

test('Windows CI is an ephemeral VM with OS egress blocking and fail-closed native evidence', () => {
  const windows = ci.slice(ci.indexOf('\n  windows:'));
  expect(windows).toContain('runs-on: windows-2025');
  expect(windows).toContain('timeout-minutes: 30');
  expect(windows).toContain('persist-credentials: false');
  expect(windows).not.toContain('secrets.');
  expect(windows).not.toContain('self-hosted');
  expect(windows).toContain('Framework64\\v4.0.30319\\csc.exe');
  expect(windows).toContain('New-NetFirewallRule');
  expect(windows).toContain('-Program $program');
  expect(windows).toContain("-Direction Outbound -Action Block -Profile Any -RemoteAddress '0.0.0.0-126.255.255.255','128.0.0.0-255.255.255.255','::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'");
  expect(windows.indexOf('New-NetFirewallRule')).toBeLessThan(windows.indexOf('npm run check'));
  for (const command of ['npm run check', 'bun test tests', 'npm run test:windows-native', 'npm run build:ui', 'npm run verify:ui']) expect(windows).toContain(command);
  expect(windows).toContain("$report.SelectNodes('//testcase')");
  expect(windows).toContain("name = $_.GetAttribute('name')");
  expect(windows).toContain('.//skipped|.//failure|.//error|.//flakyFailure|.//rerunFailure');
  expect(windows).toContain('ConvertTo-Json -InputObject $cases -Depth 3 -Compress | bun scripts/verify-windows-native-report.ts');
  expect(windows).not.toContain('$cases.Count -ne 7');
  expect(windows).toContain('Dynamically created/renamed executables are NOT covered');
  expect(windows).not.toContain('Block target toolchains and descendants');
  expect(windows).toContain('} finally {');
  expect(windows).toContain('| Remove-NetFirewallRule');
  expect(windows.indexOf('npm run verify:ui')).toBeLessThan(windows.indexOf('| Remove-NetFirewallRule'));
});

test('native reporter fixture ignores unrelated filter skips but requires the exact seven passing names', () => {
  // Records produced by the workflow's XML conversion: Bun includes skipped
  // filtered-out tests alongside the seven intended cases in the same report.
  const selected = expectedWindowsNativeTests.map(name => ({ name, blocked: false }));
  const unrelated = Array.from({ length: 26 }, (_, index) => ({ name: `unrelated filtered case ${index}`, blocked: true }));
  const fixture = [...selected, ...unrelated];
  expect(verifyWindowsNativeReport(fixture)).toBe(7);
  expect(() => verifyWindowsNativeReport(fixture.slice(1))).toThrow('Missing native testcases');
  expect(() => verifyWindowsNativeReport([...fixture, selected[0]])).toThrow('Duplicate native testcase');
  expect(() => verifyWindowsNativeReport([...fixture, { ...selected[0], name: selected[0].name + ' extra' }])).toThrow('Unexpected matching native testcase');
  for (const name of expectedWindowsNativeTests) {
    expect(() => verifyWindowsNativeReport(fixture.map(entry => entry.name === name ? { ...entry, blocked: true } : entry))).toThrow('Native testcase skipped, failed, or retried');
  }
  expect(() => verifyWindowsNativeReport(fixture.map(entry => ({ ...entry, blocked: true })))).toThrow('Native testcase skipped, failed, or retried');
  expect(() => verifyWindowsNativeReport([])).toThrow('Missing native testcases');
  expect(() => verifyWindowsNativeReport({})).toThrow('Native report must contain');
  expect(() => verifyWindowsNativeReport([{ name: selected[0].name }])).toThrow('Invalid native testcase record');
});

test('release packaging and publication depend on this SHA passing CI validation', () => {
  expect(ci).toContain('  workflow_call:');
  expect(release).toContain('uses: ./.github/workflows/ci.yml');
  expect(release).toMatch(/\n  linux:\n    needs: validation/);
  expect(release).toMatch(/\n  windows:\n    needs: validation/);
  expect(release).toContain('needs: [linux, windows]');
  expect(release).toContain('pattern: polygate-*');
  const builder = read('scripts/build-desktop.ts');
  expect(builder).toContain("['dist', 'build/gateway.js', 'build/bin']");
  expect(builder).toContain("process.env.POLYGATE_ALLOW_ANY_BUN === '1'");
  expect(builder).toContain("['LICENSE', 'LICENSE.electron.txt']");
  expect(builder).toContain("['LICENSES.chromium.html', 'LICENSES.chromium.html']");
  expect(builder.indexOf('verifyResources(resources, manifest)')).toBeLessThan(builder.indexOf("writeFileSync(exe + '.sha256'"));
  expect(builder.indexOf("writeFileSync(exe + '.sha256'")).toBeLessThan(builder.indexOf('appendFileSync(process.env.GITHUB_OUTPUT'));
  expect(pkg.build.extraResources).toEqual(expect.arrayContaining([
    { from: 'LICENSE', to: 'LICENSE' },
    { from: 'vendor/licenses', to: 'licenses', filter: ['**/*'] },
    { from: 'vendor/bridge/LICENSE', to: 'licenses/bridge-LICENSE' },
    { from: 'vendor/protocols/LICENSE', to: 'licenses/protocols-LICENSE' },
    { from: 'build/bin/bun.exe', to: 'bin/bun.exe' },
  ]));
});

test('the resource verifier rejects modified, missing, unexpected, duplicate and escaping resources', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'polygate-resource-gate-'));
  const source = path.join(temp, 'source'), packaged = path.join(temp, 'packaged');
  mkdirSync(source); mkdirSync(packaged); mkdirSync(path.join(source, 'licenses')); mkdirSync(path.join(packaged, 'licenses'));
  writeFileSync(path.join(source, 'licenses', 'bun-LICENSE'), 'runtime notice');
  writeFileSync(path.join(packaged, 'licenses', 'bun-LICENSE'), 'runtime notice');
  writeFileSync(path.join(packaged, 'app.asar'), 'Electron-owned archive');
  const resources = [{ from: 'licenses', to: 'licenses' }];
  try {
    const manifest = resourceManifest(source, resources);
    expect(() => verifyResources(packaged, manifest)).not.toThrow();
    writeFileSync(path.join(packaged, 'licenses', 'bun-LICENSE'), 'changed');
    expect(() => verifyResources(packaged, manifest)).toThrow('Packaged file differs');
    rmSync(path.join(packaged, 'licenses', 'bun-LICENSE'));
    expect(() => verifyResources(packaged, manifest)).toThrow('Packaged file differs');
    writeFileSync(path.join(packaged, 'licenses', 'bun-LICENSE'), 'runtime notice');
    writeFileSync(path.join(packaged, 'stale.js'), 'leftover');
    expect(() => verifyResources(packaged, manifest)).toThrow('Unexpected packaged resource');
    expect(() => resourceManifest(source, [...resources, ...resources])).toThrow('Duplicate resource');
    expect(() => resourceManifest(source, [{ from: '../packaged', to: 'licenses' }])).toThrow('Resource paths');
    expect(() => resourceManifest(source, [{ from: 'licenses', to: '../escape' }])).toThrow('Resource paths');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('resource manifests refuse directory aliases instead of hashing outside the source', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'polygate-resource-link-'));
  mkdirSync(path.join(temp, 'licenses')); mkdirSync(path.join(temp, 'outside'));
  try {
    symlinkSync(path.join(temp, 'outside'), path.join(temp, 'licenses', 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => resourceManifest(temp, [{ from: 'licenses', to: 'licenses' }])).toThrow('Untrusted resource entry');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

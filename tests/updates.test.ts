import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { API_URL, createReleaseChecker, isNewer, releaseInfo } from '../desktop/releases.cjs';
import { createPortableUpdater, downloadRelease, fetchAsset, portableTarget, startHelper } from '../desktop/updater.cjs';

const bytes = Buffer.from('MZ harmless update fixture');
const sha = createHash('sha256').update(bytes).digest('hex');
const name = 'Polygate-0.3.0-Windows-x64.exe';
const releaseData = () => ({ draft: false, prerelease: false, tag_name: 'v0.3.0', assets: [
  { name, browser_download_url: `https://github.com/B3hnamR/Polygate/releases/download/v0.3.0/${name}`, size: bytes.length, digest: 'sha256:' + sha },
  { name: name + '.sha256', browser_download_url: `https://github.com/B3hnamR/Polygate/releases/download/v0.3.0/${name}.sha256`, size: 97 },
] });
const fixtureFetch = (options: {badHash?: boolean; truncated?: boolean} = {}) => (async (url: string | URL | Request) => {
  const target = String(url);
  if (target === API_URL) return Response.json(releaseData());
  if (target.endsWith('.sha256')) return new Response(`${options.badHash ? '0'.repeat(64) : sha} *${name}\n`);
  return new Response(options.truncated ? bytes.subarray(0, 4) : bytes);
}) as typeof fetch;
function temporary(prefix: string) { return mkdtempSync(path.join(tmpdir(), prefix)); }
function cleanup(directory: string) {
  // Test-created folders only; resolve and verify the boundary before recursive removal on Windows.
  if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('polygate-update')) throw new Error('Unsafe fixture cleanup');
  rmSync(directory, { recursive: true, force: true });
}

describe('stable release checks', () => {
  test('compares versions numerically and never proposes a downgrade', () => {
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.2.0', '0.2.0')).toBe(false);
    expect(isNewer('0.2.0', '0.3.0')).toBe(false);
    expect(isNewer('0.2.0', '0.2.0-beta.1')).toBe(true);
    expect(isNewer('0.2.0', '0.2.0+local')).toBe(false);
    expect(() => isNewer('latest', '0.2.0')).toThrow();
  });
  test('rejects drafts, prereleases, malformed versions, and assets from another source', () => {
    expect(() => releaseInfo({ ...releaseData(), draft: true })).toThrow();
    expect(() => releaseInfo({ ...releaseData(), prerelease: true })).toThrow();
    expect(() => releaseInfo({ ...releaseData(), tag_name: 'v0.3.0-beta' })).toThrow();
    const data = releaseData(); data.assets[0].browser_download_url = 'https://example.com/update.exe';
    const result = releaseInfo(data);
    expect(result.assets.some(asset => asset.name === name)).toBe(false);
    expect(result.url).toBe('https://github.com/B3hnamR/Polygate/releases/tag/v0.3.0');
  });
  test('coalesces concurrent checks, caches for six hours, and limits repeated manual checks', async () => {
    let calls = 0, clock = 100000;
    const checker = createReleaseChecker({ version: '0.2.0', kind: 'linux', now: () => clock, fetcher: (async () => { calls++; return Response.json(releaseData()); }) as unknown as typeof fetch });
    const [first, second] = await Promise.all([checker.check(), checker.check()]);
    expect(first.available).toBe(true); expect(second.kind).toBe('linux'); expect(calls).toBe(1);
    await checker.check(); await checker.check(true); expect(calls).toBe(1);
    clock += 61000; await checker.check(true); expect(calls).toBe(2);
    clock += 6 * 3600000; await checker.check(); expect(calls).toBe(3);
  });
  test('a failed check is not reported as up to date and is retried after backoff', async () => {
    let calls = 0, clock = 100000;
    const checker = createReleaseChecker({ version: '0.2.0', now: () => clock, fetcher: (async () => { calls++; throw new Error('secret network detail'); }) as unknown as typeof fetch });
    const result = await checker.check();
    expect(result.status).toBe('error'); expect(result.error).not.toContain('secret'); expect(result.checkedAt).toBe(clock);
    await checker.check(); expect(calls).toBe(1);
    clock += 15 * 60000; await checker.check(); expect(calls).toBe(2);
  });
  test('a current or newer local build is not offered an older release', async () => {
    for (const version of ['0.3.0', '0.4.0']) {
      const checker = createReleaseChecker({ version, fetcher: fixtureFetch() });
      const result = await checker.check(); expect(result.available).toBe(false); expect(result.status).toBe('current');
    }
  });
});

describe('Windows portable downloads', () => {
  test('requires a packaged Windows portable executable', () => {
    expect(portableTarget('C:\\Apps\\Polygate.exe', false, 'win32')).toBe('');
    expect(portableTarget('Polygate.exe', true, 'win32')).toBe('');
    expect(portableTarget('C:\\Apps\\Polygate.exe', true, 'linux')).toBe('');
    expect(portableTarget(undefined, true, 'win32')).toBe('');
  });
  test('rejects a redirect off GitHub without sending a second request', async () => {
    let calls = 0;
    const fetcher = async () => { calls++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/update.exe' } }); };
    await expect(fetchAsset(releaseInfo(releaseData()).assets[0].url, fetcher, AbortSignal.timeout(1000))).rejects.toThrow('left GitHub');
    expect(calls).toBe(1);
  });
  test('downloads verified executable bytes and reports progress', async () => {
    const directory = temporary('polygate-update-download-');
    try {
      const progress: number[] = [];
      const result = await downloadRelease(releaseInfo(releaseData()), directory, fixtureFetch(), (percent: number) => progress.push(percent));
      expect(readFileSync(result.staged)).toEqual(bytes); expect(result.expectedHash).toBe(sha); expect(progress.at(-1)).toBe(100);
    } finally { cleanup(directory); }
  });
  test('rejects checksum disagreement and truncated executables', async () => {
    for (const options of [{ badHash: true }, { truncated: true }]) {
      const directory = temporary('polygate-update-bad-');
      try { await expect(downloadRelease(releaseInfo(releaseData()), directory, fixtureFetch(options))).rejects.toThrow(); }
      finally { cleanup(directory); }
    }
  });
  test('prepares the helper before requesting restart and never modifies the running executable', async () => {
    const directory = temporary('polygate-update-main-');
    const target = path.join(directory, 'Portable app.exe'); writeFileSync(target, 'old executable');
    let ready = false, helperReady = false;
    try {
      const updater = createPortableUpdater({ version: '0.2.0', target, tempDir: directory, resultPath: path.join(directory, 'result.json'), fetcher: fixtureFetch(), onReady: () => { expect(helperReady).toBe(true); ready = true; }, launchHelper: async (_script: string, configPath: string) => {
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        expect(config.target).toBe(target); expect(config.expectedHash).toBe(sha); expect(readFileSync(config.staged)).toEqual(bytes); helperReady = true;
      } });
      const result = await updater.install(); expect(result.status).toBe('installing'); expect(ready).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('old executable');
    } finally { cleanup(directory); }
  });
  test('download and helper failures keep the app open and clean the staged download', async () => {
    for (const failHelper of [false, true]) {
      const directory = temporary('polygate-update-failed-'), target = path.join(directory, 'Old.exe'); writeFileSync(target, 'old');
      let quit = false;
      try {
        const updater = createPortableUpdater({ version: '0.2.0', target, tempDir: directory, resultPath: path.join(directory, 'result.json'), fetcher: fixtureFetch({ badHash: !failHelper }), onReady: () => { quit = true; }, launchHelper: async () => { throw new Error('helper unavailable'); } });
        const result = await updater.install(); expect(result.status).toBe('error'); expect(quit).toBe(false); expect(readFileSync(target, 'utf8')).toBe('old');
        expect(readdirSync(directory)).toEqual(['Old.exe']);
      } finally { cleanup(directory); }
    }
  });
  test('deduplicates install clicks and does not downgrade a current app', async () => {
    const directory = temporary('polygate-update-current-'), target = path.join(directory, 'Old.exe'); writeFileSync(target, 'old');
    let launches = 0;
    try {
      const updater = createPortableUpdater({ version: '0.3.0', target, tempDir: directory, resultPath: path.join(directory, 'result.json'), fetcher: fixtureFetch(), launchHelper: async () => { launches++; } });
      await Promise.all([updater.install(), updater.install()]); expect(launches).toBe(0); expect(updater.getState().available).toBe(false);
    } finally { cleanup(directory); }
  });
});

const windowsTest = process.platform === 'win32' ? test : test.skip;
describe('real Windows replacement helper', () => {
  for (const badHash of [false, true]) windowsTest(badHash ? 'rejects tampered bytes while preserving the original' : 'atomically replaces an executable with spaces and apostrophes in its path', () => {
    const directory = temporary('polygate-update-target-'), staging = temporary('polygate-update-');
    const target = path.join(directory, "My app's Polygate.exe"), staged = path.join(staging, 'update.exe'), resultPath = path.join(directory, 'result.json');
    writeFileSync(target, 'old executable'); writeFileSync(staged, bytes);
    const configPath = path.join(staging, 'update.json');
    writeFileSync(configPath, JSON.stringify({ target, staged, expectedHash: badHash ? '0'.repeat(64) : sha, parentPid: 0, resultPath, version: '0.3.0' }));
    const script = path.join(staging, 'apply-update.ps1'); writeFileSync(script, readFileSync(path.resolve('desktop/apply-update.ps1')));
    try {
      const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ConfigPath', configPath, '-NoLaunch'], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
      expect(run.error).toBeUndefined();
      expect(run.status, run.stdout + run.stderr).toBe(badHash ? 1 : 0);
      expect(readFileSync(target)).toEqual(badHash ? Buffer.from('old executable') : bytes);
      expect(JSON.parse(readFileSync(resultPath, 'utf8')).ok).toBe(!badHash);
      if (!badHash) { expect(existsSync(staging)).toBe(false); expect(readdirSync(directory).sort()).toEqual([path.basename(target), 'result.json'].sort()); }
    } finally { cleanup(directory); if (existsSync(staging)) cleanup(staging); }
  });
});

const csc = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const restartTest = process.platform === 'win32' && existsSync(csc) ? test : test.skip;
restartTest('one click downloads, verifies, closes the old process, replaces the file, and launches the replacement', async () => {
  const directory = temporary('polygate-update-restart-');
  const target = path.join(directory, 'Portable app.exe'), replacement = path.join(directory, 'replacement.exe');
  const marker = path.join(directory, 'launched.txt'), source = path.join(directory, 'Fixture.cs'), resultPath = path.join(directory, 'result.json');
  // A tiny windowless .NET fixture writes a marker and exits; no user app or installed gateway is involved.
  writeFileSync(source, 'using System; using System.IO; class Fixture { static void Main() { File.WriteAllText(Environment.GetEnvironmentVariable("POLYGATE_UPDATE_TEST_MARKER"), "replacement launched\\n" + System.Diagnostics.Process.GetCurrentProcess().Id); } }');
  const compiled = spawnSync(csc, ['/nologo', '/target:winexe', '/out:' + replacement, source], { encoding: 'utf8', windowsHide: true });
  expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
  const executable = readFileSync(replacement), expectedHash = createHash('sha256').update(executable).digest('hex');
  writeFileSync(target, 'old fixture executable');
  const oldProcess = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore', windowsHide: true });
  const previousMarker = process.env.POLYGATE_UPDATE_TEST_MARKER;
  process.env.POLYGATE_UPDATE_TEST_MARKER = marker;
  let staging = '', ready = false;
  try {
    const fetcher = (async (url: string | URL | Request) => {
      if (String(url) === API_URL) {
        const data = releaseData(); data.assets[0].size = executable.length; data.assets[0].digest = 'sha256:' + expectedHash; return Response.json(data);
      }
      return new Response(String(url).endsWith('.sha256') ? `${expectedHash} *${name}\n` : executable);
    }) as typeof fetch;
    const updater = createPortableUpdater({ version: '0.2.0', target, tempDir: tmpdir(), resultPath, fetcher,
      launchHelper: async (script, configPath, stageDir) => {
        staging = stageDir;
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        config.parentPid = oldProcess.pid; writeFileSync(configPath, JSON.stringify(config));
        await startHelper(script, configPath, stageDir);
        expect(readFileSync(target, 'utf8')).toBe('old fixture executable');
      },
      onReady: () => { ready = true; oldProcess.kill(); },
    });
    const update = await updater.install();
    expect(update.status, update.error).toBe('installing'); expect(ready).toBe(true);
    const deadline = Date.now() + 20000;
    while ((!existsSync(marker) || existsSync(staging)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    expect(existsSync(marker),JSON.stringify({oldExit:oldProcess.exitCode,oldSignal:oldProcess.signalCode,result:existsSync(resultPath)?readFileSync(resultPath,'utf8'):null,staging:existsSync(staging)?readdirSync(staging):[]})).toBe(true);
    const [message, fixturePid] = readFileSync(marker, 'utf8').trim().split('\n');
    expect(message).toBe('replacement launched');
    expect(Number(fixturePid)).toBeGreaterThan(0);
    // The marker is written just before exit. Wait for the fixture to release its executable before deleting test files.
    while (Date.now() < deadline) {
      try { process.kill(Number(fixturePid), 0); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(readFileSync(target)).toEqual(executable);
    expect(JSON.parse(readFileSync(resultPath, 'utf8')).ok).toBe(true);
    expect(existsSync(staging)).toBe(false);
  } finally {
    oldProcess.kill();
    if (previousMarker === undefined) delete process.env.POLYGATE_UPDATE_TEST_MARKER; else process.env.POLYGATE_UPDATE_TEST_MARKER = previousMarker;
    cleanup(directory); if (staging && existsSync(staging)) cleanup(staging);
  }
}, 30000);

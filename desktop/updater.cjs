const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createReleaseChecker, MAX_DOWNLOAD, readLimited } = require('./releases.cjs');

// Only GitHub's release-asset hosts may serve an update, and no cookies or application credentials are sent.
const GITHUB_HOSTS = ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'];
function assertGitHub(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !GITHUB_HOSTS.includes(parsed.hostname)) throw new Error('The update download left GitHub. Nothing was installed.');
}
// Electron's net.fetch cannot hand redirects back one at a time ("Redirect was cancelled"), and GitHub redirects every release asset to its
// download host, so the fetch follows them and the host it ended on is checked before a single byte is read.
async function fetchAsset(url, fetcher, signal) {
  assertGitHub(url);
  const response = await fetcher(url, { redirect: 'follow', signal, credentials: 'omit' });
  try { assertGitHub(response.url || url); } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`The update download failed (${response.status}). Try again.`); }
  return response;
}
async function downloadRelease(release, directory, fetcher, onProgress = () => {}) {
  const name = `Polygate-${release.version}-Windows-x64.exe`;
  const asset = release.assets.find(item => item.name === name);
  const checksum = release.assets.find(item => item.name === name + '.sha256');
  if (!asset || !checksum) throw new Error('This release has no Windows executable and checksum yet. Try again later.');
  const signal = AbortSignal.timeout(15 * 60 * 1000);
  const checksumResponse = await fetchAsset(checksum.url, fetcher, signal);
  const text = await readLimited(checksumResponse, 4096);
  const lines = text.trim().split(/\r?\n/);
  const match = lines.length === 1 && /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(lines[0]);
  if (!match || match[2] !== name) throw new Error('The update checksum file is invalid. Nothing was installed.');
  const expectedHash = match[1].toLowerCase();
  if (asset.digest && asset.digest !== expectedHash) throw new Error('The published update checksums disagree. Nothing was installed.');
  const response = await fetchAsset(asset.url, fetcher, signal);
  if (Number(response.headers.get('content-length')) > MAX_DOWNLOAD) throw new Error('The update download is too large.');
  const staged = path.join(directory, 'update.exe');
  const handle = await fs.promises.open(staged, 'wx');
  const hash = createHash('sha256'); let bytes = 0, lastProgress = 0, signature = Buffer.alloc(0);
  try {
    for await (const chunk of response.body || []) {
      bytes += chunk.byteLength;
      if (bytes > asset.size || bytes > MAX_DOWNLOAD) throw new Error('The update size does not match the release. Nothing was installed.');
      if (signature.length < 2) signature = Buffer.concat([signature, Buffer.from(chunk)]).subarray(0, 2);
      hash.update(chunk); await handle.writeFile(chunk);
      if (Date.now() - lastProgress > 200) { onProgress(Math.round(bytes / asset.size * 100)); lastProgress = Date.now(); }
    }
  } finally { await handle.close(); }
  if (bytes !== asset.size || hash.digest('hex') !== expectedHash || signature.toString('ascii') !== 'MZ') throw new Error('The update failed its checksum or executable check. Nothing was installed.');
  onProgress(100);
  return { staged, expectedHash };
}
function portableTarget(file, packaged, platform = process.platform) {
  return packaged && platform === 'win32' && typeof file === 'string' && path.win32.isAbsolute(file) && file.toLowerCase().endsWith('.exe') ? path.resolve(file) : '';
}
// Staging folders (a downloaded installer each) left by an update that was interrupted are removed after a day; the one in use is always newer.
function removeStaleStaging(tempDir) {
  try {
    for (const name of fs.readdirSync(tempDir)) {
      if (!name.startsWith('polygate-update-')) continue;
      const folder = path.join(tempDir, name);
      try { if (Date.now() - fs.statSync(folder).mtimeMs > 86400000) fs.rmSync(folder, { recursive: true, force: true }); } catch { /* in use or locked: leave it */ }
    }
  } catch { /* temp folder unreadable: nothing to clean */ }
}
function createPortableUpdater({ version, target, tempDir, resultPath, fetcher = fetch, onState = () => {}, onReady = () => {}, launchHelper = startHelper }) {
  let state, busy = false;
  const canInstall = !!target;
  const emit = patch => { state = { ...state, ...patch, kind: 'windows', canInstall }; onState({ ...state }); return { ...state }; };
  const checker = createReleaseChecker({ version, kind: 'windows', fetcher, onState: next => { if (!busy) emit(next); } });
  state = { ...checker.getState(), canInstall };
  const result = {
    getState: () => ({ ...state }),
    async check(force = false) { if (busy) return { ...state }; await checker.check(force); return { ...state }; },
    async install() {
      if (busy) return { ...state };
      if (!canInstall) return emit({ status: 'error', error: 'One-click updates are available in the packaged Windows portable app. Download the release to update this copy.' });
      busy = true; let directory;
      try {
        const checked = await checker.check(true);
        if (checked.status === 'error') throw new Error(checked.error);
        if (!checked.available) { busy = false; return emit(checked); }
        // Fail before asking the app to close if its original portable file is missing or read-only.
        const stat = fs.statSync(target);
        if (!stat.isFile()) throw new Error('The portable executable could not be found. Download the release to update this copy.');
        fs.accessSync(target, fs.constants.W_OK); fs.accessSync(path.dirname(target), fs.constants.W_OK);
        emit({ ...checked, status: 'downloading', progress: 0, error: '' });
        removeStaleStaging(tempDir);
        directory = fs.mkdtempSync(path.join(tempDir, 'polygate-update-'));
        const downloaded = await downloadRelease(checker.getRelease(), directory, fetcher, progress => emit({ progress }));
        const script = path.join(directory, 'apply-update.ps1'), configPath = path.join(directory, 'update.json');
        fs.writeFileSync(script, fs.readFileSync(path.join(__dirname, 'apply-update.ps1')));
        fs.writeFileSync(configPath, JSON.stringify({ ...downloaded, target, parentPid: process.pid, resultPath, version: checked.latestVersion }));
        await launchHelper(script, configPath, directory);
        emit({ status: 'installing', progress: 100 });
        onReady();
        return { ...state };
      } catch (error) {
        // Only remove the unique staging folder created in our own temp directory.
        try { if (directory && path.dirname(path.resolve(directory)) === path.resolve(tempDir) && path.basename(directory).startsWith('polygate-update-')) fs.rmSync(directory, { recursive: true, force: true }); } catch { /* A locked temporary file must not suppress the update error or keep the app busy. */ }
        busy = false;
        const message = error?.code === 'EACCES' || error?.code === 'EPERM' ? 'The app cannot replace this executable. Move it to a folder you can write to, then try again.' : error?.message || 'The update failed. Your current app has not changed.';
        return emit({ status: 'error', error: message, progress: undefined });
      }
    },
  };
  return result;
}
async function startHelper(script, configPath, directory) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const errorPath = path.join(directory, 'launcher-error.log'), errorLog = fs.openSync(errorPath, 'a');
  let helper;
  try { helper = spawn(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ConfigPath', configPath, '-Launch'], { windowsHide: true, stdio: ['ignore', 'ignore', errorLog] }); }
  finally { fs.closeSync(errorLog); }
  let failure;
  helper.once('error', error => { failure = error; });
  const ready = path.join(directory, 'ready');
  for (let i = 0; i < 100; i++) {
    if (failure) throw failure;
    if (helper.exitCode !== null && helper.exitCode !== 0) { const detail = fs.readFileSync(errorPath, 'utf8').trim().slice(0, 400); throw new Error(`The Windows update helper could not start (exit ${helper.exitCode}). Your app is still running.` + (detail ? ' ' + detail : '')); }
    if (fs.existsSync(ready)) { helper.unref(); return; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  try { helper.kill(); } catch { /* already gone */ }
  throw new Error('The Windows update helper did not start. Your app is still running.');
}
module.exports = { fetchAsset, downloadRelease, portableTarget, createPortableUpdater, startHelper };

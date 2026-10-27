// Shared by the Bun gateway and Electron. Only published stable releases from this repository are accepted.
const REPO = 'B3hnamR/Polygate';
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const MAX_DOWNLOAD = 512 * 1024 * 1024;

function versionParts(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value));
  if (!match) throw new Error('Invalid release version');
  return { numbers: match.slice(1, 4).map(BigInt), prerelease: match[4] || '' };
}
function isNewer(latest, current) {
  const a = versionParts(latest), b = versionParts(current);
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i];
  return !a.prerelease && !!b.prerelease;
}
function releaseInfo(data) {
  if (!data || data.draft !== false || data.prerelease !== false || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(data.tag_name)) throw new Error('No published stable release is available');
  const version = data.tag_name.slice(1);
  const prefix = `https://github.com/${REPO}/releases/download/${data.tag_name}/`;
  const assets = (Array.isArray(data.assets) ? data.assets : []).filter(asset =>
    typeof asset.name === 'string' && /^[A-Za-z0-9._-]+$/.test(asset.name) &&
    asset.browser_download_url === prefix + asset.name && Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= MAX_DOWNLOAD
  ).map(asset => ({ name: asset.name, url: asset.browser_download_url, size: asset.size, digest: /^sha256:[a-f0-9]{64}$/.test(asset.digest || '') ? asset.digest.slice(7) : undefined }));
  return { version, url: `https://github.com/${REPO}/releases/tag/${data.tag_name}`, assets };
}
async function readLimited(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Release response is too large');
  const chunks = []; let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error('Release response is too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function fetchLatestRelease(fetcher = fetch) {
  const response = await fetcher(API_URL, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Polygate-update-check' }, signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (response.status === 404) throw new Error('No published stable release is available');
  if (response.status === 403 || response.status === 429) throw new Error('GitHub is limiting update checks. Try again later.');
  if (!response.ok) throw new Error('GitHub could not check for updates. Try again later.');
  return releaseInfo(JSON.parse(await readLimited(response, 2 * 1024 * 1024)));
}
function createReleaseChecker({ version, kind = 'manual', fetcher = fetch, now = Date.now, onState = () => {} }) {
  versionParts(version);
  let state = { currentVersion: version, latestVersion: '', available: false, releaseUrl: RELEASES_URL, checkedAt: 0, status: 'idle', error: '', kind, canInstall: false };
  let release = null, pending, retryAt = 0;
  const set = patch => { state = { ...state, ...patch }; onState({ ...state }); return { ...state }; };
  return {
    getState: () => ({ ...state }),
    getRelease: () => release,
    check(force = false) {
      if (pending) return pending;
      if (now() < retryAt && (!force || now() - state.checkedAt < 60000)) return Promise.resolve({ ...state });
      set({ status: 'checking', error: '' });
      pending = (async () => {
        try {
          const latest = await fetchLatestRelease(fetcher);
          const available = isNewer(latest.version, version);
          release = latest; retryAt = now() + 6 * 60 * 60 * 1000;
          return set({ latestVersion: latest.version, available, releaseUrl: latest.url, checkedAt: now(), status: available ? 'available' : 'current', error: '' });
        } catch (error) {
          retryAt = now() + 15 * 60 * 1000;
          const message = error instanceof Error && /^(No published|GitHub)/.test(error.message) ? error.message : 'Could not reach GitHub to check for updates. Check your connection and try again.';
          return set({ status: 'error', checkedAt: now(), error: message });
        } finally { pending = undefined; }
      })();
      return pending;
    },
  };
}
module.exports = { REPO, RELEASES_URL, API_URL, MAX_DOWNLOAD, isNewer, releaseInfo, readLimited, fetchLatestRelease, createReleaseChecker };

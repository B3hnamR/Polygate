import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const text = (name: string) => readFileSync(new URL(name, root), 'utf8');
const script = fileURLToPath(new URL('scripts/fetch-wireproxy.py', root));
const hashes = {
  'wireproxy-windows-amd64.exe': 'b176b561fd8bf15d828fcab484cfd5b4fb941cb9f61807901ca64b955af27e1f',
  'wireproxy-linux-amd64': '70ae5e52223dac7974af8d98a321f14a0e1689d2b14655ebc8dadfa1ec69466d',
  'wireproxy-linux-arm64': '5852e32671afb8918c39c59330b85f833c187ed41b6b1f683c90b6bfd320f3fa',
  LICENSE: '12e05cf70e2876d0cfd1c649e1c0032f82a370b365dcccd7d5a03feee17f2625',
};

test('wireproxy public provenance and source-only checkout contract', () => {
  const manifest = Object.fromEntries(text('resources/surfshark/sha256.txt').trim().split(/\r?\n/).map(line => {
    const match = /^([a-f0-9]{64})  (\S+)$/.exec(line);
    if (!match) throw new Error('Invalid manifest');
    return [match[2], match[1]];
  }));
  expect(manifest).toEqual(hashes);
  expect(createHash('sha256').update(readFileSync(new URL('resources/surfshark/LICENSE', root))).digest('hex')).toBe(hashes.LICENSE);
  expect(text('.gitignore')).toContain('/resources/surfshark/wireproxy-*');
  const source = text('scripts/fetch-wireproxy.py');
  expect(source).toContain("VERSION = '1.1.3'");
  expect(source).toContain('https://github.com/windtf/wireproxy/releases/download/v1.1.3/');
  for (const digest of [
    'bce041ea9fe0f8a3351301dcbe29cdf6a523bb25cf9c62f17ebb5699a8051d0f',
    'e88c1d090740373fc606c1bafd81d9a5eadc642cce5667616e20e9d7a444f51c',
    '370e00bd2167960d1ecd1c3c1439715bbaa94a0a110a2040468670c9af6021b6',
  ]) expect(source).toContain(digest);
  expect(source).not.toMatch(/\.(?:extract|extractall)\(/);
  expect(source).not.toMatch(/subprocess|os\.system|urlretrieve/);
  const ci = text('.github/workflows/ci.yml');
  expect(ci.indexOf('python3 scripts/fetch-wireproxy.py all')).toBeLessThan(ci.indexOf('bun test tests'));
  expect(ci.indexOf('python scripts/fetch-wireproxy.py all')).toBeLessThan(ci.indexOf('New-NetFirewallRule'));
  expect(text('.github/workflows/release.yml')).toContain('python scripts/fetch-wireproxy.py windows-amd64');
});

test('desktop, Linux and Docker provision verified helpers before packaging', () => {
  const desktop = text('scripts/build-desktop.ts');
  const fetchDesktop = desktop.indexOf("Bun.spawnSync(['python', 'scripts/fetch-wireproxy.py', 'windows-amd64']");
  expect(fetchDesktop).toBeGreaterThan(-1);
  expect(fetchDesktop).toBeLessThan(desktop.indexOf("Bun.spawnSync([process.execPath, 'run', 'build']"));
  expect(fetchDesktop).toBeLessThan(desktop.indexOf('const manifest = resourceManifest(root, build.extraResources)'));
  expect(desktop).toContain("if (helper.exitCode !== 0) throw new Error('Verified wireproxy provisioning failed");
  const linux = text('scripts/build-linux.sh');
  const fetchLinux = linux.indexOf('python3 scripts/fetch-wireproxy.py "linux-$ARCH"');
  expect(fetchLinux).toBeGreaterThan(-1);
  expect(fetchLinux).toBeLessThan(linux.indexOf('cp "resources/surfshark/wireproxy-linux-$ARCH"'));
  expect(linux).toContain('set -euo pipefail');

  const docker = text('Dockerfile');
  const stageStart = docker.indexOf('FROM python:3.13-slim-bookworm AS wireproxy');
  const runtimeStart = docker.indexOf('FROM oven/bun:1.4.4\n', stageStart);
  expect(stageStart).toBeGreaterThan(-1);
  expect(runtimeStart).toBeGreaterThan(stageStart);
  const stage = docker.slice(stageStart, runtimeStart);
  expect(stage).toContain('apt-get install -y --no-install-recommends ca-certificates');
  expect(stage).toContain('COPY scripts/fetch-wireproxy.py ./scripts/fetch-wireproxy.py');
  expect(stage).toContain('COPY resources/surfshark/LICENSE resources/surfshark/README.md resources/surfshark/sha256.txt ./resources/surfshark/');
  expect(stage).toContain('RUN python scripts/fetch-wireproxy.py linux-amd64 && python scripts/fetch-wireproxy.py linux-arm64');
  expect(stage).not.toContain('windows-amd64');
  expect(stage).not.toContain('fetch-wireproxy.py all');
  expect(docker.slice(runtimeStart)).toContain('COPY --from=wireproxy /src/resources/surfshark /app/surfshark');
  expect(docker).not.toMatch(/^COPY resources\/surfshark\s/m);
  expect(text('.dockerignore').split(/\r?\n/)).toContain('resources/surfshark/wireproxy-*');
});

test('wireproxy downloader validates local fixtures, immutable pins and selective tar reads without networking', () => {
  // Import the actual helper without __main__; all writes belong to TemporaryDirectory.
  // Patch urlopen before calling provisioning. No downloaded executable is ever run.
  const fixture = String.raw`
import gzip, hashlib, importlib.util, io, pathlib, sys, tarfile, tempfile
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('fetch_wireproxy', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
sha = lambda data: hashlib.sha256(data).hexdigest()
payload = b'fixture only, not an executable'
def packed(members):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        for name, kind, data in members:
            entry = tarfile.TarInfo(name)
            entry.type = kind
            entry.size = len(data)
            if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE): entry.linkname = 'wireproxy'
            archive.addfile(entry, io.BytesIO(data))
    return gzip.compress(buffer.getvalue())
good = packed([('wireproxy', tarfile.REGTYPE, payload)])
def rejects(call, message):
    try: call()
    except (ValueError, OSError, tarfile.TarError, EOFError): return
    raise AssertionError(message)
def unpack(data, archive_hash=None, binary_hash=None, member='wireproxy'):
    return m.binary_from_archive(data, archive_hash or sha(data), member, binary_hash or sha(payload))
assert unpack(good) == payload
assert unpack(packed([('wireproxy.exe', tarfile.REGTYPE, payload)]), member='wireproxy.exe') == payload
with patch.object(m.tarfile, 'open', side_effect=AssertionError('unverified archive parsed')):
    rejects(lambda: unpack(good, '0'*64), 'bad archive accepted')
rejects(lambda: unpack(good, binary_hash='0'*64), 'bad extracted binary accepted')
for name, kind in [('../wireproxy', tarfile.REGTYPE), ('/wireproxy', tarfile.REGTYPE),
                   ('dir/wireproxy', tarfile.REGTYPE), ('..\\wireproxy', tarfile.REGTYPE),
                   ('wireproxy', tarfile.SYMTYPE), ('wireproxy', tarfile.LNKTYPE),
                   ('wireproxy', tarfile.DIRTYPE), ('wireproxy', tarfile.FIFOTYPE)]:
    rejects(lambda: unpack(packed([(name, kind, payload)])), 'unsafe member accepted')
rejects(lambda: unpack(packed([])), 'empty tar accepted')
rejects(lambda: unpack(packed([('wireproxy', tarfile.REGTYPE, payload)]*2)), 'duplicate accepted')
rejects(lambda: unpack(packed([('wireproxy', tarfile.REGTYPE, payload), ('extra', tarfile.REGTYPE, b'x')])), 'extra member accepted')
rejects(lambda: unpack(good[:-4]), 'truncated gzip accepted')
with patch.object(m, 'MAX_ARCHIVE', len(good)-1): rejects(lambda: unpack(good), 'archive limit ignored')
with patch.object(m, 'MAX_TAR', 1024): rejects(lambda: unpack(good), 'expansion limit ignored')
with patch.object(m, 'MAX_BINARY', 4): rejects(lambda: unpack(good), 'binary limit ignored')
rejects(lambda: m.bounded_read(io.BytesIO(b'12345'), 4), 'download limit ignored')

with tempfile.TemporaryDirectory(prefix='polygate-wireproxy-') as temporary:
    root = pathlib.Path(temporary)
    directory = root / 'resources' / 'surfshark'
    directory.mkdir(parents=True)
    expected = {'wireproxy-linux-amd64': sha(payload), 'LICENSE': sha(b'fixture license')}
    (directory / 'LICENSE').write_bytes(b'fixture license')
    manifest = ''.join(digest + '  ' + name + '\n' for name, digest in expected.items())
    (directory / 'sha256.txt').write_text(manifest)
    output = directory / 'wireproxy-linux-amd64'
    asset = m.ARCHIVES['linux-amd64'][0]
    with patch.object(m, 'BINARY_HASHES', expected), patch.dict(m.ARCHIVES, {'linux-amd64': (asset, sha(good))}), \
         patch.object(m.urllib.request, 'urlopen', side_effect=AssertionError('network forbidden')) as network:
        rejects(lambda: m.provision(root, 'linux-amd64', True), 'offline miss accepted')
        output.write_bytes(payload)
        assert m.provision(root, 'linux-amd64', True) == output
        assert m.provision(root, 'linux-amd64') == output
        output.write_bytes(b'bad')
        rejects(lambda: m.provision(root, 'linux-amd64'), 'bad existing binary accepted')
        assert output.read_bytes() == b'bad'
        output.unlink()
        cache = root / 'build' / 'wireproxy' / m.VERSION / asset
        cache.write_bytes(b'bad cache')
        rejects(lambda: m.provision(root, 'linux-amd64'), 'bad cache accepted')
        assert not output.exists()
        cache.write_bytes(good)
        assert m.provision(root, 'linux-amd64', True).read_bytes() == payload
        network.assert_not_called()
        output.unlink()
        cache.unlink()
        class Response(io.BytesIO):
            def geturl(self): return 'https://release-assets.githubusercontent.com/fixture'
        with patch.object(m.urllib.request, 'urlopen', return_value=Response(b'bad download')):
            rejects(lambda: m.provision(root, 'linux-amd64'), 'bad download accepted')
            assert not output.exists() and not cache.exists()
        with patch.object(m.urllib.request, 'urlopen', return_value=Response(good)) as download:
            assert m.provision(root, 'linux-amd64').read_bytes() == payload
            assert download.call_args.args[0].full_url == m.BASE_URL + asset
            assert cache.read_bytes() == good
        (directory / 'sha256.txt').write_text(manifest + manifest)
        rejects(lambda: m.provision(root, 'linux-amd64', True), 'duplicate manifest accepted')
        (directory / 'sha256.txt').write_text(manifest.replace(sha(payload), '0'*64))
        rejects(lambda: m.provision(root, 'linux-amd64', True), 'changed manifest pin accepted')
        (directory / 'sha256.txt').write_text(manifest)
        (directory / 'LICENSE').write_bytes(b'changed')
        rejects(lambda: m.provision(root, 'linux-amd64', True), 'changed license accepted')
print('wireproxy fixture checks passed')
`;
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-I', '-c', fixture, script], {
    encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stdout).toContain('wireproxy fixture checks passed');
});

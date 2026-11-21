"""Provision public wireproxy-awg artifacts, never execute them. Python standard library only.

Usage: python scripts/fetch-wireproxy-awg.py [all|windows-amd64|linux-amd64|linux-arm64] [--offline]
Verified archives are cached in build/wireproxy-awg/1.0.18 for offline builds.
"""
import argparse
import gzip
import hashlib
import io
import os
from pathlib import Path
import re
import stat
import sys
import tarfile
import tempfile
import urllib.request

VERSION = '1.0.18'
BASE_URL = 'https://github.com/artem-russkikh/wireproxy-awg/releases/download/v1.0.18/'
# Recorded from the official release's checksums.txt and the extracted members.
# https://github.com/artem-russkikh/wireproxy-awg/releases/tag/v1.0.18
# Do not replace these pins with checksums fetched at build time.
ARCHIVES = {
    'windows-amd64': ('wireproxy_windows_amd64.tar.gz', '0b7c5e72930196b2b3e0c1d79068fad706148e4b5bbe44c8ee6374caf2c3b8b7'),
    'linux-amd64': ('wireproxy_linux_amd64.tar.gz', '6b9c6d10308cfe8b593b694473ae1feba9f6d91e81db01ea4f9f6a03ec673084'),
    'linux-arm64': ('wireproxy_linux_arm64.tar.gz', 'ee05ae8426b78947832c95c39596d5e778f4d485e8208683264c08064f82e7a3'),
}
BINARY_HASHES = {
    'wireproxy-awg-windows-amd64.exe': '3e59b2c518cf2402f8d858caf977205dfa9277703eddb266a34395c93674bbec',
    'wireproxy-awg-linux-amd64': '98d3dbd96bd43daba80863fac433c528ef2694e7a92f025d26192860a9247e6a',
    'wireproxy-awg-linux-arm64': '752d50de6c6ba9c0b524e531bc95e9971a5998f8b06bd61ea09c17eebe27b670',
    'LICENSE': '12e05cf70e2876d0cfd1c649e1c0032f82a370b365dcccd7d5a03feee17f2625',
}
MAX_ARCHIVE = 8 * 1024 * 1024
MAX_TAR = 32 * 1024 * 1024
MAX_BINARY = 24 * 1024 * 1024


def bounded_read(stream, limit):
    data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError('Size limit exceeded')
    return data


def local_bytes(path, limit):
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError(f'Refusing nonregular file: {path}')
    with path.open('rb') as stream:
        return bounded_read(stream, limit)


def verify(data, expected, label):
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError(f'SHA256 mismatch: {label}; remove the incorrect file explicitly before retrying')
    return data


def manifest_hashes(directory):
    hashes = {}
    for line in local_bytes(directory / 'sha256.txt', 4096).decode('ascii').splitlines():
        match = re.fullmatch(r'([a-f0-9]{64})  ?\*?([A-Za-z0-9.-]+)', line)
        if not match or match[2] in hashes:
            raise ValueError('Invalid or duplicate wireproxy-awg manifest entry')
        hashes[match[2]] = match[1]
    if hashes != BINARY_HASHES:
        raise ValueError('Wireproxy-awg manifest does not match the pinned release')
    verify(local_bytes(directory / 'LICENSE', 4096), hashes['LICENSE'], 'ISC LICENSE')
    return hashes


def binary_from_archive(data, expected_archive, member_name, expected_binary):
    verify(data, expected_archive, 'release archive')
    if len(data) > MAX_ARCHIVE:
        raise ValueError('Archive size limit exceeded')
    # Bound gzip expansion before tarfile can consume extended headers or padding.
    with gzip.GzipFile(fileobj=io.BytesIO(data)) as compressed:
        raw = bounded_read(compressed, MAX_TAR)
    result = None
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r|') as archive:
        for member in archive:
            if (result is not None or member.name != member_name
                    or member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE)
                    or member.linkname or member.pax_headers or member.issparse()
                    or not 0 < member.size <= MAX_BINARY):
                raise ValueError('Expected exactly one plain wireproxy member; links and paths are forbidden')
            # No extract/extractall: never use archive-controlled paths on disk.
            with archive.extractfile(member) as stream:
                result = bounded_read(stream, MAX_BINARY)
            if len(result) != member.size:
                raise ValueError('Truncated wireproxy member')
    if result is None:
        raise ValueError('Missing wireproxy member')
    return verify(result, expected_binary, member_name)


def atomic_write(path, data, executable=False):
    # Temporary files stay beside their destination; failed writes leave no partial binary.
    fd, temporary = tempfile.mkstemp(prefix='.wireproxy-awg-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
        if executable:
            os.chmod(temporary, 0o755)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def provision(root, target, offline=False):
    directory = root / 'resources' / 'wireguard'
    hashes = manifest_hashes(directory)
    name = 'wireproxy-awg-' + target + ('.exe' if target.startswith('windows-') else '')
    output = directory / name
    if output.exists() or output.is_symlink():
        verify(local_bytes(output, MAX_BINARY), hashes[name], name)
        if not target.startswith('windows-'):
            output.chmod(0o755)
        return output
    asset, expected = ARCHIVES[target]
    cache = root / 'build' / 'wireproxy-awg' / VERSION
    cache.mkdir(parents=True, exist_ok=True)
    archive_path = cache / asset
    if archive_path.exists() or archive_path.is_symlink():
        data = local_bytes(archive_path, MAX_ARCHIVE)
    elif offline:
        raise ValueError(f'Offline cache miss: {asset}')
    else:
        request = urllib.request.Request(BASE_URL + asset, headers={'User-Agent': 'Polygate-build-wireproxy-awg'})
        with urllib.request.urlopen(request, timeout=60) as response:
            if not response.geturl().startswith('https://'):
                raise ValueError('Refusing non-HTTPS release response')
            data = bounded_read(response, MAX_ARCHIVE)
    member = 'wireproxy.exe' if target.startswith('windows-') else 'wireproxy'
    binary = binary_from_archive(data, expected, member, hashes[name])
    # Cache only after both immutable archive and extracted binary checks pass.
    if not archive_path.exists():
        atomic_write(archive_path, data)
    atomic_write(output, binary, executable=not target.startswith('windows-'))
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('target', nargs='?', default='all', choices=['all', *ARCHIVES])
    parser.add_argument('--offline', action='store_true', help='Use only verified existing files or cached archives')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    for target in ARCHIVES if args.target == 'all' else [args.target]:
        print(provision(root, target, args.offline))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, tarfile.TarError, EOFError) as error:
        print(f'wireproxy-awg provisioning failed: {error}', file=sys.stderr)
        raise SystemExit(1)

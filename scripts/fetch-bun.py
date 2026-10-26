"""Fetch a pinned official Bun runtime and verify its release checksum without replacing the user's installation."""
import hashlib
from pathlib import Path
import sys
import urllib.request
import zipfile

version=sys.argv[1] if len(sys.argv)>1 else '1.4.4'
target=sys.argv[2] if len(sys.argv)>2 else 'windows-x64'
if target not in ('windows-x64','linux-x64','linux-aarch64'): raise SystemExit('Unsupported build target')
if not all(part.isdigit() for part in version.split('.')) or len(version.split('.'))!=3: raise SystemExit('Invalid version')
root=Path(__file__).resolve().parent.parent
out=root/'build/runtime'/version/target
out.mkdir(parents=True,exist_ok=True)
asset='bun-'+target
base=f'https://github.com/oven-sh/bun/releases/download/bun-v{version}'
checks=urllib.request.urlopen(base+'/SHASUMS256.txt',timeout=60).read().decode()
expected=next(line.split()[0] for line in checks.splitlines() if line.split()[-1].lstrip('*./')==asset+'.zip')
archive=out/'runtime.zip'
if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest()!=expected:
    urllib.request.urlretrieve(base+'/'+asset+'.zip',archive)
if hashlib.sha256(archive.read_bytes()).hexdigest()!=expected: raise SystemExit('Bun runtime checksum mismatch')
name='bun.exe' if target.startswith('windows') else 'bun'
with zipfile.ZipFile(archive) as z: (out/name).write_bytes(z.read(asset+'/'+name))
(out/'runtime.sha256').write_text(hashlib.sha256((out/name).read_bytes()).hexdigest()+'\n')
print(out/name)

"""Copy the Bun runtime the desktop app runs the gateway with into build/bin.

Release builds pass POLYGATE_BUN_RUNTIME (the pinned, checksum-verified runtime from fetch-bun.py). A local build may fall back to the
Bun on PATH, but only if it is the pinned version, so a package never ships whatever Bun the build machine happens to have.
"""
from pathlib import Path
import os
import shutil
import subprocess

PINNED='1.4.4'
root=Path(__file__).resolve().parent.parent
out=root/'build/bin'
out.mkdir(parents=True,exist_ok=True)
# Only the runtime belongs here; anything else (left by older builds) would be packed into the app.
for old in out.iterdir():
    if old.name!='bun.exe': shutil.rmtree(old) if old.is_dir() else old.unlink()
bun=os.environ.get('POLYGATE_BUN_RUNTIME') or shutil.which('bun')
if not bun: raise SystemExit('Bun must be installed on the build machine')
version=subprocess.run([bun,'--version'],capture_output=True,text=True,check=True).stdout.strip()
if version!=PINNED and os.environ.get('POLYGATE_ALLOW_ANY_BUN')!='1':
    raise SystemExit(f'Bun {version} found; packages ship Bun {PINNED}. Run scripts/fetch-bun.py and set POLYGATE_BUN_RUNTIME, or set POLYGATE_ALLOW_ANY_BUN=1 for a local test build.')
if Path(bun).resolve()!=(out/'bun.exe').resolve():shutil.copy2(bun,out/'bun.exe')
print(f'Bundled the Bun {version} runtime:',out)

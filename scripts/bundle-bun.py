"""Copy the Bun runtime the desktop app runs the gateway with into build/bin."""
from pathlib import Path
import os
import shutil

root=Path(__file__).resolve().parent.parent
out=root/'build/bin'
out.mkdir(parents=True,exist_ok=True)
bun=os.environ.get('POLYGATE_BUN_RUNTIME') or shutil.which('bun')
if not bun: raise SystemExit('Bun must be installed on the build machine')
if Path(bun).resolve()!=(out/'bun.exe').resolve():shutil.copy2(bun,out/'bun.exe')
print('Bundled the Bun runtime:',out)

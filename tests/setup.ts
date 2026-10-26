// Loaded before every test file (bunfig.toml). Test files share one process, so backend/state is loaded once with whichever
// POLYGATE_STATE is set first; a per-file folder that one file deletes would break every later file. One temporary folder for the
// whole run, removed after the last test, also keeps tests away from the real state under %LOCALAPPDATA% or ~/.local/state.
import { afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'polygate-test-'));
process.env.POLYGATE_STATE = dir;
process.env.POLYGATE_NO_DISCOVERY = '1';

// A stray process.exit (for example a relay's recycle timer outliving its test) used to end the run early with code 0, so CI passed
// with half the tests unrun. During tests it is an error instead; a test that expects an exit replaces it for its own duration.
process.exit = ((code?: number) => { throw new Error(`process.exit(${code ?? ''}) was called during the test run`); }) as typeof process.exit;

afterAll(async () => {
  try { const { db } = await import('../backend/state'); db.close(); } catch { /* state was never loaded */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* the folder is in the temp directory */ }
});

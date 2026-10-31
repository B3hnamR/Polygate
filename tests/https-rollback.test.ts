import { test, expect, afterAll } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
const { settings, stateDir } = await import('../backend/state');
const https = await import('../backend/https');
const dir = mkdtempSync(path.join(os.tmpdir(), 'pg-cert-'));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
// A throwaway self-signed certificate for a name; needs the openssl program, which the test machines have.
const make = (name: string) => {
  const key = path.join(dir, name + '.key'), crt = path.join(dir, name + '.crt');
  const r = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', crt, '-subj', `/CN=${name}.test`, '-days', '30', '-addext', `subjectAltName=DNS:${name}.test`], { stderr: 'pipe' });
  if (r.exitCode !== 0) return null;
  return { cert: readFileSync(crt, 'utf8'), key: readFileSync(key, 'utf8') };
};
const A = make('a'), B = make('b');
const settled = async () => { for (let i = 0; i < 100; i++) { if (!(await https.httpsStatus() as any).job?.running) return; await Bun.sleep(30); } };
const pem = () => ({ cert: readFileSync(path.join(stateDir, 'tls', 'custom-fullchain.pem'), 'utf8'), key: readFileSync(path.join(stateDir, 'tls', 'custom-privkey.pem'), 'utf8') });

test.skipIf(!A || !B)('a certificate change whose listener cannot be installed leaves the previous certificate files in place', async () => {
  let fail = false; const binds: any[] = [];
  await https.startHttps(async (o: any) => { binds.push(o); if (fail) throw new Error('address already in use'); return 0; }, { port: 4317, host: '127.0.0.1' });
  try {
    await https.httpsApply({ mode: 'custom', certPem: A!.cert, keyPem: A!.key, port: 8443 }); await settled();
    expect(pem()).toEqual({ cert: A!.cert.trim() + '\n', key: A!.key.trim() + '\n' }); expect(binds.length).toBe(1);
    const before = settings.https && { ...settings.https };
    fail = true;
    await https.httpsApply({ mode: 'custom', certPem: B!.cert, keyPem: B!.key, port: 8443 }); await settled();
    expect(pem()).toEqual({ cert: A!.cert.trim() + '\n', key: A!.key.trim() + '\n' }); // A is still the pair on disk, as the listener and the saved settings still say
    expect(settings.https?.mode).toBe(before?.mode); expect(String(settings.https?.lastError)).toContain('address already in use');
  } finally { https.stopHttps(); settings.https = { mode: 'off', httpPort: 80, redirect: true } as any; for (const f of ['custom-fullchain.pem', 'custom-privkey.pem']) rmSync(path.join(stateDir, 'tls', f), { force: true }); }
});
test.skipIf(!A)('a first certificate that fails to install leaves no files behind', async () => {
  await https.startHttps(async (): Promise<number> => { throw new Error('address already in use'); }, { port: 4317, host: '127.0.0.1' });
  try {
    await https.httpsApply({ mode: 'custom', certPem: A!.cert, keyPem: A!.key, port: 8443 }); await settled();
    expect(existsSync(path.join(stateDir, 'tls', 'custom-fullchain.pem'))).toBe(false); expect(existsSync(path.join(stateDir, 'tls', 'custom-privkey.pem'))).toBe(false);
  } finally { https.stopHttps(); settings.https = { mode: 'off', httpPort: 80, redirect: true } as any; }
});

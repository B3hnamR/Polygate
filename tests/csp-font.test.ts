import { test, expect, beforeAll, afterAll } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
process.env.POLYGATE_ADMIN_TOKEN = 'csp-secret';
const { startGateway } = await import('../backend/main');
let gateway: Awaited<ReturnType<typeof startGateway>>, base = '';
beforeAll(async () => { gateway = await startGateway(0); base = `http://127.0.0.1:${gateway.port}`; });
afterAll(async () => { await gateway?.close(); });

test('the dashboard policy lets the page use its inline font (the stamp font is embedded as a data: URL)', async () => {
  const r = await fetch(base + '/'); await r.text();
  if (r.status !== 200) return; // the dashboard has not been built on this machine
  const csp = r.headers.get('content-security-policy') || '';
  expect(csp).toContain("default-src 'self'"); expect(csp).toMatch(/font-src [^;]*'self'[^;]*data:/); expect(csp).toContain("frame-ancestors 'none'");
});

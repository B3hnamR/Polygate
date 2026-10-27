import { test, expect } from 'bun:test';
import net from 'node:net';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
const { freePort } = await import('../backend/warp');
const listen = () => new Promise<net.Server>(resolve => { const s = net.createServer(c => c.end('theirs')); s.listen(0, '127.0.0.1', () => resolve(s)); });
const portOf = (s: net.Server) => (s.address() as net.AddressInfo).port;

test('a local port another program already listens on is skipped and that program is left alone', async () => {
  const theirs = await listen(); const busy = portOf(theirs);
  try {
    const got = await freePort(busy);
    expect(got).toBeGreaterThan(busy); expect(got).toBeLessThan(busy + 300);
    // the other program still answers: nothing took over or closed its listener
    const answer = await new Promise<string>(resolve => { const c = net.connect(busy, '127.0.0.1'); let data = ''; c.on('data', d => data += d); c.on('close', () => resolve(data)); });
    expect(answer).toBe('theirs');
  } finally { theirs.close(); }
});
test('a free port is used as asked, and tunnels of the same pool never share one', async () => {
  const probe = await listen(); const free = portOf(probe); await new Promise(r => probe.close(r));
  expect(await freePort(free)).toBe(free);
  expect(await freePort(free, new Set([free]))).toBeGreaterThan(free);
});

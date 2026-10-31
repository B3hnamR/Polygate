import { test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
const { settings } = await import('../backend/state');
const warp = await import('../backend/warp');
const { __tunnels, __tunnelExited, refreshStatus } = warp;
settings.warp = { engine: 'embedded', autoStart: false, pool: 1, rotateMinutes: 0, helperPath: '', endpoint: '', split: 'auto' } as any;
// A stand-in for the helper: a live process whose SOCKS port never answers.
const fakeTunnel = (port: number) => { const proc = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); return { port, index: 0, proc, identity: 'x', endpoint: '', split: false, startedAt: Date.now(), egressIp: '1.2.3.4', egress: undefined, failures: 0, cooldownUntil: 0, restarts: 0 } as any; };

test('a tunnel that stops answering has its process killed, but the exit handler, not the monitor, removes it', async () => {
  const port = 59871; const t = fakeTunnel(port); __tunnels.set(port, t);
  try {
    const exited = new Promise<void>(r => t.proc.once('exit', () => r()));
    for (let i = 0; i < 3; i++) await refreshStatus(true);
    expect(t.failures).toBe(3);
    expect(__tunnels.get(port)).toBe(t); // still listed: removal belongs to the exit handler, which also schedules the restart
    await exited;
  } finally { __tunnels.delete(port); t.proc.kill(); }
});
test('the exit handler removes the tunnel, and a deliberate stop (entry already removed) is left alone', async () => {
  const port = 59872; const t = fakeTunnel(port); __tunnels.set(port, t);
  try {
    const exited = new Promise<void>(r => t.proc.once('exit', () => r()));
    t.proc.kill(); await exited;
    __tunnelExited(port, t.proc, 1, 0, -1); // epoch -1 never matches, so a scheduled restart would do nothing
    expect(__tunnels.has(port)).toBe(false);
    __tunnelExited(port, t.proc, 1, 0, -1); // a second call finds nothing and does nothing
  } finally { __tunnels.delete(port); }
});

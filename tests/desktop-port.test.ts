import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Each gateway runs in its own process: closing a second in-process gateway would also stop the shared bridge the other test files use.
const entry = path.join(import.meta.dir, '..', 'backend', 'main.ts');
const launch = (port: number, desktop: boolean) => {
  const state = mkdtempSync(path.join(os.tmpdir(), 'polygate-port-test-'));
  const env: Record<string, string | undefined> = { ...process.env, POLYGATE_STATE: state, POLYGATE_NO_DISCOVERY: '1', POLYGATE_ADMIN_TOKEN: 'port-test-secret', POLYGATE_HOST: '127.0.0.1', POLYGATE_PORT: String(port) };
  if (desktop) env.POLYGATE_DESKTOP = '1'; else delete env.POLYGATE_DESKTOP;
  const child = Bun.spawn([process.execPath, entry], { env, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  // Resolves with the port the gateway reports once it is listening, or null when it exits first.
  const ready = (async () => {
    const reader = child.stdout.getReader(); let buffer = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) return null;
      buffer += new TextDecoder().decode(value); let i;
      while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); try { const x = JSON.parse(line); if (x.polygateReady) return x.port as number; } catch { /* a log line */ } }
    }
  })();
  const stop = async () => { child.kill(); await child.exited; try { rmSync(state, { recursive: true, force: true }); } catch { /* temp folder */ } };
  return { child, ready, stop };
};

test('Desktop: the requested port is used when it is free', async () => {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') }); const free = probe.port as number; probe.stop(true);
  const g = launch(free, true);
  try { expect(await g.ready).toBe(free); } finally { await g.stop(); }
}, 30000);

test('Desktop: a port another program holds falls back to a free one, while a server refuses to start on it', async () => {
  const busy = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('other program') }); const taken = busy.port as number;
  try {
    const desktop = launch(taken, true);
    try {
      const port = await desktop.ready; expect(port).toBeNumber(); expect(port).not.toBe(taken);
      expect(((await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as any).app).toBe('Polygate');
    } finally { await desktop.stop(); }
    const server = launch(taken, false);
    try { expect(await server.ready).toBeNull(); expect(await server.child.exited).not.toBe(0); } finally { await server.stop(); }
  } finally { busy.stop(true); }
}, 30000);

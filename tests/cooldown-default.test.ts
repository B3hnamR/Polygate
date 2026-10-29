import { test, expect } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
const { startGateway } = await import('../backend/main');
const { settings, models, saveModel } = await import('../backend/state');

const cooling = (id: string) => saveModel({ id, upstreamId: id, providerId: 'none', name: id, context: 8000, output: 2000, tools: true, reasoning: false, state: 'cooldown', latency: 0, score: 50, priority: 100, failCount: 3, cooldownUntil: Date.now() + 3600_000, checkedAt: 0, error: 'boom' });

test('model pauses are off unless switched on: a pause saved by an earlier version is released at start', async () => {
  const saved = settings.cooldowns; settings.cooldowns = undefined; cooling('cd/old');
  const gateway = await startGateway(0);
  try {
    const m = models.get('cd/old')!; expect(m.cooldownUntil).toBe(0); expect(m.state).toBe('unchecked'); expect(m.failCount).toBe(0);
  } finally { await gateway.close(); settings.cooldowns = saved; models.delete('cd/old'); }
});

test('with model pauses switched on, a saved pause is kept at start', async () => {
  const saved = settings.cooldowns; settings.cooldowns = true; cooling('cd/kept');
  const gateway = await startGateway(0);
  try {
    const m = models.get('cd/kept')!; expect(m.state).toBe('cooldown'); expect(m.cooldownUntil).toBeGreaterThan(Date.now());
  } finally { await gateway.close(); settings.cooldowns = saved; models.delete('cd/kept'); }
});

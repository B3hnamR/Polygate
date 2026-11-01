import { afterEach, expect, test } from 'bun:test';
import { settings } from '../backend/state';
import { agentRecoveryItems, pausedAgents, setAgentPause } from '../backend/agent-recovery';
const oldDesktop = process.env.POLYGATE_DESKTOP, oldKeys = settings.keys;
afterEach(() => { settings.keys = oldKeys; if (oldDesktop === undefined) delete process.env.POLYGATE_DESKTOP; else process.env.POLYGATE_DESKTOP = oldDesktop; });
test('agent problems are scoped warnings and do not make normal gateway clients unready', () => {
  process.env.POLYGATE_DESKTOP = '1';
  settings.keys = [{ id: 'agent-test', name: 'Agent', agent: true, enabled: false, value: 'fixture', created: 1 }] as any;
  const items = agentRecoveryItems({ state: 'failed', installed: true, message: '' }, [{ id: 'session1', paused: 'Provider allowance reached' }]);
  expect(items.map(x => x.id)).toEqual(['agent_engine', 'agent_key', 'agent_paused:session1']);
  expect(items.every(x => x.severity === 'warning')).toBe(true);
  expect(items[0]).toMatchObject({ page: 'Agent', fix: { endpoint: '/admin/agent/engine/start' } });
  expect(items[1]).toMatchObject({ page: 'Settings' }); expect(items[1].fix).toBeUndefined();
  expect(items[2].detail).toContain('Provider allowance reached');
});
test('an engine that is simply off, after an app start or a stop, is not a problem', () => {
  process.env.POLYGATE_DESKTOP = '1'; settings.keys = oldKeys.filter(k => !k.agent).concat({ id: 'agent-ok', name: 'Agent', agent: true, enabled: true, value: 'fixture', created: 1, limit: 4 } as any);
  for (const state of ['installed', 'running', 'starting']) expect(agentRecoveryItems({ state, installed: true, message: '' }, []).map(x => x.id)).toEqual([]);
});
test('no agent is advertised in server mode or on a desktop that never installed it', () => {
  delete process.env.POLYGATE_DESKTOP;
  expect(agentRecoveryItems({ state: 'failed', installed: true, message: 'failed' }, [])).toEqual([]);
  process.env.POLYGATE_DESKTOP = '1'; settings.keys = oldKeys.filter(k => !k.agent);
  expect(agentRecoveryItems({ state: 'not_installed', installed: false, message: '' }, [])).toEqual([]);
});
test('pause reasons persist outside the live session map and disappear only after an explicit clear', () => {
  setAgentPause('recovery-fixture', 'Provider is exhausted');
  expect(pausedAgents()).toContainEqual({ id: 'recovery-fixture', paused: 'Provider is exhausted' });
  setAgentPause('recovery-fixture');
  expect(pausedAgents().some(s => s.id === 'recovery-fixture')).toBe(false);
});

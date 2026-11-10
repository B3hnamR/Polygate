import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// State folder comes from tests/setup.ts.
const { settings, models, saveModel, removeModels } = await import('../backend/state');
const { classifyModel, probeSummary } = await import('../backend/gateway');

const PID = 'check-result';
const fresh = (id: string) => saveModel({ id: `${PID}/${id}`, upstreamId: id, providerId: PID, name: id.toUpperCase(), context: 0, output: 0, reasoning: false, tools: true, state: 'unchecked', latency: 0, score: 0, priority: 1, failCount: 0, cooldownUntil: 0, checkedAt: 0, error: '' });
const savedCooldowns = settings.cooldowns;
afterAll(() => { settings.cooldowns = savedCooldowns; removeModels(PID); });

test('a temporary refusal after a good answer keeps the reason, its status and when the model last answered', () => {
  settings.cooldowns = false; fresh('a'); const m = models.get(`${PID}/a`)!;
  classifyModel(m, 200, '', 12);
  expect(m).toMatchObject({ state: 'available', lastStatus: 200, error: '' }); const answeredAt = m.okAt!; expect(answeredAt).toBeGreaterThan(0);
  classifyModel(m, 429, 'Rate limit reached for this model', 30);
  // Still usable (not unavailable, not resting), and the dashboard has what it needs to say why it is no longer "available".
  expect(m).toMatchObject({ state: 'unchecked', cooldownUntil: 0, lastStatus: 429, error: 'Rate limit reached for this model', okAt: answeredAt });
  expect(probeSummary(m, 429)).toBe('A did not answer (HTTP 429). That can be temporary, so it stays in use and is not marked unavailable.');
  classifyModel(m, 200, '', 9);
  expect(m).toMatchObject({ state: 'available', lastStatus: 200, error: '' }); expect(m.okAt!).toBeGreaterThanOrEqual(answeredAt);
  expect(probeSummary(m, 200)).toBe('A answered.');
});

test('the check sentence follows what was decided: gone, or resting until a time', () => {
  fresh('b'); const m = models.get(`${PID}/b`)!;
  settings.cooldowns = false; classifyModel(m, 404, 'no such model', 5);
  expect(m.okAt).toBeUndefined(); expect(probeSummary(m, 404)).toBe('B did not answer (HTTP 404). It is marked unavailable.');
  settings.cooldowns = true; m.state = 'unchecked'; classifyModel(m, 429, 'slow down', 5, 120000);
  expect(m.state as string).toBe('cooldown'); expect(probeSummary(m, 429)).toMatch(/^B did not answer \(HTTP 429\)\. It rests until /);
});

// ---- the bridge's source cache: tools are labelled with the release they were extracted from
test('cached tools keep the release they came from; the presented version is not changed by them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-source-cache-')); const had = process.env.OPENCODE_CACHE_DIR; process.env.OPENCODE_CACHE_DIR = dir;
  const identity = require('../vendor/bridge/identity.js');
  const before = identity.getState(); const priorTools = identity.getTools(); const tools = { read: { description: 'read a file', parameters: { type: 'object', properties: {} } } };
  try {
    identity.writeCachedSource('ref-226', { tools }, '2.2.6');
    const cached = identity.readCachedSource(); expect(cached).toMatchObject({ ref: 'ref-226', version: '2.2.6' });
    // What a cold start does with it: the tools are labelled 2.2.6 from ref-226, and the version presented upstream stays whatever it was.
    identity.applyRecipe(cached.extracted, null, { toolsVersion: cached.version, toolsRef: cached.ref });
    expect(identity.getState().tools).toMatchObject({ source: 'source', version: '2.2.6', ref: 'ref-226' });
    expect(identity.getState().recipe.version).toBe(before.recipe.version);
    // A cache written before the release was stored does not say: the label is unknown, never the default version.
    const file = join(dir, 'source-recipe.json'); const old = JSON.parse(readFileSync(file, 'utf8')); delete old.version; writeFileSync(file, JSON.stringify(old));
    const legacy = identity.readCachedSource(); expect(legacy.version).toBeUndefined();
    identity.applyRecipe(legacy.extracted, null, { toolsVersion: null, toolsRef: legacy.ref });
    expect(identity.getState().tools.version).toBeNull();
    // A release applied together with its own source labels the tools with that release, as before.
    identity.applyRecipe({ tools });
    expect(identity.getState().tools.version).toBe(before.recipe.version);
    // A version that is not a release number is not stored.
    identity.writeCachedSource('ref-x', { tools }, 'latest'); expect(identity.readCachedSource().version).toBeUndefined();
  } finally {
    identity.__setToolProfile(before.tools.source === 'default' ? null : priorTools, before.tools.source);
    if (had === undefined) delete process.env.OPENCODE_CACHE_DIR; else process.env.OPENCODE_CACHE_DIR = had;
    rmSync(dir, { recursive: true, force: true });
  }
});

import {test, expect, spyOn} from 'bun:test';

// Keep module warm-start and catalog writes away from the user's bridge cache.
const initialCacheDir = process.env.OPENCODE_CACHE_DIR;
process.env.OPENCODE_CACHE_DIR = 'off';
const bridge = require('../vendor/bridge/server.js');
const identity = bridge.identity;
const proxy = require('../vendor/bridge/proxy.js');
if (initialCacheDir === undefined) delete process.env.OPENCODE_CACHE_DIR;
else process.env.OPENCODE_CACHE_DIR = initialCacheDir;

const catalog = (models: Record<string, any>) => ({opencode: {api: 'https://opencode.ai/inference/v1', models}});
const free = (extra: Record<string, any> = {}) => ({cost: {input: 0, output: 0}, tool_call: true, ...extra});

async function scoped(run: () => Promise<void>) {
  const before = identity.getState();
  const modelEndpoints = Object.fromEntries(Object.keys(before.catalogVerdicts).flatMap(id => {
    const endpoint = identity.getEndpoints(id).catalogBase;
    return endpoint !== before.endpoints.catalogBase ? [[id, endpoint]] : [];
  }));
  const discovery = bridge.__getDiscoveryState();
  const cacheDir = process.env.OPENCODE_CACHE_DIR;
  process.env.OPENCODE_CACHE_DIR = 'off';
  try {
    await run();
  } finally {
    identity.applyRecipe({...before.recipe, ...before.endpoints,
      freeModels: before.freeModels, catalogVerdicts: before.catalogVerdicts,
      modelFacts: before.modelFacts, modelFamilies: before.modelFamilies,
      modelEndpoints, catalogAuthoritative: true}, null, {catalogOnly: true});
    bridge.__setActiveModels(discovery.activeModels);
    bridge.__setLastDiscoveryTime(discovery.lastDiscoveryTime);
    if (cacheDir === undefined) delete process.env.OPENCODE_CACHE_DIR;
    else process.env.OPENCODE_CACHE_DIR = cacheDir;
  }
}

test('strict discovery replaces stale free ids from a fresh catalog without identity or gateway discovery', async () => scoped(async () => {
  identity.applyRecipe(identity.parseCatalogData(catalog({'pulse-free': free(), 'retired-free': free()})), null, {catalogOnly: true});
  bridge.__setActiveModels([{id: 'pulse-free', object: 'model', owned_by: 'opencode'}]);
  const before = identity.getState();
  const cliBefore = bridge.__getCliVersionState();
  const upstream = spyOn(proxy, 'netFetch').mockImplementation(async (url: any) => {
    expect(String(url)).toBe(process.env.OPENCODE_CATALOG_URL || 'https://models.opencode.ai/api.json');
    return Response.json(catalog({
      'current-free': free({family: 'current', reasoning: true, limit: {output: 8192}}),
      'retired-free': free({status: 'deprecated'}),
      'paid-free': {cost: {input: 1, output: 1}},
    }));
  });
  try {
    const result = await bridge.discoverModels({strict: true});
    expect(result).toEqual({ok: true, authoritative: true, models: [{id: 'current-free', object: 'model', owned_by: 'opencode'}]});
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(identity.getFreeModels()).toEqual(['current-free']);
    expect(identity.getCatalogVerdict('pulse-free')).toBeUndefined();
    expect(identity.getCatalogVerdict('retired-free')).toBe('deprecated');
    expect(identity.getState().recipe.version).toBe(before.recipe.version);
    expect(identity.getState().recipe.sessionLength).toBe(before.recipe.sessionLength);
    expect(identity.getState().epoch).toBe(before.epoch);
    expect(identity.getState().lastForcedRefreshTime).toBe(before.lastForcedRefreshTime);
    expect(identity.getState().lastCheckTime).toBe(before.lastCheckTime);
    expect(identity.getUserAgent()).toBe(identity.buildUserAgent(before.recipe));
    expect(bridge.__getCliVersionState()).toEqual(cliBefore);
  } finally { upstream.mockRestore(); }
}));

test('strict discovery accepts authoritative empty and clears catalog collections and route overrides', async () => scoped(async () => {
  const seed = catalog({'pulse-free': free({family: 'pulse', reasoning: true, provider: {api: 'https://opencode.ai/old/v1', npm: '@ai-sdk/openai-compatible'}})});
  identity.applyRecipe(identity.parseCatalogData(seed), null, {catalogOnly: true});
  bridge.__setActiveModels([{id: 'pulse-free', object: 'model', owned_by: 'opencode'}]);
  const upstream = spyOn(proxy, 'netFetch').mockImplementation(async () => Response.json(catalog({})));
  try {
    expect(await bridge.discoverModels({strict: true})).toEqual({ok: true, authoritative: true, models: []});
    expect(bridge.__getDiscoveryState().activeModels).toEqual([]);
    expect(bridge.__getDiscoveryState().lastDiscoveryTime).toBeGreaterThan(0);
    expect(identity.getState()).toMatchObject({freeModels: [], catalogVerdicts: {}, modelFacts: {}, modelFamilies: {}});
    expect(identity.getEndpoints('pulse-free').chatUrl).toBe('https://opencode.ai/inference/v1/chat/completions');
  } finally { upstream.mockRestore(); }
}));

test('strict discovery preserves the previous active list and facts on fetch, HTTP, JSON or malformed catalog failure', async () => scoped(async () => {
  identity.applyRecipe(identity.parseCatalogData(catalog({'pulse-free': free()})), null, {catalogOnly: true});
  bridge.__setActiveModels([{id: 'pulse-free', object: 'model', owned_by: 'opencode'}]);
  const before = identity.getState();
  const discovery = bridge.__getDiscoveryState();
  const failures = [
    () => { throw new Error('offline fixture'); },
    () => new Response('unavailable', {status: 503}),
    () => new Response('{not json'),
    () => Response.json({}),
    () => Response.json({opencode: {models: []}}),
    () => Response.json(catalog({'broken-free': null})),
    () => Response.json(catalog({'broken-free': {}})),
    () => Response.json(catalog({'broken-free': {cost: {input: null, output: 0}}})),
  ];
  for (const fail of failures) {
    const upstream = spyOn(proxy, 'netFetch').mockImplementation(async () => fail());
    try {
      await expect(bridge.discoverModels({strict: true})).rejects.toThrow();
      expect(bridge.__getDiscoveryState()).toEqual(discovery);
      expect(identity.getState()).toEqual(before);
    } finally { upstream.mockRestore(); }
  }
}));

test('strict extraction marks a valid all-paid catalog authoritative and catalog-only apply ignores identity fields', async () => scoped(async () => {
  const before = identity.getState();
  const upstream = spyOn(proxy, 'netFetch').mockImplementation(async () => Response.json(catalog({'paid-free': {cost: {input: 1, output: 1}}})));
  try {
    const parsed = await identity.extractCatalog({strict: true});
    expect(parsed).toMatchObject({catalogAuthoritative: true, freeModels: [], catalogVerdicts: {'paid-free': 'paid'}});
    identity.applyRecipe({...parsed, version: '99.0.0', sessionLength: 26, sessionPrefix: 'changed_'}, null, {catalogOnly: true});
    expect(identity.getState().recipe).toEqual({...before.recipe, chatUrl: parsed.chatUrl, responsesUrl: parsed.responsesUrl, catalogBase: parsed.catalogBase});
    expect(identity.getState().epoch).toBe(before.epoch);
    expect(identity.getState().lastForcedRefreshTime).toBe(before.lastForcedRefreshTime);
  } finally { upstream.mockRestore(); }
}));

test('concurrent strict discovery callers each require a fresh catalog and cannot revive an earlier result', async () => scoped(async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const upstream = spyOn(proxy, 'netFetch').mockImplementation(async () => {
    if (++calls === 1) {
      await blocked;
      return Response.json(catalog({'old-free': free()}));
    }
    return Response.json(catalog({'new-free': free()}));
  });
  try {
    const first = bridge.discoverModels({strict: true});
    const second = bridge.discoverModels({strict: true});
    release();
    expect((await first).models.map((m: any) => m.id)).toEqual(['old-free']);
    expect((await second).models.map((m: any) => m.id)).toEqual(['new-free']);
    expect(bridge.__getDiscoveryState().activeModels.map((m: any) => m.id)).toEqual(['new-free']);
    expect(calls).toBe(2);
  } finally { upstream.mockRestore(); }
}));

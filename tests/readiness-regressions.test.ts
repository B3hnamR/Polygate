import { test, expect, beforeEach, afterEach } from 'bun:test';
import type { ApiKey, Model, Provider, Route } from '../backend/types';
// State isolation and disabled discovery come from tests/setup.ts. No servers or requests are needed.
const { settings, models } = await import('../backend/state');
const { readiness } = await import('../backend/gateway');
const { checklist } = await import('../backend/checklist');
const { routeForProvider } = await import('../backend/transport');

const provider = (id = 'readiness-regression'): Provider => ({ id, name: id, kind: 'openai', enabled: true, baseUrl: 'https://provider.invalid/v1', apiKey: '', models: [], routeId: '' });
const model = (name: string, providerId = 'readiness-regression', extra: Partial<Model> = {}): Model => ({ id: `${providerId}/${name}`, upstreamId: name, providerId, name, context: 0, output: 0, reasoning: false, tools: true, state: 'available', latency: 0, score: 50, priority: 1, failCount: 0, cooldownUntil: 0, checkedAt: 0, error: '', ...extra });
const key = (extra: Partial<ApiKey> = {}): ApiKey => ({ id: 'readiness-key', name: 'Readiness key', value: 'pg_readiness_fixture', enabled: true, limit: 0, ...extra });
const route = (id: string, extra: Partial<Route> = {}): Route => ({ id, name: id, kind: 'proxy', url: 'socks5://127.0.0.1:1', enabled: true, models: [], ...extra });
let saved: Pick<typeof settings, 'providers' | 'routes' | 'keys' | 'enabled' | 'rotate' | 'strategy' | 'routeId' | 'spreadDirect' | 'exhaustedFailover' | 'checklistAck'>;
let savedModels: Map<string, Model>;
beforeEach(() => {
  saved = { providers: settings.providers, routes: settings.routes, keys: settings.keys, enabled: settings.enabled, rotate: settings.rotate, strategy: settings.strategy, routeId: settings.routeId, spreadDirect: settings.spreadDirect, exhaustedFailover: settings.exhaustedFailover, checklistAck: settings.checklistAck };
  savedModels = new Map(models);
  Object.assign(settings, { providers: [provider()], routes: [route('direct', { kind: 'direct', url: '' })], keys: [key()], enabled: true, rotate: false, strategy: 'round_robin', routeId: 'direct', spreadDirect: false, exhaustedFailover: false, checklistAck: {} });
  models.clear();
  const m = model('available'); models.set(m.id, m);
});
afterEach(() => {
  Object.assign(settings, saved);
  models.clear(); for (const [id, m] of savedModels) models.set(id, m);
});
const codes = () => readiness().issues.map(i => i.code);

test('readiness searches later models of the same provider for an eligible route', () => {
  const later = model('later'); models.set(later.id, later);
  settings.rotate = true; settings.routes = [route('later-only', { models: [later.id] })]; settings.routeId = 'later-only';
  expect(() => routeForProvider(settings.providers[0], model('available').id, true)).toThrow();
  expect(routeForProvider(settings.providers[0], later.id, true).id).toBe('later-only');
  expect(readiness()).toMatchObject({ ready: true, state: 'ready', issues: [] });
});

test('a usable key scoped to a missing model does not make an unrelated model ready', () => {
  settings.keys = [key({ models: ['removed/model'] })];
  expect(readiness()).toMatchObject({ ready: false, state: 'attention', issues: [{ code: 'no_allowed_model', page: 'Settings' }] });
  expect(readiness().issues[0].message).toContain('allow-lists');
  settings.keys.push(key({ id: 'allowed-key', models: [model('available').id] }));
  expect(readiness().ready).toBe(true);
});

test('the key-allowed model must itself have a route, not just another model', () => {
  const later = model('later'); models.set(later.id, later);
  settings.keys = [key({ models: [model('available').id] })];
  settings.rotate = true; settings.routes = [route('later-only', { models: [later.id] })]; settings.routeId = 'later-only';
  expect(codes()).toEqual(['no_route']);
  expect(readiness().issues[0].message).toContain('All configured routes are unavailable');
  settings.keys[0].models = [later.id];
  expect(readiness().ready).toBe(true);
});

test('only valid keys can supply the allowed key/model intersection', () => {
  settings.keys = [key({ models: ['removed/model'] }), key({ id: 'off', enabled: false }), key({ id: 'expired', expiresAt: 1 }), key({ id: 'spent', budget: 10, used: 10 })];
  expect(codes()).toEqual(['no_allowed_model']);
  expect(readiness().checklist.filter(i => i.id.startsWith('key:')).map(i => i.id)).toEqual(['key:expired', 'key:spent']);
});

test('agent-only readiness requires confirmed tool support, while ordinary keys do not', () => {
  models.get(model('available').id)!.tools = false;
  settings.keys = [key({ agent: true })];
  expect(codes()).toEqual(['no_allowed_model']);
  const tools = model('tools'); models.set(tools.id, tools);
  expect(readiness().ready).toBe(true);
  settings.keys[0].models = [model('available').id];
  expect(codes()).toEqual(['no_allowed_model']);
  settings.keys.push(key({ id: 'ordinary', models: [model('available').id] }));
  expect(readiness().ready).toBe(true);
});

test('readiness delegates qualified and unqualified upstream scopes to modelAllowed', () => {
  models.clear(); const m = model('vendor/model'); models.set(m.id, m);
  settings.keys = [key({ models: ['other-provider/vendor/model'] })];
  expect(codes()).toEqual(['no_allowed_model']);
  settings.keys[0].models = ['model'];
  expect(codes()).toEqual(['no_allowed_model']);
  settings.keys[0].models = ['vendor/model'];
  settings.keys[0].modelGrantKinds = { 'vendor/model': 'upstream' };
  expect(readiness().ready).toBe(true);
  settings.keys[0].models = [m.id];
  expect(readiness().ready).toBe(true);
});

test('a qualified grant cannot authorize a different provider with a colliding upstream suffix', () => {
  settings.providers = [provider('readiness-a'), provider('readiness-b')];
  models.clear();
  const granted = model('vendor/model', 'readiness-a', { state: 'unavailable' });
  const collision = model('readiness-a/vendor/model', 'readiness-b');
  models.set(granted.id, granted); models.set(collision.id, collision);
  settings.keys = [key({ models: [granted.id] })];
  expect(codes()).toEqual(['no_allowed_model']);
  settings.keys[0].models = [collision.id];
  expect(readiness().ready).toBe(true);
});

test('missing keys, missing models, resting models and a paused gateway keep their diagnostics', () => {
  settings.keys = [];
  expect(codes()).toEqual(['no_key']);
  settings.routes = [];
  expect(codes()).toEqual(['no_key', 'no_route']);
  settings.keys = [key()]; settings.routes = [route('direct', { kind: 'direct', url: '' })];
  models.get(model('available').id)!.cooldownUntil = 4102444800000;
  expect(codes()).toEqual(['models_resting']);
  expect(checklist({ providers: settings.providers, known: [], usable: [], starting: false }).filter(i => i.severity === 'blocking').map(i => i.id)).toEqual(['no_models']);
  expect(checklist({ providers: settings.providers, known: [], usable: [], starting: true }).filter(i => i.severity === 'blocking')).toEqual([]);
  models.get(model('available').id)!.cooldownUntil = 0; settings.enabled = false;
  expect(readiness()).toMatchObject({ ready: false, state: 'paused', issues: [] });
  settings.providers = [];
  expect(codes()).toEqual(['no_provider']);
});

test('paused provider routes remain blocked with the existing route diagnostic', () => {
  settings.providers[0].routes = { ids: ['direct'], paused: ['direct'] };
  expect(codes()).toEqual(['no_route']);
  expect(readiness().issues[0].message).toContain('Every route of readiness-regression is paused');
  expect(settings.providers[0].routes.paused).toEqual(['direct']);
});

test('readiness previews do not advance global or provider route rotation or mutate fixtures', () => {
  const p = settings.providers[0]; const m = model('available');
  settings.routes = [route('a'), route('b')]; settings.routeId = 'a'; settings.rotate = true;
  const globalNext = routeForProvider(p, m.id, true).id;
  const globalState = JSON.stringify(settings);
  for (let i = 0; i < 3; i++) expect(readiness().ready).toBe(true);
  expect(JSON.stringify(settings)).toBe(globalState);
  expect(routeForProvider(p, m.id, true).id).toBe(globalNext);

  p.routes = { ids: ['a', 'b'], spread: true };
  const providerNext = routeForProvider(p, m.id, true).id;
  const providerState = JSON.stringify(settings);
  for (let i = 0; i < 3; i++) expect(readiness().ready).toBe(true);
  expect(JSON.stringify(settings)).toBe(providerState);
  expect(routeForProvider(p, m.id, true).id).toBe(providerNext);
});

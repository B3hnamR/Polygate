import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { models, persist, settings, stateDir } from '../backend/state';
import { __captureKeyTestState, authenticate, checkTokenRate, createKey, keyFields, modelAllowed, recordUsage, updateKey } from '../backend/keys';
import { keyGate } from '../backend/auth';
import type { ApiKey, Model } from '../backend/types';

let savedKeys = settings.keys;
let savedModels = new Map(models);
beforeEach(() => { savedKeys = settings.keys; savedModels = new Map(models); settings.keys = []; models.clear(); });
afterEach(() => { settings.keys = savedKeys; models.clear(); for (const [id, m] of savedModels) models.set(id, m); persist(); });

const add = (id: string, upstreamId: string) => {
  const m: Model = { id, upstreamId, providerId: id.split('/')[0], name: id, context: 0, output: 0, reasoning: false, tools: true, state: 'available', latency: 0, score: 50, priority: 1, failCount: 0, cooldownUntil: 0, checkedAt: 0, error: '' };
  models.set(id, m); return m;
};
const legacy = (grants: string[]): ApiKey => ({ id: 'legacy', name: 'Legacy', value: 'pg_fixture', enabled: true, limit: 0, models: grants });
const persistedKeys = (): ApiKey[] => {
  const raw = readFileSync(path.join(stateDir, 'settings.vault'));
  const decipher = createDecipheriv('aes-256-gcm', readFileSync(path.join(stateDir, 'vault.key')), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString()).keys;
};

test('new grants keep the string-list contract and persist server-derived kinds', () => {
  add('a/vendor/model', 'vendor/model');
  const key = createKey({ models: ['a/vendor/model', 'vendor/model', 'bare', 'unknown/model'], modelGrantKinds: { 'a/vendor/model': 'upstream', 'unknown/model': 'upstream' } });
  expect(key.models).toEqual(['a/vendor/model', 'vendor/model', 'bare', 'unknown/model']);
  expect(key.modelGrantKinds).toEqual({ 'a/vendor/model': 'qualified', 'vendor/model': 'upstream', bare: 'upstream', 'unknown/model': 'qualified' });
  expect(persistedKeys().find(k => k.id === key.id)).toMatchObject({ models: key.models, modelGrantKinds: key.modelGrantKinds });
});

test('qualified grants do not become upstream aliases after removal or JSON reload', () => {
  add('a/vendor/model', 'vendor/model'); add('b/a/vendor/model', 'a/vendor/model');
  const key = createKey({ models: ['a/vendor/model'] });
  expect(modelAllowed(key, 'a/vendor/model')).toBe(true);
  expect(modelAllowed(key, 'b/a/vendor/model')).toBe(false);
  models.delete('a/vendor/model');
  const restored = persistedKeys().find(k => k.id === key.id)!;
  expect(modelAllowed(restored, 'b/a/vendor/model')).toBe(false);
  add('a/vendor/model', 'vendor/model');
  expect(modelAllowed(restored, 'a/vendor/model')).toBe(true);
});

test('validated upstream grants retain alias semantics if a colliding catalog ID appears', () => {
  add('a/vendor/model', 'vendor/model');
  const key = createKey({ models: ['vendor/model'] });
  add('vendor/model', 'different'); add('b/vendor/model', 'vendor/model');
  expect(modelAllowed(key, 'a/vendor/model')).toBe(true);
  expect(modelAllowed(key, 'b/vendor/model')).toBe(true);
  expect(modelAllowed(key, 'vendor/model')).toBe(false);
  models.delete('a/vendor/model');
  expect(modelAllowed(persistedKeys().find(k => k.id === key.id)!, 'b/vendor/model')).toBe(true);
});

test('whole-list UI updates preserve retained decisions after catalog churn', () => {
  add('a/vendor/model', 'vendor/model');
  const key = createKey({ models: ['a/vendor/model', 'vendor/model'] });
  models.delete('a/vendor/model'); add('b/a/vendor/model', 'a/vendor/model'); add('vendor/model', 'different'); add('b/vendor/model', 'vendor/model');
  updateKey(key.id, { name: 'Edited', models: ['vendor/model', 'a/vendor/model', 'b/vendor/model'], modelGrantKinds: { 'a/vendor/model': 'upstream', 'vendor/model': 'qualified' } });
  expect(key.modelGrantKinds).toEqual({ 'vendor/model': 'upstream', 'a/vendor/model': 'qualified', 'b/vendor/model': 'qualified' });
  expect(modelAllowed(key, 'b/a/vendor/model')).toBe(false);
  expect(modelAllowed(key, 'b/vendor/model')).toBe(true);
  expect(modelAllowed(key, 'vendor/model')).toBe(false);
  expect(persistedKeys().find(k => k.id === key.id)?.modelGrantKinds).toEqual(key.modelGrantKinds);
});

test('legacy slash grants fail closed even when the catalog could currently interpret an alias', () => {
  add('a/vendor/model', 'vendor/model'); add('b/a/vendor/model', 'a/vendor/model');
  const key = legacy(['a/vendor/model', 'vendor/model']);
  expect(modelAllowed(key, 'a/vendor/model')).toBe(true);
  models.delete('a/vendor/model');
  expect(modelAllowed(key, 'b/a/vendor/model')).toBe(false);
  add('a/vendor/model', 'vendor/model');
  expect(modelAllowed(legacy(['vendor/model']), 'a/vendor/model')).toBe(false);
  expect(key.modelGrantKinds).toBeUndefined();
  settings.keys.push(key);
  updateKey(key.id, { models: ['a/vendor/model', 'vendor/model'] });
  expect(key.modelGrantKinds).toEqual({ 'a/vendor/model': 'qualified', 'vendor/model': 'qualified' });
  expect(modelAllowed(key, 'b/a/vendor/model')).toBe(false);
});

test('legacy bare grants remain exact upstream aliases, not arbitrary suffixes', () => {
  add('a/model', 'model'); add('b/vendor/model', 'vendor/model');
  const key = legacy(['model']);
  expect(modelAllowed(key, 'a/model')).toBe(true);
  expect(modelAllowed(key, 'b/vendor/model')).toBe(false);
  expect(modelAllowed(key, 'missing/model')).toBe(false);
  expect(modelAllowed(key, 'auto')).toBe(true);
  expect(modelAllowed(key, 'auto:smart')).toBe(true);
});

test('non-model updates and untrusted metadata cannot reclassify grants', () => {
  add('a/vendor/model', 'vendor/model');
  const key = createKey({ models: ['a/vendor/model'] });
  const kinds = key.modelGrantKinds;
  updateKey(key.id, { enabled: false, modelGrantKinds: { 'a/vendor/model': 'upstream' } });
  expect(key.modelGrantKinds).toBe(kinds);
  expect(keyFields({ modelGrantKinds: { 'a/vendor/model': 'upstream' } })).toEqual({});
  const old = legacy(['vendor/model']); settings.keys.push(old);
  updateKey(old.id, { name: 'Renamed' });
  expect(old.modelGrantKinds).toBeUndefined();
});

test('replacing or clearing the list removes stale tags without changing empty-list access', () => {
  add('a/model', 'model');
  const key = createKey({ models: ['a/model'] });
  updateKey(key.id, { models: ['model'] });
  expect(key.modelGrantKinds).toEqual({ model: 'upstream' });
  updateKey(key.id, { models: [] });
  expect(key.models).toEqual([]); expect(key.modelGrantKinds).toEqual({});
  expect(modelAllowed(key, 'anything')).toBe(true);
});

test('rejected updates leave both lists and persisted metadata untouched', () => {
  add('a/model', 'model');
  const key = createKey({ models: ['a/model'] });
  const before = JSON.stringify(key);
  expect(() => updateKey(key.id, { models: ['model'], expiresAt: -1 })).toThrow(/Expiry/);
  expect(JSON.stringify(key)).toBe(before);
  expect(JSON.stringify(persistedKeys().find(k => k.id === key.id))).toBe(before);
});

test('prototype-shaped grant strings are ordinary own metadata entries', () => {
  add('a/proto', '__proto__'); add('a/constructor', 'constructor');
  const key = createKey({ models: ['__proto__', 'constructor'] });
  expect(Object.hasOwn(key.modelGrantKinds!, '__proto__')).toBe(true);
  expect(key.modelGrantKinds!['__proto__']).toBe('upstream');
  expect(modelAllowed(JSON.parse(JSON.stringify(key)), 'a/proto')).toBe(true);
  expect(modelAllowed(key, 'a/constructor')).toBe(true);
});

test('new ambiguous grants prefer an exact catalog ID, not another models upstream ID', () => {
  add('vendor/model', 'different'); add('a/vendor/model', 'vendor/model');
  const key = createKey({ models: ['vendor/model'] });
  expect(key.modelGrantKinds).toEqual({ 'vendor/model': 'qualified' });
  expect(modelAllowed(key, 'vendor/model')).toBe(true);
  expect(modelAllowed(key, 'a/vendor/model')).toBe(false);
  models.delete('vendor/model');
  expect(modelAllowed(key, 'a/vendor/model')).toBe(false);
});

test('unverified slash grants cannot turn into aliases when matching models are later discovered', () => {
  const key = createKey({ models: ['unknown/model'] });
  add('a/unknown/model', 'unknown/model');
  expect(modelAllowed(key, 'a/unknown/model')).toBe(false);
  updateKey(key.id, { models: ['unknown/model'] });
  expect(key.modelGrantKinds).toEqual({ 'unknown/model': 'qualified' });
  expect(modelAllowed(key, 'a/unknown/model')).toBe(false);
});

test('invalid persisted kind values never grant upstream alias access', () => {
  add('b/a/model', 'a/model');
  const key = JSON.parse(JSON.stringify({ ...legacy(['a/model']), modelGrantKinds: { 'a/model': 'typo' } }));
  expect(modelAllowed(key, 'b/a/model')).toBe(false);
  expect(modelAllowed(key, 'a/model')).toBe(true);
});

test('key-state restore deeply preserves baseline rate windows and invalid-key history on every call', () => {
  const outer = __captureKeyTestState();
  try {
    const key = createKey({ rpm: 2, tpm: 3 });
    const request = { headers: { authorization: `Bearer ${key.value}` }, socket: { remoteAddress: '192.0.2.120' } } as unknown as IncomingMessage;
    authenticate(request, true); recordUsage(key.id, 1);
    const ip = '192.0.2.121'; keyGate.clear(ip);
    for (let i = 0; i < 29; i++) keyGate.fail(ip);
    const restore = __captureKeyTestState();
    expect(() => restore.assertIdle()).not.toThrow();
    for (let i = 0; i < 2; i++) {
      authenticate(request, true); recordUsage(key.id, 2); keyGate.fail(ip);
      expect(() => authenticate(request, true)).toThrow(/Request rate limit/);
      expect(() => checkTokenRate(key)).toThrow(/Token rate limit/);
      expect(keyGate.retryAfter(ip)).toBeGreaterThan(0);
      restore();
      expect(() => checkTokenRate(key)).not.toThrow();
      expect(keyGate.retryAfter(ip)).toBe(0);
    }
    keyGate.fail(ip); expect(keyGate.retryAfter(ip)).toBeGreaterThan(0);
    restore();
  } finally { outer(); }
});

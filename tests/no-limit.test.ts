import { test, expect } from 'bun:test';
import { AdmissionQueue } from '../backend/queue';
// State folder comes from tests/setup.ts.
const { noLimitDefaults, initialSettings } = await import('../backend/state');

test('0 for the gateway and for a key means no limit: every request starts at once', async () => {
  const q = new AdmissionQueue(0, 0); const signal = new AbortController().signal;
  const held = await Promise.all(Array.from({ length: 50 }, () => q.acquire('k', 0, signal)));
  expect(q.active).toBe(50); expect(q.waiting.length).toBe(0);
  held.forEach(release => release()); expect(q.active).toBe(0);
});

test('a set limit still queues and refuses when the queue is full', async () => {
  const q = new AdmissionQueue(1, 0); const signal = new AbortController().signal;
  const release = await q.acquire('k', 0, signal);
  await expect(q.acquire('k', 0, signal)).rejects.toThrow(/queue is full/);
  release();
  const perKey = new AdmissionQueue(0, 0); const one = await perKey.acquire('k', 1, signal);
  await expect(perKey.acquire('k', 1, signal)).rejects.toThrow(/queue is full/);
  expect((await perKey.acquire('other', 1, signal))).toBeFunction(); one();
});

test('new settings have no concurrency limit', () => {
  const s = initialSettings(); expect(s.maxConcurrent).toBe(0); expect(s.keys.every(k => k.limit === 0)).toBe(true);
});

test('the old default of 4 moves to no limit once; numbers chosen by hand stay', () => {
  const old = { maxConcurrent: 4, keys: [{ id: 'a', limit: 4 }, { id: 'b', limit: 12 }] };
  const moved = noLimitDefaults(old);
  expect(moved.maxConcurrent).toBe(0); expect(moved.keys.map((k: any) => k.limit)).toEqual([0, 12]); expect(moved.noLimitDefaults).toBe(true);
  expect(noLimitDefaults({ maxConcurrent: 12, keys: [] }).maxConcurrent).toBe(12);
  // After the move, a 4 set by hand is kept.
  expect(noLimitDefaults({ ...moved, maxConcurrent: 4 }).maxConcurrent).toBe(4);
});

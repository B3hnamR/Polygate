import { afterEach, expect, test } from 'bun:test';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { admin } from '../backend/admin';
import { settings, persist, stateDir } from '../backend/state';
import { preserveTestState } from './setup';

const restore = preserveTestState();
afterEach(restore);

test('a rejected source update changes neither builtin selection nor saved source settings', async () => {
  const saved = { builtin: false, sources: [{ id: 'existing', url: 'https://example.com/list.txt', proto: 'all' as const, enabled: true }] };
  settings.proxyLists = structuredClone(saved); persist();
  const vault = path.join(stateDir, 'settings.vault'), bytes = readFileSync(vault);
  for (const sources of [
    [{ url: 'not a url' }],
    [{ url: 'https://example.com/repeated' }, { url: 'https://example.com/repeated' }],
    Array.from({ length: 201 }, (_, i) => ({ url: `https://example.com/${i}` })),
  ]) {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ builtin: true, sources }))]), {
      method: 'POST', url: '/admin/proxies/sources', headers: { 'content-type': 'application/json' },
    });
    await expect(admin(req as any, {} as any, '/admin/proxies/sources')).rejects.toMatchObject({ status: 400 });
    expect(settings.proxyLists).toEqual(saved);
    expect(readFileSync(vault)).toEqual(bytes);
  }
});

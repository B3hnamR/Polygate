import { test, expect } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
const { relayReaches } = await import('../backend/transport');
const reaches = (u: string) => relayReaches(new URL(u));

test('a relay is used for public HTTPS hosts, and a provider on a local address or plain http is reached directly', () => {
  for (const u of ['https://api.example.org/v1', 'https://models.corp.example.com:8443/x', 'https://opencode.ai/zen/v1']) expect(reaches(u)).toBe(true);
  for (const u of ['http://api.example.org/v1', 'https://127.0.0.1/v1', 'https://192.168.1.5:9000', 'https://[::1]/v1', 'https://localhost:3000', 'https://box.local/v1', 'https://db.internal', 'https://nas.lan']) expect(reaches(u)).toBe(false);
});

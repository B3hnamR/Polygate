import { test, expect, afterAll } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
const { relayRequest, relayRedirect, plainRouteError } = await import('../backend/transport');
let hits = 0;
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) {
  hits++;
  if (new URL(req.url).pathname === '/elsewhere') return new Response('should never be asked', { status: 200 });
  return new Response(null, { status: 302, headers: { location: 'https://blocked.example.net/denied?token=abc' } });
} });
afterAll(() => server.stop(true));
const route: any = { id: 'r1', name: 'Relay', kind: 'relay', url: `http://127.0.0.1:${server.port}/`, token: 'access-token', enabled: true, models: [] };

test('a redirect that comes back through a relay is reported, not followed, and says where it pointed', async () => {
  const r = relayRequest('https://opencode.ai/inference/v1/models', { headers: {} }, route);
  const response = await fetch(r.url, r.init);
  expect(response.status).toBe(302); expect(hits).toBe(1); // the access token header was sent once, to the relay only
  const moved = relayRedirect(response)!;
  expect(moved.message).toBe('redirected (HTTP 302) to blocked.example.net/denied'); // no query string in the message
  expect(plainRouteError(moved.message, 'relay')).toContain('The site sent the request to blocked.example.net/denied (HTTP 302) instead of answering it');
  expect(plainRouteError(moved.message, 'relay')).toContain('may be blocked');
  expect(plainRouteError(moved.message, 'proxy')).not.toContain('may be blocked');
});

test('ordinary answers are not treated as redirects', () => {
  expect(relayRedirect(new Response('ok'))).toBeUndefined();
  expect(relayRedirect(new Response('no', { status: 429 }))).toBeUndefined();
  expect(relayRedirect(new Response(null, { status: 304 }))).toBeUndefined(); // a 3xx without a Location is not a redirect
});

test('a redirect to a path on the same address is described in full, not cut after its first word', () => {
  const moved = relayRedirect(new Response(null, { status: 308, headers: { location: '/somewhere/else' } }))!;
  expect(moved.message).toBe('redirected (HTTP 308) to a path on the same address');
  expect(plainRouteError(moved.message, 'relay')).toContain('The site sent the request to a path on the same address (HTTP 308)');
});

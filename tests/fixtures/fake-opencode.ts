// Stands in for `opencode serve` in tests/agent-engine.test.ts: the endpoints the engine manager's health check and self-test read,
// answered from the configuration Polygate wrote. FAKE_OPENCODE_MODE makes it misbehave the way a real engine could; a file named by
// FAKE_OPENCODE_CRASH_FILE makes it exit shortly after starting (once: the file is removed).
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2); const port = Number(args[args.indexOf('--port') + 1]);
writeFileSync(path.join(process.cwd(), 'fake-env.json'), JSON.stringify({ args, env: process.env }));
const mode = process.env.FAKE_OPENCODE_MODE || 'ok';
const configDir = path.join(process.env.XDG_CONFIG_HOME || '', 'opencode');
const config = JSON.parse(readFileSync(path.join(configDir, 'opencode.json'), 'utf8'));
const expected = 'Basic ' + Buffer.from('opencode:' + (process.env.OPENCODE_PASSWORD || '')).toString('base64');
const json = (body: unknown) => Response.json(body);
Bun.serve({ hostname: '127.0.0.1', port, fetch(req) {
  if (!process.env.OPENCODE_PASSWORD || req.headers.get('authorization') !== expected) return new Response('unauthorized', { status: 401 });
  const p = new URL(req.url).pathname;
  if (p === '/api/info') return json({ version: mode === 'old-version' ? '1.19.5' : '2.0.32', pid: process.pid });
  if (p === '/api/config') return json([
    { type: 'document', path: path.join(configDir, 'opencode.json'), info: config }, { type: 'directory', path: configDir },
    ...(mode === 'project-config' ? [{ type: 'document', path: 'C:\\work\\cloned-repo\\opencode.json', info: {} }] : []),
  ]);
  if (p === '/api/model') return json({ data: [
    ...Object.keys(config.providers.polygate.models).map(id => ({ id, providerID: 'polygate' })),
    ...(mode === 'other-provider' ? [{ id: 'm', providerID: 'evil' }] : []),
  ] });
  if (p === '/api/agent') return json({ data: [{ id: 'build', permissions: [
    { action: '*', resource: '*', effect: 'allow' }, ...config.permissions, { action: 'browser', resource: '*', effect: 'deny' },
    ...(mode === 'loose-rules' ? [{ action: 'shell', resource: '*', effect: 'allow' }] : []),
  ] }] });
  return new Response('not found', { status: 404 });
} });
const crash = process.env.FAKE_OPENCODE_CRASH_FILE;
if (crash && existsSync(crash)) { rmSync(crash); setTimeout(() => process.exit(3), 600); }

import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { GatewayError } from './queue';
import { settings, persist, stateDir, initialSettings, withBuiltIns } from './state';
import { version } from './version';
import type { Settings } from './types';
// A backup is the settings (providers and their keys, routes and relay tokens, client keys, chains, MCP servers, preferences) in one file,
// encrypted with a passphrase chosen at export time, so it can be restored on another computer. The saved settings file on disk is tied to
// that machine's vault.key and cannot be moved on its own.
// Not in the file: the dashboard password, HTTPS certificates, the WARP registration, the request log and the proxy pool's health data.
const FORMAT = 'polygate-backup';
const KDF = { N: 1 << 15, r: 8, p: 1 };
const key = (passphrase: string, salt: Buffer, params = KDF) => scryptSync(passphrase, salt, 32, { N: params.N, r: params.r, p: params.p, maxmem: 128 * 1024 * 1024 });
const checkPassphrase = (value: unknown) => { const p = String(value ?? ''); if (p.length < 8) throw new GatewayError('Choose a passphrase of at least 8 characters', 400); return p; };

export function createBackup(rawPassphrase: unknown) {
  const passphrase = checkPassphrase(rawPassphrase);
  const { admin: _password, ...content } = settings;
  const salt = randomBytes(16), iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key(passphrase, salt), iv);
  const body = Buffer.concat([c.update(JSON.stringify(content)), c.final()]);
  const file = { format: FORMAT, version: 1, created: new Date().toISOString(), app: version, kdf: { name: 'scrypt', ...KDF, salt: salt.toString('base64') }, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: body.toString('base64') };
  return { filename: `polygate-backup-${new Date().toISOString().slice(0, 10)}.pgbackup`, content: JSON.stringify(file), providers: settings.providers.length, routes: settings.routes.length, keys: settings.keys.length };
}

// Opens a backup file. A wrong passphrase and a damaged file are told apart only as far as the cipher allows; both say the same thing.
export function openBackup(raw: unknown, rawPassphrase: unknown): Settings {
  const passphrase = checkPassphrase(rawPassphrase); let file: any;
  try { file = JSON.parse(String(raw)); } catch { throw new GatewayError('That is not a Polygate backup file', 400); }
  if (!file || file.format !== FORMAT || file.version !== 1 || !file.kdf || typeof file.data !== 'string') throw new GatewayError('That is not a Polygate backup file', 400);
  const params = { N: Number(file.kdf.N), r: Number(file.kdf.r), p: Number(file.kdf.p) };
  // The file chooses the cost of the key derivation: refuse values that would tie the server up.
  if (![1 << 14, 1 << 15, 1 << 16].includes(params.N) || params.r !== 8 || params.p !== 1) throw new GatewayError('That backup uses settings this version does not support', 400);
  let text: string;
  try {
    const d = createDecipheriv('aes-256-gcm', key(passphrase, Buffer.from(file.kdf.salt, 'base64'), params), Buffer.from(file.iv, 'base64')); d.setAuthTag(Buffer.from(file.tag, 'base64'));
    text = Buffer.concat([d.update(Buffer.from(file.data, 'base64')), d.final()]).toString();
  } catch { throw new GatewayError('Wrong passphrase, or the backup file is damaged', 400); }
  let parsed: any; try { parsed = JSON.parse(text); } catch { throw new GatewayError('The backup could not be read', 400); }
  const arrays = ['providers', 'routes', 'keys'];
  if (!parsed || typeof parsed !== 'object' || arrays.some(k => !Array.isArray(parsed[k]))) throw new GatewayError('The backup does not hold usable settings', 400);
  if (parsed.routes.some((r: any) => !r || typeof r.id !== 'string' || typeof r.kind !== 'string') || parsed.providers.some((p: any) => !p || typeof p.id !== 'string') || parsed.keys.some((k: any) => !k || typeof k.id !== 'string' || typeof k.value !== 'string')) throw new GatewayError('The backup does not hold usable settings', 400);
  const next = withBuiltIns({ ...initialSettings(), ...parsed });
  if (!next.routes.some(r => r.id === 'direct')) next.routes.unshift(initialSettings().routes[0]);
  return next;
}

// Replaces the running settings with the backup's. The dashboard password stays as it is, so a restore cannot lock anyone out.
// A session that cannot manage this machine (a remote dashboard) does not bring in local programs the backup lists (MCP programs, the WARP helper): it could otherwise start commands here.
export function restoreBackup(raw: unknown, passphrase: unknown, canRunLocal: boolean) {
  const next = openBackup(raw, passphrase);
  // The WARP helper is a program the gateway starts: only a session that manages this machine may change which one (see checkHelperPath).
  if (!canRunLocal && next.warp) next.warp = { ...next.warp, helperPath: settings.warp?.helperPath || '' };
  if (!canRunLocal && next.mcp) next.mcp = { ...next.mcp, servers: [...next.mcp.servers.filter(s => s.transport !== 'stdio'), ...(settings.mcp?.servers || []).filter(s => s.transport === 'stdio')] };
  const before = path.join(stateDir, 'settings.vault.before-restore-' + Date.now());
  const vault = path.join(stateDir, 'settings.vault'); if (existsSync(vault)) copyFileSync(vault, before);
  const keep = settings.admin;
  for (const k of Object.keys(settings)) delete (settings as any)[k];
  Object.assign(settings, next); if (keep) settings.admin = keep; else delete settings.admin;
  persist();
  return { providers: settings.providers.length, routes: settings.routes.length, keys: settings.keys.length, kept: path.basename(before) };
}

import { settings } from './state';
import { keyProblem } from './plan';
import type { CheckItem } from './checklist';
import { plainError } from './plain-error';
import { enginePaths } from './agent-engine';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './state';
const pauseFile = () => path.join(enginePaths().root, 'paused.json');
export function pausedAgents(): { id: string; paused: string }[] {
  try { const data = JSON.parse(readFileSync(pauseFile(), 'utf8')); return Array.isArray(data) ? data.filter(s => typeof s?.id === 'string' && typeof s.paused === 'string').slice(-100) : []; } catch { return []; }
}
export function setAgentPause(id: string, message?: string) {
  const items = pausedAgents().filter(s => s.id !== id);
  if (message) items.push({ id: id.slice(0, 100), paused: message.slice(0, 2000) });
  const file = pauseFile(); mkdirSync(path.dirname(file), { recursive: true }); writeFileAtomic(file, JSON.stringify(items.slice(-100)));
}

export function agentRecoveryItems(engine: { state: string; installed: boolean; message: string }, sessions: { id: string; paused?: string }[]): CheckItem[] {
  if (process.env.POLYGATE_DESKTOP !== '1' || !engine.installed && !['running', 'failed'].includes(engine.state)) return [];
  const items: CheckItem[] = [];
  // Only a failure is a problem: the engine is off after every app start until the Agent page starts it, and the user may stop it.
  if (engine.state === 'failed') items.push({ id: 'agent_engine', severity: 'warning', title: 'The coding agent engine stopped with a problem', detail: engine.message || 'Agent sessions cannot run. Other model clients can still use the gateway.', page: 'Agent', ...(engine.installed ? { fix: { label: 'Start agent engine', endpoint: '/admin/agent/engine/start' } } : {}) });
  const key = settings.keys.find(k => k.agent), why = key ? keyProblem(key) : 'it is missing';
  if (why) items.push({ id: 'agent_key', severity: 'warning', title: 'The agent client key cannot be used', detail: `The agent key cannot make requests because ${why}. Review it in Settings; it is never enabled automatically.`, page: 'Settings' });
  for (const session of sessions.filter(s => s.paused)) items.push({ id: `agent_paused:${session.id}`, severity: 'warning', title: 'An agent session is paused', detail: plainError(session.paused), page: 'Agent' });
  return items;
}

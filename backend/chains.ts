import { settings, models } from './state';
import { GatewayError } from './queue';
import type { Chain } from './types';

// A chain's steps are real model ids or these aliases (an alias stands for its best few models at that point in the order).
export const AUTO_STEPS = ['auto', 'auto:smart', 'auto:fast'];
export const MAX_CHAINS = 30;
export const MAX_STEPS = 8;
const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;
export const chainFor = (name: string) => settings.chains?.find(c => c.name === name);
export const modelFor = (id: string) => models.get(id) || [...models.values()].find(m => m.upstreamId === id);

// Checks a chain from the dashboard or the API before anything is saved. `existing` is the saved version being edited: steps it
// already holds stay valid even when their model has since left the provider's catalog, so an old chain can still be reordered.
export function cleanChain(raw: any, existing?: Chain): Chain {
  const name = String(raw?.name ?? '').trim().toLowerCase();
  if (!NAME.test(name)) throw new GatewayError('Give the chain a short name of letters, numbers, dots, dashes or underscores, such as my-coding.', 400, 'invalid_chain');
  if (name === 'auto') throw new GatewayError('"auto" is already built in. Pick another name.', 400, 'invalid_chain');
  if (modelFor(name)) throw new GatewayError(`A model is already called "${name}". Pick another name.`, 400, 'invalid_chain');
  if (settings.chains?.some(c => c.name === name && c.id !== existing?.id)) throw new GatewayError(`A chain called "${name}" already exists.`, 400, 'invalid_chain');
  if (!Array.isArray(raw.models) || !raw.models.length) throw new GatewayError('Add at least one model to the chain.', 400, 'invalid_chain');
  if (raw.models.length > MAX_STEPS) throw new GatewayError(`A chain can have up to ${MAX_STEPS} steps.`, 400, 'invalid_chain');
  const steps: string[] = [];
  for (const entry of raw.models) {
    const step = String(entry ?? '').trim();
    if (!AUTO_STEPS.includes(step) && !modelFor(step) && !existing?.models.includes(step)) throw new GatewayError(`"${step.slice(0, 80)}" is not a model Polygate knows. Pick one from the Models page.`, 400, 'invalid_chain');
    if (steps.includes(step)) throw new GatewayError(`"${step}" is in the chain twice.`, 400, 'invalid_chain');
    steps.push(step);
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new GatewayError('Expected a boolean', 400, 'invalid_chain');
  return { id: existing?.id || crypto.randomUUID(), name, description: String(raw.description ?? '').trim().slice(0, 200) || undefined, enabled: raw.enabled ?? existing?.enabled ?? true, models: steps, created: existing?.created || Date.now() };
}

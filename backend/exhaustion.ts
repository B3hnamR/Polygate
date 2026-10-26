// OpenCode Free answers several different problems with the same 429 FreeUsageLimitError, and every one of them carries a Retry-After
// that counts down to 00:00:00 UTC: a used-up daily allowance (which follows the egress IP), a request whose shape is wrong, and a
// client whose TLS handshake is not Bun's. The response alone cannot tell them apart, so a 429 with a
// countdown is only a suspicion; transport.ts confirms it with a small known-good request through the same exit before retiring it.
// `refused` marks a short-lived exhaustion recorded for a relay whose outbound TLS client cannot be confirmed to be Bun's.
export type Exhaustion = { until: number; seconds: number; refused?: boolean };
const DAY = 86400;
// Retry-After is either a number of seconds or an HTTP date.
export function parseRetryAfter(value: string | null | undefined): number {
  if (!value) return 0; const n = Number(value); if (Number.isFinite(n)) return Math.max(0, n);
  const at = Date.parse(value); return Number.isFinite(at) ? Math.max(0, Math.round((at - Date.now()) / 1000)) : 0;
}
export const FREE_LIMIT_TEXT = /FreeUsageLimit|Free usage limit/i;
export function exhaustionOf(status: number, retryAfter: string | null | undefined, text: string): Exhaustion | undefined {
  if (status !== 429 || !FREE_LIMIT_TEXT.test(text)) return;
  const seconds = parseRetryAfter(retryAfter); if (seconds <= 0) return;
  const capped = Math.min(seconds, DAY); return { until: Date.now() + capped * 1000, seconds: capped };
}
// Reads the (small) error body from a copy, so the caller can still consume the original response.
export async function detectExhaustion(response: Response): Promise<Exhaustion | undefined> {
  if (response.status !== 429 || parseRetryAfter(response.headers.get('retry-after')) <= 0) return;
  let text = ''; try { text = (await response.clone().text()).slice(0, 2000); } catch { return; }
  return exhaustionOf(429, response.headers.get('retry-after'), text);
}
// The gateway learns about an exhausted egress from the network layer, keyed by the request that hit it.
const seen = new Map<string, Exhaustion>();
export function noteExhaustion(requestId: string | undefined, ex: Exhaustion) { if (!requestId) return; seen.set(requestId, ex); if (seen.size > 300) seen.delete(seen.keys().next().value!); }
export function takeExhaustion(requestId: string | undefined) { if (!requestId) return; const ex = seen.get(requestId); seen.delete(requestId); return ex; }
// Confirmation requests carry this prefix so the network layer neither retires an exit nor starts another confirmation for them.
export const isCanary = (id?: string) => !!id && id.startsWith('canary-');
export const newCanaryId = () => 'canary-' + crypto.randomUUID();
export const nextResetAt = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime(); };
export const refusedExhaustion = (minutes = 15): Exhaustion => ({ until: Date.now() + minutes * 60000, seconds: minutes * 60, refused: true });
// A request whose exit was confirmed clean: the 429 was a refusal of that request, not a used-up allowance.
const refusedIds = new Set<string>();
export function noteRefused(requestId: string | undefined) { if (!requestId) return; refusedIds.add(requestId); if (refusedIds.size > 300) refusedIds.delete(refusedIds.values().next().value!); }
export function takeRefused(requestId: string | undefined) { return !!requestId && refusedIds.delete(requestId); }
export const resetTime = (until: number) => new Date(until).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

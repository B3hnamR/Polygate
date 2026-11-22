// OpenCode Free can answer quota and access restrictions with the same 429 FreeUsageLimitError. Retry-After is an advertised delay,
// not proof of an exhausted daily allowance or midnight reset. The response alone cannot tell them apart, so a 429 with a
// countdown is only a suspicion; transport.ts confirms it with a small known-good request through the same exit before retiring it.
// `refused` marks a short-lived exhaustion recorded for a relay whose outbound TLS client cannot be confirmed to be Bun's.
export type Exhaustion = { until: number; seconds: number; refused?: boolean };
const DAY = 86400;
// A countdown under an hour is a rate limit, not the provider's daily allowance. Treating it as a used-up exit labels every exit the
// limit touched with "Used up until ...", so one short throttle rests a whole group. Keep the real wait but mark it as a refusal:
// the exit is skipped briefly, rechecked, and never recorded as a spent daily quota.
const SHORT_LIMIT_SECONDS = 3600;
// Retry-After is either a number of seconds or an HTTP date.
export function parseRetryAfter(value: string | null | undefined): number {
  if (!value) return 0; const n = Number(value); if (Number.isFinite(n)) return Math.max(0, n);
  const at = Date.parse(value); return Number.isFinite(at) ? Math.max(0, Math.round((at - Date.now()) / 1000)) : 0;
}
export const FREE_LIMIT_TEXT = /FreeUsageLimit|Free usage limit/i;
export function exhaustionOf(status: number, retryAfter: string | null | undefined, text: string): Exhaustion | undefined {
  if (status !== 429 || !FREE_LIMIT_TEXT.test(text)) return;
  const seconds = parseRetryAfter(retryAfter); if (seconds <= 0) return;
  if (seconds < SHORT_LIMIT_SECONDS) return refusedExhaustion(Math.max(1, Math.ceil(seconds / 60)));
  const capped = Math.min(seconds, DAY); return { until: Date.now() + capped * 1000, seconds: capped };
}
// Bound both bytes and time: an error body can be a stalled or unbounded stream.
async function limitText(response: Response): Promise<string> {
  const reader = response.clone().body?.getReader(); if (!reader) return '';
  const decoder = new TextDecoder(); let text = '', bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Error body timed out')), 2000); });
  try {
    while (bytes < 2000) {
      const { value, done } = await Promise.race([reader.read(), timeout]); if (done) break;
      const part = value.subarray(0, 2000 - bytes); bytes += part.byteLength; text += decoder.decode(part, { stream: true });
    }
    return text + decoder.decode();
  } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}
// Reads a bounded copy, so the caller can still consume the original response.
export async function detectExhaustion(response: Response): Promise<Exhaustion | undefined> {
  if (response.status !== 429 || parseRetryAfter(response.headers.get('retry-after')) <= 0) return;
  let text = ''; try { text = await limitText(response); } catch { return; }
  return exhaustionOf(429, response.headers.get('retry-after'), text);
}
// A live request's 429: the countdown case above, or OpenCode's limit text with no Retry-After at all. The second is only a suspicion that the
// exit cannot be used (marked `refused`, rechecked in 15 minutes, never read as a daily reset); the caller confirms it with a known-good request
// through the same exit before the exit is set aside, so a refusal of this one request still reads as a refusal of the request.
export async function suspectExhaustion(response: Response): Promise<Exhaustion | undefined> {
  if (response.status !== 429) return;
  let text = ''; try { text = await limitText(response); } catch { return; }
  return exhaustionOf(429, response.headers.get('retry-after'), text) || (FREE_LIMIT_TEXT.test(text) ? refusedExhaustion() : undefined);
}
// The gateway learns about an exhausted egress from the network layer, keyed by the request that hit it.
const seen = new Map<string, Exhaustion>();
export function noteExhaustion(requestId: string | undefined, ex: Exhaustion) { if (!requestId) return; inconclusiveIds.delete(requestId); refusedIds.delete(requestId); seen.set(requestId, ex); if (seen.size > 300) seen.delete(seen.keys().next().value!); }
export function takeExhaustion(requestId: string | undefined) { if (!requestId) return; const ex = seen.get(requestId); seen.delete(requestId); return ex; }
// An unconfirmed countdown must not be reinterpreted as confirmed by the gateway.
const inconclusiveIds = new Set<string>();
export function noteInconclusive(requestId: string | undefined) { if (!requestId) return; seen.delete(requestId); refusedIds.delete(requestId); inconclusiveIds.add(requestId); if (inconclusiveIds.size > 300) inconclusiveIds.delete(inconclusiveIds.values().next().value!); }
export function takeInconclusive(requestId: string | undefined) { return !!requestId && inconclusiveIds.delete(requestId); }
// Confirmation requests carry this prefix so the network layer neither retires an exit nor starts another confirmation for them.
export const isCanary = (id?: string) => !!id && id.startsWith('canary-');
export const newCanaryId = () => 'canary-' + crypto.randomUUID();
export const nextResetAt = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime(); };
export const refusedExhaustion = (minutes = 15): Exhaustion => ({ until: Date.now() + minutes * 60000, seconds: minutes * 60, refused: true });
// A request whose exit was confirmed clean: the 429 was a refusal of that request, not a used-up allowance.
const refusedIds = new Set<string>();
export function noteRefused(requestId: string | undefined) { if (!requestId) return; seen.delete(requestId); inconclusiveIds.delete(requestId); refusedIds.add(requestId); if (refusedIds.size > 300) refusedIds.delete(refusedIds.values().next().value!); }
export function takeRefused(requestId: string | undefined) { return !!requestId && refusedIds.delete(requestId); }
export const resetTime = (until: number) => new Date(until).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

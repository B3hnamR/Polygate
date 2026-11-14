import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { GatewayError } from './queue';
// Cancel for dashboard actions that take a while (a route test, a relay deploy, a Psiphon server update…). The dashboard cancels by
// dropping its request; every admin request carries a signal that fires then, and the work below picks it up wherever it waits:
// cancellable(ms) is the usual timeout, which now also ends when the person who started the work cancels it. Outside a dashboard
// request (client traffic, timers) there is no signal and cancellable(ms) is a plain timeout.
// The signal belongs to the request only while it is in flight: async context also reaches timers and child processes started during
// the request, and those must not be cancelled later by a request that has already ended (see also detached()).
type Entry = { signal: AbortSignal; open: boolean };
const current = new AsyncLocalStorage<Entry>();
export const CANCELLED = 'Cancelled.';
export const cancelledError = () => new GatewayError(CANCELLED, 499, 'cancelled');
export function withRequestCancel<T>(res: ServerResponse, _req: IncomingMessage, fn: () => Promise<T>): Promise<T> {
  const c = new AbortController(); const entry: Entry = { signal: c.signal, open: true };
  // 'close' also fires after a normal answer; only a connection that closes before the answer was written is a cancel.
  const closed = () => { if (!res.writableEnded) c.abort(cancelledError()); };
  res.once('close', closed);
  return current.run(entry, fn).finally(() => { entry.open = false; res.off('close', closed); });
}
const live = () => { const e = current.getStore(); return e?.open ? e.signal : undefined; };
// The signal of the dashboard request this code runs for, while that request is in flight.
export const requestSignal = () => live();
export const isCancelled = () => !!live()?.aborted;
// Between two steps of a longer job: stop here when the person cancelled.
export function stopIfCancelled() { const s = live(); if (s?.aborted) throw s.reason instanceof Error ? s.reason : cancelledError(); }
export function cancellable(ms: number): AbortSignal {
  const s = live(); const t = AbortSignal.timeout(ms);
  return s ? AbortSignal.any([s, t]) : t;
}
// The same, for a signal the caller already has (a client's own abort, say).
export function alsoOnCancel(signal: AbortSignal | undefined): AbortSignal | undefined {
  const s = live(); if (!s) return signal; return signal ? AbortSignal.any([s, signal]) : s;
}
// Clean-up after a cancel (removing what a half-finished deploy created) must not be cancelled itself: it runs outside the request's signal.
export const afterCancel = <T>(fn: () => Promise<T>): Promise<T> => current.exit(fn);
// Work a request starts but does not own (a timer for a later re-check, a long-running client process and its notices) is started with
// this, so cancelling the request never reaches it.
export const detached = <T>(fn: () => T): T => current.exit(fn);

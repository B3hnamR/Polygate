import { test, expect } from 'bun:test';
import './setup';
import { serve } from '../backend/serve';
const { withRequestCancel, cancellable, isCancelled, afterCancel, requestSignal } = await import('../backend/cancel');

// A server that accepts a request and never answers: work waiting on it only ends by its timeout or a cancel.
function hanging(): Promise<{ url: string; close: () => void }> {
  return new Promise(resolve => {
    const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Promise<Response>(() => {}) });
    resolve({ url: `http://127.0.0.1:${s.port}/`, close: () => s.stop(true) });
  });
}

test('a dashboard request that is dropped cancels the work it started, at once', async () => {
  const slow = await hanging();
  let outcome = ''; let took = 0; let cleanedUpWithSignal: boolean | undefined;
  const c = new AbortController();
  let ready!: () => void, finish!: () => void;
  const started = new Promise<void>(r => { ready = r; }), done = new Promise<void>(r => { finish = r; });
  const server = serve((req, res) => {
    const start = Date.now();
    return withRequestCancel(res, req, async () => {
      ready();
      try { await fetch(slow.url, { signal: cancellable(20000) }); outcome = 'answered'; }
      catch { outcome = isCancelled() ? 'cancelled' : 'failed'; took = Date.now() - start; cleanedUpWithSignal = await afterCancel(async () => !!requestSignal()); }
      finish();
    });
  }, 0);
  try {
    void fetch(`http://127.0.0.1:${server.port}/`, { method: 'POST', signal: c.signal }).catch(() => {});
    await started; c.abort(); await done;
  } finally { server.stop(true); slow.close(); }
  expect(outcome).toBe('cancelled');
  expect(took).toBeLessThan(3000); // not the 20 s timeout
  expect(cleanedUpWithSignal).toBe(false); // clean-up runs outside the cancelled request
});

test('a request that is answered normally is not taken for a cancel', async () => {
  let after: boolean | undefined;
  const server = serve((req, res) => {
    void withRequestCancel(res, req, async () => {
      const signal = requestSignal()!;
      res.end('ok');
      await new Promise(r => setTimeout(r, 200)); after = signal.aborted;
    });
  }, 0);
  try {
    expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toBe('ok');
    await new Promise(r => setTimeout(r, 400));
  } finally { server.stop(true); }
  expect(after).toBe(false);
});

test('outside a dashboard request cancellable(ms) is a plain timeout', async () => {
  const slow = await hanging();
  const start = Date.now(); let name = '';
  try { await fetch(slow.url, { signal: cancellable(300) }); } catch (e: any) { name = e?.name; }
  slow.close();
  expect(name).toBe('TimeoutError');
  expect(Date.now() - start).toBeLessThan(3000);
  expect(isCancelled()).toBe(false);
});

test('a cancel reaches only the request: work it scheduled for later, or started detached, keeps running', async () => {
  const { detached } = await import('../backend/cancel');
  const { EventEmitter } = await import('node:events');
  const res = Object.assign(new EventEmitter(), { writableEnded: false }) as any; const req = new EventEmitter() as any;
  let later: AbortSignal | undefined; let detachedSignal: AbortSignal | undefined; let duringRequest: AbortSignal | undefined;
  const running = withRequestCancel(res, req, async () => {
    duringRequest = cancellable(60000);
    setTimeout(() => { later = cancellable(60000); }, 150);                     // scheduled the ordinary way: runs after the request ended
    detached(() => setTimeout(() => { detachedSignal = cancellable(60000); }, 20)); // started detached: runs while the request is still open
    await new Promise(r => setTimeout(r, 60));
  });
  setTimeout(() => res.emit('close'), 40); // the person cancels while the request is in flight
  await running; await new Promise(r => setTimeout(r, 250));
  expect(duringRequest!.aborted).toBe(true);    // the request's own work is cancelled
  expect(detachedSignal!.aborted).toBe(false);  // detached work is not
  expect(later!.aborted).toBe(false);           // nor is anything that runs after the request ended
});

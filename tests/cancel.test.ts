import { test, expect } from 'bun:test';
import './setup';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
const { withRequestCancel, cancellable, isCancelled, afterCancel, requestSignal } = await import('../backend/cancel');

// A server that accepts a request and never answers: work waiting on it only ends by its timeout or a cancel.
function hanging(): Promise<{ url: string; close: () => void }> {
  return new Promise(resolve => {
    const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Promise<Response>(() => {}) });
    resolve({ url: `http://127.0.0.1:${s.port}/`, close: () => s.stop(true) });
  });
}
function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string }> {
  return new Promise(resolve => { const server = createServer(handler); server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` })); });
}

test('a dashboard request that is dropped cancels the work it started, at once', async () => {
  const slow = await hanging();
  let outcome = ''; let took = 0; let cleanedUpWithSignal: boolean | undefined;
  const done = new Promise<void>(r => {
    void listen((req, res) => {
      const start = Date.now();
      void withRequestCancel(res, req, async () => {
        try { await fetch(slow.url, { signal: cancellable(20000) }); outcome = 'answered'; }
        catch { outcome = isCancelled() ? 'cancelled' : 'failed'; took = Date.now() - start; cleanedUpWithSignal = await afterCancel(async () => !!requestSignal()); }
        r();
      });
    }).then(({ server, url }) => {
      const c = new AbortController();
      fetch(url, { method: 'POST', signal: c.signal }).catch(() => {});
      setTimeout(() => c.abort(), 300);
      void done.then(() => server.close());
    });
  });
  await done; slow.close();
  expect(outcome).toBe('cancelled');
  expect(took).toBeLessThan(3000); // not the 20 s timeout
  expect(cleanedUpWithSignal).toBe(false); // clean-up runs outside the cancelled request
});

test('a request that is answered normally is not taken for a cancel', async () => {
  let after: boolean | undefined;
  const { server, url } = await listen((req, res) => {
    void withRequestCancel(res, req, async () => {
      const signal = requestSignal()!;
      res.end('ok');
      await new Promise(r => setTimeout(r, 200)); after = signal.aborted;
    });
  });
  expect(await (await fetch(url)).text()).toBe('ok');
  await new Promise(r => setTimeout(r, 400)); server.close();
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

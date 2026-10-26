import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
// Bun's node:http server never emits 'close' when a client disconnects, so cancelled requests kept running
// upstream. Bun.serve reports disconnects through request.signal; this adapter exposes the small slice of the
// IncomingMessage/ServerResponse surface used by the gateway and vendored adapters on top of it.
export type NodeHandler = (req: IncomingMessage, res: ServerResponse) => unknown;
const bodyless = (status: number) => status < 200 || status === 204 || status === 205 || status === 304;
const bytes = (chunk: any, encoding?: any) => typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8') : chunk as Uint8Array;
export function serve(handler: NodeHandler, port: number, hostname = '127.0.0.1', tls?: { cert: string; key: string }, reusePort = false) {
  const server = Bun.serve({
    port, hostname, idleTimeout: 0, ...(tls ? { tls } : {}), ...(reusePort && process.platform === 'linux' ? { reusePort: true } : {}),
    fetch(request, bun) {
      return new Promise<Response>(resolve => {
        const url = new URL(request.url); const headers: Record<string, string> = {};
        request.headers.forEach((value, key) => { headers[key] = value; });
        const req: any = Object.assign(request.body ? Readable.fromWeb(request.body as any) : Readable.from([]), { method: request.method, url: url.pathname + url.search, headers, socket: { remoteAddress: bun.requestIP(request)?.address ?? '', encrypted: url.protocol === 'https:' } });
        const out = new Headers(); let status = 200; let committed = false, ended = false, closed = false, flushed = false; let ctl: ReadableStreamDefaultController<Uint8Array> | undefined;
        const res: any = new EventEmitter(); res.socket = req.socket; res.destroyed = false; res.writableEnded = false; res.finished = false;
        const respond = (body: BodyInit | null) => { if (committed) return; committed = true; resolve(new Response(bodyless(status) ? null : body, { status, headers: out })); };
        const close = () => { if (closed) return; closed = true; res.destroyed = true; res.emit('close'); };
        const open = () => {
          if (ctl || ended || res.destroyed) return;
          respond(new ReadableStream<Uint8Array>({ start(c) { ctl = c; }, pull() { res.emit('drain'); }, cancel() { close(); } }, new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 })));
        };
        Object.defineProperty(res, 'statusCode', { get: () => status, set: (v: number) => { status = v; } });
        Object.defineProperty(res, 'headersSent', { get: () => flushed || committed });
        Object.defineProperty(res, 'writable', { get: () => !ended && !res.destroyed });
        res.setHeader = (name: string, value: any) => { out.delete(name); for (const v of Array.isArray(value) ? value : [value]) out.append(name, String(v)); return res; };
        res.getHeader = (name: string) => out.get(name) ?? undefined; res.hasHeader = (name: string) => out.has(name); res.removeHeader = (name: string) => out.delete(name);
        res.writeHead = (code: number, a?: any, b?: any) => { status = code; flushed = true; const extra = typeof a === 'object' && a ? a : b; if (extra) for (const [k, v] of Object.entries(extra)) res.setHeader(k, v); return res; };
        res.flushHeaders = () => { flushed = true; open(); };
        res.write = (chunk: any, encoding?: any, cb?: any) => { if (ended || res.destroyed) return false; flushed = true; open(); const data = bytes(chunk, encoding); if (data.byteLength) try { ctl!.enqueue(data); } catch { return false; } if (typeof encoding === 'function') encoding(); else if (typeof cb === 'function') cb(); return (ctl!.desiredSize ?? 1) > 0; };
        res.end = (chunk?: any, encoding?: any, cb?: any) => {
          if (typeof chunk === 'function') { cb = chunk; chunk = undefined; } else if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
          if (ended || res.destroyed) { cb?.(); return res; }
          ended = true; flushed = true; res.writableEnded = res.finished = true;
          const data = chunk == null ? null : bytes(chunk, encoding);
          if (ctl) { try { if (data?.byteLength) ctl.enqueue(data); ctl.close(); } catch { /* client already gone */ } } else respond((data?.byteLength ? data : null) as BodyInit | null);
          queueMicrotask(() => { res.emit('finish'); close(); cb?.(); }); return res;
        };
        res.destroy = () => { if (res.destroyed) return res; if (ctl) { try { ctl.error(new Error('Response destroyed')); } catch { /* already closed */ } } else respond(null); ended = true; close(); return res; };
        res.cork = res.uncork = res.setTimeout = () => res;
        request.signal.addEventListener('abort', () => { respond(null); close(); req.destroy?.(); }, { once: true });
        Promise.resolve().then(() => handler(req, res)).catch(error => {
          if (committed) { if (!ended) { try { ctl?.error(error); } catch { /* closed */ } } return; }
          status = 500; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: { type: 'gateway_error', message: String(error?.message || error) } }));
        });
      });
    },
  });
  return server;
}

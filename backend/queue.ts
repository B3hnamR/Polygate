export class GatewayError extends Error { constructor(message: string, public status = 500, public type = 'gateway_error', public retryAfter = 0) { super(message); } }
type Waiter = { key: string; limit: number; resolve: (release: () => void) => void; reject: (e: Error) => void; signal: AbortSignal; cancel: () => void };
export class AdmissionQueue {
  active = 0; perKey = new Map<string,number>(); waiting: Waiter[] = [];
  constructor(public max = 4, public capacity = 32) {}
  private available(key: string, limit: number) { return this.active < this.max && (this.perKey.get(key)||0) < limit; }
  private take(key: string) { this.active++; this.perKey.set(key,(this.perKey.get(key)||0)+1); let done=false; return () => { if(done)return; done=true; this.active--; this.perKey.set(key,Math.max(0,(this.perKey.get(key)||0)-1)); this.drain(); }; }
  drain() { for(let i=0;i<this.waiting.length;) { const w=this.waiting[i]; if(this.available(w.key,w.limit)){ this.waiting.splice(i,1); w.signal.removeEventListener('abort',w.cancel);w.resolve(this.take(w.key)); }else i++; } }
  acquire(key: string, limit: number, signal: AbortSignal, maxWaitMs = 0): Promise<() => void> {
    if(signal.aborted) return Promise.reject(new GatewayError('Request cancelled',499));
    if(this.available(key,limit))return Promise.resolve(this.take(key));
    if(this.waiting.length>=this.capacity)return Promise.reject(new GatewayError('Gateway queue is full. Retry shortly.',429,'queue_full',3));
    return new Promise((resolve,reject)=>{ let timer:ReturnType<typeof setTimeout>|undefined; const w:Waiter={ key,limit,resolve:release=>{if(timer)clearTimeout(timer);resolve(release);},reject,signal,cancel:()=>{if(timer)clearTimeout(timer);this.waiting=this.waiting.filter(x=>x!==w);reject(new GatewayError('Request expired while queued',408));} };this.waiting.push(w);signal.addEventListener('abort',w.cancel,{once:true});
    // A bounded wait turns a long backlog into a prompt 429 the client can retry, instead of a request that hangs until its deadline.
    if(maxWaitMs>0){timer=setTimeout(()=>{signal.removeEventListener('abort',w.cancel);this.waiting=this.waiting.filter(x=>x!==w);reject(new GatewayError('The gateway is busy; the request waited too long in the queue.',429,'queue_timeout',3));},maxWaitMs);timer.unref?.();} });
  }
}

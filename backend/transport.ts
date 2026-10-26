import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { settings, persist, redactError } from './state';
import { GatewayError } from './queue';
import type { Route } from './types';
import { socksBridge, parseSocksUrl } from './socks-bridge';
import { warpTarget, warpFailure, warpSuccess } from './warp';
import { pickPoolProxy, poolReport, virtualPoolRoute, poolExhausted, hasCleanStandby, poolSummary } from './pool';
import { detectExhaustion, FREE_LIMIT_TEXT, noteExhaustion, noteRefused, isCanary, newCanaryId, refusedExhaustion, nextResetAt, resetTime, type Exhaustion } from './exhaustion';
import { beginAttempt, finishAttempt } from './diagnostics';
const exec = promisify(execFile);
// requestId ties outbound calls to the gateway request that caused them, so their shape can be logged with it.
export const routeContext = new AsyncLocalStorage<{routeId: string; requestId?: string}>();
let cursor=0;
const now=()=>Date.now();
// A route is out of play while it cools down after connection failures, or while its exit address has used up its daily Free allowance.
const coolingDown=(r:Route)=>(!!r.cooldownUntil&&r.cooldownUntil>now())||(!!r.exhaustedUntil&&r.exhaustedUntil>now());
export const isExhausted=(r:Route)=>!!r.exhaustedUntil&&r.exhaustedUntil>now();
export function routeExhausted(route:Route,ex:Exhaustion){route.exhaustedUntil=ex.until;route.status=ex.refused?`Refused by the Free tier (retry after ${resetTime(ex.until)})`:`Daily Free allowance used (resets ${resetTime(ex.until)})`;persist();}
// A relay is judged like a direct connection only when it says its TLS handshake is Bun's: it runs on Bun, or on Node with Bun's cipher list (relays/netlify-relay.js).
const trustedRuntime=(v:string|null)=>/^(bun|node-bun-ciphers)/i.test(v||'');
// A 429 with a countdown is only a suspicion of a used-up exit: a wrong request shape or a TLS client other than Bun's gets the same answer.
// One small known-good request through the same exit settles it. Replaceable so tests need no network.
// undefined when there is nothing to send with or the connection failed; canaryNote says which.
let canaryNote='';
async function canaryResponse(routeId:string):Promise<Response|undefined>{
  const {rankedModels,providerChat,sessionFor}=await import('./providers');
  const provider=settings.providers.find(p=>p.enabled&&p.kind==='free');
  // Models that last answered come first; one the provider calls unavailable would fail for a reason that has nothing to do with the exit.
  const usable=provider?rankedModels().filter(m=>m.providerId===provider.id&&(m.state==='available'||m.state==='unchecked')&&m.cooldownUntil<=Date.now()).sort((a,b)=>(a.state==='available'?0:1)-(b.state==='available'?0:1)||(a.latency||1e9)-(b.latency||1e9)):[];
  if(!provider||!usable.length){canaryNote='no enabled OpenCode Free provider has an available model';return;}
  let last:Response|undefined;
  for(const model of usable.slice(0,3)){
    try{
      const r=await providerChat(provider,model,{messages:[{role:'user',content:'Reply with OK.'}],max_tokens:8,stream:true},AbortSignal.timeout(20000),routeId,sessionFor('canary',[{role:'user',content:'canary'}],{}),newCanaryId());
      // A refusal or success says something about the exit; a model-level error (unavailable, deprecated) says nothing, so the next model is tried.
      if(r.ok||r.status===429||![400,404,410,502,503].includes(r.status))return r;
      last?.body?.cancel().catch(()=>{});last=r;
    }catch(e:any){canaryNote=redactError(String(e?.message||e)).slice(0,160);return;}
  }
  canaryNote='';return last;
}
async function defaultVerifier(routeId:string):Promise<'exhausted'|'refused'>{
  const r=await canaryResponse(routeId);if(!r)return 'exhausted';
  r.body?.cancel().catch(()=>{});return r.ok?'refused':'exhausted';
}
let canarySender=canaryResponse;export const __setCanarySender=(fn?:typeof canaryResponse)=>{canarySender=fn||canaryResponse;};
export type ChatCheck={chat:'ok'|'used-up'|'refused'|'unknown';until?:number;note?:string};
// A "used up" mark is only the countdown the provider announced. Asking again settles it: a passing request clears the mark, a refusal renews it.
export async function checkChat(route:Route):Promise<ChatCheck>{
  const r=await canarySender(route.id);if(!r)return {chat:'unknown',note:canaryNote};
  if(r.ok){r.body?.cancel().catch(()=>{});route.exhaustedUntil=0;route.cooldownUntil=0;route.status='healthy';persist();return {chat:'ok'};}
  // The bridge answers a refusal without the provider's Retry-After header, so the limit text alone also counts (the reset is the next 00:00 UTC).
  let seen=await detectExhaustion(r);const text=seen?'':await r.text().catch(()=>'');r.body?.cancel().catch(()=>{});
  if(!seen&&r.status===429&&FREE_LIMIT_TEXT.test(text)){const until=nextResetAt();seen={until,seconds:Math.round((until-Date.now())/1000)};}
  if(!seen)return {chat:'unknown',note:`HTTP ${r.status} ${redactError(text.replace(/\s+/g,' ')).slice(0,140)}`.trim()};
  const ex=route.kind==='relay'&&!trustedRuntime(r.headers.get('x-relay-runtime'))?refusedExhaustion():seen;
  routeExhausted(route,ex);return {chat:ex.refused?'refused':'used-up',until:ex.until};
}
// Routes marked used up are asked again every few minutes, so a stale mark (an address that recovered, a wrong countdown) does not keep a working exit out of play.
export function startExitRecheck(){
  const run=async()=>{for(const r of settings.routes)if(r.enabled&&isExhausted(r)&&!r.status?.startsWith('Refused')&&r.id!=='proxy-pool')await checkChat(r).catch(()=>{});};
  const first=setTimeout(()=>void run(),60000);const timer=setInterval(()=>void run(),10*60000);first.unref?.();timer.unref?.();
  return ()=>{clearTimeout(first);clearInterval(timer);};
}
let exitVerifier=defaultVerifier;export const __setExitVerifier=(fn?:typeof defaultVerifier)=>{exitVerifier=fn||defaultVerifier;};
// Returns the exhaustion to record, or undefined when the exit is fine and only this request was refused.
async function judgeExhaustion(routeId:string,viaRelay:boolean,response:Response,ex:Exhaustion,rid?:string):Promise<Exhaustion|undefined>{
  if(rid?.startsWith('pool-test-'))return ex; // pool tests already are the known-good request
  // A relay is the TLS client the provider sees. Only one that says it runs Bun can be judged like a direct connection (relays/vercel-bun).
  if(viaRelay&&!trustedRuntime(response.headers.get('x-relay-runtime')))return refusedExhaustion();
  return (await exitVerifier(routeId))==='refused'?undefined:ex;
}
// Where a request goes when its route's exit is used up: a pool proxy that just proved itself clean, else the next healthy route.
export function exhaustedAlternative(current:Route):Route|undefined{
  if(settings.exhaustedFailover===false)return;
  const pool=settings.routes.find(r=>r.id==='proxy-pool'&&r.enabled&&r.id!==current.id&&!coolingDown(r));
  if(pool&&hasCleanStandby())return pool;
  return failoverRoutes(current).find(r=>r.id!=='proxy-pool');
}
// Virtual routes ("pool:<proxy>") let the pool tester send real traffic through one specific proxy without saving a route for it.
export const findRoute=(id:string):Route|undefined=>id.startsWith('pool:')?virtualPoolRoute(id.slice(5)):settings.routes.find(r=>r.id===id&&r.enabled);
export function routeFor(model='', explicit=''): Route {
  const selected=explicit||settings.routeId;
  const current=findRoute(selected);
  // The selected route's exit has used up its daily allowance: stay on a clean alternative until the allowance resets.
  if(current&&isExhausted(current)){const alt=exhaustedAlternative(current);if(alt)return alt;}
  if(!settings.rotate||explicit){if(!current)throw new GatewayError('Selected network route is disabled or missing',503,'route_unavailable');return current;}
  const pool=settings.routes.filter(r=>r.enabled&&r.kind!=='direct'&&(!r.models.length||r.models.some(x=>model===x||model.endsWith('/'+x)))&&!coolingDown(r));
  if(!pool.length)throw new GatewayError('All configured routes are unavailable or cooling down. Direct fallback is disabled.',503,'route_unavailable');
  if(settings.strategy==='random')return pool[Math.floor(Math.random()*pool.length)];
  if(settings.strategy==='round_robin')return pool[cursor++%pool.length];
  // Unmeasured routes are tried first so every route gets a latency before the fastest one is locked in.
  if(settings.strategy==='fastest')return pool.find(r=>r.latency==null)||pool.reduce((best,r)=>r.latency!<best.latency!?r:best);
  return pool.find(x=>x.id===selected)||pool[0];
}
// Deterministic order used when a connection fails: WARP first, then the other routes in the order they were added, direct only if allowed.
export function failoverRoutes(current: Route): Route[] {
  const usable=settings.routes.filter(r=>r.enabled&&r.id!==current.id&&!coolingDown(r)&&(r.kind!=='direct'||settings.allowDirect===true)&&(r.kind!=='warp'||!!warpTarget()));
  return [...usable.filter(r=>r.kind==='warp'),...usable.filter(r=>r.kind!=='warp'&&r.kind!=='direct'),...usable.filter(r=>r.kind==='direct')];
}
// One description of every route, used by the Routing page and the Proxies page so they cannot disagree.
// role: active = where requests go now; backup = used when the active exit is used up or cannot connect; off = never used.
export type RouteInfo = { role: 'active' | 'backup' | 'off'; label: string; tone: 'healthy' | 'cooldown' | 'error' | 'neutral'; detail: string };
export function describeRoutes(): Record<string, RouteInfo> {
  const out: Record<string, RouteInfo> = {}; const backupOn = settings.exhaustedFailover !== false;
  for (const r of settings.routes) {
    const role: RouteInfo['role'] = !r.enabled ? 'off' : r.id === settings.routeId ? 'active' : backupOn && (r.id === 'proxy-pool' || r.kind !== 'direct' || settings.allowDirect === true) ? 'backup' : 'off';
    let label = r.status || 'Not tested'; let tone: RouteInfo['tone'] = 'neutral'; let detail = '';
    if (!r.enabled) { label = 'Disabled'; }
    else if (isExhausted(r)) { const refused = !!r.status?.startsWith('Refused'); label = refused ? 'Refused by Free tier' : 'Used up today'; tone = 'cooldown'; detail = refused ? `Skipped until ${resetTime(r.exhaustedUntil!)}` : `Resets ${resetTime(r.exhaustedUntil!)}`; }
    else if (r.id === 'proxy-pool') { const s = poolSummary(); label = s.clean ? `${s.clean} clean exit${s.clean > 1 ? 's' : ''} ready` : s.ready ? `${s.ready} model-ready` : 'No clean proxy yet'; tone = s.clean || s.ready ? 'healthy' : 'cooldown'; detail = `${s.exhausted} used up today · keeps ${s.target} ready`; }
    else if (r.kind === 'warp') { const up = !!warpTarget(); label = up ? 'Connected' : 'Not connected'; tone = up ? 'healthy' : 'neutral'; detail = up ? '' : 'Connect it in the WARP panel below'; }
    else if (coolingDown(r)) { label = 'Cooling down'; tone = 'cooldown'; detail = `Until ${new Date(r.cooldownUntil!).toISOString().slice(11, 16)} UTC`; }
    else if (r.status === 'healthy') { label = 'Healthy'; tone = 'healthy'; if (r.kind === 'relay') { const i = relayInfo(r.id); if (i.egress) detail = `Address ${i.egress}` + (i.spent ? ` · ${i.spent} used up today` : ''); } }
    else if (r.status?.startsWith('HTTP')) tone = 'cooldown'; else if (r.status) tone = 'error';
    out[r.id] = { role, label, tone, detail };
  }
  return out;
}
// The order a request would try other exits in when the active one is used up, mirroring exhaustedAlternative.
export function backupChain(): { id: string; name: string; usable: boolean; why: string }[] {
  const current = settings.routes.find(r => r.id === settings.routeId); const chain: { id: string; name: string; usable: boolean; why: string }[] = [];
  if (settings.exhaustedFailover === false) return chain;
  const add = (r: Route, usable: boolean, why: string) => chain.push({ id: r.id, name: r.name, usable, why });
  const pool = settings.routes.find(r => r.id === 'proxy-pool' && r.id !== current?.id);
  if (pool) { const s = poolSummary(); const ok = pool.enabled && !coolingDown(pool) && s.ready > 0; add(pool, ok, !pool.enabled ? 'disabled' : s.ready ? `${s.ready} model-ready` : 'no clean proxy yet'); }
  const others = settings.routes.filter(r => r.id !== 'proxy-pool' && r.id !== current?.id && r.kind !== 'direct');
  for (const r of [...others.filter(r => r.kind === 'warp'), ...others.filter(r => r.kind !== 'warp')]) add(r, r.enabled && !coolingDown(r) && (r.kind !== 'warp' || !!warpTarget()), !r.enabled ? 'disabled' : isExhausted(r) ? 'used up today' : coolingDown(r) ? 'cooling down' : r.kind === 'warp' && !warpTarget() ? 'not connected' : 'ready');
  const direct = settings.routes.find(r => r.kind === 'direct' && r.id !== current?.id); if (direct) add(direct, settings.allowDirect === true && !coolingDown(direct), settings.allowDirect === true ? (isExhausted(direct) ? 'used up today' : 'allowed as last resort') : 'blocked (allow it under the policy below)');
  return chain;
}
// --- Relay instances ---
// A Bun relay on a serverless platform sends from the address of whichever instance serves the request, and a new instance has a new address
//. The relay reports its address on every answer; when OpenCode confirms that address is used up, Polygate asks the
// relay to recycle that instance and retries on the new one, and only retires the whole relay after several instances in a row are used up.
const spentEgress = new Map<string, Map<string, number>>(); const liveEgress = new Map<string, string>(); const bunRelays = new Set<string>(); const rotating = new Map<string, Promise<boolean>>();
const spentList = (id: string) => { const m = spentEgress.get(id); if (!m) return []; for (const [ip, until] of m) if (until <= now()) m.delete(ip); return [...m.keys()]; };
export const relayInfo = (id: string) => ({ egress: liveEgress.get(id) || '', spent: spentList(id).length, bun: bunRelays.has(id) });
const markSpent = (id: string, ip: string | null | undefined, until: number) => { if (!ip) return; let m = spentEgress.get(id); if (!m) spentEgress.set(id, m = new Map()); m.set(ip, until); };
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function relayControl(route: Route, control: string): Promise<{ instance: string; egress: string }> {
  const r = await fetch(route.url, { headers: { 'x-relay-key': route.token || '', 'x-relay-control': control }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) { await r.body?.cancel(); throw new Error('HTTP ' + r.status); } return await r.json() as any;
}
// One rotation at a time per relay; concurrent requests that hit the same used-up instance wait for the same new one.
function rotateRelay(route: Route): Promise<boolean> {
  const running = rotating.get(route.id); if (running) return running;
  const job = (async () => {
    let before: { instance: string; egress: string }; try { before = await relayControl(route, 'ping'); await relayControl(route, 'recycle'); } catch { return false; }
    for (let i = 0; i < 10; i++) {
      await pause(i ? 800 : 1200);
      try { const p = await relayControl(route, 'ping'); if (p.instance !== before.instance && !spentList(route.id).includes(p.egress)) { liveEgress.set(route.id, p.egress); return true; } } catch { /* the old instance may still be draining */ }
    }
    return false;
  })().finally(() => rotating.delete(route.id)); rotating.set(route.id, job); return job;
}
const usedUpAnswer = () => new Response(JSON.stringify({ error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached. Every instance of this relay that was tried is used up.', code: 429 } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(Math.max(1, Math.round((nextResetAt() - now()) / 1000))) } });
export function relayRequest(url: string, init: RequestInit, route: Route) {
  const target=new URL(url);const headers=new Headers(init.headers);
  headers.set('x-relay-target',target.origin);headers.set('x-relay-path',target.pathname+target.search);
  if(route.token)headers.set('x-relay-key',route.token);
  headers.delete('host');headers.delete('content-length');
  return {url:route.url,init:{...init,headers,redirect:'error' as RequestRedirect}};
}
// Circuit breaker: three consecutive connection failures open the route for 30s, doubling on each re-open up to 5 minutes. One success closes it.
const BREAKER_THRESHOLD=3;
export function routeFailed(route:Route,reason:string,immediate=false){
  route.status=redactError(reason);route.failures=(route.failures||0)+1;
  if(immediate||route.failures>=BREAKER_THRESHOLD){route.opened=(route.opened||0)+1;route.cooldownUntil=now()+Math.min(300000,30000*2**(route.opened-1));route.failures=0;}
}
export function routeSucceeded(route:Route,ms:number){route.latency=ms;route.status='healthy';route.failures=0;route.opened=0;route.cooldownUntil=0;}
// A caller-side abort (client disconnect, request deadline) says nothing about the route; a timeout the caller set on the route itself does.
const callerCancelled=(init:any)=>{const s=init?.signal as AbortSignal|undefined;return !!s?.aborted&&(s.reason as any)?.name!=='TimeoutError';};
const LOOPBACK=['127.0.0.1','localhost','[::1]'];
// Turns any proxy URL into one Bun's fetch can use: HTTP(S) proxies pass through, SOCKS5 goes through the native bridge, SOCKS4 and SOCKS5 through the local bridge (backend/socks-bridge.ts).
export async function usableProxy(proxy:string):Promise<string>{
  const socks=parseSocksUrl(proxy);if(socks)return socksBridge(socks);
  return proxy;
}
async function viaPool(route:Route,url:string,init:any):Promise<Response>{
  const attempts=Math.max(1,settings.pool?.retries??3);let last:unknown;let exhausted:Response|undefined;const rid=routeContext.getStore()?.requestId;
  for(let i=0;i<attempts;i++){
    const pick=await pickPoolProxy(route);
    if(!pick){if(exhausted)return exhausted;throw new GatewayError('No model-ready proxy is available in the pool. Test the pool with models on the Proxies page, or add proxies.',503,'route_unavailable');}
    const started=now();
    try{
      const response=await fetch(url,{...init,proxy:await usableProxy(pick.proxy)});
      // A used-up daily allowance belongs to this proxy's exit address: retire it until the reset and try the next clean one.
      if(response.status===429){const seen=await detectExhaustion(response);if(seen){const ex=await judgeExhaustion('pool:'+pick.url,false,response,seen,rid);if(ex){poolExhausted(pick.url,ex);noteExhaustion(rid,ex);exhausted?.body?.cancel().catch(()=>{});exhausted=response;continue;}noteRefused(rid);}}
      // 403 is how the free tier answers an IP it dislikes; the proxy is rotated out instead of blamed on the model.
      poolReport(pick.url,response.status===403?'blocked':response.status<500?'ok':'bad',now()-started,false);return response;
    }catch(e){if(callerCancelled(init))throw e;poolReport(pick.url,'unreachable',0);last=e;}
  }
  if(exhausted)return exhausted;
  throw last;
}
const isReadOnly=(init:any)=>['GET','HEAD'].includes(String(init?.method||'GET').toUpperCase());
export async function networkFetch(raw: string|URL|Request, init: any = {}, explicit?: string): Promise<Response> {
  const url=typeof raw==='string'?raw:raw instanceof URL?raw.toString():raw.url;
  const local=new URL(url);if(LOOPBACK.includes(local.hostname)) return fetch(url,init);
  const id=explicit||routeContext.getStore()?.routeId||settings.routeId;
  const route=findRoute(id);
  if(!route)throw new GatewayError('Network route is disabled or missing',503,'route_unavailable');
  const started=now();let warpPort=0;let judged:{seen?:Exhaustion;ex?:Exhaustion}|undefined;
  // Diagnostic lookups (egress identity) must not move a route's health or open its breaker.
  const quiet=!!init?.polygateQuiet;if(quiet){init={...init};delete init.polygateQuiet;}
  const attempt=quiet?undefined:beginAttempt(routeContext.getStore()?.requestId||'',url,init);
  try{
    let response:Response;
    if(route.kind==='relay'){
      const max=Math.max(0,Math.min(10,Number(settings.relayRotations??4)));const rid0=routeContext.getStore()?.requestId;
      for(let spin=0;;spin++){
        const r=relayRequest(url,init,route);const avoid=spentList(route.id);if(avoid.length&&bunRelays.has(route.id))(r.init.headers as Headers).set('x-relay-avoid',avoid.join(','));
        // A relay that is known to run Bun is a pool of instances: when one cannot be reached, take another before giving the route up.
        try{response=await fetch(r.url,r.init);}
        catch(e){if(callerCancelled(init)||!bunRelays.has(route.id)||isCanary(rid0)||spin>=max||!await rotateRelay(route))throw e;continue;}
        const egress=response.headers.get('x-relay-egress');// A relay that reports its egress address can be rotated (relays/vercel-bun); the Netlify relay trusts the same handshake but has no instances.
      const bun=!!response.headers.get('x-relay-egress')&&trustedRuntime(response.headers.get('x-relay-runtime'));
        if(egress)liveEgress.set(route.id,egress);if(bun)bunRelays.add(route.id);
        if(!(bun||bunRelays.has(route.id))||isCanary(rid0))break;
        // The instance did not answer: the platform's own 5xx or the relay's own 502 carry no runtime header. A new instance usually works.
        if(!bun&&[500,502,503,504].includes(response.status)&&spin<max){if(await rotateRelay(route)){await response.body?.cancel().catch(()=>{});continue;}break;}
        // The instance knew its address was used up and refused before calling OpenCode: take another instance.
        if(response.headers.get('x-relay-rotate')==='1'){await response.body?.cancel().catch(()=>{});if(spin<max&&await rotateRelay(route))continue;response=usedUpAnswer();judged={seen:{until:nextResetAt(),seconds:0},ex:{until:nextResetAt(),seconds:0}};break;}
        if(response.status!==429)break;
        const seen=await detectExhaustion(response);if(!seen)break;
        const ex=await judgeExhaustion(route.id,true,response,seen,rid0);judged={seen,ex};
        // Confirmed used up on this instance's address: recycle the instance and retry on the new one.
        if(ex&&!ex.refused&&spin<max){markSpent(route.id,egress,ex.until);if(await rotateRelay(route)){await response.body?.cancel().catch(()=>{});judged=undefined;continue;}}
        break;
      }
    }
    else if(route.kind==='warp'){
      const target=warpTarget();if(!target)throw new GatewayError('Cloudflare WARP is not connected. Connect it on the Routing page.',503,'route_unavailable');
      warpPort=target.port;response=await fetch(url,{...init,proxy:await socksBridge(target)});
    }
    else if(route.kind==='proxy'){
      // Only a chat request spends Free allowance; catalog, version and other reads are not limited, so they skip the slow shared proxies.
      if(route.id==='proxy-pool'&&settings.catalogDirect!==false&&isReadOnly(init))response=await fetch(url,init);
      else if(route.id==='proxy-pool')response=await viaPool(route,url,init);
      else response=await fetch(url,{...init,proxy:await usableProxy(route.url||'')});
    }
    else response=await fetch(url,init);
    finishAttempt(attempt,response);
    // A 429 with a Retry-After that counts down to the daily reset is probably this exit's allowance, but is confirmed first (judgeExhaustion); the gateway learns of it by request id.
    let exhausted=false;const rid=routeContext.getStore()?.requestId;
    if(response.status===429&&!quiet&&!isCanary(rid)&&route.id!=='proxy-pool'){const seen=judged?judged.seen:await detectExhaustion(response);const ex=judged?judged.ex:seen&&await judgeExhaustion(route.id,route.kind==='relay',response,seen,rid);if(ex&&route.kind==='relay')markSpent(route.id,liveEgress.get(route.id),ex.until);if(seen&&!ex)noteRefused(rid);if(ex){exhausted=true;noteExhaustion(routeContext.getStore()?.requestId,ex);if(route.id.startsWith('pool:'))poolExhausted(route.id.slice(5),ex);else if(route.id!=='proxy-pool')routeExhausted(route,ex);}}
    // Route health follows delivery, not the model's verdict: a 429 or 500 from the provider means the route worked.
    if(quiet){/* diagnostic lookup: leave route health alone */}
    else if(route.id.startsWith('pool:')){/* virtual route: the pool keeps its own health */}
    else if(response.status<500&&!exhausted){routeSucceeded(route,now()-started);if(warpPort)warpSuccess(warpPort);}
    else if(route.kind==='relay'&&(response.status===502||response.status===504))routeFailed(route,`HTTP ${response.status}`);
    return response;
  }catch(e){
    finishAttempt(attempt,undefined,e);
    if(quiet||callerCancelled(init)||route.id.startsWith('pool:'))throw e;
    if(warpPort)warpFailure(warpPort);
    routeFailed(route,String(e),e instanceof GatewayError&&e.type==='route_unavailable'&&route.kind!=='proxy');throw e;
  }
}
export async function testRoute(id:string){
  if(typeof id!=='string'||!id)throw new GatewayError('Say which route to test',400);
  const route=id.startsWith('pool:')?virtualPoolRoute(id.slice(5)):settings.routes.find(r=>r.id===id);if(!route)throw new GatewayError('Route not found',404);
  const start=now();
  try{
    const r=await networkFetch('https://opencode.ai/inference/v1/models',{signal:AbortSignal.timeout(15000)},id);await r.body?.cancel();
    route.status=r.ok?'healthy':`HTTP ${r.status}`;route.latency=now()-start;if(r.status<500){route.failures=0;route.opened=0;route.cooldownUntil=0;}persist();
    // The model list is not counted against the allowance, so reaching it proves only the connection. A chat request shows whether the Free tier accepts this exit.
    const check:ChatCheck=r.ok&&!id.startsWith('pool:')&&id!=='proxy-pool'?await checkChat(route):{chat:'unknown'};
    const summary=check.chat==='ok'?`${route.name}: connected, and a real chat request passed.`
      :check.chat==='used-up'?`${route.name}: connected, but OpenCode Free says this exit's daily allowance is used up (resets ${resetTime(check.until!)}).`
      :check.chat==='refused'?`${route.name}: connected, but OpenCode Free refused a chat request through it.`
      :`${route.name}: connected, but a chat request could not be checked${check.note?' ('+check.note+')':''}.`;
    return {ok:r.ok,status:r.status,latency:route.latency,buffered:!!route.buffered,chat:check.chat,summary};
  }catch(e){route.status='unreachable';persist();throw e instanceof GatewayError?e:new GatewayError('Could not connect through this route: '+redactError(String((e as Error)?.message||e)),502,'route_unreachable');}
}

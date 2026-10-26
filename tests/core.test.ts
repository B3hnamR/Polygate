import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The state folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts (shared by every test file and removed after the run).
process.env.POLYGATE_ADMIN_TOKEN='test-admin-secret';
const {startGateway}=await import('../backend/main');
const {settings,models,saveModel,redactError,logs,db,record,usagePenalties}=await import('../backend/state');
const {AdmissionQueue}=await import('../backend/queue');
const {relayRequest,routeFor,networkFetch,routeFailed,__setExitVerifier,__setCanarySender,checkChat}=await import('../backend/transport');
const {discover,sessionFor}=await import('../backend/providers');
const {queue,probeModel}=await import('../backend/gateway');
const {toChat,observeSse}=await import('../backend/protocols');
let gateway:Awaited<ReturnType<typeof startGateway>>,base='',seen:any[]=[];
const upstream=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(req){
  if(new URL(req.url).pathname.endsWith('/models'))return Response.json({data:[{id:'working'},{id:'limited'}]});
  const body=await req.json() as any;seen.push(body);
  if(body.model==='limited')return Response.json({error:{message:'Model capacity exhausted'}},{status:429,headers:{'retry-after':'60'}});
  const data=[{id:'chatcmpl-test',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'Hello '},finish_reason:null}]},
    {id:'chatcmpl-test',choices:[{index:0,delta:{content:'from Polygate'},finish_reason:null}]},
    {choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}}];
  return new Response(data.map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
}});
beforeAll(async()=>{
  // Do not discover or borrow a WARP listener belonging to another local app/test session.
  settings.warp={engine:'disabled',autoStart:false,pool:1,rotateMinutes:0,wireproxyPath:''};
  settings.providers=[{id:'mock',name:'Mock upstream',kind:'openai',enabled:true,baseUrl:`http://127.0.0.1:${upstream.port}/v1`,apiKey:'upstream-secret',models:[],routeId:'direct'}];
  for(const id of ['working','limited'])saveModel({id:'mock/'+id,upstreamId:id,providerId:'mock',name:id,context:128000,output:4096,tools:true,reasoning:false,state:'unchecked',latency:0,score:50,priority:100,failCount:0,cooldownUntil:0,checkedAt:0,error:''});
  gateway=await startGateway(0);base=`http://127.0.0.1:${gateway.port}`;
});
afterAll(async()=>{await gateway?.close();upstream.stop(true);});
const call=(p:string,body:any,key=settings.keys[0].value,signal?:AbortSignal)=>fetch(base+p,{method:'POST',signal,headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(body)});
test('API keys and admin sessions are separate',async()=>{
  expect((await fetch(base+'/v1/models')).status).toBe(401);
  expect((await fetch(base+'/admin/state',{headers:{authorization:'Bearer '+settings.keys[0].value}})).status).toBe(401);
  expect((await fetch(base+'/admin/state',{headers:{authorization:'Bearer test-admin-secret'}})).status).toBe(200);
});
test('Chat JSON aggregates actual SSE and usage',async()=>{
  const r=await call('/v1/chat/completions',{model:'mock/working',messages:[{role:'user',content:'Hello'}],stream:false});const x:any=await r.json();
  expect(r.status).toBe(200);expect(x.choices[0].message.content).toBe('Hello from Polygate');expect(x.usage.total_tokens).toBe(10);expect(seen.at(-1).stream).toBe(true);
});
test('Chat streaming returns deltas and terminal event',async()=>{const r=await call('/v1/chat/completions',{model:'mock/working',messages:[{role:'user',content:'Hello'}],stream:true});const s=await r.text();expect(s).toContain('Hello ');expect(s).toContain('[DONE]');});
test('Responses JSON input/output conversion',async()=>{const r=await call('/v1/responses',{model:'mock/working',input:'Hello'});const x:any=await r.json();expect(r.status).toBe(200);expect(x.object).toBe('response');expect(x.output[0].content[0].text).toBe('Hello from Polygate');});
test('Responses streaming uses Responses events',async()=>{const r=await call('/v1/responses',{model:'mock/working',input:'Hello',stream:true});const s=await r.text();expect(s).toContain('response.output_text.delta');expect(s).toContain('response.completed');});
test('Anthropic JSON preserves the caller conversation',async()=>{const r=await call('/v1/messages',{model:'mock/working',max_tokens:64,messages:[{role:'user',content:'Hello'}]});const x:any=await r.json();expect(r.status).toBe(200);expect(x.type).toBe('message');expect(x.content.some((b:any)=>b.text==='Hello from Polygate')).toBe(true);});
test('Anthropic streaming has message_stop',async()=>{const r=await call('/v1/messages',{model:'mock/working',max_tokens:64,messages:[{role:'user',content:'Hello'}],stream:true});const s=await r.text();expect(s).toContain('message_start');expect(s).toContain('message_stop');expect(s).toContain('Hello ');});
test('Responses function calls and Anthropic tool results retain IDs',()=>{
  const r=toChat({model:'mock/working',input:[{type:'function_call_output',call_id:'call-1',output:'done'}]},'responses');expect(r.messages[0].tool_call_id).toBe('call-1');
  const a=toChat({model:'mock/working',messages:[{role:'user',content:[{type:'tool_result',tool_use_id:'call-2',content:'done'}]}]},'anthropic');expect(a.messages.some((m:any)=>m.tool_call_id==='call-2')).toBe(true);
});
test('Malformed JSON is a clear client error',async()=>{const r=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+settings.keys[0].value,'content-type':'application/json'},body:'{broken'});expect(r.status).toBe(400);});
test('Explicit quota response is not retried or routed to another model',async()=>{const before=seen.length;const r=await call('/v1/chat/completions',{model:'mock/limited',messages:[{role:'user',content:'Hello'}]});expect(r.status).toBe(429);expect(seen.length-before).toBe(1);expect(models.get('mock/limited')!.state).toBe('cooldown');});
process.env.POLYGATE_DIAG_EGRESS='0';
test('Disabling model cooldowns releases cooling models and keeps every request going upstream',async()=>{
  const setting=(body:any)=>fetch(base+'/admin/settings',{method:'POST',headers:{authorization:'Bearer test-admin-secret','content-type':'application/json'},body:JSON.stringify(body)});
  const limited=models.get('mock/limited')!;expect(limited.state).toBe('cooldown');
  expect((await setting({cooldowns:false})).status).toBe(200);expect(settings.cooldowns).toBe(false);expect(limited.cooldownUntil).toBe(0);expect(limited.state).not.toBe('cooldown');
  const before=seen.length;
  for(let i=0;i<2;i++){const r=await call('/v1/chat/completions',{model:'mock/limited',messages:[{role:'user',content:'Hello'}]});expect(r.status).toBe(429);expect(models.get('mock/limited')!.cooldownUntil).toBe(0);expect(models.get('mock/limited')!.state).not.toBe('cooldown');}
  expect(seen.length-before).toBe(2);
  expect((await setting({cooldowns:true})).status).toBe(200);const again=await call('/v1/chat/completions',{model:'mock/limited',messages:[{role:'user',content:'Hello'}]});expect(again.status).toBe(429);expect(models.get('mock/limited')!.state).toBe('cooldown');
});
test('Paused gateway refuses inference without closing administration',async()=>{settings.enabled=false;const r=await call('/v1/chat/completions',{model:'mock/working',messages:[{role:'user',content:'Hi'}]});expect(r.status).toBe(503);settings.enabled=true;});
test('Admission respects per-key limit and abort removes waiter',async()=>{const q=new AdmissionQueue(2,2);const c=new AbortController();const release=await q.acquire('a',1,c.signal);const pending=q.acquire('a',1,c.signal);const other=await q.acquire('b',1,new AbortController().signal);expect(q.active).toBe(2);expect(q.waiting.length).toBe(1);c.abort();await expect(pending).rejects.toThrow();expect(q.waiting.length).toBe(0);release();other();expect(q.active).toBe(0);});
test('Relay contract preserves path/query and isolates relay secret',()=>{const r=relayRequest('https://opencode.ai/inference/v1/responses?x=1',{method:'POST',headers:{authorization:'Bearer public'}},{id:'r',name:'Relay',kind:'relay',url:'https://example.invalid/relay',token:'relay-secret',enabled:true,models:[]});const h=new Headers(r.init.headers);expect(h.get('x-relay-target')).toBe('https://opencode.ai');expect(h.get('x-relay-path')).toBe('/inference/v1/responses?x=1');expect(h.get('x-relay-key')).toBe('relay-secret');expect(r.url).toBe('https://example.invalid/relay');});
test('Secrets are redacted in activity errors',()=>{expect(redactError('Bearer upstream-secret')).not.toContain('upstream-secret');});
test('Route selection and rotation strategies',()=>{
  const origRoutes = settings.routes;
  const origRotate = settings.rotate;
  const origStrategy = settings.strategy;
  const origRouteId = settings.routeId;
  try {
    settings.routes = [
      { id: 'direct', name: 'Direct', kind: 'direct', url: '', enabled: true, models: [] },
      { id: 'p1', name: 'Proxy 1', kind: 'proxy', url: 'http://127.0.0.1:8001', enabled: true, models: [], latency: 150 },
      { id: 'p2', name: 'Proxy 2', kind: 'proxy', url: 'http://127.0.0.1:8002', enabled: true, models: [], latency: 50 },
      { id: 'p3', name: 'Proxy 3', kind: 'proxy', url: 'http://127.0.0.1:8003', enabled: false, models: [], latency: 10 },
      { id: 'p4', name: 'Proxy 4', kind: 'proxy', url: 'http://127.0.0.1:8004', enabled: true, models: ['special-model'], latency: 20 },
      { id: 'p5', name: 'Proxy 5', kind: 'proxy', url: 'http://127.0.0.1:8005', enabled: true, models: [], latency: 100, cooldownUntil: Date.now() + 60000 }
    ];
    settings.rotate = false;
    settings.routeId = 'direct';
    expect(routeFor().id).toBe('direct');
    expect(routeFor('', 'p1').id).toBe('p1');
    expect(() => routeFor('', 'missing')).toThrow();

    settings.rotate = true;
    settings.strategy = 'fastest';
    // Eligible routes: p1 (150ms) and p2 (50ms). p3 disabled, p4 model-restricted, p5 cooling down, direct excluded.
    expect(routeFor('general-model').id).toBe('p2');
    // For special-model: p4 (20ms) is eligible and fastest
    expect(routeFor('special-model').id).toBe('p4');

    settings.strategy = 'round_robin';
    const picked = [routeFor('general-model').id, routeFor('general-model').id];
    expect(picked).toContain('p1');
    expect(picked).toContain('p2');

    // When all pool routes are cooling down
    settings.routes.forEach(r => { if (r.kind !== 'direct') r.cooldownUntil = Date.now() + 60000; });
    expect(() => routeFor('general-model')).toThrow(/Direct fallback is disabled/);
  } finally {
    settings.routes = origRoutes;
    settings.rotate = origRotate;
    settings.strategy = origStrategy;
    settings.routeId = origRouteId;
  }
});


// --- Regression coverage: upstream framing, catalog refresh, route health, cancellation, probes, relays ---
// The remote mock listens on 127.0.0.2 because 127.0.0.1 traffic bypasses route accounting in networkFetch.
let catalog:string[]=['a','b'];
const sse=(sep:string)=>[{id:'c',choices:[{index:0,delta:{role:'assistant',content:'ok'},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}}].map(x=>'data: '+JSON.stringify(x)+sep).join('')+'data: [DONE]'+sep;
const CRLFLESS=String.fromCharCode(10,10);let relayInstance=1;const relayCalls:string[]=[];const relayAvoid:string[]=[];
const remote=Bun.serve({port:0,hostname:'127.0.0.2',async fetch(req){
  const u=new URL(req.url);
  if(u.pathname.startsWith('/nocatalog'))return new Response('missing',{status:404});
  if(u.pathname.endsWith('/models'))return Response.json({data:catalog.map(id=>({id,name:id.toUpperCase(),context_length:32000}))});
  if(u.pathname.endsWith('/hang')){await Bun.sleep(4000);return new Response('late');}
  // A Bun relay's controls: ping reports the instance, recycle moves to the next one (relays/vercel-bun).
  const control=req.headers.get('x-relay-control');if(control){relayCalls.push(control);if(control==='recycle')relayInstance++;return Response.json({instance:'i'+relayInstance,egress:'10.0.0.'+relayInstance});}
  const body=await req.json() as any;
  if(body.model==='crlf')return new Response(sse('\r\n\r\n'),{headers:{'content-type':'text/event-stream'}});
  const FREE_LIMIT=JSON.stringify({error:{message:'Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go',type:'FreeUsageLimitError',code:429,log_id:'log-1'}});
  if(body.model==='flaky'){const runtime=req.headers.get('x-test-runtime');if(relayInstance<2)return new Response('upstream connect error',{status:502});return new Response(sse(CRLFLESS),{headers:{'content-type':'text/event-stream','x-relay-runtime':runtime||'bun 1.3.14','x-relay-egress':'10.0.0.'+relayInstance}});}
  if(body.model==='drained'){
    const runtime=req.headers.get('x-test-runtime');relayAvoid.push(req.headers.get('x-relay-avoid')||'');
    const relayHeaders:Record<string,string>=runtime?{'x-relay-runtime':runtime,'x-relay-egress':'10.0.0.'+relayInstance}:{};
    // From this instance on, the relay's address has allowance again.
    if(runtime&&relayInstance>=Number(req.headers.get('x-test-good-from')||Infinity))return new Response(sse(CRLFLESS),{headers:{'content-type':'text/event-stream',...relayHeaders}});
    return new Response(FREE_LIMIT,{status:429,headers:{'content-type':'application/json','retry-after':'7200',...relayHeaders}});
  }
  if(body.model==='shape')return new Response(FREE_LIMIT,{status:429,headers:{'content-type':'application/json'}});
  if(body.model==='boom')return Response.json({error:{message:'upstream exploded'}},{status:503});
  if(body.model==='slow')await Bun.sleep(4000);
  return new Response(sse('\n\n'),{headers:{'content-type':'text/event-stream'}});
}});
const opencodeSeen:string[]=[];
const opencode=Bun.serve({port:0,hostname:'127.0.0.1',fetch(req){
  const u=new URL(req.url);opencodeSeen.push(req.method+' '+u.pathname);
  if(req.method==='POST'&&u.pathname==='/session')return Response.json({id:'s1'});
  if(u.pathname==='/session/s1/message')return Response.json({parts:[{type:'text',text:'from opencode'}],info:{tokens:{input:2,output:3}}});
  if(req.method==='DELETE')return Response.json(true);
  return new Response('nf',{status:404});
}});
afterAll(()=>{remote.stop(true);opencode.stop(true);});
const remoteProvider=()=>({id:'remote',name:'Remote',kind:'openai' as const,enabled:true,baseUrl:`http://127.0.0.2:${remote.port}/v1`,apiKey:'',models:[] as string[],routeId:'direct'});
const freshModel=(provider:string,id:string)=>saveModel({id:provider+'/'+id,upstreamId:id,providerId:provider,name:id,context:0,output:0,tools:true,reasoning:false,state:'unchecked',latency:0,score:50,priority:100,failCount:0,cooldownUntil:0,checkedAt:0,error:''});
// Runs a test body against a temporary provider list and restores the shared one afterwards.
const scoped=async(providers:any[],body:()=>Promise<void>)=>{const saved=settings.providers;settings.providers=providers;try{await body();}finally{settings.providers=saved;}};
const until=async<T>(find:()=>T|undefined,ms=3000):Promise<T>=>{const t=Date.now();while(Date.now()-t<ms){const v=find();if(v)return v;await Bun.sleep(25);}throw new Error('Timed out waiting for condition');};
const faultOf=(id:string)=>(db.query('SELECT fault FROM requests WHERE id=?').get(id) as {fault:number}).fault;
const chat=(model:string,extra:any={})=>call('/v1/chat/completions',{model,stream:true,messages:[{role:'user',content:'x'}],...extra});

test('SSE observer handles CRLF framing split across chunks and an unterminated final event',async()=>{
  const run=async(chunks:string[])=>{const seen:string[]=[];const body=new ReadableStream({start(c){for(const x of chunks)c.enqueue(new TextEncoder().encode(x));c.close();}}).pipeThrough(observeSse(x=>seen.push(x)));await new Response(body).arrayBuffer();return seen;};
  expect(await run(['data: {"a":1}\r','\n\r\ndata: [DONE]'])).toEqual(['{"a":1}','[DONE]']);
  expect(await run(['data: x\n\n','data: y\n\n'])).toEqual(['x','y']);
});
test('A CRLF-framed upstream stream is a success, not a 502 with a cooldown',async()=>{await scoped([remoteProvider()],async()=>{
  freshModel('remote','crlf');const r=await chat('remote/crlf');expect(await r.text()).toContain('[DONE]');
  const row=await until(()=>logs(5).find(l=>l.model==='remote/crlf'));expect(row.status).toBe(200);expect(models.get('remote/crlf')!.state).toBe('available');
});});
test('Catalog refresh keeps models on an empty answer, refreshes facts and revives returned models',async()=>{await scoped([remoteProvider()],async()=>{
  catalog=['a','b'];await discover();expect(models.get('remote/a')!.context).toBe(32000);expect(models.get('remote/a')!.name).toBe('A');
  models.get('remote/a')!.priority=7;
  catalog=[];await expect(discover()).rejects.toThrow(/empty catalog/);expect(models.get('remote/a')!.state).toBe('unchecked');expect(models.get('remote/b')!.state).toBe('unchecked');
  catalog=['a'];await discover();expect(models.get('remote/b')!.state).toBe('unavailable');expect(models.get('remote/b')!.error).toContain('Absent');expect(models.get('remote/a')!.priority).toBe(7);
  catalog=['a','b'];await discover();expect(models.get('remote/b')!.state).toBe('unchecked');expect(models.get('remote/b')!.error).toBe('');
});});
test('Model ID overrides work when the provider has no /models endpoint',async()=>{
  const nocat={...remoteProvider(),id:'nocat',baseUrl:`http://127.0.0.2:${remote.port}/nocatalog/v1`,models:['custom-1']};
  await scoped([nocat],async()=>{freshModel('nocat','old');await discover();expect(models.has('nocat/custom-1')).toBe(true);expect(models.get('nocat/old')!.state).toBe('unchecked');});
  await scoped([{...nocat,models:[]}],async()=>{await expect(discover()).rejects.toThrow(/Catalog HTTP 404/);});
});
test('Route health follows delivery, not provider verdicts or caller aborts',async()=>{
  const direct=settings.routes.find(r=>r.id==='direct')!;direct.cooldownUntil=0;direct.failures=0;
  const ac=new AbortController();const pending=networkFetch(`http://127.0.0.2:${remote.port}/v1/hang`,{method:'POST',signal:ac.signal});setTimeout(()=>ac.abort(new Error('Client disconnected')),100);
  await expect(pending).rejects.toThrow();expect(direct.cooldownUntil||0).toBe(0);
  const bad=await networkFetch(`http://127.0.0.2:${remote.port}/v1/chat/completions`,{method:'POST',body:JSON.stringify({model:'boom'})});expect(bad.status).toBe(503);expect(direct.cooldownUntil||0).toBe(0);expect(direct.status).toBe('healthy');
  // Circuit breaker: a real refused connection counts as one failure; two more (simulated, because refused loopback connections are slow on Windows) open the route for 30s.
  await expect(networkFetch('http://127.0.0.2:1/v1/x',{})).rejects.toThrow();expect(direct.failures).toBe(1);expect(direct.cooldownUntil||0).toBe(0);
  routeFailed(direct,'refused');expect(direct.cooldownUntil||0).toBe(0);routeFailed(direct,'refused');expect(direct.cooldownUntil).toBeGreaterThan(Date.now()+25000);expect(direct.opened).toBe(1);
  routeFailed(direct,'refused');routeFailed(direct,'refused');routeFailed(direct,'refused');expect(direct.opened).toBe(2);expect(direct.cooldownUntil).toBeGreaterThan(Date.now()+55000);// each re-open doubles the wait
  direct.cooldownUntil=0;direct.failures=0;direct.opened=0;
});
test('A provider failure is the model fault, counted once per request',async()=>{await scoped([remoteProvider()],async()=>{
  freshModel('remote','boom');const r=await chat('remote/boom');expect(r.status).toBe(503);expect(r.headers.get('retry-after')).toBeNull();
  const row=await until(()=>logs(5).find(l=>l.model==='remote/boom'));expect(faultOf(row.id)).toBe(1);
  const m=models.get('remote/boom')!;expect(m.state).toBe('cooldown');expect(m.failCount).toBe(1);expect(settings.routes.find(x=>x.id==='direct')!.cooldownUntil||0).toBe(0);
});});
// The remote mock sits on 127.0.0.2, where outbound calls are attributed to a route and so recorded as attempts.
test('Request shape is recorded with each request and holds no prompt or credential text',async()=>{await scoped([{...remoteProvider(),apiKey:'remote-secret-key'}],async()=>{
  const admin=(p:string)=>fetch(base+p,{headers:{authorization:'Bearer test-admin-secret'}}).then(r=>r.json()) as Promise<any>;
  const PROMPT='PRIVATE-PROMPT-TEXT-4417';freshModel('remote','boom');freshModel('remote','fine');
  const body=(model:string,extra:any={})=>({model,stream:false,messages:[{role:'system',content:'<env>\n  Platform: linux\n</env>'},{role:'user',content:PROMPT}],...extra});
  const ok=await call('/v1/chat/completions',body('remote/fine',{tools:[{type:'function',function:{name:'t',description:'d',parameters:{type:'object'}}}]}));expect(ok.status).toBe(200);
  const bad=await call('/v1/chat/completions',body('remote/boom'));expect(bad.status).toBe(503);
  const rows=(await admin('/admin/state')).logs;const failed=rows.find((r:any)=>r.model==='remote/boom');const good=rows.find((r:any)=>r.model==='remote/fine');
  expect(failed.hasDetail).toBe(1);expect(good.hasDetail).toBe(1);
  const f=await admin('/admin/request?id='+failed.id);const g=await admin('/admin/request?id='+good.id);
  expect(f.detail).toMatchObject({v:1,model:'remote/boom',status:503,route:{kind:'direct'},cooldownsEnabled:true,client:{body:{messages:2,roles:{system:1,user:1}}}});
  expect(f.detail.attempts[0]).toMatchObject({method:'POST',response:{status:503}});expect(f.detail.attempts[0].url).toEndWith('/v1/chat/completions');
  expect(f.detail.attempts[0].headers.auth).toBe('Bearer key (17 chars)');expect(f.detail.client.headers.auth).toMatch(/^Bearer key/);
  expect(g.detail.client.body).toMatchObject({tools:1,env:{blocks:1,blocksWithWorkingDirectory:0}});expect(g.detail.attempts[0].body.tools).toBe(1);
  for(const d of [f,g]){const text=JSON.stringify(d);expect(text).not.toContain(PROMPT);expect(text).not.toContain('remote-secret-key');expect(text).not.toContain(settings.keys[0].value);}
  const all=await admin('/admin/diagnostics');expect(all.failures.some((x:any)=>x.id===failed.id)).toBe(true);expect(all.baseline.some((x:any)=>x.id===good.id)).toBe(true);
  expect((await fetch(base+'/admin/request?id=nope',{headers:{authorization:'Bearer test-admin-secret'}})).status).toBe(404);
});});
// --- Used-up exits: a 429 with a Retry-After that counts down to the daily reset is the exit's allowance, not the model's fault ---
const FREE_LIMIT_BODY=JSON.stringify({error:{message:'Free usage limit reached. Free models work in OpenCode (https://opencode.ai)',type:'FreeUsageLimitError',code:429,log_id:'l'}});
const proxyEntry=(n:number,port:number,ms:number)=>({url:`http://127.0.0.1:${port}`,proxy:`http://127.0.0.1:${port}`,proto:'http',host:'127.0.0.1',port,https:true,latencyMs:ms,exitIp:`exit-${n}`});
const sseOk=()=>new Response(sse('\n\n'),{headers:{'content-type':'text/event-stream'}});
async function withPool(proxies:Array<(req:Request)=>Response|Promise<Response>>,body:(info:{entries:any[];hits:number[];route:any})=>Promise<void>){
  const hits=proxies.map(()=>0);const servers=proxies.map((fn,i)=>Bun.serve({port:0,hostname:'127.0.0.1',fetch(req){hits[i]++;return fn(req);}}));
  const entries=servers.map((sv,i)=>proxyEntry(i+1,sv.port!,10*(i+1)));__setPoolEntries(entries);__poolHealth.clear();
  const route={id:'proxy-pool',name:'pool',kind:'proxy' as const,url:'proxyhive://saved-pool',enabled:true,models:[] as string[],poolUrls:[] as string[]};
  const saved={routes:[...settings.routes],pool:settings.pool,strategy:settings.strategy,routeId:settings.routeId};
  settings.routes.push(route);settings.pool={mode:'ready',deepTest:true,recheckMinutes:30,maxTested:60,concurrency:2,retries:3,standby:false};settings.strategy='fastest';
  try{await body({entries,hits,route});}finally{servers.forEach(sv=>sv.stop(true));settings.routes=saved.routes;settings.pool=saved.pool;settings.strategy=saved.strategy;settings.routeId=saved.routeId;__poolHealth.clear();for(const r of settings.routes)r.exhaustedUntil=0;}
}
const viaPoolProvider=()=>({...remoteProvider(),routeId:'proxy-pool'});
test('A pool proxy whose exit is used up is retired and the same request moves to the next clean proxy',async()=>{
  const exhaustedProxy=()=>new Response(FREE_LIMIT_BODY,{status:429,headers:{'content-type':'application/json','retry-after':'7200'}});
  await withPool([exhaustedProxy,()=>sseOk()],async({entries,hits})=>{await scoped([viaPoolProvider()],async()=>{
    freshModel('remote','pooled');poolReport(entries[0].url,'ok',10);poolReport(entries[1].url,'ok',50);
    const r=await chat('remote/pooled');expect(r.status).toBe(200);await r.text();
    expect(hits).toEqual([1,1]);
    const a=__poolHealth.get(entries[0].url)!;expect(a.status).toBe('exhausted');expect(a.exhaustedUntil!).toBeGreaterThan(Date.now()+7000e3);
    const m=models.get('remote/pooled')!;expect(m.state).not.toBe('cooldown');expect(m.cooldownUntil).toBe(0);
    const again=await chat('remote/pooled');expect(again.status).toBe(200);await again.text();expect(hits).toEqual([1,2]);
  });});
});
test('When every exit is used up the client gets one clear message with the reset time and the model is not paused',async()=>{
  const exhaustedProxy=()=>new Response(FREE_LIMIT_BODY,{status:429,headers:{'content-type':'application/json','retry-after':'7200'}});
  await withPool([exhaustedProxy,exhaustedProxy],async({entries})=>{await scoped([viaPoolProvider()],async()=>{
    freshModel('remote','allgone');poolReport(entries[0].url,'ok',10);poolReport(entries[1].url,'ok',50);
    const r=await chat('remote/allgone',{stream:false});const x:any=await r.json();
    expect(r.status).toBe(429);expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(7000);expect(Number(r.headers.get('retry-after'))).toBeLessThanOrEqual(7200);
    expect(x.error).toMatchObject({code:'egress_exhausted',type:'egress_exhausted'});expect(x.error.message).toContain('daily allowance');expect(x.error.message).toContain('UTC');expect(x.error.message).toMatch(/in 1 h|in 2 h/);expect(x.error.message).not.toContain('{"error"');
    expect(x.error.retry_after_seconds).toBeGreaterThan(7000);expect(new Date(x.error.resets_at).getTime()).toBeGreaterThan(Date.now());
    const m=models.get('remote/allgone')!;expect(m.state).not.toBe('cooldown');expect(m.cooldownUntil).toBe(0);
    const row=await until(()=>logs(5).find(l=>l.model==='remote/allgone'));expect(faultOf(row.id)).toBe(0);expect(row.error).toContain('daily allowance');
  });});
});
test('The default strategy sticks to the proxy that carried the last request, and the warm-up keeps good proxies warm and drops dead ones',async()=>{
  const {warmTick,__setApiRunner,pickPoolProxy}=await import('../backend/pool');
  const catalogGets=[0,0,0];const forward=async(req:Request)=>fetch(req.url,{method:req.method,headers:req.headers,body:req.method==='GET'||req.method==='HEAD'?undefined:await req.arrayBuffer()});
  const px=(i:number,dead=false)=>async(req:Request)=>{if(req.method==='GET')catalogGets[i]++;return dead?new Response('no',{status:502}):forward(req);};
  const savedApi=process.env.POLYGATE_POOL_API_URL;process.env.POLYGATE_POOL_API_URL=`http://127.0.0.2:${remote.port}/v1/models`;
  await withPool([px(0),px(1),px(2,true)],async({entries,route})=>{
    for(const [i,ms] of [[0,80],[1,40],[2,60]])poolReport(entries[i as number].url,'ok',ms as number);
    settings.strategy='single';
    const picks:string[]=[];for(let i=0;i<5;i++)picks.push((await pickPoolProxy(route))!.url);
    expect(new Set(picks)).toEqual(new Set([entries[1].url]));                       // the fastest one, and the same one every time
    poolReport(entries[1].url,'unreachable',0);poolReport(entries[1].url,'unreachable',0);
    const next=(await pickPoolProxy(route))!.url;expect(next).toBe(entries[2].url);expect((await pickPoolProxy(route))!.url).toBe(next);   // it moves on only when the sticky one goes bad
    settings.strategy='round_robin';const spread=new Set<string>();for(let i=0;i<4;i++)spread.add((await pickPoolProxy(route))!.url);expect(spread.size).toBeGreaterThan(1);
    // warm-up
    __poolHealth.get(entries[1].url)!.coolUntil=0;poolReport(entries[1].url,'ok',40);
    await warmTick(3);
    expect(catalogGets[0]).toBe(1);expect(catalogGets[1]).toBe(1);expect(catalogGets[2]).toBe(1);
    expect(__poolHealth.get(entries[0].url)!.warm).toMatchObject({fails:0});expect(__poolHealth.get(entries[0].url)!.warm!.ms).toBeGreaterThanOrEqual(0);
    await warmTick(3);                                                                  // a proxy that answers 502 twice in a row is taken out
    expect(__poolHealth.get(entries[2].url)!.status).not.toBe('ready');
    expect(__poolHealth.get(entries[0].url)!.status).toBe('ready');
    settings.pool={...settings.pool!,keepWarm:false};const before=[...catalogGets];await warmTick(3);expect(catalogGets).toEqual(before);
  });
  if(savedApi===undefined)delete process.env.POLYGATE_POOL_API_URL;else process.env.POLYGATE_POOL_API_URL=savedApi;
});
test('With the pool as the route, chat requests use a proxy while catalog reads go straight out',async()=>{
  const forward=async(req:Request)=>fetch(req.url,{method:req.method,headers:req.headers,body:req.method==='GET'||req.method==='HEAD'?undefined:await req.arrayBuffer()});
  await withPool([forward],async({entries,hits})=>{
    poolReport(entries[0].url,'ok',10);settings.routeId='proxy-pool';
    const base=`http://127.0.0.2:${remote.port}/v1`;
    const catalog=await networkFetch(base+'/models',{});expect(catalog.status).toBe(200);expect(hits).toEqual([0]);
    const chatCall=await networkFetch(base+'/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'fine',stream:true,messages:[]})});expect(chatCall.status).toBe(200);await chatCall.text();expect(hits).toEqual([1]);
    settings.catalogDirect=false;await (await networkFetch(base+'/models',{})).text();expect(hits).toEqual([2]);settings.catalogDirect=undefined;
  });
});
test('A used-up direct exit sends requests to a clean pool proxy, and keeps doing so until the reset',async()=>{
  await withPool([()=>sseOk()],async({entries,hits})=>{await scoped([{...remoteProvider(),routeId:'direct'}],async()=>{
    freshModel('remote','drained');poolReport(entries[0].url,'ok',10);
    const r=await chat('remote/drained');expect(r.status).toBe(200);await r.text();expect(hits).toEqual([1]);
    const direct=settings.routes.find(x=>x.id==='direct')!;expect(direct.exhaustedUntil!).toBeGreaterThan(Date.now()+7000e3);expect(direct.status).toContain('Daily Free allowance used');
    const before=seen.length;const again=await chat('remote/drained');expect(again.status).toBe(200);await again.text();
    expect(seen.length).toBe(before);expect(hits).toEqual([2]);
    expect(models.get('remote/drained')!.state).not.toBe('cooldown');
    settings.exhaustedFailover=false;const off=await chat('remote/drained',{stream:false});expect(off.status).toBe(429);settings.exhaustedFailover=undefined;
  });});
});
test('A 429 without a reset time is explained as a refused request and still pauses the model',async()=>{await scoped([remoteProvider()],async()=>{
  freshModel('remote','shape');const r=await chat('remote/shape',{stream:false});const x:any=await r.json();
  expect(r.status).toBe(429);expect(x.error.code).toBe('request_refused');expect(x.error.message).toContain('did not give a reset time');expect(x.error.message).toContain('Request shape');
  expect(models.get('remote/shape')!.state).toBe('cooldown');
  const again=await chat('remote/shape',{stream:false});const y:any=await again.json();expect(again.status).toBe(429);expect(y.error.type).toBe('model_paused');expect(y.error.message).toContain('paused');expect(Number(again.headers.get('retry-after'))).toBeGreaterThan(0);
});});
// A 429 with a countdown is also what a wrong request shape or a non-Bun TLS client gets, so it is confirmed first.
test('A 429 countdown is only a suspicion: when a known-good request through the same exit passes, the exit is kept and the model is not paused to midnight',async()=>{await scoped([remoteProvider()],async()=>{
  freshModel('remote','drained');let asked=0;__setExitVerifier(async()=>{asked++;return 'refused';});
  try{
    const r=await chat('remote/drained',{stream:false});const x:any=await r.json();
    expect(asked).toBe(1);expect(r.status).toBe(429);expect(x.error.code).toBe('request_refused');expect(x.error.message).toContain('still has allowance');
    expect(settings.routes.find(z=>z.id==='direct')!.exhaustedUntil||0).toBe(0);
    const m=models.get('remote/drained')!;expect(m.cooldownUntil).toBeLessThan(Date.now()+3600e3);
  }finally{__setExitVerifier();settings.routes.find(z=>z.id==='direct')!.exhaustedUntil=0;}
});});
test('Asking a used-up route again clears a stale mark, renews a true one and skips a relay that is not Bun',async()=>{
  const route={id:'recheck',name:'Recheck',kind:'direct' as const,url:'',enabled:true,models:[] as string[],exhaustedUntil:Date.now()+3600e3,status:'Daily Free allowance used'};
  try{
    __setCanarySender(async()=>new Response('data: {}\n\n',{status:200}));
    expect((await checkChat(route)).chat).toBe('ok');expect(route.exhaustedUntil).toBe(0);expect(route.status).toBe('healthy');
    __setCanarySender(async()=>new Response(FREE_LIMIT_BODY,{status:429,headers:{'content-type':'application/json','retry-after':'7200'}}));
    const again=await checkChat(route);expect(again.chat).toBe('used-up');expect(route.exhaustedUntil!).toBeGreaterThan(Date.now()+3600e3);
    route.exhaustedUntil=0;
    const relay={...route,kind:'relay' as const};
    __setCanarySender(async()=>new Response(FREE_LIMIT_BODY,{status:429,headers:{'content-type':'application/json','retry-after':'7200'}}));
    expect((await checkChat(relay)).chat).toBe('refused');expect(relay.status).toContain('Refused');
    __setCanarySender(async()=>undefined);expect((await checkChat(route)).chat).toBe('unknown');
  }finally{__setCanarySender();}
});
test('A pool proxy that passes the confirmation request is not retired',async()=>{
  const countdown=()=>new Response(FREE_LIMIT_BODY,{status:429,headers:{'content-type':'application/json','retry-after':'7200'}});
  await withPool([countdown,()=>sseOk()],async({entries,hits})=>{await scoped([viaPoolProvider()],async()=>{
    freshModel('remote','pooledclean');poolReport(entries[0].url,'ok',10);poolReport(entries[1].url,'ok',50);__setExitVerifier(async()=>'refused');
    try{const r=await chat('remote/pooledclean',{stream:false});expect(r.status).toBe(429);expect(hits).toEqual([1,0]);expect(__poolHealth.get(entries[0].url)!.status).not.toBe('exhausted');}
    finally{__setExitVerifier();}
  });});
});
test('A relay that does not say it runs Bun is skipped briefly, a Bun relay is judged like a direct exit',async()=>{
  const saved=settings.routes;const mk=(id:string)=>({id,name:id,kind:'relay' as const,url:`http://127.0.0.2:${remote.port}/relay`,enabled:true,models:[] as string[]});
  settings.routes=[...saved,mk('relay-x'),mk('relay-bun')];
  const call=(id:string,runtime:string)=>networkFetch('https://opencode.ai/x',{method:'POST',headers:{'content-type':'application/json','x-test-runtime':runtime},body:JSON.stringify({model:'drained'})},id);
  let asked=0;__setExitVerifier(async()=>{asked++;return 'exhausted';});settings.relayRotations=0;
  try{
    await (await call('relay-x','node v22')).text();const x=settings.routes.find(r=>r.id==='relay-x')!;
    expect(asked).toBe(0);expect(x.exhaustedUntil!).toBeGreaterThan(Date.now());expect(x.exhaustedUntil!).toBeLessThan(Date.now()+20*60e3);expect(x.status).toContain('Refused');
    await (await call('relay-bun','bun 1.3.14')).text();const b=settings.routes.find(r=>r.id==='relay-bun')!;
    expect(asked).toBe(1);expect(b.exhaustedUntil!).toBeGreaterThan(Date.now()+7000e3);expect(b.status).toContain('Daily Free allowance used');
  }finally{settings.routes=saved;settings.relayRotations=undefined;__setExitVerifier();for(const r of settings.routes)r.exhaustedUntil=0;}
});
test('A Bun relay whose address is used up is recycled and the same request is retried on the new instance',async()=>{
  const saved=settings.routes;settings.routes=[...saved,{id:'relay-fan',name:'relay-fan',kind:'relay' as const,url:`http://127.0.0.2:${remote.port}/relay`,token:'k',enabled:true,models:[] as string[]}];
  relayInstance=1;relayCalls.length=0;relayAvoid.length=0;let asked=0;__setExitVerifier(async()=>{asked++;return 'exhausted';});
  const call=()=>networkFetch('https://opencode.ai/x',{method:'POST',headers:{'content-type':'application/json','x-test-runtime':'bun 1.3.14','x-test-good-from':'2'},body:JSON.stringify({model:'drained'})},'relay-fan');
  try{
    const r=await call();expect(r.status).toBe(200);await r.text();
    expect(asked).toBe(1);expect(relayCalls).toEqual(['ping','recycle','ping']);expect(relayInstance).toBe(2);
    const route=settings.routes.find(x=>x.id==='relay-fan')!;expect(route.exhaustedUntil||0).toBe(0);
    const {relayInfo}=await import('../backend/transport');expect(relayInfo('relay-fan')).toMatchObject({egress:'10.0.0.2',spent:1,bun:true});
    // The address that was used up is sent along, so an instance on it answers without calling OpenCode.
    await (await call()).text();expect(relayAvoid[relayAvoid.length-1]).toBe('10.0.0.1');
    // When every instance tried is used up, the whole relay is retired until the reset.
    relayInstance=1;settings.relayRotations=2;const never=await networkFetch('https://opencode.ai/x',{method:'POST',headers:{'content-type':'application/json','x-test-runtime':'bun 1.3.14'},body:JSON.stringify({model:'drained'})},'relay-fan');
    expect(never.status).toBe(429);await never.text();expect(route.exhaustedUntil!).toBeGreaterThan(Date.now()+60e3);
  }finally{settings.routes=saved;settings.relayRotations=undefined;__setExitVerifier();for(const r of settings.routes)r.exhaustedUntil=0;}
});
test('A Bun relay instance that does not answer is replaced by a new one before the route is given up',async()=>{
  const saved=settings.routes;settings.routes=[...saved,{id:'relay-flaky',name:'relay-flaky',kind:'relay' as const,url:`http://127.0.0.2:${remote.port}/relay`,token:'k',enabled:true,models:[] as string[]}];
  const {relayInfo}=await import('../backend/transport');const call=()=>networkFetch('https://opencode.ai/x',{method:'POST',headers:{'content-type':'application/json','x-test-runtime':'bun 1.3.14'},body:JSON.stringify({model:'flaky'})},'relay-flaky');
  try{
    // The route has to be known as a Bun relay first (an earlier answer carried the runtime header).
    relayInstance=2;await (await call()).text();expect(relayInfo('relay-flaky').bun).toBe(true);
    relayInstance=1;relayCalls.length=0;const r=await call();expect(r.status).toBe(200);await r.text();expect(relayCalls).toEqual(['ping','recycle','ping']);expect(relayInstance).toBe(2);
  }finally{settings.routes=saved;settings.relayRotations=undefined;}
});
test('The standby keeps distinct clean exits ready by testing only what is missing, and retires used-up ones',async()=>{
  const forward=async(req:Request)=>fetch(req.url,{method:req.method,headers:req.headers,body:req.method==='GET'||req.method==='HEAD'?undefined:await req.arrayBuffer()});
  const usedUp=async(req:Request)=>req.method==='POST'?new Response(FREE_LIMIT_BODY,{status:429,headers:{'content-type':'application/json','retry-after':'7200'}}):forward(req);
  const {standbyTick,hasCleanStandby,__setApiRunner,engineApiRunner}=await import('../backend/pool');const savedCatalog=process.env.POLYGATE_POOL_CATALOG_URL;process.env.POLYGATE_POOL_CATALOG_URL=`http://127.0.0.2:${remote.port}/v1/models`;
  await withPool([usedUp,forward,forward,forward],async({entries,hits})=>{await scoped([remoteProvider()],async()=>{
    freshModel('remote','fine');entries[3].exitIp=entries[2].exitIp;settings.pool={...settings.pool!,standby:true,standbyTarget:2,standbyFreshMinutes:20};
    __setApiRunner(async()=>new Map(entries.map(e=>[e.url,{latency:40,status:200}])));
    expect(hasCleanStandby()).toBe(false);
    await standbyTick();
    expect(__poolHealth.get(entries[0].url)!.status).toBe('exhausted');
    expect(__poolHealth.get(entries[1].url)!.status).toBe('ready');expect(__poolHealth.get(entries[2].url)!.status).toBe('ready');
    expect(hits[3]).toBe(0);expect(hasCleanStandby()).toBe(true);
    const after=[...hits];await standbyTick();expect(hits).toEqual(after);
    const {poolStatus}=await import('../backend/pool');const st=(await poolStatus()).standby;expect(st).toMatchObject({clean:2,target:2,exhausted:1,enabled:true});
    // A test older than the freshness window no longer counts, so the next tick re-verifies instead of trusting it.
    for(const e of entries.slice(1,3))__poolHealth.get(e.url)!.checkedAt=Date.now()-3*3600e3;
    await standbyTick();expect(hits[1]+hits[2]).toBeGreaterThan(after[1]+after[2]);
  });});
  __setApiRunner(engineApiRunner);
  if(savedCatalog===undefined)delete process.env.POLYGATE_POOL_CATALOG_URL;else process.env.POLYGATE_POOL_CATALOG_URL=savedCatalog;
});
test('The pool test checks the OpenCode API first, applies the speed gate and sends model requests only through the survivors',async()=>{
  const forward=async(req:Request)=>fetch(req.url,{method:req.method,headers:req.headers,body:req.method==='GET'||req.method==='HEAD'?undefined:await req.arrayBuffer()});
  const posts=[0,0,0,0];const px=(i:number)=>async(req:Request)=>{if(req.method==='POST')posts[i]++;return forward(req);};
  const {testPool,poolJob,stageOf,__setApiRunner,engineApiRunner,scanApi}=await import('../backend/pool');
  await withPool([px(0),px(1),px(2),px(3)],async({entries})=>{await scoped([remoteProvider()],async()=>{
    freshModel('remote','fine');settings.pool={...settings.pool!,standby:false,apiMaxLatencyMs:2000,maxTested:10};
    // 0 never answers the API, 1 answers but too slowly, 2 and 3 are fast.
    __setApiRunner(async(_list,{progress})=>{progress(2,4);return new Map([[entries[1].url,{latency:9000,status:200}],[entries[2].url,{latency:120,status:200}],[entries[3].url,{latency:300,status:200}]]);});
    const started=await testPool({deep:true,api:true});expect(started.phase).toBe('api');
    await until(()=>!poolJob().running?poolJob():undefined,6000);
    expect(posts).toEqual([0,0,1,1]);
    const stages=entries.map(e=>stageOf(e,__poolHealth.get(e.url)));expect(stages).toEqual(['failed','failed','ready','ready']);
    expect(__poolHealth.get(entries[0].url)!.error).toContain('OpenCode API');expect(__poolHealth.get(entries[1].url)!.api).toMatchObject({ok:true,latency:9000});
    expect(poolJob().message).toContain('2 reach the API in time');expect(poolJob().ready).toBe(2);
    // The API-only run (Quick check in the dashboard) stops after the speed gate and sends no model request.
    const before=[...posts];await testPool({deep:false,api:true});await until(()=>!poolJob().running?poolJob():undefined,6000);expect(posts).toEqual(before);expect(poolJob().message).toContain('reach the OpenCode API within 2000 ms');
    // A scan that fails outright leaves the proxy list as it was.
    __setApiRunner(async()=>null);expect(await scanApi(entries)).toBeNull();
  });});
  __setApiRunner(engineApiRunner);
});
test('The pool is either the active route or standby, and standby gives the previous route back',async()=>{
  const {setPoolRole}=await import('../backend/pool');const {describeRoutes,backupChain}=await import('../backend/transport');
  const saved={routes:[...settings.routes],routeId:settings.routeId,prev:settings.previousRouteId,pool:settings.pool,allow:settings.allowDirect,ef:settings.exhaustedFailover};
  try{
    settings.routes=[{id:'direct',name:'Direct connection',kind:'direct',url:'',enabled:true,models:[]},{id:'proxy-pool',name:'Verified proxy pool',kind:'proxy',url:'proxyhive://saved-pool',enabled:true,models:[]}];
    settings.routeId='direct';settings.allowDirect=false;settings.exhaustedFailover=undefined;
    let info=describeRoutes();expect(info.direct.role).toBe('active');expect(info['proxy-pool'].role).toBe('backup');
    expect(backupChain().map(b=>b.id)).toEqual(['proxy-pool']);
    setPoolRole(true);expect(settings.routeId).toBe('proxy-pool');expect(settings.previousRouteId).toBe('direct');
    info=describeRoutes();expect(info['proxy-pool'].role).toBe('active');expect(info.direct.role).toBe('off');
    expect(backupChain().filter(b=>b.usable)).toEqual([]);                    // direct is listed but blocked as a last resort until allowed
    settings.allowDirect=true;expect(backupChain().filter(b=>b.usable).map(b=>b.id)).toEqual(['direct']);expect(describeRoutes().direct.role).toBe('backup');
    setPoolRole(true);expect(settings.previousRouteId).toBe('direct');           // selecting it twice keeps the real previous route
    setPoolRole(false);expect(settings.routeId).toBe('direct');
    settings.routes.find(r=>r.id==='direct')!.exhaustedUntil=Date.now()+3600e3;
    expect(describeRoutes().direct).toMatchObject({label:'Used up today',tone:'cooldown'});expect(describeRoutes().direct.detail).toContain('UTC');
    settings.exhaustedFailover=false;expect(backupChain()).toEqual([]);expect(describeRoutes()['proxy-pool'].role).toBe('off');
  }finally{Object.assign(settings,{routes:saved.routes,routeId:saved.routeId,previousRouteId:saved.prev,pool:saved.pool,allowDirect:saved.allow,exhaustedFailover:saved.ef});for(const r of settings.routes)r.exhaustedUntil=0;}
});
test('The pool list is filtered, sorted and paged on the server, with a count for every tab',async()=>{
  const {__setPoolEntries,poolStatus,poolReport,poolExhausted,stageOf}=await import('../backend/pool');
  const entries=Array.from({length:120},(_,i)=>({url:`http://10.1.0.${i}:8080`,proxy:`http://10.1.0.${i}:8080`,proto:i%4===0?'socks5':'http',host:`10.1.0.${i}`,port:8080,https:true,latencyMs:100+i,exitIp:`x${i}`}));
  __setPoolEntries(entries);__poolHealth.clear();const saved=settings.pool;settings.pool={mode:'ready',deepTest:true,recheckMinutes:30,maxTested:60,concurrency:2,retries:3,apiMaxLatencyMs:2000};
  try{
    const apiOk=(i:number,latency:number)=>{poolReport(entries[i].url,'ok',50,false);__poolHealth.get(entries[i].url)!.api={ok:true,latency,at:Date.now()};};
    for(let i=0;i<10;i++){poolReport(entries[i].url,'ok',80+i,true);__poolHealth.get(entries[i].url)!.api={ok:true,latency:200+i,at:Date.now()};}   // ready
    for(let i=10;i<30;i++)apiOk(i,300+i);                                                                                                        // passed the API check, waiting for the model test
    for(let i=30;i<35;i++)poolExhausted(entries[i].url,{until:Date.now()+3600e3,seconds:3600});                                                  // used up
    for(let i=35;i<45;i++){poolReport(entries[i].url,'unreachable',0);poolReport(entries[i].url,'unreachable',0);}                               // failed
    apiOk(45,9000);                                                                                                                              // answered, but too slow
    const all=await poolStatus();
    expect(all.counts).toEqual({all:120,ready:10,api:20,exhausted:5,failed:11,untested:74});expect(all.total).toBe(120);expect(all.pages).toBe(3);expect(all.entries).toHaveLength(50);expect(all.page).toBe(1);
    expect(all.entries[0].stage).toBe('ready');
    expect(stageOf(entries[45],__poolHealth.get(entries[45].url))).toBe('failed');
    const last=await poolStatus({page:3});expect(last.entries).toHaveLength(20);expect((await poolStatus({page:99})).page).toBe(3);expect((await poolStatus({page:0})).page).toBe(1);
    const ready=await poolStatus({tab:'ready'});expect(ready.total).toBe(10);expect(ready.entries.every((e:any)=>e.stage==='ready')).toBe(true);
    expect((await poolStatus({tab:'exhausted'})).total).toBe(5);expect((await poolStatus({tab:'failed'})).total).toBe(11);expect((await poolStatus({tab:'untested'})).total).toBe(74);
    expect((await poolStatus({tab:'api'})).entries.map((e:any)=>e.host)[0]).toBe('10.1.0.10');
    expect((await poolStatus({proto:'socks5'})).total).toBe(30);expect((await poolStatus({q:'10.1.0.7:'})).entries.map((e:any)=>e.host)).toContain('10.1.0.7');
    const byApi=await poolStatus({tab:'api',sort:'api'});const ms=byApi.entries.map((e:any)=>e.health.api.latency);expect(ms).toEqual([...ms].sort((a:number,b:number)=>a-b));
    expect((await poolStatus({pageSize:5})).pageSize).toBe(10);
  }finally{settings.pool=saved;__poolHealth.clear();}
});
test('The pool settings and the proxy finding endpoints validate what they are given',async()=>{
  const post=(path:string,b:any)=>fetch(base+path,{method:'POST',headers:{authorization:'Bearer test-admin-secret','content-type':'application/json'},body:JSON.stringify(b)});
  const saved=settings.pool;
  try{
    expect((await post('/admin/pool/settings',{standby:true,standbyTarget:3,apiMaxLatencyMs:1500})).status).toBe(200);expect(settings.pool!.standbyTarget).toBe(3);expect(settings.pool!.apiMaxLatencyMs).toBe(1500);
    expect((await post('/admin/pool/settings',{standbyTarget:0})).status).toBe(400);expect((await post('/admin/pool/settings',{keepWarm:'yes'})).status).toBe(400);
    expect((await post('/admin/proxies/import',{text:'   '})).status).toBe(400);expect((await post('/admin/proxies/remove',{})).status).toBe(400);
    expect((await post('/admin/proxies/remove',{urls:['http://203.0.113.1:80']})).status).toBe(200);expect((await post('/admin/proxies/remove',{all:true})).status).toBe(200);
    expect((await post('/admin/proxies/stop',{})).status).toBe(200);
  }finally{settings.pool=saved;}
});
test('Exit-used-up detection needs both the daily Retry-After and the Free limit text',async()=>{
  const {exhaustionOf,parseRetryAfter}=await import('../backend/exhaustion');
  expect(exhaustionOf(429,'7200','Free usage limit reached')?.seconds).toBe(7200);
  expect(exhaustionOf(429,null,'Free usage limit reached')).toBeUndefined();
  expect(exhaustionOf(429,'30','Too many requests')).toBeUndefined();
  expect(exhaustionOf(503,'7200','Free usage limit reached')).toBeUndefined();
  expect(exhaustionOf(429,'999999','FreeUsageLimitError')?.seconds).toBe(86400);
  expect(parseRetryAfter(new Date(Date.now()+60000).toUTCString())).toBeGreaterThan(50);
});
test('Client disconnect cancels the wait and is not charged to the model',async()=>{await scoped([remoteProvider()],async()=>{
  freshModel('remote','slow');const ac=new AbortController();const started=Date.now();
  const sent=call('/v1/chat/completions',{model:'remote/slow',stream:true,messages:[{role:'user',content:'y'}]},undefined,ac.signal).catch(()=>{});
  await Bun.sleep(400);ac.abort();await sent;
  const row=await until(()=>logs(10).find(l=>l.model==='remote/slow'&&l.status===499),2500);expect(Date.now()-started).toBeLessThan(3500);expect(faultOf(row.id)).toBe(0);
  expect(models.get('remote/slow')!.state).not.toBe('cooldown');
});});
test('Only upstream verdicts count toward a model usage penalty',()=>{
  const row=(status:number,fault:boolean)=>record({id:crypto.randomUUID(),time:Date.now(),model:'penalty/model',provider:'x',protocol:'chat',route:'',status,ms:1,input:0,output:0,error:'e',keyId:'k',fault});
  for(let i=0;i<6;i++)row(503,false);expect(usagePenalties().get('penalty/model')).toBeUndefined();
  for(let i=0;i<6;i++)row(500,true);expect(usagePenalties().get('penalty/model')).toBe(8);
});
test('A full admission queue does not mark a model as failed',async()=>{await scoped([remoteProvider()],async()=>{
  freshModel('remote','okp');const prev=[queue.max,queue.capacity];queue.max=1;queue.capacity=0;const hold=await queue.acquire('hold',1,new AbortController().signal);
  try{await expect(probeModel('remote/okp')).rejects.toThrow(/queue/i);}finally{hold();[queue.max,queue.capacity]=prev;}
  expect(models.get('remote/okp')!.state).toBe('unchecked');expect(models.get('remote/okp')!.failCount).toBe(0);
  expect((await probeModel('remote/okp')).state).toBe('available');
});});
test('A model of a disabled provider is a 404, not a 500',async()=>{await scoped([{...remoteProvider(),enabled:false}],async()=>{
  freshModel('remote','dis');const r=await chat('remote/dis');expect(r.status).toBe(404);expect((await r.json() as any).error.type).toBe('model_not_found');
});});
test('Session IDs separate conversations that share a system prompt',()=>{
  const sys={role:'system',content:'You are a coding agent'};const user=(content:string)=>({role:'user',content});
  const a=sessionFor('k',[sys,user('fix bug A')],{});
  expect(a).not.toBe(sessionFor('k',[sys,user('write docs')],{}));
  expect(a).toBe(sessionFor('k',[sys,user('fix bug A'),{role:'assistant',content:'done'},user('and more')],{}));
  expect(sessionFor('k',[sys],{'x-session-id':'abc'})).toBe(sessionFor('k',[sys,user('zzz')],{'x-session-id':'abc'}));
});
test('The OpenCode server adapter validates first and removes its throwaway session',async()=>{
  const oc={id:'oc',name:'OC server',kind:'opencode' as const,enabled:true,baseUrl:`http://127.0.0.1:${opencode.port}`,apiKey:'',models:['anthropic/claude'],routeId:''};
  await scoped([oc],async()=>{
    await discover();const r=await call('/v1/chat/completions',{model:'oc/anthropic/claude',messages:[{role:'user',content:'hi'}]});expect((await r.json() as any).choices[0].message.content).toBe('from opencode');
    await until(()=>opencodeSeen.includes('DELETE /session/s1')||undefined);
    freshModel('oc','noslash');const before=opencodeSeen.filter(x=>x==='POST /session').length;const bad=await call('/v1/chat/completions',{model:'oc/noslash',messages:[{role:'user',content:'hi'}]});
    expect(bad.status).toBe(400);expect(opencodeSeen.filter(x=>x==='POST /session').length).toBe(before);
  });
});
test('Fastest routing tries unmeasured routes first, then the lowest latency',()=>{
  const saved=[settings.routes,settings.rotate,settings.strategy] as const;
  try{
    const proxy=(id:string,latency?:number)=>({id,name:id,kind:'proxy' as const,url:'http://127.0.0.1:1',enabled:true,models:[],latency});
    settings.routes=[{id:'direct',name:'Direct',kind:'direct',url:'',enabled:true,models:[]},proxy('p1'),proxy('p2',80),proxy('p3',0)];settings.rotate=true;settings.strategy='fastest';
    expect(routeFor('m').id).toBe('p1');settings.routes[1].latency=30;expect(routeFor('m').id).toBe('p3');
  }finally{[settings.routes,settings.rotate,settings.strategy]=saved as any;}
});
test('Rejected settings apply nothing and accepted limits reach the queue',async()=>{
  const post=(b:any)=>fetch(base+'/admin/settings',{method:'POST',headers:{authorization:'Bearer test-admin-secret','content-type':'application/json'},body:JSON.stringify(b)});
  const before=settings.maxConcurrent;
  expect((await post({maxConcurrent:5,retries:9})).status).toBe(400);expect(settings.maxConcurrent).toBe(before);
  expect((await post({timeoutMs:null})).status).toBe(400);
  expect((await post({maxConcurrent:6})).status).toBe(200);expect(queue.max).toBe(6);
  await post({maxConcurrent:before});
});


// --- Server mode, scoped keys, SOCKS bridge, WARP, pool, health, HTTPS ---
const { socksBridge, socksConnect } = await import('../backend/socks-bridge');
const { loginGate, keyGate, signOutEverywhere } = await import('../backend/auth');
const { poolReport, pickPoolProxy, __setPoolEntries, __poolHealth } = await import('../backend/pool');
const { notify, notices, clearNotices } = await import('../backend/notifications');
const net = await import('node:net');
const { existsSync, writeFileSync, mkdirSync, chmodSync } = await import('node:fs');
const adminFetch = (p: string, body?: any, init: RequestInit = {}) => fetch(base + p, { method: body === undefined ? 'GET' : 'POST', ...init, headers: { authorization: 'Bearer test-admin-secret', 'content-type': 'application/json', ...(init.headers as any) }, body: body === undefined ? undefined : JSON.stringify(body) });

// A small SOCKS5 server: records what each client asked for and optionally requires a username/password.
function socksServer(opts: { user?: string; pass?: string; map?: Record<string, { host: string; port: number }> } = {}) {
  const seen: { atyp: number; host: string; port: number }[] = [];
  const server = net.createServer(client => {
    let state = 'greet'; let buf = Buffer.alloc(0);
    client.on('error', () => {}); client.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (state === 'greet' && buf.length >= 2) {
        const methods = [...buf.subarray(2, 2 + buf[1])]; buf = buf.subarray(2 + buf[1]);
        if (opts.user) { if (!methods.includes(2)) return void client.end(Buffer.from([5, 0xff])); client.write(Buffer.from([5, 2])); state = 'auth'; } else { client.write(Buffer.from([5, 0])); state = 'request'; }
      }
      if (state === 'auth' && buf.length >= 2) {
        const ulen = buf[1]; if (buf.length < 3 + ulen) return; const plen = buf[2 + ulen]; if (buf.length < 3 + ulen + plen) return;
        const user = buf.subarray(2, 2 + ulen).toString(), pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString(); buf = buf.subarray(3 + ulen + plen);
        if (user !== opts.user || pass !== opts.pass) return void client.end(Buffer.from([1, 1])); client.write(Buffer.from([1, 0])); state = 'request';
      }
      if (state === 'request' && buf.length >= 5) {
        const atyp = buf[3]; let host = '', end = 0;
        if (atyp === 1) { host = [...buf.subarray(4, 8)].join('.'); end = 8; } else if (atyp === 3) { host = buf.subarray(5, 5 + buf[4]).toString(); end = 5 + buf[4]; } else return void client.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]));
        if (buf.length < end + 2) return; const port = buf.readUInt16BE(end); seen.push({ atyp, host, port }); state = 'pipe'; const target = opts.map?.[host] || { host, port };
        const upstream = net.connect(target.port, target.host, () => { client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); upstream.pipe(client); client.pipe(upstream); });
        upstream.on('error', () => client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])));
      }
    });
  });
  return new Promise<{ port: number; seen: typeof seen; close: () => void }>(resolve => server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as any).port, seen, close: () => server.close() })));
}
const echoTarget = Bun.serve({ port: 0, hostname: '127.0.0.2', fetch: req => new Response('target says hi: ' + new URL(req.url).pathname) });
afterAll(() => echoTarget.stop(true));
const ECHO = echoTarget.port as number;

test.skipIf(process.platform === 'win32')('The SOCKS bridge carries HTTP through a SOCKS5 server and sends hostnames unresolved', async () => {
  const socks = await socksServer({ map: { 'upstream.test': { host: '127.0.0.2', port: ECHO } } });
  try {
    const proxy = await socksBridge({ host: '127.0.0.1', port: socks.port });
    const r = await fetch(`http://127.0.0.2:${ECHO}/abs`, { proxy } as any); expect(await r.text()).toBe('target says hi: /abs'); expect(socks.seen[0]).toMatchObject({ atyp: 1, host: '127.0.0.2', port: ECHO });
    // CONNECT with a domain name: the SOCKS server, not Polygate, must resolve it.
    const bridgePort = Number(new URL(proxy).port); const reply = await new Promise<string>((resolve, reject) => {
      const c = net.connect(bridgePort, '127.0.0.1'); let out = ''; c.on('error', reject);
      c.on('data', d => { out += d; if (out.includes('200 Connection Established') && !out.includes('target says')) c.write('GET /tunnel HTTP/1.1\r\nHost: upstream.test\r\nConnection: close\r\n\r\n'); if (out.includes('target says')) { c.destroy(); resolve(out); } });
      c.write('CONNECT upstream.test:80 HTTP/1.1\r\nHost: upstream.test:80\r\n\r\n');
    });
    expect(reply).toContain('target says hi: /tunnel'); expect(socks.seen.at(-1)).toMatchObject({ atyp: 3, host: 'upstream.test', port: 80 });
  } finally { socks.close(); }
});
// The SOCKS bridge tests pass on Windows when run alone, but Bun 1.3.x there segfaults when they share a process with the gateway streaming tests (Bun 1.4 on Linux is fine), so they run on Linux/macOS only.
test.skipIf(process.platform === 'win32')('The SOCKS bridge authenticates with username and password and reports failures as 502', async () => {
  const socks = await socksServer({ user: 'u', pass: 'p' });
  try {
    const good = await socksConnect({ host: '127.0.0.1', port: socks.port, username: 'u', password: 'p' }, '127.0.0.2', ECHO); good.destroy();
    await expect(socksConnect({ host: '127.0.0.1', port: socks.port, username: 'u', password: 'wrong' }, '127.0.0.2', ECHO)).rejects.toThrow(/rejected/);
    const proxy = await socksBridge({ host: '127.0.0.1', port: socks.port, username: 'u', password: 'wrong' });
    expect((await fetch(`http://127.0.0.2:${ECHO}/x`, { proxy } as any)).status).toBe(502);
  } finally { socks.close(); }
});
test.skipIf(process.platform === 'win32')('A socks5 route sends provider traffic through the bridge', async () => {
  const socks = await socksServer(); const saved = [...settings.routes];
  try {
    settings.routes.push({ id: 'via-socks', name: 'SOCKS', kind: 'proxy', url: `socks5://127.0.0.1:${socks.port}`, enabled: true, models: [] });
    const r = await networkFetch(`http://127.0.0.2:${ECHO}/routed`, {}, 'via-socks'); expect(await r.text()).toBe('target says hi: /routed'); expect(socks.seen.length).toBe(1);
    expect(settings.routes.find(x => x.id === 'via-socks')!.status).toBe('healthy');
  } finally { settings.routes = saved; socks.close(); }
});

test('Dashboard login issues a signed session, locks out guessing and can be revoked', async () => {
  loginGate.reset();
  expect(((await (await fetch(base + '/admin/whoami')).json()) as any).authenticated).toBe(false);
  const login = (password: string) => fetch(base + '/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  const ok = await login('test-admin-secret'); expect(ok.status).toBe(200); const cookie = ok.headers.get('set-cookie')!.split(';')[0]; expect(cookie.startsWith('polygate_session=')).toBe(true); expect(ok.headers.get('set-cookie')).toContain('HttpOnly');
  expect((await fetch(base + '/admin/state', { headers: { cookie } })).status).toBe(200);
  expect(((await (await fetch(base + '/admin/whoami', { headers: { cookie } })).json()) as any).authenticated).toBe(true);
  expect((await fetch(base + '/admin/state', { headers: { cookie: cookie.slice(0, -4) + 'beef' } })).status).toBe(401);
  signOutEverywhere(); expect((await fetch(base + '/admin/state', { headers: { cookie } })).status).toBe(401);
  for (let i = 0; i < 5; i++) expect((await login('nope-' + i)).status).toBe(401);
  const locked = await login('test-admin-secret'); expect(locked.status).toBe(429); expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
  loginGate.reset();
});
test('The dashboard password can be changed and old sessions stop working', async () => {
  const login = (password: string) => fetch(base + '/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  expect((await adminFetch('/admin/password', { current: 'wrong', next: 'a-new-long-password-1' })).status).toBe(403);
  expect((await adminFetch('/admin/password', { current: 'test-admin-secret', next: 'short' })).status).toBe(400);
  const changed = await adminFetch('/admin/password', { current: 'test-admin-secret', next: 'a-new-long-password-1' }); expect(changed.status).toBe(200);
  expect((await login('a-new-long-password-1')).status).toBe(200); expect((await login('test-admin-secret')).status).toBe(401); loginGate.reset();
});
test('Invalid API keys are throttled per address', async () => {
  keyGate.reset(); let last = 0;
  for (let i = 0; i < 31; i++) last = (await fetch(base + '/v1/models', { headers: { authorization: 'Bearer pg_wrong' + i } })).status;
  expect(last).toBe(429);
  // Only failures are throttled: a valid key from the same (paused) address still works, so one bad client cannot lock out the rest.
  expect((await fetch(base + '/v1/models', { headers: { authorization: 'Bearer ' + settings.keys[0].value } })).status).toBe(200);
  keyGate.reset();
});
test('Lockouts: parallel slow logins are all counted, the table evicts instead of resetting, and IPv6 counts per /64', async () => {
  loginGate.reset();
  const login = (password: string) => fetch(base + '/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  const answers = await Promise.all(Array.from({ length: 8 }, (_, i) => login('guess-' + i).then(r => r.status)));
  expect(answers.filter(s => s === 401).length).toBeLessThanOrEqual(5); expect(answers).toContain(429);
  loginGate.reset();
  const { FailureGate, gateKey } = await import('../backend/auth');
  const gate = new FailureGate(2, 60000, 3); gate.fail('10.0.0.1'); gate.fail('10.0.0.1');
  for (const ip of ['10.0.0.2', '10.0.0.3']) gate.fail(ip); expect(gate.retryAfter('10.0.0.1')).toBeGreaterThan(0);   // at capacity, still locked
  gate.fail('10.0.0.4'); expect(gate.retryAfter('10.0.0.1')).toBe(0);   // the oldest entry made room; the others are kept
  expect(gateKey('2001:db8:1:2:aaaa::1')).toBe(gateKey('2001:db8:1:2:ffff:1:2:3')); expect(gateKey('2001:db8:1:3::1')).not.toBe(gateKey('2001:db8:1:2::1'));
  expect(gateKey('::ffff:192.0.2.7')).toBe('192.0.2.7');
  expect((await fetch(base + '/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x'.repeat(5000) }) })).status).toBe(413);
  loginGate.reset();
});
test('Behind a trusted proxy the client address is the one the proxy saw, not a forged left-hand X-Forwarded-For entry', async () => {
  const { clientIp } = await import('../backend/auth'); const saved = process.env.POLYGATE_TRUST_PROXY;
  const req = (xff: string) => ({ headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: '127.0.0.1' } }) as any;
  try {
    process.env.POLYGATE_TRUST_PROXY = '1'; expect(clientIp(req('6.6.6.6, 198.51.100.9'))).toBe('198.51.100.9'); expect(clientIp(req('198.51.100.9'))).toBe('198.51.100.9');
    process.env.POLYGATE_TRUST_PROXY = '2'; expect(clientIp(req('6.6.6.6, 198.51.100.9, 203.0.113.5'))).toBe('198.51.100.9');
    delete process.env.POLYGATE_TRUST_PROXY; expect(clientIp(req('6.6.6.6'))).toBe('127.0.0.1');
  } finally { if (saved === undefined) delete process.env.POLYGATE_TRUST_PROXY; else process.env.POLYGATE_TRUST_PROXY = saved; }
});
test('HTTPS: the certificate name is an allowed Host on a loopback-configured server, and the desktop app refuses HTTPS routes', async () => {
  const { hostAllowed } = await import('../backend/auth'); const saved = settings.https;
  try {
    expect(hostAllowed('panel.example.com')).toBe(false);
    settings.https = { mode: 'domain', domain: 'panel.example.com', httpPort: 80, redirect: true }; expect(hostAllowed('panel.example.com:443')).toBe(true); expect(hostAllowed('other.example.com')).toBe(false);
    settings.https = { mode: 'ip', ip: '2001:db8::7', httpPort: 80, redirect: true }; expect(hostAllowed('[2001:db8::7]:443')).toBe(true);
    settings.https = { mode: 'off', domain: 'panel.example.com', httpPort: 80, redirect: true }; expect(hostAllowed('panel.example.com')).toBe(false);
  } finally { settings.https = saved; }
  process.env.POLYGATE_DESKTOP = '1';
  try { expect((await fetch(base + '/admin/https', { headers: { authorization: 'Bearer test-admin-secret' } })).status).toBe(404); }
  finally { delete process.env.POLYGATE_DESKTOP; }
  expect((await fetch(base + '/admin/https', { headers: { authorization: 'Bearer test-admin-secret' } })).status).toBe(200);
});
test('Diagnostics limits cannot be negative, and /v1/models lists what a short-name scope allows', async () => {
  const diag = await fetch(base + '/admin/diagnostics?failures=-1&baseline=-1', { headers: { authorization: 'Bearer test-admin-secret' } }); expect(diag.status).toBe(200);
  const d = (await diag.json()) as any; expect(d.failures.length).toBeLessThanOrEqual(1); expect(d.baseline.length).toBeLessThanOrEqual(1);   // -1 used to become LIMIT -1: every row
  const key = settings.keys[0]; const saved = key.models;
  try { key.models = ['working']; const ids = ((await (await fetch(base + '/v1/models', { headers: { authorization: 'Bearer ' + key.value } })).json()) as any).data.map((m: any) => m.id); expect(ids).toContain('mock/working'); expect(ids).not.toContain('mock/limited'); }
  finally { key.models = saved; }
});
test('The health check reports the package version', async () => {
  const { version } = await import('../backend/version'); expect(version).toBe((await Bun.file(path.join(import.meta.dir, '..', 'package.json')).json() as any).version);
  expect(((await (await fetch(base + '/healthz')).json()) as any).version).toBe(version);
});
test('Health, readiness and CORS endpoints behave for a public deployment', async () => {
  expect((await fetch(base + '/healthz')).status).toBe(200);
  const ready = await fetch(base + '/readyz'); expect(ready.status).toBe(200); expect(((await ready.json()) as any).status).toBe('ready');
  settings.enabled = false; const paused = await fetch(base + '/readyz'); expect(paused.status).toBe(503); settings.enabled = true;
  const pre = await fetch(base + '/v1/chat/completions', { method: 'OPTIONS', headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' } }); expect(pre.status).toBe(204); expect(pre.headers.get('access-control-allow-origin')).toBe('*'); expect(pre.headers.get('access-control-allow-headers')).toContain('authorization');
  const cross = await fetch(base + '/admin/state', { headers: { authorization: 'Bearer test-admin-secret', origin: 'https://evil.example' } }); expect(cross.status).toBe(403);
  const same = await fetch(base + '/admin/state', { headers: { authorization: 'Bearer test-admin-secret', origin: base } }); expect(same.status).toBe(200);
});

test('Scoped keys enforce rate, budget, expiry, model list and enabled state', async () => {
  const create = async (b: any) => ((await (await adminFetch('/admin/keys', b)).json()) as any).key;
  const use = (key: string, model = 'mock/working') => fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }) });
  const rpm = await create({ name: 'rpm', rpm: 2 }); expect((await use(rpm.value)).status).toBe(200); expect((await use(rpm.value)).status).toBe(200);
  const blocked = await use(rpm.value); expect(blocked.status).toBe(429); expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  const budget = await create({ name: 'budget', budget: 5 }); expect((await use(budget.value)).status).toBe(200);
  const exhausted = await use(budget.value); expect(exhausted.status).toBe(429); expect(((await exhausted.json()) as any).error.type).toBe('insufficient_quota'); expect(settings.keys.find((k: any) => k.id === budget.id)!.used).toBeGreaterThanOrEqual(5);
  const only = await create({ name: 'only-working', models: ['mock/working'] }); expect((await use(only.value, 'mock/limited')).status).toBe(403); expect((await use(only.value)).status).toBe(200);
  expect(((await (await fetch(base + '/v1/models', { headers: { authorization: 'Bearer ' + only.value } })).json()) as any).data.map((m: any) => m.id).filter((id: string) => id !== 'auto')).toEqual(['mock/working']);
  const expiring = await create({ name: 'expiring' }); settings.keys.find((k: any) => k.id === expiring.id)!.expiresAt = Date.now() - 1000; const expired = await use(expiring.value); expect(expired.status).toBe(403); expect(((await expired.json()) as any).error.type).toBe('key_expired');
  expect((await adminFetch('/admin/keys', { name: 'past', expiresAt: '2001-01-01' })).status).toBe(400);
  await adminFetch('/admin/keys/update', { id: only.id, enabled: false }); expect((await use(only.value)).status).toBe(403);
  const updated = ((await (await adminFetch('/admin/keys/update', { id: rpm.id, rpm: 100, resetUsage: true, regenerate: true })).json()) as any).key; expect(updated.value).not.toBe(rpm.value); expect(updated.requests).toBe(0); expect((await use(updated.value)).status).toBe(200);
  for (const k of [rpm, budget, only, expiring]) await adminFetch('/admin/keys/delete', { id: k.id });
});

test('Failover moves to the next route when the selected proxy cannot connect', async () => {
  // Inject only the failed transport boundary; the recovery still goes to the real local mock server.
  // Repeated refused proxy sockets in Bun's connection pool can stall nondeterministically in a full suite.
  const originalFetch=globalThis.fetch;
  globalThis.fetch=(async(input:any,init:any)=>{if(init?.proxy==='http://failed-proxy.invalid:8080')throw new Error('Fixture proxy connection refused');return originalFetch(input,init);}) as any;
  const savedRoutes = [...settings.routes], saved = [settings.routeId, settings.failover, settings.allowDirect, settings.rotate] as const;
  try {
    await scoped([{ ...remoteProvider(), routeId: '' }], async () => {
      settings.routes.push({ id: 'dead', name: 'Dead proxy', kind: 'proxy', url: 'http://failed-proxy.invalid:8080', enabled: true, models: [] }); freshModel('remote', 'fo');
      settings.routeId = 'dead'; settings.rotate = false; settings.failover = undefined; /* the default is on */ settings.allowDirect = false;
      const refused = await chat('remote/fo',{stream:false}); const refusedBody = await refused.text(); expect([refused.status, refusedBody]).toEqual([502, expect.any(String)]);
      settings.allowDirect = true; settings.routes.find(r => r.id === 'dead')!.cooldownUntil = 0; settings.routes.find(r => r.id === 'dead')!.failures = 0;
      freshModel('remote','fo');
      const recovered = await chat('remote/fo',{stream:false}); expect(recovered.status).toBe(200); expect(decodeURIComponent(recovered.headers.get('x-polygate-route') || '')).toBe('Direct connection'); await recovered.text();
    });
  } finally { globalThis.fetch=originalFetch;settings.routes = savedRoutes; [settings.routeId, settings.failover, settings.allowDirect, settings.rotate] = saved as any; }
});

test('The proxy pool serves only model-ready proxies, rotates them and drops ones the upstream refuses', async () => {
  const entry = (n: number) => ({ url: `http://10.0.0.${n}:8080`, proxy: `http://10.0.0.${n}:8080`, proto: 'http', host: `10.0.0.${n}`, port: 8080, https: true, latencyMs: 100 * n });
  __setPoolEntries([entry(1), entry(2), entry(3)]); __poolHealth.clear();
  const route = { id: 'proxy-pool', name: 'pool', kind: 'proxy' as const, url: 'proxyhive://saved-pool', enabled: true, models: [], poolUrls: [] as string[] };
  const savedPool = settings.pool, savedStrategy = settings.strategy; settings.pool = { mode: 'ready', deepTest: true, recheckMinutes: 30, maxTested: 60, concurrency: 6, retries: 3 }; settings.strategy = 'round_robin';
  try {
    expect(await pickPoolProxy(route)).toBeNull();
    poolReport(entry(1).url, 'ok', 120); poolReport(entry(2).url, 'ok', 90);
    const picks = [(await pickPoolProxy(route))!.url, (await pickPoolProxy(route))!.url, (await pickPoolProxy(route))!.url]; expect(new Set(picks)).toEqual(new Set([entry(1).url, entry(2).url])); expect(picks).not.toContain(entry(3).url);
    poolReport(entry(1).url, 'blocked', 0); // one refusal by the upstream is enough to rotate a proxy out
    for (let i = 0; i < 4; i++) expect((await pickPoolProxy(route))!.url).toBe(entry(2).url);
    poolReport(entry(2).url, 'unreachable', 0); expect((await pickPoolProxy(route))!.url).toBe(entry(2).url); poolReport(entry(2).url, 'unreachable', 0); expect(await pickPoolProxy(route)).toBeNull();
    settings.strategy = 'fastest'; poolReport(entry(3).url, 'ok', 300); poolReport(entry(1).url, 'ok', 50); __poolHealth.get(entry(1).url)!.coolUntil = 0; expect((await pickPoolProxy(route))!.url).toBe(entry(1).url);
    settings.pool = { ...settings.pool, mode: 'selected' }; route.poolUrls = [entry(3).url]; expect((await pickPoolProxy(route))!.url).toBe(entry(3).url);
  } finally { settings.pool = savedPool; settings.strategy = savedStrategy; __poolHealth.clear(); }
});

test('A catalog-only pool check never makes a proxy model-ready in deep-test mode', async () => {
  const {isUsable}=await import('../backend/pool');const saved=settings.pool;
  settings.pool={mode:'ready',deepTest:true,recheckMinutes:30,maxTested:60,concurrency:2,retries:3};
  try{const url='http://192.0.2.77:8080';poolReport(url,'ok',30,false);expect(isUsable(__poolHealth.get(url))).toBe(false);poolReport(url,'ok',60,true);expect(isUsable(__poolHealth.get(url))).toBe(true);}
  finally{settings.pool=saved;__poolHealth.clear();}
});

test('Notifications are stored, de-duplicated and delivered to a webhook', async () => {
  clearNotices(); const hooks: any[] = [];
  const hook = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { hooks.push(await req.json()); return new Response('ok'); } });
  try {
    expect((await adminFetch('/admin/notify/settings', { webhookUrl: `http://127.0.0.1:${hook.port}/hook`, minLevel: 'warning' })).status).toBe(200);
    notify('Route down', 'Everything is cooling down', 'error', 'k1'); notify('Route down', 'Everything is cooling down', 'error', 'k1'); notify('FYI', 'low priority', 'info', 'k2');
    await until(() => hooks.length >= 1 || undefined); await Bun.sleep(150);
    expect(notices().items.length).toBe(2); expect(hooks.length).toBe(1); expect(hooks[0].text).toContain('Route down');
    const state = ((await (await adminFetch('/admin/state')).json()) as any); expect(state.settings.notify.webhookUrl).toBe('••••••••'); expect(state.settings.admin).toBeUndefined(); expect(state.notices).toBe(2);
    await adminFetch('/admin/notifications/read', {}); expect(notices().unread).toBe(0);
  } finally { hook.stop(true); settings.notify = undefined; clearNotices(); }
});

test('Metrics report latency percentiles and a Prometheus view', async () => {
  const m = ((await (await adminFetch('/admin/metrics')).json()) as any); expect(m.requests).toBeGreaterThan(0); expect(m.p95).toBeGreaterThanOrEqual(m.p50); expect(Array.isArray(m.byModel)).toBe(true); expect(m.keys.length).toBeGreaterThan(0);
  const text = await (await adminFetch('/metrics')).text(); expect(text).toContain('# TYPE polygate_requests_24h gauge'); expect(text).toContain('polygate_ready 1'); expect((await fetch(base + '/metrics')).status).toBe(401);
});

test('The queue answers 429 with Retry-After when full and when a wait expires', async () => {
  const q = new AdmissionQueue(1, 1); const open = new AbortController(); const hold = await q.acquire('a', 1, open.signal);
  const waiter = q.acquire('a', 1, new AbortController().signal, 80); await expect(waiter).rejects.toMatchObject({ status: 429, type: 'queue_timeout' });
  const queued = q.acquire('a', 1, new AbortController().signal); await expect(q.acquire('a', 1, new AbortController().signal)).rejects.toMatchObject({ status: 429, type: 'queue_full', retryAfter: 3 });
  hold(); (await queued)();
});

test('WARP: only the built-in engine exists; a saved engine from an older version is read as built-in, and an unknown one is refused', async () => {
  const warp = await import('../backend/warp'); const saved = settings.warp;
  try {
    settings.warp = { engine: 'cli', host: '127.0.0.1', autoStart: false, pool: 1, rotateMinutes: 0, wireproxyPath: '' } as any;
    expect(warp.engineMode()).toBe('embedded'); expect((warp.warpConfig() as any).host).toBeUndefined();
    settings.warp = { engine: 'disabled', autoStart: false, pool: 1, rotateMinutes: 0, wireproxyPath: '' }; expect(warp.engineMode()).toBe('disabled');
    await expect(warp.setWarpSettings({ engine: 'sidecar' as any })).rejects.toThrow(/Unknown WARP setting/);
    await expect(warp.warpConnect()).rejects.toThrow(/turned off/);
    settings.warp = undefined; expect((await warp.warpStatus()).install.kind).toBe('wireproxy');
  } finally { settings.warp = saved; }
});

test('HTTPS: input is validated', async () => {
  const bad = (b: any) => adminFetch('/admin/https/apply', b);
  expect((await bad({ mode: 'ip', ip: '192.168.1.5' })).status).toBe(400); expect((await bad({ mode: 'domain', domain: 'not a domain' })).status).toBe(400); expect((await bad({ mode: 'domain', domain: '*.example.com' })).status).toBe(400);
  expect((await bad({ mode: 'custom', certPem: 'x', keyPem: 'y' })).status).toBe(400); expect((await bad({ mode: 'bogus' })).status).toBe(400);
});
test.skipIf(!Bun.which('openssl'))('HTTPS: a custom certificate switches the listener to TLS and back', async () => {
  const bad = (b: any) => adminFetch('/admin/https/apply', b);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'polygate-tls-')); const { spawnSync } = await import('node:child_process');
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']);
  if (made.status !== 0) throw new Error('openssl could not create the test certificate: ' + made.stderr);
  const certPem = await Bun.file(path.join(dir, 'c.pem')).text(), keyPem = await Bun.file(path.join(dir, 'k.pem')).text();
  expect((await bad({ mode: 'custom', certPem, keyPem: keyPem.replace(/[A-Za-z]/, 'A') + 'x' })).status).toBe(400);
  const probe = Bun.serve({ port: 0, hostname: '0.0.0.0', fetch: () => new Response('') }); const port = probe.port as number; probe.stop(true); const plainPort = gateway.port;
  expect((await bad({ mode: 'custom', certPem, keyPem, port, redirect: false })).status).toBe(200);
  // The listener moves to TLS mid-job, so poll whichever address currently answers.
  const poll = async () => { for (const [u, o] of [[`https://127.0.0.1:${port}`, { tls: { rejectUnauthorized: false } }], [base, {}]] as const) { try { return await (await fetch(u + '/admin/https', { headers: { authorization: 'Bearer test-admin-secret' }, ...o } as any)).json() as any; } catch { /* try the next address */ } } return undefined; };
  let status: any; for (let i = 0; i < 80; i++) { status = await poll(); if (status && !status.job.running && status.job.finishedAt) break; await Bun.sleep(100); }
  expect(status.job.error).toBe(''); expect(status.active).toBe(true); expect(status.mode).toBe('custom');
  const tlsHealth = await fetch(`https://127.0.0.1:${port}/healthz`, { tls: { rejectUnauthorized: false } } as any); expect(tlsHealth.status).toBe(200);
  const tlsAdmin = await fetch(`https://127.0.0.1:${port}/admin/state`, { headers: { authorization: 'Bearer test-admin-secret' }, tls: { rejectUnauthorized: false } } as any); expect(tlsAdmin.status).toBe(200);
  const tlsSession = await fetch(`https://127.0.0.1:${port}/admin/session`, {method:'POST',headers:{authorization:'Bearer test-admin-secret','content-type':'application/json'},body:'{}',tls:{rejectUnauthorized:false}} as any);expect(tlsSession.headers.get('set-cookie')).toContain('Secure');expect(tlsSession.headers.get('strict-transport-security')).toContain('max-age=');
  expect((await (await fetch(`https://127.0.0.1:${port}/admin/https`, { headers: { authorization: 'Bearer test-admin-secret' }, tls: { rejectUnauthorized: false } } as any)).json() as any).url).toContain(`:${port}`);
  const off = await (await fetch(`https://127.0.0.1:${port}/admin/https/disable`, { method: 'POST', headers: { authorization: 'Bearer test-admin-secret', 'content-type': 'application/json' }, body: '{}', tls: { rejectUnauthorized: false } } as any)).json() as any; expect(off.mode).toBe('off');
  await Bun.sleep(200); const plain = await fetch(`http://127.0.0.1:${plainPort}/healthz`); expect(plain.status).toBe(200);
});
test('A route test with no usable id is a 400, and a route that cannot connect is a 502 with a readable reason',async()=>{
  const post=(b:any)=>fetch(base+'/admin/routes/test',{method:'POST',headers:{authorization:'Bearer test-admin-secret','content-type':'application/json'},body:JSON.stringify(b)});
  for(const b of [{},{id:null},{id:123},{id:{a:1}}])expect((await post(b)).status).toBe(400);
  expect((await post({id:'no-such-route'})).status).toBe(404);
  const saved=settings.routes;settings.routes=[...saved,{id:'dead-proxy',name:'dead',kind:'proxy' as const,url:'http://127.0.0.1:9',enabled:true,models:[] as string[]}];
  try{const r=await post({id:'dead-proxy'});const x:any=await r.json();expect(r.status).toBe(502);expect(x.error.type).toBe('route_unreachable');expect(x.error.message).toContain('Could not connect');}
  finally{settings.routes=saved;}
});
test('WARP: "New identity" and "Set up" without the tunnel helper fail at once instead of registering identities first',async()=>{
  const warp=await import('../backend/warp');if(warp.findWireproxy())return; // a machine that has wireproxy installed cannot show this
  const saved=settings.warp;settings.warp={engine:'embedded',autoStart:false,pool:2,rotateMinutes:0,wireproxyPath:''};
  try{for(const call of [warp.warpRotate,warp.warpConnect]){const t=Date.now();const e:any=await call().catch((x:any)=>x);expect(e.message).toContain('Download tunnel helper');expect(Date.now()-t).toBeLessThan(2500);}}
  finally{settings.warp=saved;}
});
test('WARP: a configured helper path that is a folder or cannot be run is not used (spawning it used to end the gateway)',async()=>{
  const warp=await import('../backend/warp');const saved=settings.warp;const tmp=mkdtempSync(path.join(os.tmpdir(),'polygate-wp-'));
  const {writeFileSync,chmodSync}=await import('node:fs');const file=path.join(tmp,process.platform==='win32'?'wireproxy.exe':'wireproxy');writeFileSync(file,'not a program');
  const using=(wireproxyPath:string)=>{settings.warp={engine:'embedded',autoStart:false,pool:1,rotateMinutes:0,wireproxyPath};return warp.findWireproxy();};
  try{
    const other=using('');   // whatever this machine has without the setting
    expect(using(tmp)).toBe(other);
    if(process.platform!=='win32'){chmodSync(file,0o644);expect(using(file)).toBe(other);chmodSync(file,0o755);expect(using(file)).toBe(file);
      // An executable file that is not a program: the kernel refuses it (ENOEXEC), the spawn emits 'error', and the connect call fails
      // with a clear message. Before the listener existed this ended the whole process. A saved identity avoids registering with Cloudflare.
      const {stateDir}=await import('../backend/state');const {mkdirSync,existsSync,readFileSync}=await import('node:fs');const acc=path.join(stateDir,'warp','accounts.json');const had=existsSync(acc)?readFileSync(acc):null;
      mkdirSync(path.dirname(acc),{recursive:true});writeFileSync(acc,JSON.stringify([{privateKey:'x',addressV4:'172.16.0.2',addressV6:'',peerPublicKey:'y',accountId:'t',registeredAt:''}]));
      try{const e:any=await warp.warpConnect().catch((x:any)=>x);expect(String(e?.message||e)).toContain('could not be started');}
      finally{if(had)writeFileSync(acc,had);else rmSync(acc,{force:true});await warp.warpDisconnect().catch(()=>{});}
    }
  }finally{settings.warp=saved;rmSync(tmp,{recursive:true,force:true});}
});
test('The webhook test waits for the webhook, reports a refusal, and is not suppressed by the minimum level',async()=>{
  const post=(p:string,b:any)=>fetch(base+p,{method:'POST',headers:{authorization:'Bearer test-admin-secret','content-type':'application/json'},body:JSON.stringify(b)});
  const saved=settings.notify;let status=204;let hits=0;const hook=Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>{hits++;return new Response(null,{status});}});
  try{
    settings.notify=undefined;expect((await post('/admin/notify/test',{})).status).toBe(400);
    settings.notify={webhookUrl:`http://127.0.0.1:${hook.port}/h`,minLevel:'error'};
    expect((await post('/admin/notify/test',{})).status).toBe(200);expect(hits).toBe(1);   // the answer is awaited: the hook has been called when the request returns
    status=500;const bad=await post('/admin/notify/test',{});const x:any=await bad.json();expect(bad.status).toBe(502);expect(x.error.message).toContain('HTTP 500');
    settings.notify={webhookUrl:'http://127.0.0.1:1/h',minLevel:'warning'};expect((await post('/admin/notify/test',{})).status).toBe(502);
  }finally{settings.notify=saved;hook.stop(true);}
});

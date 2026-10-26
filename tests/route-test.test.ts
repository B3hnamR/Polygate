import { test, expect, beforeAll, afterAll } from 'bun:test';
// State folder and POLYGATE_NO_DISCOVERY come from tests/setup.ts.
const {settings,models,saveModel,removeModels}=await import('../backend/state');
const {testRoute}=await import('../backend/transport');
// One stand-in server answers both ways a request can arrive: straight (the provider's own URL) and through a relay (x-relay-path says where it was going).
let mode:'ok'|'limit'|'busy'|'refused'|'catalog500'='ok';const seen:{path:string;auth:string|null;relayKey:string|null;model?:string}[]=[];
const upstream=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(req){
  const path=req.headers.get('x-relay-path')||new URL(req.url).pathname;const call:any={path,auth:req.headers.get('authorization'),relayKey:req.headers.get('x-relay-key')};
  if(path.endsWith('/models')){seen.push(call);return mode==='catalog500'?new Response('down',{status:500}):Response.json({data:[{id:'a:free'}]});}
  const body=await req.json() as any;call.model=body.model;seen.push(call);
  if(mode==='limit')return Response.json({error:{code:'PROMOTION_MODEL_LIMIT_REACHED',message:'Sign up for free to continue'}},{status:429});
  if(mode==='busy')return Response.json({error:{message:'a:free is temporarily rate-limited upstream'}},{status:429});
  if(mode==='refused')return Response.json({error:{message:'blocked'}},{status:403});
  return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:'OK'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
}});
const saved={providers:settings.providers,routes:settings.routes};
const model=(state:'available'|'unchecked'='available')=>saveModel({id:'kilo/a:free',upstreamId:'a:free',providerId:'kilo',name:'A (free)',context:1000,output:100,tools:true,reasoning:false,state,latency:10,score:50,priority:150,failCount:0,cooldownUntil:0,checkedAt:0,error:''});
const direct={id:'direct',name:'Direct connection',kind:'direct' as const,url:'',enabled:true,models:[]};
const kiloOnly={id:'r-kilo',name:'Kilo relay',kind:'relay' as const,url:`http://127.0.0.1:${upstream.port}/`,token:'relay-secret',enabled:true,models:[],only:'kilo' as const};
const kilo=(baseUrl:string,apiKey='')=>({id:'kilo',name:'Kilo Free',kind:'kilo' as const,enabled:true,baseUrl,apiKey,models:[] as string[],routeId:''});
const opencode={id:'opencode',name:'OpenCode Free',kind:'free' as const,enabled:true,baseUrl:'',apiKey:'',models:[] as string[],routeId:''};
beforeAll(()=>{settings.routes=[direct,kiloOnly];settings.providers=[kilo(`http://127.0.0.1:${upstream.port}/api/gateway`),opencode];removeModels('kilo');model();});
afterAll(()=>{settings.providers=saved.providers;settings.routes=saved.routes;removeModels('kilo');upstream.stop(true);});
const reset=(m:typeof mode='ok')=>{mode=m;seen.length=0;settings.providers[0].apiKey='';model();};

test('a route is tested with the chosen provider: model list first, then one small chat, in plain words',async()=>{
  reset();const r=await testRoute('direct','kilo');
  expect(r).toMatchObject({ok:true,status:200,chat:'ok',provider:'Kilo Free'});expect(r.summary).toBe('Direct connection: connected, and a real Kilo Free chat request passed.');
  expect(seen.map(s=>s.path)).toEqual(['/api/gateway/models','/api/gateway/chat/completions']);expect(seen[1].model).toBe('a:free');expect(seen.every(s=>s.auth===null)).toBe(true);
  expect(settings.routes[0].status).toBe('healthy');expect(settings.routes[0].latency).toBeGreaterThanOrEqual(0);
  reset();settings.providers[0].apiKey='kilo-key';await testRoute('direct','kilo');expect(seen.every(s=>s.auth==='Bearer kilo-key')).toBe(true);
});
test('Kilo\'s address limit, a busy model and a refusal each get their own sentence, and the model keeps its state',async()=>{
  reset('limit');let r=await testRoute('direct','kilo');expect(r.chat).toBe('limited');expect(r.summary).toContain('limits anonymous use per address');expect(r.ok).toBe(true);
  reset('busy');r=await testRoute('direct','kilo');expect(r.chat).toBe('busy');expect(r.summary).toContain('was busy (HTTP 429)');
  reset('refused');r=await testRoute('direct','kilo');expect(r.chat).toBe('refused');expect(r.summary).toContain('refused the request (HTTP 403)');
  expect(models.get('kilo/a:free')!.state).toBe('available');expect(models.get('kilo/a:free')!.cooldownUntil).toBe(0);
});
test('a model list that does not answer, or no ready model, is reported without sending a chat',async()=>{
  reset('catalog500');let r=await testRoute('direct','kilo');expect(r.ok).toBe(false);expect(r.status).toBe(500);expect(r.summary).toContain('model list answered HTTP 500');expect(seen.some(s=>s.path.endsWith('/chat/completions'))).toBe(false);expect(settings.routes[0].status).toBe('HTTP 500');
  reset();removeModels('kilo');r=await testRoute('direct','kilo');expect(r.chat).toBe('unknown');expect(r.summary).toContain('no Kilo Free model is ready');expect(seen.some(s=>s.path.endsWith('/chat/completions'))).toBe(false);
});
test('a Kilo-only relay defaults to Kilo, works through the relay, and cannot be tested with another provider',async()=>{
  reset();settings.providers[0].baseUrl='https://api.kilo.ai/api/gateway';
  try{
    const r=await testRoute('r-kilo');expect(r.chat).toBe('ok');expect(r.summary).toContain('Kilo relay: connected, and a real Kilo Free chat request passed.');
    expect(seen.map(s=>s.path)).toEqual(['/api/gateway/models','/api/gateway/chat/completions']);expect(seen.every(s=>s.relayKey==='relay-secret')).toBe(true);
    seen.length=0;await expect(testRoute('r-kilo','opencode')).rejects.toThrow('carries Kilo only');expect(seen.length).toBe(0);
    settings.providers=[opencode];await expect(testRoute('r-kilo')).rejects.toThrow('enable that provider');
  }finally{settings.providers=[kilo(`http://127.0.0.1:${upstream.port}/api/gateway`),opencode];}
});
test('unknown or disabled providers and routes are refused before anything is sent',async()=>{
  reset();await expect(testRoute('direct','nope')).rejects.toThrow('not enabled');settings.providers[0].enabled=false;
  try{await expect(testRoute('direct','kilo')).rejects.toThrow('not enabled');}finally{settings.providers[0].enabled=true;}
  await expect(testRoute('missing','kilo')).rejects.toThrow('Route not found');await expect(testRoute('' as any)).rejects.toThrow('Say which route');expect(seen.length).toBe(0);
});

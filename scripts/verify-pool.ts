// Linux integration test: the saved proxy list + actual HTTP forwarders + mock model, no public inference traffic.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=mkdtempSync(path.join(os.tmpdir(),'polygate-pool-'));
process.env.POLYGATE_STATE=dir;process.env.POLYGATE_NO_DISCOVERY='1';process.env.POLYGATE_ADMIN_TOKEN='pool-verification';
const model=Bun.serve({hostname:'127.0.0.2',port:0,fetch(req){
  const p=new URL(req.url).pathname;
  if(p==='/trace')return new Response('ip=198.51.100.20\nloc=US\n');
  if(p.endsWith('/models'))return Response.json({data:[{id:'fixture-model'}]});
  return new Response('data: '+JSON.stringify({id:'chatcmpl-pool-fixture',choices:[{index:0,delta:{content:'Verified proxy'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
}});
process.env.POLYGATE_POOL_CATALOG_URL=`http://127.0.0.2:${model.port}/v1/models`;process.env.POLYGATE_POOL_API_URL=process.env.POLYGATE_POOL_CATALOG_URL;
const counters=[0,0],blocked=[false,false];const sockets=new Set<net.Socket>();
async function forwarder(index:number){const s=http.createServer((req,res)=>{
  const u=new URL(req.url!);if(u.pathname.endsWith('/chat/completions')){counters[index]++;if(blocked[index]){res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Fixture exit is blocked'}}));return;}}
  const out=http.request(u,{method:req.method,headers:{...req.headers,host:u.host}},reply=>{res.writeHead(reply.statusCode||502,reply.headers);reply.pipe(res);});out.on('error',()=>{res.writeHead(502);res.end();});req.pipe(out);
});s.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});s.on('connect',(req,client,head)=>{const [host,port]=req.url!.split(':');const upstream=net.connect(Number(port),host,()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());});await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));return {s,url:`http://127.0.0.1:${(s.address() as any).port}`};}
const proxies=await Promise.all([forwarder(0),forwarder(1)]);
const {startGateway}=await import('../backend/main');const {settings,db}=await import('../backend/state');settings.warp={engine:'disabled',autoStart:false,pool:1,rotateMinutes:0,helperPath:'',endpoint:''};const app=await startGateway(0);const base=`http://127.0.0.1:${app.port}`;
async function admin(endpoint:string,body?:unknown){const r=await fetch(base+endpoint,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer pool-verification',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});const b:any=await r.json();assert(r.ok,JSON.stringify(b));return b;}
async function until(check:()=>Promise<boolean>,label:string){for(let i=0;i<100;i++){if(await check())return;await Bun.sleep(150);}throw new Error('Timed out: '+label);}
try{
  await admin('/admin/providers',{...settings.providers[0],enabled:false});
  await admin('/admin/providers',{name:'Pool test fixture',kind:'openai',baseUrl:`http://127.0.0.2:${model.port}/v1`,models:[],enabled:true});await admin('/admin/discover',{});
  // Public lists never contain loopback addresses, so the fixture proxies are saved directly (the same file a scan or an import writes).
  const engine=await import('../backend/proxy-engine');const found=new Map<string,{latency:number;status:number}>();const fixtures=proxies.map(p=>{const port=Number(new URL(p.url).port);found.set(p.url,{latency:20,status:200});return {url:p.url,proxy:p.url,proto:'http' as const,host:'127.0.0.1',port};});
  engine.addVerified(fixtures,found);await until(async()=>(await admin('/admin/pool')).total===2,'saved proxies');
  await admin('/admin/pool/test',{deep:true});
  await until(async()=>{const s=await admin('/admin/pool');return !s.job.running&&s.job.phase==='done';},'deep model test');
  const ready=await admin('/admin/pool');assert.equal(ready.ready,2);assert(ready.entries.every((e:any)=>e.health.deep));
  await admin('/admin/proxy/attach',{});await admin('/admin/settings',{strategy:'round_robin'});
  const request=async()=>{const state=await admin('/admin/state');const id=state.models.find((m:any)=>m.upstreamId==='fixture-model').id;const r=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+state.settings.keys[0].value,'content-type':'application/json'},body:JSON.stringify({model:id,messages:[{role:'user',content:'Test route'}]})});const b:any=await r.json();assert.equal(r.status,200,JSON.stringify(b));assert.equal(b.choices[0].message.content,'Verified proxy');};
  counters.fill(0);await request();await request();assert(counters.every(n=>n>=1),'Both proxies must carry inference traffic');
  // Latency ordering can place either URL first. Visit a full two-route cycle before checking failure recovery.
  const beforeBlocked=counters[0];blocked[0]=true;await request();await request();assert(counters[0]>beforeBlocked,'The blocked exit must actually be attempted');const recovered=await admin('/admin/pool');assert.equal(recovered.entries.find((e:any)=>e.url===proxies[0].url).health.status,'blocked');
  console.log(JSON.stringify({ok:true,saved:2,deepReady:2,rotatedAcrossBoth:true,blockedProxyRecovered:true,upstream:'local mock'}));
}finally{await app.close();model.stop(true);for(const socket of sockets)socket.destroy();for(const p of proxies){p.s.closeAllConnections();p.s.close();}db.close();rmSync(dir,{recursive:true,force:true});}

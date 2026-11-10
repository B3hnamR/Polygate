import { afterAll, expect, test } from 'bun:test';
import { preserveTestState } from './setup';
import { db, models, saveModel, settings } from '../backend/state';
import { discover } from '../backend/providers';
import type { Model, Provider } from '../backend/types';
const restore=preserveTestState();
const bridge=require('../vendor/bridge/server.js');
let list:any[]=[{id:'current',isFree:true}],status=200;
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>Response.json({data:list},{status})});
const provider=(kind:'free'|'kilo'):Provider=>({id:'reconcile-'+kind,name:'Fixture '+kind,kind,enabled:true,baseUrl:`http://127.0.0.1:${server.port}`,apiKey:'',models:[],routeId:'direct'});
const seed=(p:Provider,id:string,extra:Partial<Model>={})=>saveModel({id:p.id+'/'+id,upstreamId:id,providerId:p.id,name:id,state:'available',context:0,output:0,reasoning:false,tools:true,latency:12,score:50,priority:7,failCount:0,cooldownUntil:0,checkedAt:1,error:'',...extra});
afterAll(()=>{server.stop(true);restore();});
async function scoped(kind:'free'|'kilo',run:(p:Provider)=>Promise<void>){
 const undo=preserveTestState(),original=bridge.discoverModels,active=bridge.__getDiscoveryState().activeModels;
 const p=provider(kind);settings.providers=[p];settings.routes=[{id:'direct',name:'Fixture',kind:'direct',url:'',enabled:true,models:[]}];settings.routeId='direct';settings.rotate=false;
 try{await run(p);}finally{bridge.discoverModels=original;bridge.__setActiveModels(active);undo();}
}
for(const kind of ['free','kilo'] as const){
 test(`${kind} successful catalog removes retired models from memory and persistence but retains surviving preferences`,async()=>scoped(kind,async p=>{
  seed(p,'old');seed(p,'current');seed({...p,id:'unrelated'},'keep');
  const inFlight=models.get(p.id+'/old')!;
  list=[{id:'current',isFree:true},{id:'new',isFree:true},{id:'paid',isFree:false}];status=200;
  if(kind==='free')bridge.discoverModels=async(options:any)=>{expect(options).toEqual({strict:true});bridge.__setActiveModels([{id:'current'},{id:'new'}]);};
  await discover();expect(models.has(p.id+'/old')).toBe(false);expect(db.query('SELECT 1 FROM models WHERE id=?').get(p.id+'/old')).toBeNull();
  expect(models.get(p.id+'/current')).toMatchObject({priority:7,state:'available',latency:12});expect(models.get(p.id+'/new')?.state).toBe('unchecked');expect(models.has(p.id+'/paid')).toBe(false);expect(models.has('unrelated/keep')).toBe(true);
  // A response completing after refresh must not resurrect a model removed by the catalog.
  inFlight.state='available';saveModel(inFlight);expect(models.has(inFlight.id)).toBe(false);expect(db.query('SELECT 1 FROM models WHERE id=?').get(inFlight.id)).toBeNull();
 }));
 test(`${kind} successful empty free catalog clears prior models without reviving configured stale IDs`,async()=>scoped(kind,async p=>{
  seed(p,'old');p.models=['old'];list=[];status=200;
  if(kind==='free')bridge.discoverModels=async()=>{bridge.__setActiveModels([]);};
  await discover();expect([...models.values()].some(m=>m.providerId===p.id)).toBe(false);
 }));
 test(`${kind} failed catalog refresh preserves previous models`,async()=>scoped(kind,async p=>{
  seed(p,'old');status=503;
  if(kind==='free')bridge.discoverModels=async()=>{throw Error('fixture catalog unavailable');};
  await expect(discover()).rejects.toThrow();expect(models.get(p.id+'/old')?.state).toBe('available');
 }));
}
test('malformed Kilo catalog does not masquerade as an authoritative empty free list',async()=>scoped('kilo',async p=>{
 seed(p,'old');list=[{id:null,isFree:true}];status=200;
 await expect(discover()).rejects.toThrow('invalid model entries');expect(models.get(p.id+'/old')?.state).toBe('available');
}));
test('a model reference held across multiple catalog generations cannot resurrect a retired entry',async()=>scoped('kilo',async p=>{
 seed(p,'current');const old=models.get(p.id+'/current')!;
 list=[{id:'current',isFree:true}];status=200;await discover();expect(models.get(old.id)).not.toBe(old);
 list=[];await discover();old.state='available';saveModel(old);
 expect(models.has(old.id)).toBe(false);expect(db.query('SELECT 1 FROM models WHERE id=?').get(old.id)).toBeNull();
 list=[{id:'current',isFree:true}];await discover();expect(models.get(old.id)?.state).toBe('unchecked');
}));

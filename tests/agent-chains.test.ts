import {test,expect} from 'bun:test';
import {agentChains} from '../backend/agent-chains';
import {models,settings} from '../backend/state';
test('Agent chains use conservative limits and exclude disabled or non-tool members',()=>{
  const old={providers:settings.providers,chains:settings.chains,keys:settings.keys};const saved=new Map(models);
  try{
    settings.providers=[{id:'fixture',name:'Fixture',kind:'openai',enabled:true} as any];settings.keys=[];models.clear();
    for(const [id,context,output,tools] of [['one',128000,8000,true],['two',64000,4000,true],['text',200000,16000,false]] as const)models.set(id,{id,providerId:'fixture',upstreamId:id,name:id,context,output,tools,state:'available',score:50} as any);
    settings.chains=[{id:'chain',name:'mychain',models:['one','two','text'],enabled:true,created:1}];
    expect(agentChains()[0]).toMatchObject({id:'mychain',provider:'Model chains',context:64000,output:4000,usable:true,efforts:[]});
    settings.keys=[{id:'agent',agent:true,models:['one'],enabled:true} as any];expect(agentChains()[0].context).toBe(128000);
    settings.chains[0].enabled=false;expect(agentChains()).toEqual([]);
  }finally{settings.providers=old.providers;settings.chains=old.chains;settings.keys=old.keys;models.clear();for(const [k,v]of saved)models.set(k,v);}
});

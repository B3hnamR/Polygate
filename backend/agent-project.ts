import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,mkdirSync,readFileSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {enginePaths} from './agent-engine';
import {inspectTrust} from './agent-trust';
import {writeFileAtomic} from './state';

export type ProjectTemplate={id:string;kind:'command'|'skill';name:string;text:string};
export type ProjectPreferences={instructions:string;templates:ProjectTemplate[];revision:string};
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const fileFor=(folder:string,root=enginePaths().root)=>path.join(root,'projects',digest(realpathSync(folder).replace(/\\/g,'/').toLowerCase())+'.json');
export function projectPreferences(folder:string,root?:string):ProjectPreferences{
  try{const p=JSON.parse(readFileSync(fileFor(folder,root),'utf8'));return {...p,revision:digest(JSON.stringify([p.instructions,p.templates]))};}
  catch(e:any){if(e.code!=='ENOENT')throw new Error('Project preferences could not be read. Do not overwrite them until the file is repaired.');return {instructions:'',templates:[],revision:digest(JSON.stringify(['',[]]))};}
}
export function saveProjectPreferences(folder:string,input:any,root?:string){
  const current=projectPreferences(folder,root);
  if(input.revision!==current.revision)throw new Error('Project preferences changed. Refresh before saving again.');
  if(typeof input.instructions!=='string'||Buffer.byteLength(input.instructions)>32000||input.instructions.includes('\0'))throw new Error('Instructions must be text of up to 32,000 bytes.');
  if(!Array.isArray(input.templates)||input.templates.length>50)throw new Error('Save up to 50 commands and skills.');
  const seen=new Set<string>();let bytes=Buffer.byteLength(input.instructions);
  const templates:ProjectTemplate[]=input.templates.map((t:any)=>{
    if(!['command','skill'].includes(t?.kind)||typeof t.name!=='string'||!t.name.trim()||t.name.length>80||/[\x00-\x1f]/.test(t.name)||typeof t.text!=='string'||!t.text.trim()||Buffer.byteLength(t.text)>32000||t.text.includes('\0'))throw new Error('Each command or skill needs a name and text (up to 32,000 bytes).');
    const key=t.kind+':'+t.name.trim().toLowerCase();if(seen.has(key))throw new Error('Command and skill names must be unique within their kind.');seen.add(key);bytes+=Buffer.byteLength(t.text);
    return {id:typeof t.id==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(t.id)?t.id:randomUUID(),kind:t.kind,name:t.name.trim(),text:t.text};
  });
  if(bytes>128000)throw new Error('Project text must total 128,000 bytes or less.');
  const file=fileFor(folder,root);mkdirSync(path.dirname(file),{recursive:true});writeFileAtomic(file,JSON.stringify({instructions:input.instructions,templates}));
  return projectPreferences(folder,root);
}
export function projectSources(folder:string){
  return inspectTrust(folder).files.filter(f=>f.bytes<=32000&&(/(?:^|\/)(AGENTS|CLAUDE)\.md$/i.test(f.path)||/(?:^|\/)(commands?\/.*\.md|skills\/.*\/SKILL\.md)$/i.test(f.path))).map(f=>({path:f.path,hash:f.hash,bytes:f.bytes}));
}
export function readProjectSource(folder:string,relative:string,hash:string){
  const source=projectSources(folder).find(f=>f.path===relative&&f.hash===hash);if(!source)throw new Error('This source changed or is not in the reviewed project inventory. Refresh and review it again.');
  const full=path.resolve(folder,relative);
  // Recheck path components immediately before reading, not just during the earlier inventory.
  for(let current=full;;current=path.dirname(current)){
    if(lstatSync(current).isSymbolicLink())throw new Error('Linked project sources are not imported.');
    if(current===path.dirname(current))break;
  }
  const text=readFileSync(full,'utf8');if(Buffer.byteLength(text)>32000||digest(text)!==hash||text.includes('\0'))throw new Error('Project source changed or is not valid text. Refresh and review it again.');
  return {path:relative,text};
}

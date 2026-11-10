import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {BUILTIN_ENGINE_SKILLS,enginePaths,isBuiltinEngineSkill} from './agent-engine';
import {writeFileAtomic} from './state';

// Polygate's own Agent library, for every working folder: a system prompt applied before each message, and skills. Each skill is
// written as <id>/SKILL.md in a folder only Polygate writes; the engine's configuration points there, so the agent sees the skills it
// may load by itself (those with auto on), and the user can attach any of them to a message.
export type LibrarySkill={id:string;name:string;description:string;text:string;auto:boolean};
export type AgentLibrary={instructions:string;skills:LibrarySkill[];revision:string};
// Built-in skills use engine-owned URIs, not arbitrary files named after a built-in.
export const BUILTIN_SKILLS:readonly string[]=BUILTIN_ENGINE_SKILLS;
export const isBuiltinSkill=isBuiltinEngineSkill;
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const fileFor=(root=enginePaths().root)=>path.join(root,'library.json');
export const skillsDir=(root=enginePaths().root)=>path.join(root,'skills');
export const skillId=(name:string,taken:Set<string>)=>{
  const base=name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,48)||'skill';
  let id=base;for(let n=2;taken.has(id)||BUILTIN_SKILLS.includes(id);n++)id=`${base}-${n}`;return id;
};
export function agentLibrary(root?:string):AgentLibrary{
  try{const p=JSON.parse(readFileSync(fileFor(root),'utf8'));return {instructions:p.instructions,skills:p.skills,revision:digest(JSON.stringify([p.instructions,p.skills]))};}
  catch(e:any){if(e.code!=='ENOENT')throw new Error('The Agent library could not be read. Do not overwrite it until the file is repaired.');return {instructions:'',skills:[],revision:digest(JSON.stringify(['',[]]))};}
}
export function saveAgentLibrary(input:any,root?:string){
  const current=agentLibrary(root);
  if(input.revision!==current.revision)throw new Error('The Agent library changed. Refresh before saving again.');
  if(typeof input.instructions!=='string'||Buffer.byteLength(input.instructions)>32000||input.instructions.includes('\0'))throw new Error('The system prompt must be text of up to 32,000 bytes.');
  if(!Array.isArray(input.skills)||input.skills.length>50)throw new Error('Save up to 50 skills.');
  const ids=new Set<string>(),names=new Set<string>();let bytes=Buffer.byteLength(input.instructions);
  // A saved skill keeps its ID through renames; a new one gets an ID from its name.
  for(const s of input.skills)if(typeof s?.id==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(s.id)&&!BUILTIN_SKILLS.includes(s.id)&&current.skills.some(c=>c.id===s.id))ids.add(s.id);
  const kept=new Set<string>();
  const skills:LibrarySkill[]=input.skills.map((s:any)=>{
    const text=(v:unknown,max:number)=>typeof v==='string'&&!!v.trim()&&Buffer.byteLength(v)<=max&&!v.includes('\0');
    if(!text(s?.name,240)||s.name.length>80||/[\x00-\x1f]/.test(s.name))throw new Error('Each skill needs a name of up to 80 characters.');
    if(!text(s.description,1024)||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s.description))throw new Error(`Describe when to use the skill “${s.name.trim()}” (up to 1,024 bytes). The agent decides from this description.`);
    if(!text(s.text,32000))throw new Error(`The skill “${s.name.trim()}” needs instructions of up to 32,000 bytes.`);
    const name=s.name.trim();if(names.has(name.toLowerCase()))throw new Error('Skill names must be unique.');names.add(name.toLowerCase());
    bytes+=Buffer.byteLength(s.text)+Buffer.byteLength(s.description);
    const id=ids.has(s.id)&&!kept.has(s.id)?s.id:skillId(name,new Set([...ids,...kept]));kept.add(id);
    return {id,name,description:s.description.trim(),text:s.text,auto:s.auto!==false};
  });
  if(bytes>256000)throw new Error('The system prompt and skills must total 256,000 bytes or less.');
  const file=fileFor(root);mkdirSync(path.dirname(file),{recursive:true});writeFileAtomic(file,JSON.stringify({instructions:input.instructions,skills}));
  syncSkills(skills,root);
  return agentLibrary(root);
}
// The SKILL.md the engine reads. JSON strings are valid YAML double-quoted scalars, so no name or description can break the header.
export const skillFile=(s:LibrarySkill)=>['---',`name: ${JSON.stringify(s.name)}`,`description: ${JSON.stringify(s.description)}`,...(s.auto?[]:['disable-model-invocation: true']),'---','',s.text,''].join('\n');
// Makes the skills folder hold exactly the saved skills: anything else in it (added or changed outside Polygate) goes.
export function syncSkills(skills=agentLibrary().skills,root?:string){
  const dir=skillsDir(root);mkdirSync(dir,{recursive:true});
  for(const name of readdirSync(dir))if(!skills.some(s=>s.id===name))rmSync(path.join(dir,name),{recursive:true,force:true});
  for(const s of skills){
    const folder=path.join(dir,s.id),file=path.join(folder,'SKILL.md'),want=skillFile(s);
    mkdirSync(folder,{recursive:true});
    for(const name of readdirSync(folder))if(name!=='SKILL.md')rmSync(path.join(folder,name),{recursive:true,force:true});
    let now='';try{now=readFileSync(file,'utf8');}catch{}
    if(now!==want)writeFileAtomic(file,want);
  }
}
// Whether the engine's list of skills is exactly the engine's own plus the saved ones, as saved. `listed` is the engine's answer.
export function skillProblems(listed:any[],skills=agentLibrary().skills,root?:string){
  const dir=path.resolve(skillsDir(root)).toLowerCase(),problems:string[]=[];
  for(const k of listed){
    const at=path.resolve(String(k?.path||'')).toLowerCase();
    if(isBuiltinSkill(k))continue;
    const saved=skills.find(s=>s.id===k?.id);
    if(!at.startsWith(dir+path.sep))problems.push(`it offers the skill ${k?.id} from ${k?.path}, outside Polygate's skills`);
    else if(!saved||at!==path.join(dir,saved.id,'skill.md')||k.name!==saved.name||k.description!==saved.description||String(k.content||'').trim()!==saved.text.trim()||(k.autoinvoke===false)!==!saved.auto)problems.push(`its skill ${k?.id} is not the one saved in Polygate`);
  }
  for(const s of skills)if(!listed.some(k=>k?.id===s.id))problems.push(`it has not loaded the skill ${s.id}`);
  return problems;
}

import {spawn,spawnSync,type ChildProcess} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import path from 'node:path';
import {realpathSync} from 'node:fs';
import {chooseShell} from './agent-engine';
import {redactError} from './state';

type Terminal={folder:string;command:string;output:string;running:boolean;started:number;ended?:number;exitCode?:number|null;truncated:boolean;process?:ChildProcess};
const terminals=new Map<string,Terminal>();
const canonical=(folder:string)=>{try{folder=realpathSync(folder);}catch{}return process.platform==='win32'?path.resolve(folder).toLowerCase():path.resolve(folder);};
export const terminalInFolder=(folder:string)=>[...terminals.values()].some(t=>t.running&&canonical(t.folder)===canonical(folder));
export const terminalState=(id:string)=>{const t=terminals.get(id);if(!t)return null;const {process,...state}=t;return state;};
export function startTerminal(id:string,folder:string,command:string){
  if(terminalInFolder(folder))throw new Error('This folder already has a running terminal command. Stop it or wait for it to finish.');
  if(!command.trim()||command.length>20000||command.includes('\0'))throw new Error('Enter a command of up to 20,000 characters.');
  if([...terminals.values()].filter(t=>t.running).length>=4)throw new Error('Four terminal commands are already running. Stop one first.');
  if(terminals.size>=100)for(const [key,t] of terminals)if(!t.running){terminals.delete(key);break;}
  const t:Terminal={folder,command,output:'',running:true,started:Date.now(),truncated:false};terminals.set(id,t);
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^POLYGATE_|^OPENCODE_|(?:TOKEN|PASSWORD|SECRET|API_KEY)/i.test(k)));
  const windows=process.platform==='win32';
  const proc=spawn(windows?chooseShell():Bun.which('sh')||'/bin/sh',windows?['-NoLogo','-NoProfile','-NonInteractive','-Command',command]:['-c',command],{cwd:folder,env,windowsHide:true,detached:!windows,stdio:['ignore','pipe','pipe']});t.process=proc;
  const append=(text:string)=>{t.output+=redactError(text,text.length+1000);if(t.output.length>200000){t.output=t.output.slice(-200000);t.truncated=true;}};
  for(const stream of [proc.stdout,proc.stderr]){const decoder=new StringDecoder('utf8');stream?.on('data',chunk=>append(decoder.write(chunk)));stream?.on('end',()=>append(decoder.end()));}
  proc.once('error',e=>{append(`\nCould not start command: ${e.message}`);t.running=false;t.ended=Date.now();});
  proc.once('close',code=>{t.running=false;t.exitCode=code;t.ended=Date.now();t.process=undefined;});
  return terminalState(id);
}
export function stopTerminal(id:string){
  const t=terminals.get(id),proc=t?.process;if(!proc||!t?.running)return terminalState(id);
  if(process.platform==='win32'&&proc.pid)spawnSync(path.join(process.env.SystemRoot||'C:\\Windows','System32/taskkill.exe'),['/pid',String(proc.pid),'/T','/F'],{windowsHide:true,timeout:5000,stdio:'ignore'});
  else if(proc.pid)try{process.kill(-proc.pid,'SIGKILL');}catch{proc.kill('SIGKILL');}
  return terminalState(id);
}
export function clearTerminal(id:string){if(terminals.get(id)?.running)throw new Error('Stop the terminal command before clearing its output.');terminals.delete(id);}
export function stopAllTerminals(){for(const id of terminals.keys())stopTerminal(id);}

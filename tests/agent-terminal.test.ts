import {afterAll,expect,test} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {clearTerminal,startTerminal,stopAllTerminals,stopTerminal,terminalState} from '../backend/agent-terminal';
const folder=mkdtempSync(path.join(tmpdir(),'pg-terminal-'));
afterAll(()=>{stopAllTerminals();rmSync(folder,{recursive:true,force:true});});
const wait=async(id:string)=>{const end=Date.now()+15000;while(terminalState(id)?.running){if(Date.now()>end)throw Error('Terminal test timed out');await Bun.sleep(30);}return terminalState(id)!;};
let fixture=0;
const command=(js:string)=>{
  const file=path.join(folder,`command-${++fixture}.js`);writeFileSync(file,js);
  // Windows PowerShell's native argument binder removes embedded quotes in -e;
  // a real script file tests terminal behavior without depending on that binder.
  return process.platform==='win32'?`& '${process.execPath.replace(/'/g,"''")}' '${file.replace(/'/g,"''")}'`:`'${process.execPath}' '${file.replace(/'/g,"'\\''")}'`;
};

test('terminal runs in its folder, collects both streams and exit code without exposing gateway credentials',async()=>{
  const old=process.env.PROVIDER_API_KEY;process.env.PROVIDER_API_KEY='not-for-child';
  try{
    startTerminal('output',folder,command('console.log(process.cwd()); console.error("stderr-text"); console.log(JSON.stringify({admin:!!process.env.POLYGATE_ADMIN_TOKEN,provider:!!process.env.PROVIDER_API_KEY})); process.exit(3)'));
    const t=await wait('output');expect(t.output).toContain(folder);expect(t.output).toContain('stderr-text');expect(t.output).toContain('"admin":false');expect(t.output).toContain('"provider":false');expect(t.exitCode).toBe(process.platform==='win32'?1:3);
    clearTerminal('output');expect(terminalState('output')).toBeNull();
  }finally{if(old===undefined)delete process.env.PROVIDER_API_KEY;else process.env.PROVIDER_API_KEY=old;}
});
test('running commands survive observers closing, cannot be replaced or cleared, and Stop kills their process tree',async()=>{
  startTerminal('long',folder,command('console.log("started");setInterval(()=>{},1000)'));
  expect(()=>startTerminal('long',folder,'echo replacement')).toThrow(/already/);expect(()=>clearTerminal('long')).toThrow(/Stop/);
  await Bun.sleep(500);expect(terminalState('long')?.running).toBe(true);stopTerminal('long');expect((await wait('long')).running).toBe(false);
});
test('terminal output is bounded and commands are validated',async()=>{
  expect(()=>startTerminal('bad',folder,'')).toThrow(/Enter/);
  startTerminal('large',folder,command('console.log("x".repeat(250000))'));
  const t=await wait('large');expect(t.truncated).toBe(true);expect(t.output.length).toBeLessThanOrEqual(200000);
});

import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createElement,Fragment} from 'react';

const deferred=()=>{let resolve!:(value:any)=>void,reject!:(error:Error)=>void;const promise=new Promise<any>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const nodes=(tree:any):any[]=>Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==='object'?[tree,...nodes(tree.props?.children)]:[];
const text=(tree:any):string=>Array.isArray(tree)?tree.map(text).join(''):tree&&typeof tree==='object'?text(tree.props?.children):typeof tree==='string'?tree:'';

// Execute the real component and event handlers with persistent hook slots, not a
// second implementation of its state transitions. No DOM, gateway or network.
function harness(needsPassword=false){
  const slots:any[]=[],effects:(()=>void)[]=[];let at=0,tree:any,writes=0;
  const useState=(initial:any)=>{const i=at++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],(value:any)=>{writes++;slots[i]=typeof value==='function'?value(slots[i]):value;}];};
  const useRef=(value:any)=>{const i=at++;return slots[i]??(slots[i]={current:value});};
  const useEffect=(fn:()=>any,deps:any[])=>{const i=at++,old=slots[i];if(!old||deps.some((d,n)=>!Object.is(d,old.deps[n]))){slots[i]={deps,cleanup:old?.cleanup};effects.push(()=>{old?.cleanup?.();slots[i].cleanup=fn();});}};
  const requests:{path:string;body:any;pending:ReturnType<typeof deferred>}[]=[],notices:string[]=[];let refreshes=0;
  const bindings={createElement,Fragment,useState,useRef,useEffect,api:(path:string,body:any)=>{const pending=deferred();requests.push({path,body,pending});return pending.promise;},Button:'button',Field:'label',ApplyTag:'span',Download:()=>null,TriangleAlert:()=>null,Upload:()=>null};
  const source=readFileSync(new URL('../src/backup.tsx',import.meta.url),'utf8').split('\n').filter(l=>!l.startsWith('import ')).join('\n').replace('export function','function');
  const transpiler=new Bun.Transpiler({loader:'tsx',tsconfig:{compilerOptions:{jsx:'react',jsxFactory:'createElement',jsxFragmentFactory:'Fragment'}}});
  const Component=new Function(...Object.keys(bindings),transpiler.transformSync(source)+'\nreturn BackupPanel;')(...Object.values(bindings));
  const render=()=>{at=0;tree=Component({needsPassword,notice:(s:string)=>notices.push(s),refresh:()=>refreshes++});for(const node of nodes(tree))if(node.type==='input'&&node.props.type==='file'&&!node.props.ref.current)node.props.ref.current={value:'chosen'};while(effects.length)effects.shift()!();return tree;};
  const all=(predicate:(node:any)=>boolean)=>nodes(tree).filter(predicate);
  const forms=()=>all(n=>n.type==='form');
  const field=(label:string,form?:number)=>nodes(form===undefined?tree:forms()[form]).find(n=>n.type==='label'&&n.props.label===label)?.props.children;
  render();
  return {render,requests,notices,refreshes:()=>refreshes,writes:()=>writes,field,
    select:(file?:any)=>{field('Backup file').props.onChange({target:{files:file?[file]:[]}});render();},
    change:(label:string,value:string,form?:number)=>{field(label,form).props.onChange({target:{value}});render();},
    sure:()=>all(n=>n.props.id==='restore-sure')[0],
    confirm:()=>{all(n=>n.props.id==='restore-sure')[0].props.onChange({target:{checked:true}});render();},
    submit:()=>forms()[1].props.onSubmit({preventDefault(){}}),
    submitHandler:()=>forms()[1].props.onSubmit,
    restore:()=>all(n=>n.type==='button'&&text(n).includes('Restor'))[0],
    content:()=>text(tree),
    unmount:()=>{for(const s of slots)s?.cleanup?.();},
  };
}
const file=(name:string,pending=deferred(),size=10)=>({name,size,text:()=>pending.promise,pending});
const restored={providers:1,routes:2,keys:3};

test('backup selection invalidates old content, passphrase and confirmation; latest read wins',async()=>{
  const h=harness(),a=file('A'),b=file('B');h.select(a);a.pending.resolve('A bytes');await flush();h.render();
  h.change('Passphrase','secret',1);h.confirm();expect(h.restore().props.disabled).toBe(false);
  h.select(b);expect(h.restore().props.disabled).toBe(true);expect(h.sure().props.checked).toBe(false);expect(h.field('Passphrase',1).props.value).toBe('');expect(h.content()).toContain('Reading backup file');
  h.submit();expect(h.requests).toHaveLength(0);
  b.pending.resolve('B bytes');await flush();h.render();h.change('Passphrase','B secret',1);h.confirm();h.submit();h.submit();
  expect(h.requests).toHaveLength(1);expect(h.requests[0].body).toEqual({content:'B bytes',passphrase:'B secret'});
});

test('backup stale successes, errors and finalizers cannot replace the current selection',async()=>{
  const h=harness(),a=file('A'),b=file('B');h.select(a);h.select(b);a.pending.reject(new Error('obsolete error'));await flush();h.render();
  expect(h.content()).not.toContain('obsolete error');expect(h.content()).toContain('Reading backup file');
  b.pending.resolve('B');await flush();h.render();
  const c=file('C'),d=file('D');h.select(c);h.select(d);d.pending.resolve('D');await flush();c.pending.resolve('C');await flush();h.render();
  h.change('Passphrase','secret',1);h.confirm();h.submit();expect(h.requests[0].body.content).toBe('D');
});

test('backup clearing, oversized files, read errors and unmount invalidate pending reads',async()=>{
  const h=harness(),a=file('A');h.select(a);h.select();a.pending.resolve('A');await flush();h.render();expect(h.restore().props.disabled).toBe(true);
  const b=file('B');h.select(b);h.select(file('huge',deferred(),17*1024*1024));b.pending.resolve('B');await flush();h.render();
  expect(h.content()).toContain('too large');expect(h.sure().props.checked).toBe(false);expect(h.restore().props.disabled).toBe(true);
  const c=file('C');h.select(c);c.pending.reject(new Error('read failed'));await flush();h.render();expect(h.content()).toContain('read failed');expect(h.content()).not.toContain('Reading backup file');
  const d=file('D');h.select(d);h.unmount();const writes=h.writes();d.pending.resolve('D');await flush();expect(h.writes()).toBe(writes);
});

test('backup restore guards dashboard password and stale rendered submit handlers',async()=>{
  const h=harness(true),a=file('A');h.select(a);a.pending.resolve('A');await flush();h.render();h.change('Passphrase','secret',1);h.confirm();h.submit();expect(h.requests).toHaveLength(0);
  h.change('Dashboard password','dashboard');h.submit();expect(h.requests[0].body.password).toBe('dashboard');
  const other=harness(),b=file('B');other.select(b);b.pending.resolve('B');await flush();other.render();other.change('Passphrase','secret',1);other.confirm();const oldSubmit=other.submitHandler();other.select(file('C'));oldSubmit({preventDefault(){}});expect(other.requests).toHaveLength(0);
});

test('restore completion never clears a newer file and retains the restart warning',async()=>{
  const h=harness(),a=file('A'),b=file('B');h.select(a);a.pending.resolve('A');await flush();h.render();h.change('Passphrase','secret',1);h.confirm();h.submit();h.render();
  h.select(b);b.pending.resolve('B');await flush();h.render();h.requests[0].pending.resolve(restored);await flush();h.render();
  expect(h.field('Backup file').props.ref.current.value).toBe('chosen');expect(h.content()).toContain('Restart Polygate now');expect(h.refreshes()).toBe(1);expect(h.notices).toHaveLength(1);
  h.change('Passphrase','new secret',1);h.confirm();h.submit();expect(h.requests[1].body.content).toBe('B');
  h.requests[1].pending.resolve(restored);await flush();h.render();expect(h.field('Backup file').props.ref.current.value).toBe('');expect(h.restore().props.disabled).toBe(true);
});

test('a failed restore identifies the submitted file and leaves the newer file ready for confirmation',async()=>{
  const h=harness(),a=file('A.pgbackup'),b=file('B.pgbackup');h.select(a);a.pending.resolve('A');await flush();h.render();h.change('Passphrase','secret',1);h.confirm();h.submit();h.render();
  h.select(b);b.pending.resolve('B');await flush();h.requests[0].pending.reject(new Error('wrong passphrase'));await flush();h.render();
  expect(h.content()).toContain('Could not restore A.pgbackup: wrong passphrase');expect(h.sure().props.checked).toBe(false);expect(h.field('Passphrase',1).props.value).toBe('');
  h.change('Passphrase','new secret',1);h.confirm();h.submit();h.render();expect(h.requests[1].body.content).toBe('B');expect(h.content()).not.toContain('wrong passphrase');
});

test('a restore failure and the new file read error are both visible',async()=>{
  const h=harness(),a=file('A'),b=file('B');h.select(a);a.pending.resolve('A');await flush();h.render();h.change('Passphrase','secret',1);h.confirm();h.submit();h.render();
  h.select(b);b.pending.reject(new Error('new read failed'));await flush();h.requests[0].pending.reject(new Error('old restore failed'));await flush();h.render();
  expect(h.content()).toContain('new read failed');expect(h.content()).toContain('Could not restore A: old restore failed');
});

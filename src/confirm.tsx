import {useCallback,useState,type ReactNode} from 'react';
import {Trash2} from 'lucide-react';
import {Dialog} from './mcp';
import {Button} from './ui';

// A confirmation inside the app, in place of the browser's own box: `const {confirm, dialog} = useConfirm()`, render `{dialog}` once,
// and `if (await confirm(<>Delete it?</>, {title: 'Delete', confirm: 'Delete'})) …` where the browser's confirm() was. The icon is a bin unless
// another is given (`icon`), for a confirmation that deletes nothing.
type Ask={message:ReactNode;title:string;confirm:string;icon?:ReactNode;resolve:(answer:boolean)=>void};
export function useConfirm(){
  const [ask,setAsk]=useState<Ask|null>(null);
  const confirm=useCallback((message:ReactNode,options:{title?:string;confirm?:string;icon?:ReactNode}={})=>new Promise<boolean>(resolve=>setAsk({message,title:options.title||'Are you sure?',confirm:options.confirm||'Delete',icon:options.icon,resolve})),[]);
  const answer=(value:boolean)=>{ask?.resolve(value);setAsk(null);};
  const dialog=ask?<Dialog title={ask.title} icon={ask.icon||<Trash2 size={18}/>} onClose={()=>answer(false)}>
    <p>{ask.message}</p>
    {/* Focus starts on Cancel, so Enter on a confirmation never deletes by accident; Tab reaches the action, Escape closes. */}
    <div className="dialog-actions"><button type="button" className="button" data-autofocus onClick={()=>answer(false)}>Cancel</button><Button variant="primary" onClick={()=>answer(true)}>{ask.confirm}</Button></div>
  </Dialog>:null;
  return {confirm,dialog};
}

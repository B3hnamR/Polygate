import {useCallback,useState,type ReactNode} from 'react';
import {Trash2} from 'lucide-react';
import {Dialog} from './mcp';
import {Button} from './ui';

// A confirmation inside the app, in place of the browser's own box: `const {confirm, dialog} = useConfirm()`, render `{dialog}` once,
// and `if (await confirm(<>Delete it?</>, {title: 'Delete', confirm: 'Delete'})) …` where the browser's confirm() was.
type Ask={message:ReactNode;title:string;confirm:string;resolve:(answer:boolean)=>void};
export function useConfirm(){
  const [ask,setAsk]=useState<Ask|null>(null);
  const confirm=useCallback((message:ReactNode,options:{title?:string;confirm?:string}={})=>new Promise<boolean>(resolve=>setAsk({message,title:options.title||'Are you sure?',confirm:options.confirm||'Delete',resolve})),[]);
  const answer=(value:boolean)=>{ask?.resolve(value);setAsk(null);};
  const dialog=ask?<Dialog title={ask.title} icon={<Trash2 size={18}/>} onClose={()=>answer(false)}>
    <p>{ask.message}</p>
    <div className="dialog-actions"><Button onClick={()=>answer(false)}>Cancel</Button><Button variant="primary" onClick={()=>answer(true)}>{ask.confirm}</Button></div>
  </Dialog>:null;
  return {confirm,dialog};
}

import {useEffect,useRef,useState,type KeyboardEvent} from 'react';
import {ArrowLeft,ArrowRight,Check,MessageCircleQuestion,Send,X} from 'lucide-react';
import {api} from './api';
import {usePoll} from './ui';
import {formActive,formAnswer,formReady,formChoice,splitRecommended,type FormField} from './agent-logic';
// Questions the agent asks (the engine's question tool, or any form it opens): one question at a time, with a tab per question.
// Choices are cards to click; one choice moves on by itself, several are ticked, and "Other" takes a typed answer when the question allows it.
type Form={id:string;title:string;fields:FormField[]};
export function AgentForms({id}:{id:string}){
 const {data,error,reload}=usePoll<{forms:Form[]}>('/admin/agent/session/forms?id='+encodeURIComponent(id),1500);
 return <>{error&&<p className="pg-error" role="alert">Questions could not be loaded: {error}</p>}{data?.forms?.map(f=><Question key={f.id} session={id} form={f} onDone={reload}/>)}</>;
}
function Question({session,form,onDone}:{session:string;form:Form;onDone:()=>void}){
 const [values,setValues]=useState<Record<string,any>>(()=>Object.fromEntries(form.fields.filter(f=>f.default!==undefined).map(f=>[f.key,f.default]))),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [step,setStep]=useState(0),[other,setOther]=useState<Record<string,string>>({}),[otherOn,setOtherOn]=useState<Record<string,boolean>>({});
 const shown=form.fields.filter(f=>formActive(f,values)&&!f.hidden);const at=Math.min(step,Math.max(0,shown.length-1));const field=shown[at];const last=at>=shown.length-1;
 const card=useRef<HTMLFormElement>(null);
 const set=(key:string,value:any)=>setValues(v=>({...v,[key]:value}));
 const next=()=>setStep(s=>Math.min(s+1,shown.length-1));
 const send=async(cancel=false)=>{setBusy(true);setError('');try{await api('/admin/agent/session/form',{id:session,form:form.id,...(cancel?{cancel:true}:{answer:formAnswer(form.fields,values)})});onDone();}catch(e:any){setError(e.message);}finally{setBusy(false);}};
 const external=form.fields.some(f=>formActive(f,values)&&f.type==='external');const ready=formReady(form.fields,values)&&!external;
 useEffect(()=>{card.current?.querySelector<HTMLElement>('.ag-q-option[aria-checked="true"],.ag-q-option,input,textarea')?.focus({preventScroll:true});},[at]);
 if(!field)return null;
 const answered=(f:FormField)=>{const v=values[f.key];return Array.isArray(v)?v.length>0:v!==undefined&&v!=='';};
 // 1-9 picks a choice, unless a text box has the keyboard.
 const keys=(e:KeyboardEvent)=>{if(/^(INPUT|TEXTAREA)$/.test((e.target as HTMLElement).tagName)||e.ctrlKey||e.metaKey||e.altKey)return;const n=Number(e.key);if(n>=1&&n<=9){const b=card.current?.querySelectorAll<HTMLButtonElement>('.ag-q-options > .ag-q-option')[n-1];if(b){e.preventDefault();b.click();}}};
 return <form ref={card} className="ag-q" aria-label="Question from the agent" onKeyDown={keys} onSubmit={e=>{e.preventDefault();if(last){if(ready)void send();}else next();}}>
  <header className="ag-q-head"><MessageCircleQuestion size={16}/><span>{shown.length>1?`The agent has ${shown.length} questions`:'The agent is asking'}</span>
   <button type="button" className="icon-button" aria-label="Dismiss question" title="Dismiss: the agent is told you did not answer" disabled={busy} onClick={()=>send(true)}><X size={14}/></button></header>
  {shown.length>1&&<nav className="ag-q-tabs" aria-label="Questions">{shown.map((f,i)=><button type="button" key={f.key} aria-current={i===at?'step':undefined} className={answered(f)?'done':undefined} onClick={()=>setStep(i)}>{answered(f)&&<Check size={12}/>}<span dir="auto">{f.title||`Question ${i+1}`}</span></button>)}</nav>}
  <div className="ag-q-body">
   {shown.length<=1&&field.title&&<span className="ag-q-chip" dir="auto">{field.title}</span>}
   <p className="ag-q-text" dir="auto">{field.description||field.title||'Answer the question'}{field.required&&<em> (required)</em>}</p>
   <Answer key={field.key} field={field} value={values[field.key]} set={v=>set(field.key,v)} other={other[field.key]||''} otherOn={!!otherOn[field.key]}
     setOther={t=>{setOther(o=>({...o,[field.key]:t}));}} setOtherOn={on=>setOtherOn(o=>({...o,[field.key]:on}))} onChosen={()=>{if(!last)setTimeout(next,160);}}/>
  </div>
  <footer className="ag-q-foot">
   {shown.length>1&&<span className="ag-q-count">{at+1} of {shown.length}</span>}
   <span className="toolbar-spacer"/>
   {at>0&&<button type="button" className="button" disabled={busy} onClick={()=>setStep(at-1)}><ArrowLeft size={14}/>Back</button>}
   {!last&&<button type="submit" className="button" disabled={busy}>{answered(field)?'Next':'Skip'}<ArrowRight size={14}/></button>}
   {last&&<button type="submit" className="button primary" disabled={busy||!ready} title={ready?undefined:external?'This question needs your trusted client':'Answer the required questions first'}><Send size={14}/>{busy?'Sending…':'Send answers'}</button>}
  </footer>
  {external&&<p className="subtle ag-q-note">One question asks for an outside interaction. Polygate does not open it: answer it in a client you trust, or dismiss the question.</p>}
  {error&&<p className="pg-error" role="alert">{error}</p>}
 </form>;
}
// The answer area for one question. A typed "Other" answer replaces the choice (one) or joins the ticked ones (several).
function Answer({field:f,value,set,other,otherOn,setOther,setOtherOn,onChosen}:{field:FormField;value:any;set:(v:any)=>void;other:string;otherOn:boolean;setOther:(t:string)=>void;setOtherOn:(on:boolean)=>void;onChosen:()=>void}){
 if(f.type==='external')return <p className="subtle">An outside interaction was requested. No link is opened automatically.</p>;
 const options=f.type==='boolean'?[{value:'true',label:'Yes'},{value:'false',label:'No'}]:f.options||[];
 if(!options.length)return <input className="ag-q-input" dir="auto" aria-label={f.title||f.key} placeholder={f.placeholder||'Type your answer'} required={f.required} type={f.type==='number'||f.type==='integer'?'number':'text'} step={f.type==='integer'?1:'any'} min={f.minimum} max={f.maximum} minLength={f.minLength} maxLength={f.maxLength} pattern={f.pattern} value={value??''} onChange={e=>set(e.target.value===''?undefined:f.type==='number'||f.type==='integer'?Number(e.target.value):e.target.value)}/>;
 const many=f.type==='multiselect';const list:string[]=many?(Array.isArray(value)?value:[]):[];
 const known=new Set(options.map(o=>o.value));
 const typed=many?list.filter(v=>!known.has(v)).join(', '):value!==undefined&&!known.has(String(value))&&f.type!=='boolean'?String(value):'';
  const choose=(v:string)=>{
   const next=formChoice(f,value,v);set(next.value);
   if(!many){setOther(next.other!);setOtherOn(next.otherOn!);onChosen();}
 };
 const typeOther=(t:string)=>{setOther(t);const clean=t.trim();if(many)set([...list.filter(v=>known.has(v)),...(clean?[clean]:[])]);else set(clean||undefined);};
 const checked=(v:string)=>many?list.includes(v):f.type==='boolean'?value===(v==='true'):value===v&&!otherOn;
 const showOther=otherOn||!!typed;
 return <div className="ag-q-options" role={many?'group':'radiogroup'} aria-label={f.title||f.key}>
  {options.map((o,i)=>{const {label,recommended}=splitRecommended(o.label);return <button type="button" key={o.value} role={many?'checkbox':'radio'} aria-checked={checked(o.value)} className="ag-q-option" onClick={()=>choose(o.value)}>
   <span className={`ag-q-mark ${many?'box':'dot'}`}>{checked(o.value)&&<Check size={11}/>}</span>
   <span className="ag-q-label"><strong dir="auto">{label}</strong>{recommended&&<span className="ag-q-rec">Recommended</span>}{o.description&&<small dir="auto">{o.description}</small>}</span>
   <kbd>{i+1}</kbd>
  </button>;})}
  {f.custom&&f.type!=='boolean'&&<div className={`ag-q-other${showOther?' open':''}`}>
    <button type="button" role={many?'checkbox':'radio'} aria-checked={showOther&&!!(other||typed).trim()} className="ag-q-option" onClick={()=>{if(many&&showOther){setOtherOn(false);setOther('');set(list.filter(v=>known.has(v)));}else{setOtherOn(true);if(!many)set(other.trim()||typed||undefined);}}}>
    <span className={`ag-q-mark ${many?'box':'dot'}`}>{showOther&&!!(other||typed).trim()&&<Check size={11}/>}</span><span className="ag-q-label"><strong>Other</strong><small>Type your own answer</small></span></button>
   {showOther&&<input className="ag-q-input" dir="auto" autoFocus aria-label={`Your own answer to ${f.title||f.key}`} placeholder="Your answer" value={other||typed} onChange={e=>typeOther(e.target.value)}/>}
  </div>}
 </div>;
}

import React from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './App';
import './styles.css';
// A render error (for example a snapshot shape from a newer gateway) used to unmount the whole dashboard and leave a blank window.
class Boundary extends React.Component<{children:React.ReactNode},{error:string}>{
  state={error:''};
  static getDerivedStateFromError(e:unknown){return {error:String((e as Error)?.message||e)};}
  componentDidCatch(e:unknown){console.error('[dashboard]',e);}
  render(){
    if(!this.state.error)return this.props.children;
    return <div className="loading" role="alert"><div className="error-banner"><span>The dashboard hit an error: {this.state.error}</span><button className="button" onClick={()=>location.reload()}>Reload</button></div></div>;
  }
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Boundary><App/></Boundary></React.StrictMode>);

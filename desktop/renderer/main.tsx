import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import * as Tooltip from '@radix-ui/react-tooltip';
import '@fontsource-variable/inter';
import '@fontsource-variable/geist-mono';
import './styles/tokens.css';
import './styles/ui.css';
import './styles/shell.css';
import './features/content.css';
import App from './App';
import { WorkspaceProvider, prepareAPI } from './state/workspace';
class ErrorBoundary extends Component<{children:ReactNode},{error:string}> {
 state={error:''}; static getDerivedStateFromError(error:Error){return {error:error.message};}
 componentDidCatch(error:Error,info:ErrorInfo){console.error('Morrow UI error',error,info);}
 render(){return this.state.error?<div style={{padding:50}}><h2>界面未能加载</h2><p style={{margin:'20px 0'}}>{this.state.error}</p><button onClick={()=>window.location.reload()}>重新加载</button></div>:this.props.children;}
}
await prepareAPI();
const root=import.meta.hot?.data.root ?? createRoot(document.getElementById('root')!);
if(import.meta.hot)import.meta.hot.data.root=root;
root.render(<StrictMode><ErrorBoundary><Tooltip.Provider delayDuration={450}><WorkspaceProvider><App/></WorkspaceProvider></Tooltip.Provider></ErrorBoundary></StrictMode>);

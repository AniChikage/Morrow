import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, ChevronDown, Clock3, Copy, History, LoaderCircle, Terminal } from 'lucide-react';
import type { Run, RunDetails, RunOutputChunk, RunsQuery, WorkspaceEvent } from '../../shared/types';
import type { FeatureProps } from './types';
import { Button, EmptyState, Markdown, StatusLabel } from '../components/ui';
import { formatDate, runtimeLabel, shortId } from '../components/format';
import { EventLog } from './EventLog';
import './content.css';
import './runs.css';

const reportLabels:Record<string,string>={pending:'等待结果',valid:'看板已同步',missing:'没有看板报告',invalid:'报告未同步',conflict:'报告存在冲突'};
const nativeRun=(run:Run)=>run.executionOwner==='codex-app'||run.permission==='native';
const runTime=(run:Run,value:string)=>value?formatDate(value):nativeRun(run)?'原生时间未提供':'时间未记录';
const runProject=(run:Run,props:FeatureProps)=>run.projectId||props.snapshot.channels.find(channel=>channel.id===run.channelId)?.projectId;
export function RunsView(props:FeatureProps){
 const [status,setStatus]=useState('all'),[projectId,setProjectId]=useState('');
 const runs=props.snapshot.runs.filter(run=>!projectId||runProject(run,props)===projectId);
 return <main className="feature-main"><div className="feature-toolbar"><span className="feature-toolbar-title"><History size={15}/>运行记录</span><div className="feature-toolbar-spacer"/><label className="feature-select-label">项目<select aria-label="按项目筛选运行" value={projectId} onChange={event=>setProjectId(event.target.value)}><option value="">全部项目</option>{props.snapshot.projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label className="feature-select-label">状态<select aria-label="按运行状态筛选" value={status} onChange={event=>setStatus(event.target.value)}><option value="all">全部</option><option value="running">运行中</option><option value="completed">已完成</option><option value="failed">失败</option><option value="interrupted">中断</option></select></label></div><div className="feature-scroll"><RunHistory key={projectId||'all'} {...props} runs={runs} statusFilter={status} query={projectId?{projectId}:{}}/></div></main>;
}

export function RunHistory({runs,showChannel=true,emptyDescription,query={},statusFilter='all',...props}:FeatureProps & {runs:Run[];showChannel?:boolean;emptyDescription?:string;query?:RunsQuery;statusFilter?:string}){
 const [stored,setStored]=useState<Run[]>([]),[historyLoaded,setHistoryLoaded]=useState(false),[cursor,setCursor]=useState<string>(),[hasMore,setHasMore]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState(''),[expanded,setExpanded]=useState<string|null>(null);
 const scope=JSON.stringify({projectId:query.projectId,channelId:query.channelId});
 const generation=useRef(0),snapshotBaseline=useRef(new Set<string>());
 async function load(before?:string){
  const current=generation.current;setLoading(true);setError('');
  try{const page=await props.api.getRuns({...query,...(before?{before}:{}),limit:80});if(current!==generation.current)return;setStored(previous=>before?[...page.runs,...previous]:page.runs);setHistoryLoaded(true);setCursor(page.cursor);setHasMore(page.hasMore);}
  catch(failure){if(current===generation.current)setError(failure instanceof Error?failure.message:'暂时无法读取更早运行。');}
  finally{if(current===generation.current)setLoading(false);}
 }
 useEffect(()=>{generation.current++;snapshotBaseline.current=new Set(runs.map(run=>run.id));setStored([]);setHistoryLoaded(false);setExpanded(null);setHasMore(false);setCursor(undefined);void load();return()=>{generation.current++;};},[scope]);
 const merged=useMemo(()=>{
  const loadedIds=new Set(stored.map(run=>run.id));
  // The history cursor owns the loaded range; snapshots refresh those rows and add new runs.
  const live=historyLoaded?runs.filter(run=>loadedIds.has(run.id)||!snapshotBaseline.current.has(run.id)):runs;
  return [...new Map([...stored,...live].map(run=>[run.id,run])).values()].filter(run=>(!query.projectId||runProject(run,props)===query.projectId)&&(!query.channelId||run.channelId===query.channelId)&&(statusFilter==='all'||run.status===statusFilter)).sort((a,b)=>b.startedAt.localeCompare(a.startedAt));
 },[stored,runs,historyLoaded,statusFilter,scope,props.snapshot.channels]);
 let lastDay='';
 return <div className="run-history">
  {error&&<div className="feature-inline-error" role="alert">{error}<Button variant="ghost" onClick={()=>void load(cursor)}>重试</Button></div>}
  {!merged.length&&!loading&&<EmptyState icon={<History/>} title={statusFilter==='all'?'还没有运行记录':'没有符合条件的运行'} description={emptyDescription||'持续跟踪或运行一次后，本轮输入、输出、会话与看板报告都会保存在这里。'}/>}
  {merged.map(run=>{const channel=props.snapshot.channels.find(channel=>channel.id===run.channelId),project=props.snapshot.projects.find(project=>project.id===runProject(run,props));const day=run.startedAt.slice(0,10)||(nativeRun(run)?'原生时间未提供':'时间未记录'),heading=day!==lastDay;lastDay=day;return <section className="run-history-entry" key={run.id}>{heading&&<h3 className="run-day"><Clock3 size={13}/>{day}</h3>}<button className={`run-heading ${expanded===run.id?'expanded':''}`} aria-expanded={expanded===run.id} onClick={()=>setExpanded(previous=>previous===run.id?null:run.id)}><Terminal size={15}/><span className="run-heading-main"><strong>{runtimeLabel(run.runtime)}<span>{shortId(run.id)}</span></strong>{showChannel&&<small>{project?.name} / {channel?.name||'频道不可用'}</small>}</span><time>{runTime(run,run.startedAt)}</time><StatusLabel status={run.status}/><ChevronDown className="run-chevron" size={14}/></button>{expanded===run.id&&<RunInspector key={run.id} {...props} run={run}/>}</section>;})}
  {(loading||hasMore)&&<div className="load-history"><Button variant="ghost" disabled={loading} onClick={()=>void load(cursor)}>{loading?<LoaderCircle className="spin" size={14}/>:<History size={14}/>} {loading?'正在读取记录…':'加载更早运行'}</Button></div>}
 </div>;
}

function RunInspector({run,...props}:FeatureProps & {run:Run}){
 const {api,snapshot,onNavigate}=props;
 const [tab,setTab]=useState<'activity'|'input'|'output'|'report'>('activity');
 const [details,setDetails]=useState<RunDetails>(),[events,setEvents]=useState<WorkspaceEvent[]>([]),[moreEvents,setMoreEvents]=useState(false),[eventCursor,setEventCursor]=useState<string>(),[loadingEvents,setLoadingEvents]=useState(false);
 const [chunks,setChunks]=useState<RunOutputChunk[]>([]),[outputCursor,setOutputCursor]=useState<string>(),[moreOutput,setMoreOutput]=useState(true),[loadingOutput,setLoadingOutput]=useState(false),[loadedOutput,setLoadedOutput]=useState(false);
 const [detailError,setDetailError]=useState(''),[eventError,setEventError]=useState(''),[outputError,setOutputError]=useState(''),[copied,setCopied]=useState(false);
 const mounted=useRef(true),request=useRef(0),outputBusy=useRef(false);
 const channel=snapshot.channels.find(channel=>channel.id===run.channelId);
 const value=details?.run.status===run.status?details.run:run;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;request.current++;};},[]);
 useEffect(()=>{const current=++request.current;void api.getRun(run.id).then(value=>{if(mounted.current&&current===request.current){setDetails(value);setDetailError('');}}).catch(failure=>{if(mounted.current&&current===request.current)setDetailError(failure instanceof Error?failure.message:'无法读取运行详情。');});},[run.id,run.status,api]);
 async function loadEvents(before?:string){setLoadingEvents(true);setEventError('');try{const page=await api.getEvents({channelId:run.channelId,runId:run.id,...(before?{before}:{}),limit:80});if(!mounted.current)return;setEvents(previous=>[...new Map([...page.events,...(before?previous:[])].map(event=>[event.id,event])).values()]);setMoreEvents(page.hasMore);setEventCursor(page.cursor);}catch(failure){if(mounted.current)setEventError(failure instanceof Error?failure.message:'无法读取事件。');}finally{if(mounted.current)setLoadingEvents(false);}}
 useEffect(()=>{void loadEvents();},[run.id]);
 async function loadOutput(){if(outputBusy.current)return;outputBusy.current=true;setLoadingOutput(true);setOutputError('');try{const page=await api.getRunOutput(run.id,{...(outputCursor?{after:outputCursor}:{}),limit:60});if(!mounted.current)return;setChunks(previous=>[...new Map([...previous,...page.chunks].map(chunk=>[chunk.id,chunk])).values()].sort((a,b)=>a.sequence-b.sequence));setMoreOutput(page.hasMore);setOutputCursor(page.cursor||outputCursor);setLoadedOutput(true);}catch(failure){if(mounted.current)setOutputError(failure instanceof Error?failure.message:'无法读取原始输出。');}finally{outputBusy.current=false;if(mounted.current)setLoadingOutput(false);}}
 useEffect(()=>{if(tab==='output'&&!loadedOutput)void loadOutput();},[tab]);
 const timeline=[...new Map([...events,...snapshot.events.filter(event=>event.runId===run.id)].map(event=>[event.id,event])).values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||(a.detail?.sequence??0)-(b.detail?.sequence??0));
 const visibleChunks=chunks.filter(chunk=>['stdout','stderr','final'].includes(chunk.stream));
 const tabs=[['activity','执行动态'],['input','本轮输入'],['output','原始输出'],['report','看板报告']] as const;
 return <div className="run-expanded">
  <div className="run-session-meta"><div><span>触发方式</span><strong>{value.source==='native-app'?'Codex App 对话':value.source==='nohuman-chat'?'NoHuman 对话':value.trigger==='schedule'?'持续调度':value.trigger==='manual'?'手动运行':'历史记录'}</strong></div><div><span>工作模式</span><strong>{value.permission==='native'?'原生设置':value.permission==='workspace-write'?'工作区编辑':value.permission==='read-only'?'只读跟踪':'—'}</strong></div><div><span>看板报告</span><strong className={['invalid','conflict'].includes(value.reportStatus||'')?'run-report-warning':''}>{value.reportStatus?reportLabels[value.reportStatus]:'旧版记录'}</strong></div></div>
  {value.summary&&<div className="run-summary"><Markdown>{value.summary}</Markdown></div>}
  {value.reportError&&<p className="run-report-warning">{value.reportError}</p>}
  <div className="run-duration"><span>开始 {runTime(run,run.startedAt)}</span><span>结束 {run.finishedAt?formatDate(run.finishedAt):run.status==='running'?'尚未结束':nativeRun(run)?'原生时间未提供':'时间未记录'}</span>{value.exitCode!==undefined&&<span>退出码 {value.exitCode}</span>}{channel&&<Button variant="ghost" onClick={()=>onNavigate({kind:'channel',id:channel.id})}>打开频道<ArrowUpRight size={12}/></Button>}</div>
  {run.sessionId&&<div className="run-native-session"><span>原生会话</span><code>{run.sessionId}</code><Button variant="ghost" aria-label="复制原生会话 ID" onClick={()=>void navigator.clipboard.writeText(run.sessionId).then(()=>setCopied(true)).catch(()=>setCopied(false))}><Copy size={12}/>{copied?'已复制':'复制'}</Button>{value.resumedFromSessionId&&<small>沿用已有会话</small>}</div>}
  <div className="feature-tabs run-detail-tabs" role="tablist" aria-label="运行详情">{tabs.map(([key,label])=><button key={key} role="tab" aria-selected={tab===key} className={tab===key?'active':''} onClick={()=>setTab(key)}>{label}</button>)}</div>
  <div className="run-detail-content">
   {tab==='activity'&&<>{eventError&&<p className="feature-inline-error" role="alert">{eventError}</p>}{moreEvents&&<Button variant="ghost" disabled={loadingEvents} onClick={()=>void loadEvents(eventCursor)}>加载更早动态</Button>}{timeline.map(event=><EventLog key={event.id} event={event} runtime={run.runtime}/>)}{!timeline.length&&<p className="subtle">{loadingEvents?'正在读取动态…':'此次运行没有可显示的事件。'}</p>}</>}
   {tab==='input'&&<>{detailError?<p className="feature-inline-error" role="alert">{detailError}</p>:details?<><p className="run-storage-note">{nativeRun(value)?'原生 App 对话中记录的本轮输入。':'发送给原生 CLI 的本轮完整输入。历史会话由 CLI 自身管理。'}</p><pre className="run-raw"><code>{details.prompt||'这条历史记录未保存输入副本。'}</code></pre></>:<p className="subtle">正在读取输入…</p>}</>}
   {tab==='output'&&<><p className="run-storage-note">{nativeRun(value)?'SQLite 中保存的原生 App 输出与活动记录。':'SQLite 中保存的 CLI 原始输出，按接收顺序展示。'}</p>{outputError&&<p className="feature-inline-error" role="alert">{outputError}</p>}{visibleChunks.map(chunk=><section className="run-output-chunk" key={chunk.id}><header><span>{chunk.stream==='final'?'最终输出':chunk.stream}</span><span>{chunk.sequence}</span></header><pre className="run-raw"><code>{chunk.text}</code></pre></section>)}{loadedOutput&&!visibleChunks.length&&!moreOutput&&<p className="subtle">没有原始输出副本；旧版记录可以在执行动态中查看。</p>}{(moreOutput||run.status==='running'||!!outputError)&&<Button disabled={loadingOutput} onClick={()=>void loadOutput()}>{loadingOutput?'正在读取…':loadedOutput&&moreOutput?'加载后续输出':'刷新输出'}</Button>}</>}
   {tab==='report'&&<>{detailError?<p className="feature-inline-error" role="alert">{detailError}</p>:!details?<p className="subtle">正在读取报告…</p>:details.report?<pre className="run-raw"><code>{JSON.stringify(details.report,null,2)}</code></pre>:<p className="subtle">本轮没有可同步的看板报告。执行结果和原生输出仍被保留。</p>}{details?.finalOutput&&<section className="run-final-answer"><h4>原生最终回复</h4><Markdown>{details.finalOutput}</Markdown></section>}</>}
  </div>
 </div>;
}

import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowUpRight, CheckCircle2, Clock3 } from 'lucide-react';
import type { ProjectLoop, Release, DesktopAPI } from '../../shared/types';
import type { FeatureProps } from './types';
import { Button, EmptyState, Markdown } from '../components/ui';
import { formatDate } from '../components/format';
import './project-work.css';

const releaseLabels:Record<Release['status'],string>={awaiting_approval:'待上线确认',approved:'已确认，准备发布',publishing:'正在发布',published:'已上线 · 跟踪效果',rejected:'暂不上线',unknown:'发布结果待核对',failed:'发布失败'};
const learningLabels={outcome:'目标成效',hypothesis:'判断',experiment:'尝试'};
const conclusionLabels={active:'进行中',supported:'证据支持',refuted:'已被推翻',inconclusive:'证据不足',stopped:'已停止'};
function useProjectWork(api:DesktopAPI,projectId:string,itemId?:string){
  const [data,setData]=useState<ProjectLoop>();const [error,setError]=useState('');
  useEffect(()=>{let cancelled=false;let pending=false;setData(undefined);setError('');
    const load=async()=>{if(pending||!api.getProjectWork)return;pending=true;try{const result=await api.getProjectWork(projectId,itemId);if(!cancelled){setData(result);setError('');}}catch(e){if(!cancelled)setError(e instanceof Error?e.message:'工作记录加载失败');}finally{pending=false;}};
    void load();const timer=setInterval(()=>{if(document.visibilityState!=='hidden')void load();},5000);return()=>{cancelled=true;clearInterval(timer);};
  },[api,projectId,itemId]);return {data,error};
}
export function FeatureWork({api,projectId,itemId}: {api:DesktopAPI;projectId:string;itemId:string}){
  const {data,error}=useProjectWork(api,projectId,itemId);
  if(!api.getProjectWork)return null;
  if(error)return <p role="alert" className="form-error">{error}</p>;
  if(!data)return <p className="subtle">正在读取工作记录…</p>;
  if(!data.learning.length&&!data.watches.length&&!data.releases.length&&!data.evidence.length)return <section className="finding-section"><h2>持续跟踪</h2><p className="subtle">Codex 会在这里记录判断、尝试和实际反馈，沿着同一个 feature 持续推进。</p></section>;
  return <section className="finding-section"><h2>判断、尝试与反馈</h2>
    {data.learning.map(row=><details className="work-record" key={row.id} open={row.status==='active'}><summary><span className="work-record-kind">{learningLabels[row.kind]}</span><strong>{row.title}</strong><span className="subtle">{conclusionLabels[row.status]}</span></summary><div className="work-record-body"><Markdown>{row.rationale}</Markdown><p><b>预期结果：</b>{row.expectedResult}</p><p><b>验证方式：</b>{row.evaluation}</p>{row.conclusion&&<p><b>上次判断：</b>{row.conclusion}</p>}<EvidenceReferences ids={row.evidenceIds} data={data}/></div></details>)}
    {data.watches.map(row=><div className="work-watch" key={row.id}><Clock3 size={14}/><div><strong>{row.title}</strong><p>{row.status==='triggered'?(row.continuous!==false?'已收到反馈 · 持续监测':'已收到符合条件的反馈'):row.status==='expired'?(row.continuous!==false?'已到复查时间 · 持续监测':'观察已到截止时间'):row.status==='cancelled'?'已停止观察':`等待反馈 · ${formatDate(row.deadline)}`}</p>{row.error&&<p className="form-error">{row.error}</p>}</div></div>)}
    {data.releases.map(row=><div className="work-watch" key={row.id}><CheckCircle2 size={14}/><div><strong>{row.title}</strong><p>{releaseLabels[row.status]}</p><p>{row.observationPlan}</p></div></div>)}
    {!!data.evidence.length&&<details className="work-record"><summary>实际记录与来源 <span className="subtle">{data.evidence.length}</span></summary><div className="work-record-body"><EvidenceReferences ids={data.evidence.map(e=>e.id)} data={data}/></div></details>}
  </section>;
}
function EvidenceReferences({ids,data}:{ids:string[];data?:ProjectLoop}){return <div className="work-evidence">{ids.map(id=>{const e=data?.evidence.find(row=>row.id===id);return <details key={id}><summary>{e?.summary||`证据 ${id.slice(0,8)}`} <span className="subtle">{e?.origin==='http'?'HTTP 采集':e?.origin==='file'?'文件采集':'Agent 记录'}</span></summary>{e&&<><p className="work-source">{e.source} · {formatDate(e.observedAt)}</p><pre>{typeof e.data==='string'?e.data:JSON.stringify(e.data,null,2)}</pre></>}</details>;})}</div>;}
export function ProjectReleases(props:FeatureProps&{projectId:string}){
  const {snapshot,api,projectId,busy,onMutate,onNavigate}=props;
  const releases=(snapshot.releases||[]).filter(row=>row.projectId===projectId).slice().reverse();
  const [selected,setSelected]=useState<string>();const [feedback,setFeedback]=useState('');const [pending,setPending]=useState(false);const [localError,setLocalError]=useState('');
  const {data,error}=useProjectWork(api,projectId);
  const row=releases.find(r=>r.id===selected);
  const missingEvidence=!!row&&!!data&&row.checks.some(check=>check.evidenceIds.some(id=>!data.evidence.some(e=>e.id===id)));
  const review=async(decision:'approve'|'reject')=>{if(!row||!api.reviewRelease||pending)return;setPending(true);setLocalError('');const ok=await onMutate(()=>api.reviewRelease!(row.id,row.reviewHash,decision,feedback));if(!ok)setLocalError('操作未完成，请核对错误后重试；不会自动重复提交。');setPending(false);};
  if(!row)return <div className="feature-scroll">{releases.length?<div className="release-list">{releases.map(release=><button key={release.id} onClick={()=>{setSelected(release.id);setFeedback('');setLocalError('');}} className="release-row"><span className={`release-status release-${release.status}`}>{releaseLabels[release.status]}</span><strong>{release.title}</strong><span className="subtle">{release.itemIds.length} 个功能</span><ArrowUpRight size={14}/></button>)}</div>:<EmptyState title="AI 准备好后，在这里确认上线" description="变更、验证结果、预期收益与观察计划会一并提交。发布后的效果继续归入原来的 feature。"/>}</div>;
  return <div className="feature-scroll"><article className="finding-document release-document">
    <Button variant="ghost" onClick={()=>setSelected(undefined)}><ArrowLeft size={14}/>所有发布</Button>
    <div className="release-heading"><span className={`release-status release-${row.status}`}>{releaseLabels[row.status]}</span><span className="subtle">{formatDate(row.createdAt)}</span></div><h1>{row.title}</h1>
    <div className="release-features">{row.itemIds.map(id=>{const item=snapshot.items.find(v=>v.id===id);return <button key={id} onClick={()=>onNavigate({kind:'finding',id})}>#{item?.number||'—'} {item?.title||'查看功能'}</button>;})}</div>
    <section className="finding-section"><h2>这次改了什么</h2><Markdown>{row.changes}</Markdown></section>
    <section className="finding-section"><h2>为什么做</h2><Markdown>{row.rationale}</Markdown></section>
    <section className="finding-section"><h2>预期收益</h2><Markdown>{row.expectedBenefit}</Markdown><p className="subtle">这是待验证的预期，上线后的实际效果会单独记录。</p></section>
    <section className="finding-section"><h2>验证情况</h2>{row.checks.map((check,index)=><div key={index} className="release-check"><strong>{check.result==='passed'?'已通过':'尚未验证'} · {check.name}</strong><EvidenceReferences ids={check.evidenceIds} data={data}/></div>)}{error&&<p role="alert" className="form-error">证据加载失败：{error}</p>}{missingEvidence&&<p role="alert" className="form-error">部分验证证据尚未读取，暂时无法确认上线。</p>}</section>
    <section className="finding-section"><h2>影响范围与回退</h2><Markdown>{row.risks}</Markdown><Markdown>{row.rollback}</Markdown></section>
    <section className="finding-section"><h2>上线后如何判断效果</h2><Markdown>{row.observationPlan}</Markdown></section>
    <section className="finding-section"><h2>发布到哪里</h2><p>{row.target.label}</p><p className="work-source">{row.target.url}</p><details className="work-record"><summary>本次确认的版本</summary><p className="work-source">{row.artifact.name} · {row.artifact.bytes.toLocaleString()} 字节</p><p className="work-source">SHA256 {row.artifact.sha256}</p><p className="subtle">发布使用这份封存产物，后续修改需要重新准备版本。</p></details></section>
    {row.feedback&&<section className="finding-section"><h2>你的指导</h2><Markdown>{row.feedback}</Markdown></section>}
    {row.error&&<p role="alert" className="form-error">{row.error}</p>}
    {row.status==='unknown'&&<Button disabled={busy||pending||!api.reconcileRelease} onClick={()=>void onMutate(()=>api.reconcileRelease!(row.id))}>核对发布结果</Button>}
    {row.status==='awaiting_approval'&&<div className="release-confirm"><label>指导意见（可选）<textarea aria-label="上线指导意见" value={feedback} onChange={e=>setFeedback(e.target.value)} placeholder="需要调整的地方，或补充观察重点…"/></label><div><Button disabled={busy||pending||!api.reviewRelease} onClick={()=>void review('reject')}>暂不上线，继续调整</Button><Button variant="primary" disabled={busy||pending||!api.reviewRelease||!!error||!data||missingEvidence} onClick={()=>void review('approve')}>{pending?'正在提交…':'确认这个版本上线'}</Button></div>{localError&&<p role="alert" className="form-error">{localError}</p>}</div>}
  </article></div>;
}

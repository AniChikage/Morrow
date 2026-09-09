import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowUpRight, CheckCircle2, Clock3 } from 'lucide-react';
import type { ProjectLoop, Release, DesktopAPI, DecisionView } from '../../shared/types';
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
  if(!data.learning.length&&!data.watches.length&&!data.releases.length&&!data.evidence.length&&!data.strategy?.decisions.length&&!data.verifications?.length)return <section className="finding-section"><h2>持续跟踪</h2><p className="subtle">Codex 会在这里记录判断、尝试和实际反馈，沿着同一个 feature 持续推进。</p></section>;
  return <section className="finding-section"><h2>判断、尝试与反馈</h2>
    <VerificationRecords data={data}/>
    {data.strategy?.decisions.filter(row=>row.expectations?.length).map(row=><div key={row.id}><h3>{row.options[row.selected].title}</h3><ExpectationReview row={row} data={data}/>{row.review&&<p><b>{outcomeLabels[row.review.outcome]}：</b>{row.review.conclusion}</p>}</div>)}
    {data.learning.map(row=><details className="work-record" key={row.id} open={row.status==='active'}><summary><span className="work-record-kind">{learningLabels[row.kind]}</span><strong>{row.title}</strong><span className="subtle">{conclusionLabels[row.status]}</span></summary><div className="work-record-body"><Markdown>{row.rationale}</Markdown><p><b>预期结果：</b>{row.expectedResult}</p><p><b>验证方式：</b>{row.evaluation}</p>{row.conclusion&&<p><b>上次判断：</b>{row.conclusion}</p>}<EvidenceReferences ids={row.evidenceIds} data={data}/></div></details>)}
    {data.watches.map(row=><div className="work-watch" key={row.id}><Clock3 size={14}/><div><strong>{row.title}</strong><p>{row.status==='triggered'?(row.continuous!==false?'已收到反馈 · 持续监测':'已收到符合条件的反馈'):row.status==='expired'?(row.continuous!==false?'已到复查时间 · 持续监测':'观察已到截止时间'):row.status==='cancelled'?'已停止观察':`等待反馈 · ${formatDate(row.deadline)}`}</p>{row.error&&<p className="form-error">{row.error}</p>}</div></div>)}
    {data.releases.map(row=><div className="work-watch" key={row.id}><CheckCircle2 size={14}/><div><strong>{row.title}</strong><p>{releaseLabels[row.status]}</p><p>{row.observationPlan}</p></div></div>)}
    {!!data.evidence.length&&<details className="work-record"><summary>实际记录与来源 <span className="subtle">{data.evidence.length}</span></summary><div className="work-record-body"><EvidenceReferences ids={data.evidence.map(e=>e.id)} data={data}/></div></details>}
  </section>;
}
function EvidenceReferences({ids,data}:{ids:string[];data?:ProjectLoop}){return <div className="work-evidence">{ids.map(id=>{const e=data?.evidence.find(row=>row.id===id);return <details key={id}><summary>{e?.summary||`证据 ${id.slice(0,8)}`} <span className="subtle">{e?.origin==='execution'?'原生执行记录':e?.origin==='http'?'HTTP 采集':e?.origin==='file'?'文件采集':'Agent 记录'}</span></summary>{e&&<><p className="work-source">{e.source} · {formatDate(e.observedAt)}</p>{e.origin==='file'&&<p className="subtle">文件采集证明当时保存的内容，不能单独证明命令实际运行。</p>}<pre>{typeof e.data==='string'?e.data:JSON.stringify(e.data,null,2)}</pre></>}</details>;})}</div>;}
const verificationLabels={queued:'等待独立复核',running:'正在独立复核',passed:'独立复核通过',failed:'复核发现问题',unknown:'复核尚不能判断'};
function VerificationRecords({data}:{data:ProjectLoop}){
  if(!data.verifications?.length)return null;
  return <section className="finding-section"><h2>独立复核</h2>{data.verifications.slice().reverse().map(row=><details className="work-record" key={row.id} open={row.status==='failed'||row.status==='running'}><summary><strong>{row.status==='passed'&&!row.current?'源码或核验材料已变化，需要重新复核':verificationLabels[row.status]}</strong><span className="subtle">{formatDate(row.finishedAt||row.createdAt)}</span></summary><div className="work-record-body"><Markdown>{row.summary}</Markdown>{row.findings.map((f,i)=><p key={i}><b>{f.severity==='blocking'?'需要修正':'复核备注'}：</b>{f.message}</p>)}{row.checks.map(c=><p key={c.expectationId}><b>{verdictLabels[c.verdict]}：</b>{c.reason}</p>)}{row.limitations.map((v,i)=><p className="subtle" key={i}>{v}</p>)}<p className="subtle">独立只读任务 · 最多 5 分钟 · 计入频道预算。通过仅覆盖本次核验范围，业务效果仍需实际反馈。</p><p className="work-source">源版本：{row.version.digest.slice(0,16)} · {row.version.files} 个文件{row.threadId?` · 原生任务：${row.threadId}`:''}</p><EvidenceReferences ids={row.evidenceIds} data={data}/></div></details>)}</section>;
}
const understandingLabels={fact:'事实记录',assumption:'待验证判断',unknown:'关键未知',capability:'工作能力',constraint:'约束认识'};
const optionLabels={act:'推进改进',investigate:'获取信息',build_capability:'补齐能力',observe:'继续观察',stop:'停止尝试'};
const outcomeLabels={improved:'本次预期已达成',not_improved:'未达到本次预期',inconclusive:'仍无法判断',abandoned:'停止这个方向'};
const memoryUseLabels={apply:'沿用',adapt:'调整后采用',avoid:'避免重犯',not_applicable:'本次不适用'};
const verdictLabels={met:'有证据支持',not_met:'与预期不符',unknown:'仍待核对'};
const diagnosisLabels={expected:'符合本次预期',pending:'等待数据',measurement:'观察存在问题',execution:'执行存在问题',assumption:'原假设需要调整',environment:'适用环境发生变化',uncertain:'原因仍不确定'};
const adjustmentLabels={continue:'继续当前方向',observe:'继续观察',measurement:'完善观察',method:'调整方法',assumption:'重新判断假设',stop:'停止这个方向'};
function ExpectationReview({row,data}:{row:DecisionView;data:ProjectLoop}){
  const assessment=row.review?.assessment;
  if(!row.expectations?.length)return null;
  const needsRepair=row.observations?.some(o=>o.status==='needs_repair');
  return <details className="work-record"><summary>预期与实际 <span className="subtle">{row.expectations.length} 项{needsRepair?' · 观测待修复':''}</span></summary><div className="work-record-body">
    {row.expectations.map(expected=>{const result=assessment?.results.find(r=>r.expectationId===expected.id),plan=expected.measurement,observation=result?.observation||row.observations?.find(o=>o.expectationId===expected.id);return <div className="strategy-option" key={expected.id}>
      <strong>{expected.kind==='guardrail'?'不能牺牲的条件':'希望取得的结果'} · {expected.claim}</strong>
      <p>{result?verdictLabels[result.verdict]:'等待核对'}{result?` · ${result.checkedBy==='rule'?'规则核对':'Codex 根据证据解读'}`:''}</p>
      <p><b>适用条件：</b>{expected.scope}</p><p><b>验证办法：</b>{expected.verification}</p>
      {expected.rule&&<p><b>预先约定：</b>{plan?.comparison==='delta'?'相对原基线的差值 · ':''}{expected.rule.pointer||'整个值'} {expected.rule.operator==='gte'?'≥':expected.rule.operator==='lte'?'≤':'='} {String(expected.rule.expected)}{result?.observedValue!==undefined?` · 采集值：${result.observedValue===null?'字段缺失或类型不符':String(result.observedValue)}`:''}</p>}
      {plan&&<div className="measurement-detail">
        <p><b>观测指标：</b>{plan.metric}</p><p><b>与目标的关系：</b>{plan.goalRelation}</p>
        <p><b>原基线：</b>{'unavailable' in plan.baseline?`尚未取得 · ${plan.baseline.unavailable}`:observation?.baselineValue==null?'待核对原始记录':String(observation.baselineValue)}{observation?.observedValue!=null?` · 最新值：${String(observation.observedValue)}`:''}{plan.comparison==='delta'&&observation?.comparedValue!=null?` · 差值：${String(observation.comparedValue)}`:''}</p>
        <p><b>数据核对：</b>{observation?.status==='ready'?'已满足原观测条件':observation?.status==='needs_repair'?'需要修复观测':'等待有效观测'}{observation?.status==='ready'?` · ${verdictLabels[observation.verdict]}`:''}</p>
        {observation?.issues.map(issue=><p className="subtle" key={issue}>{issue}</p>)}
        <p className="subtle">数据时间最多落后 {plan.freshness.maxAgeSeconds} 秒；{plan.checks.map(c=>c.label).join('、')}。</p>
        {!!observation?.checks.length&&<ul>{observation.checks.map((c,i)=><li key={i}>{c.label}：{c.status==='passed'?'符合约定':c.status==='failed'?'不符合约定':'缺少有效字段'}{c.observedValue!=null?` · ${String(c.observedValue)}`:''}</li>)}</ul>}
        <p className="subtle">判断边界：{plan.limitation}</p>
        <EvidenceReferences ids={[...new Set([...('evidenceId' in plan.baseline?[plan.baseline.evidenceId]:[]),...(observation?.evidenceId?[observation.evidenceId]:[])])]} data={data}/>
      </div>}
      <p><b>反证条件：</b>{expected.disconfirm}</p><p className="subtle">观察窗口：{formatDate(expected.notBefore)} — {formatDate(expected.deadline)}</p>
      <p className="work-source">约定来源：{expected.source.kind==='file'?expected.source.path:expected.source.kind==='execution'?expected.source.command:expected.source.url}</p>
      {result&&<><Markdown>{result.reason}</Markdown><EvidenceReferences ids={result.evidenceIds} data={data}/></>}
    </div>;})}
    {assessment&&<div className="strategy-option"><strong>{diagnosisLabels[assessment.diagnosis]}</strong><p><b>条件核对：</b>{assessment.conditions==='matched'?'与原条件相符':assessment.conditions==='changed'?'条件已有变化':'条件尚未确认'} · {assessment.conditionReason}</p><Markdown>{assessment.explanation}</Markdown><p><b>接下来：</b>{adjustmentLabels[assessment.adjustment]}</p>{assessment.understandingRefs.map(ref=><p className="subtle" key={ref.id}>已保存的认识：{data.strategy?.understanding.find(u=>u.id===ref.id)?.title||ref.id} · 版本 {ref.revision}</p>)}<p className="subtle">规则核对只说明约定字段的结果，因果解释仍需验证。</p></div>}
  </div></details>;
}
function DecisionRecord({row,data,onChannel}:{row:DecisionView;data:ProjectLoop;onChannel:()=>void}){
  const selected=row.options[row.selected];
  return <section className="finding-section strategy-decision">
    <div className="strategy-meta"><span>{optionLabels[selected.kind]}</span><button onClick={onChannel}>进入对话 <ArrowUpRight size={12}/></button></div>
    <h2>{selected.title}</h2><Markdown>{row.rationale}</Markdown>
    {row.status==='active'&&row.reviewReasons.length>0&&<div className="strategy-review" role="status"><strong>需要重新判断</strong>{row.reviewReasons.map(reason=><p key={reason}>{reason}</p>)}</div>}
    <p><b>下一步：</b>{row.nextStep}</p><p><b>预期结果：</b>{row.expectedOutcome}</p><p><b>如何判断：</b>{row.evaluation}</p>
    <ExpectationReview row={row} data={data}/>
    <details className="work-record"><summary>选择依据与投入边界</summary><div className="work-record-body">
      {row.options.map((option,index)=><div className="strategy-option" key={index}><strong>{index===row.selected?'已选择 · ':''}{option.title}</strong><p>价值：{option.benefit}</p><p>投入：{option.cost}</p><p>未知：{option.uncertainty}</p></div>)}
      <p><b>调整或停止条件：</b>{row.stopWhen}</p><p className="subtle">复查时间：{formatDate(row.reviewAt)} · 已投入 {row.runsUsed} / {row.maxRuns} 轮，达到边界后先复盘。</p>
      <p><b>当时的目标：</b>{row.objective.goal}</p>
      {row.understandingRefs.map(ref=>{const u=data.strategy?.understanding.find(v=>v.id===ref.id);return <p key={ref.id} className="subtle">依据：{u?.title||ref.id} · 当时版本 {ref.revision}{u&&u.revision!==ref.revision?' · 后续已更新':''}</p>;})}
      <EvidenceReferences ids={row.evidenceIds} data={data}/>
    </div></details>
    {!!row.memoryRefs?.length&&<details className="work-record"><summary>这次参考了哪些经验 <span className="subtle">{row.memoryRefs.length}</span></summary><div className="work-record-body">
      {row.memoryRefs.map(ref=><div className="strategy-option" key={`${ref.kind}:${ref.id}`}><strong>{memoryUseLabels[ref.use]} · {ref.snapshot.title}</strong><p>{ref.reason}</p><p className="subtle">当时版本 {ref.revision}{ref.snapshot.outcome?` · ${outcomeLabels[ref.snapshot.outcome]}`:''}</p>{ref.snapshot.caution&&<p className="subtle">{ref.snapshot.caution}</p>}<Markdown>{ref.snapshot.excerpt}</Markdown>{ref.snapshot.truncated&&<p className="subtle">此处为历史摘要，完整记录仍保留。</p>}<EvidenceReferences ids={ref.snapshot.evidenceIds} data={data}/></div>)}
    </div></details>}
    {row.review&&<div className="strategy-result"><strong>{outcomeLabels[row.review.outcome]}</strong>{!row.evaluationVersion&&<p className="subtle">历史文字复盘，未进行逐项预期核对。</p>}<Markdown>{row.review.conclusion}</Markdown><p><b>对下一步的影响：</b>{row.review.nextDirection}</p><EvidenceReferences ids={row.review.evidenceIds} data={data}/></div>}
  </section>;
}
export function ProjectThinking({api,projectId,onNavigate}:Pick<FeatureProps,'api'|'onNavigate'>&{projectId:string}){
  const {data,error}=useProjectWork(api,projectId);
  if(error)return <div className="feature-scroll"><p role="alert" className="form-error">{error}</p></div>;
  if(!api.getProjectWork)return <EmptyState title="当前连接暂不支持项目判断" description="连接新版 Morrow 服务后可查看。"/>;
  if(!data)return <p className="subtle">正在读取项目判断…</p>;
  if(!data.strategy)return <EmptyState title="当前服务尚未支持项目判断" description="更新所连接的 Morrow 执行服务后，可查看项目认识与行动复盘。"/>;
  const strategy=data.strategy,active=strategy?.decisions.filter(r=>r.status==='active')||[],history=strategy?.decisions.filter(r=>r.status==='reviewed')||[];
  return <div className="feature-scroll"><article className="finding-document strategy-document"><h1>当前判断</h1><p className="subtle">Codex 对项目的认识、为什么选择下一步，以及反馈如何改变判断。</p>
    {!active.length&&<section className="finding-section"><h2>{history.length?'已保存的下一步':data.verifications?.length?'已有复核反馈':'等待形成下一步判断'}</h2><p className="subtle">{history.at(-1)?.review?.nextDirection||(data.verifications?.length?'复核记录已保存，原频道可据此继续修正或核验。':'开始工作后，Codex 会理解项目现状，再记录值得推进的方向。这里仅展示已保存的真实判断。')}</p></section>}
    <VerificationRecords data={data}/>
    {active.map(row=><DecisionRecord key={row.id} row={row} data={data} onChannel={()=>onNavigate({kind:'channel',id:row.channelId})}/>)}
    {!!strategy?.understanding.length&&<section className="finding-section"><h2>对项目的认识</h2>{strategy.understanding.map(row=><details className="work-record" key={row.id}><summary><span className="work-record-kind">{understandingLabels[row.kind]}</span><strong>{row.title}</strong><span className="subtle">{row.status==='invalidated'?'已推翻':row.status==='retired'?'已停用':row.reviewAt<=new Date().toISOString()?'待复查':''}</span></summary><div className="work-record-body"><Markdown>{row.statement}</Markdown><p><b>为什么相关：</b>{row.relevance}</p><p><b>如何复查：</b>{row.verification}</p><p className="subtle">版本 {row.revision} · {formatDate(row.updatedAt)}</p><EvidenceReferences ids={row.evidenceIds} data={data}/></div></details>)}</section>}
    {!!history.length&&<details className="work-record strategy-history"><summary>此前尝试与复盘 <span className="subtle">{history.length}</span></summary>{history.slice().reverse().map(row=><DecisionRecord key={row.id} row={row} data={data} onChannel={()=>onNavigate({kind:'channel',id:row.channelId})}/>)}</details>}
  </article></div>;
}
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
    {!!row.verificationIds?.length&&data&&<VerificationRecords data={{...data,verifications:data.verifications?.filter(v=>row.verificationIds!.includes(v.id))}}/>}
    <section className="finding-section"><h2>上线后如何判断效果</h2><Markdown>{row.observationPlan}</Markdown></section>
    <section className="finding-section"><h2>发布到哪里</h2><p>{row.target.label}</p><p className="work-source">{row.target.url}</p><details className="work-record"><summary>本次确认的版本</summary><p className="work-source">{row.artifact.name} · {row.artifact.bytes.toLocaleString()} 字节</p><p className="work-source">SHA256 {row.artifact.sha256}</p><p className="subtle">发布使用这份封存产物，后续修改需要重新准备版本。</p></details></section>
    {row.feedback&&<section className="finding-section"><h2>你的指导</h2><Markdown>{row.feedback}</Markdown></section>}
    {row.error&&<p role="alert" className="form-error">{row.error}</p>}
    {row.status==='unknown'&&<Button disabled={busy||pending||!api.reconcileRelease} onClick={()=>void onMutate(()=>api.reconcileRelease!(row.id))}>核对发布结果</Button>}
    {row.status==='awaiting_approval'&&<div className="release-confirm"><label>指导意见（可选）<textarea aria-label="上线指导意见" value={feedback} onChange={e=>setFeedback(e.target.value)} placeholder="需要调整的地方，或补充观察重点…"/></label><div><Button disabled={busy||pending||!api.reviewRelease} onClick={()=>void review('reject')}>暂不上线，继续调整</Button><Button variant="primary" disabled={busy||pending||!api.reviewRelease||!!error||!data||missingEvidence} onClick={()=>void review('approve')}>{pending?'正在提交…':'确认这个版本上线'}</Button></div>{localError&&<p role="alert" className="form-error">{localError}</p>}</div>}
  </article></div>;
}

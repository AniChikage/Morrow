import { createHash, randomUUID } from 'node:crypto';
import { APIError, choice, integer, keys, object, string } from './protocol.ts';
import type { Channel, Project, Run } from './protocol.ts';
import type { Evidence, FeedbackWatch, Release, Learning } from './autonomy-types.ts';
import type { ActionOption, Understanding, StrategyDecision, DecisionView, StrategyView, MemoryKind } from './strategy-types.ts';
import type { ProjectWorkLoop, Scope } from './project-loop.ts';
import { ProjectMemory, memoryTables } from './project-memory.ts';
import { DecisionEvaluation } from './decision-evaluation.ts';
import { qualityChecks } from './measurement.ts';
import { now } from './store.ts';
import type { Verification } from './verification-types.ts';

const tables={understanding:'strategy_understanding',decision:'strategy_decisions',learning:'loop_learning'} as const;
const text=(v:unknown,f:string,max=5000)=>string(v,f,max);
function deadline(value:unknown){const v=text(value,'reviewAt',40);if(!Number.isFinite(Date.parse(v))||Date.parse(v)<=Date.now())throw new APIError(400,'reviewAt 必须是未来的复查时间');return new Date(v).toISOString();}
function ids(value:unknown,field:string){if(!Array.isArray(value)||value.length>30)throw new APIError(400,`${field} 必须为不超过 30 项的数组`);return [...new Set(value.map(v=>text(v,field,200)))];}
function preview<T>(row:T):T&{truncated?:boolean}{
  let truncated=false;
  const compact=(value:any):any=>{if(typeof value==='string'&&value.length>500){truncated=true;return value.slice(0,500);}if(Array.isArray(value))return value.map(compact);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,compact(v)]));return value;};
  const result=compact(row);return {...result,...(truncated?{truncated:true}:{})};
}

/** Durable decision support. Strategy comes from the native agent; no task generator or model calls here. */
export class ProjectStrategy {
  loop:ProjectWorkLoop;
  memory:ProjectMemory;
  evaluation:DecisionEvaluation;
  constructor(loop:ProjectWorkLoop){this.loop=loop;this.memory=new ProjectMemory(loop);this.evaluation=new DecisionEvaluation(loop);}
  get store(){return this.loop.store;}
  objective(project:Project,channel:Channel){return {goal:project.goal,direction:channel.goal,version:createHash('sha256').update(JSON.stringify([project.goal,channel.goal])).digest('hex')};}
  cursor(projectId:string){return Number((this.store.db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM strategy_signals WHERE json_extract(data,'$.projectId')=?").get(projectId) as any).n);}
  active(projectId:string){return this.loop.rows<StrategyDecision>('strategy_decisions',projectId).filter(row=>row.status==='active');}
  runsUsed(id:string){return Number((this.store.db.prepare("SELECT COUNT(*) AS n FROM strategy_runs WHERE json_extract(data,'$.decisionId')=?").get(id) as any).n);}
  decisionView(row:StrategyDecision,runId?:string):DecisionView {
    const project=this.store.get<Project>('projects',row.projectId),channel=this.store.get<Channel>('channels',row.channelId);
    const reviewReasons:string[]=[];const runsUsed=this.runsUsed(row.id);
    if(row.status==='active'){
      if(project&&channel&&this.objective(project,channel).version!==row.objective.version)reviewReasons.push('目标或工作方向已经改变');
      if(row.reviewAt<=now())reviewReasons.push('已到约定的复查时间');
      for(const expected of row.expectations||[])if(expected.deadline<=now())reviewReasons.push(`预期已到观察期限：${expected.claim}`);
      // The current run is still allowed to finish its bounded attempt.
      const currentIncluded=runId&&this.store.get('strategy_runs',`${row.id}:${runId}`)?1:0;
      if(!['observe','stop'].includes(row.options[row.selected].kind)&&runsUsed-currentIncluded>=row.maxRuns)reviewReasons.push('已用完这次尝试的轮次预算，先评估是否值得继续');
      for(const ref of row.understandingRefs){const known=this.store.get<Understanding>('strategy_understanding',ref.id);if(!known||known.status!=='active'||known.revision!==ref.revision||known.reviewAt<=now())reviewReasons.push(`依据需要复查：${known?.title||ref.id}`);}
      for(const ref of row.memoryRefs||[]){
        if(ref.use==='not_applicable')continue;
        const current=this.store.get<any>(memoryTables[ref.kind],ref.id);
        if(!current||current.projectId!==row.projectId||current.revision!==ref.revision||(ref.kind==='understanding'&&current.status==='active'&&current.reviewAt>row.createdAt&&current.reviewAt<=now()))reviewReasons.push(`参考经验需要复查：${ref.snapshot.title}`);
      }
      const signals=this.store.db.prepare("SELECT data FROM strategy_signals WHERE json_extract(data,'$.projectId')=? AND rowid>? AND (json_extract(data,'$.decisionId')=? OR json_extract(data,'$.decisionId') IS NULL) ORDER BY rowid DESC LIMIT 8").all(row.projectId,row.signalCursor,row.id) as {data:string}[];
      reviewReasons.push(...signals.map(r=>JSON.parse(r.data).reason));
    }
    const observations=row.review?.assessment?row.review.assessment.results.flatMap(r=>r.observation?[r.observation]:[]):this.evaluation.observations(row,now());
    return {...row,runsUsed,reviewReasons:[...new Set(reviewReasons)],observations};
  }
  view(projectId:string,itemId?:string,runId?:string):StrategyView {
    const allUnderstanding=this.loop.rows<Understanding>('strategy_understanding',projectId);
    const allDecisions=this.loop.rows<StrategyDecision>('strategy_decisions',projectId).filter(r=>!itemId||r.itemId===itemId);
    const decisions=allDecisions.filter((r,i)=>r.status==='active'||i>=allDecisions.length-12).map(r=>this.decisionView(r,runId));
    const referenced=new Set(decisions.flatMap(r=>[...r.understandingRefs,...(r.review?.assessment?.understandingRefs||[])].map(ref=>ref.id)));
    const understanding=allUnderstanding.filter(r=>referenced.has(r.id)||r.status==='active').sort((a,b)=>{
      const priority=(r:Understanding)=>referenced.has(r.id)?0:r.kind==='constraint'?1:r.reviewAt<=now()?2:r.kind==='unknown'?3:4;
      return priority(a)-priority(b)||b.updatedAt.localeCompare(a.updatedAt);
    }).slice(0,80);
    return {understanding,decisions,counts:{understanding:allUnderstanding.length,decisions:allDecisions.length}};
  }
  context(scope:Scope,itemId?:string){const {project,channel}=this.loop.scope(scope);const day=now().slice(0,10);const view=this.view(project.id,undefined,scope.runId);return {
    relatedMemory:this.memory.recall(scope,{...(itemId?{itemId}:{}),limit:6}),
    ...view,understanding:view.understanding.slice(0,40).map(preview),decisions:view.decisions.sort((a,b)=>Number(b.channelId===channel.id&&b.status==='active')-Number(a.channelId===channel.id&&a.status==='active')).slice(0,12).map(preview),objective:this.objective(project,channel),
    partial:view.counts.understanding>40||view.counts.decisions>12,readMore:'truncated 为摘要，完整记录与旧经验通过 memory.search/read 读取；数量截断用 counts 与 partial 标明。',
    budget:{channelRunsToday:this.store.runCount(channel.id,day),channelDailyLimit:channel.maxRunsPerDay,reset:'UTC 日界；不会因选择新行动而重置'},
    evaluationGuidance:'新选择使用 expectations 留下可核对的结果、适用条件与不能牺牲的约束；复盘用 assessment 对照实际采集记录，原因不明就保留未知。遇到重复无效尝试，检查原假设、数据来源和工作方法是否需要修订；有依据地沿用或改向，不为填写分类而制造工作。一次调查或测试达成预期，不等于整个项目目标已经达成。',
    observationGuidance:'设计改变时一起设计观测：先确认哪个真实结果代表目标、指标口径/分母/人群/版本、当前基线、反馈延迟与不能牺牲的条件。文件或 HTTP 指标用 expectation.measurement 保存目标关系、不能证明的部分、基线证据、数据时效和质量规则；delta 表示与原基线的绝对差值。先沿一次真实输入到结果核对采集链路；缺打点、查询、样本或权限时，自主比较 investigate/build_capability/observe 的价值，在已有授权内补齐，不能拿自编 JSON 当真实用户反馈。observations 会暴露等待/修复缺口；观测规则是否充分仍需判断。样本量门槛不等于统计显著性，代理指标提升不等于因果成立。执行检查无需伪造业务指标，未约定 measurement 的旧记录不会被补成已核验。',
    guidance:'先理解项目阶段和关键未知，自主比较有价值的行动、获取信息、补齐能力、观察或停止。首次接手可先调查，再保存真正影响决策的认识；无需填满类别。采用行动前用 decision.choose 留下选择依据、预期、验证与止损条件。reviewReasons 是复查信号，不能把旧判断当作仍然有效；用 decision.review 评估后再决定下一步。结果未知可继续观察，不必为了忙碌制造事项。其他频道的行动和认识是共享上下文；避免重复占用同一个 feature。relatedMemory 自动召回相关旧记录；准备新的方向时可用 memory.recall 描述拟解决的问题，再用 memory.read 阅读完整经验。选择行动时用 memoryRefs 记录哪些经验影响了取舍、适用条件有什么不同、为什么沿用/调整/避免/不适用；没有相关经验不必凑引用。文字相关不代表有效，失效认识和失败尝试不能直接沿用。',
  };}
  checkpoint(kind:MemoryKind,row:Understanding|StrategyDecision|Learning){
    this.store.put(tables[kind],row);
    this.store.put('strategy_revisions',{id:`${kind}:${row.id}:${row.revision}`,projectId:row.projectId,kind,recordId:row.id,revision:row.revision,data:row,createdAt:now()});
  }
  prepare(run:Run){for(const row of this.active(run.projectId))if(row.channelId===run.channelId)this.store.put('strategy_runs',{id:`${row.id}:${run.id}`,projectId:run.projectId,decisionId:row.id,runId:run.id,createdAt:now()});}
  requireCurrent(scope:Scope){
    const decision=this.active(scope.projectId).find(row=>row.channelId===scope.channelId);if(!decision)return;
    const reasons=this.decisionView(decision,scope.runId).reviewReasons;
    if(reasons.length)throw new APIError(409,`当前选择需要复盘后再推进 feature 或准备发布：${reasons.join('；')}。可以继续采集证据、更新认识并调用 decision.review。`);
  }
  notify(projectId:string,reason:string,decisionId?:string){this.store.put('strategy_signals',{id:randomUUID(),projectId,reason,decisionId,createdAt:now()});}
  memoryChanged(projectId:string,kind:MemoryKind,id:string){
    for(const decision of this.active(projectId))if((kind==='understanding'&&decision.understandingRefs.some(ref=>ref.id===id))||decision.memoryRefs?.some(ref=>ref.kind===kind&&ref.id===id&&ref.use!=='not_applicable'))this.loop.wake(decision.channelId,'行动参考的认识或经验已更新');
  }
  needsObservation(watch:FeedbackWatch,data:unknown){
    const latest=watch.lastEvidenceId?this.store.get<Evidence>('loop_evidence',watch.lastEvidenceId):undefined;
    return this.active(watch.projectId).some(row=>row.expectations?.some(expected=>expected.source.kind==='watch'&&expected.source.watchId===watch.id&&expected.notBefore<=now()&&expected.deadline>=now()&&(!latest||latest.observedAt<expected.notBefore||!this.evaluation.isNew(row,latest)||!!expected.rule&&this.evaluation.ruleValue(expected,latest.data)!==this.evaluation.ruleValue(expected,data)||this.measurementChanged(expected,latest,data))));
  }
  measurementChanged(expected:import('./strategy-types.ts').Expectation,latest:Evidence,data:unknown){
    const plan=expected.measurement;if(!plan)return false;
    const previous=qualityChecks(plan,latest.data,latest.observedAt),current=qualityChecks(plan,data,now());
    // Fresh timestamps alone do not wake work every poll; quality transitions and sample changes do.
    const signature=(rows:typeof previous)=>JSON.stringify(rows.map((r,i)=>[r.status,i===0?undefined:r.observedValue]));
    return signature(previous)!==signature(current)||(previous[0].status==='passed'&&qualityChecks(plan,latest.data,now())[0].status!=='passed'&&current[0].status==='passed');
  }
  evidenceObserved(evidence:Evidence){
    for(const row of this.active(evidence.projectId))if(row.expectations?.some(expected=>this.evaluation.matches(expected,evidence)&&evidence.createdAt>=row.createdAt&&evidence.observedAt>=expected.notBefore&&evidence.observedAt<=expected.deadline)){
      this.notify(row.projectId,'收到约定来源的新证据，核对原始预期与约束',row.id);this.loop.wake(row.channelId,'收到预期核对证据');
    }
  }
  sourceChanged(sourceId:string,reason:string){
    const source=this.store.get<FeedbackWatch>('loop_watches',sourceId)||this.store.get<Release>('loop_releases',sourceId);
    if(!source)return;
    for(const decision of this.active(source.projectId)){
      const itemIds='itemIds' in source?source.itemIds:source.itemId?[source.itemId]:[];
      if(decision.watchIds.includes(sourceId)||decision.channelId===source.channelId||(decision.itemId&&itemIds.includes(decision.itemId))){
        this.notify(source.projectId,reason,decision.id);this.loop.wake(decision.channelId,reason);
      }
    }
  }
  finish(run:Run){
    const channel=this.store.get<Channel>('channels',run.channelId);
    if(!channel||!this.store.get<any>('controls',channel.id)?.enabled)return;
    const decision=this.active(run.projectId).find(d=>d.channelId===channel.id);if(!decision)return;
    const view=this.decisionView(decision);
    const basisDeadlines=[...decision.understandingRefs.map(ref=>this.store.get<Understanding>('strategy_understanding',ref.id)?.reviewAt),...(decision.memoryRefs||[]).filter(ref=>ref.kind==='understanding'&&ref.use!=='not_applicable').map(ref=>{const row=this.store.get<Understanding>('strategy_understanding',ref.id);return row?.status==='active'&&row.reviewAt>decision.createdAt?row.reviewAt:undefined;})].filter((v):v is string=>!!v);
    const next=view.reviewReasons.length?new Date(Date.now()+30000).toISOString():[decision.reviewAt,...basisDeadlines,...(decision.expectations||[]).map(row=>row.deadline)].sort()[0];
    if(!channel.nextRunAt||next<channel.nextRunAt)this.store.put('channels',{...channel,nextRunAt:next});
  }
  read(scope:Scope,operation:string,input:Record<string,any>){
    this.loop.scope(scope);
    if(operation==='memory.recall')return this.memory.recall(scope,input);
    if(operation==='memory.search'){
      keys(input,['query','kind','limit','offset']);const query=string(input.query??'','query',300,true).trim();const limit=integer(input.limit??15,'limit',1,30),offset=integer(input.offset??0,'offset',0,10000);
      const kinds=input.kind?[choice(input.kind,'kind',Object.keys(tables) as (keyof typeof tables)[])]:Object.keys(tables) as (keyof typeof tables)[];
      const terms=query.toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0,8);
      const conditions=terms.map(()=>"instr(lower(data),?)>0").join(' AND ');
      const sql=kinds.map(kind=>`SELECT '${kind}' AS kind,data FROM ${tables[kind]} WHERE json_extract(data,'$.projectId')=?${conditions?` AND ${conditions}`:''}`).join(' UNION ALL ');
      const params=kinds.flatMap(()=>[scope.projectId,...terms]);
      const rows=this.store.db.prepare(`SELECT * FROM (${sql}) ORDER BY json_extract(data,'$.updatedAt') DESC LIMIT ? OFFSET ?`).all(...params,limit+1,offset) as {kind:keyof typeof tables;data:string}[];
      return {matches:rows.slice(0,limit).map(r=>{const v=JSON.parse(r.data);return {kind:r.kind,id:v.id,title:v.title||v.options[v.selected].title,status:v.status,excerpt:(v.statement||v.review?.conclusion||v.rationale||'').slice(0,600),updatedAt:v.updatedAt};}),hasMore:rows.length>limit,nextOffset:offset+Math.min(limit,rows.length)};
    }
    keys(input,['kind','id','beforeRevision']);const kind=choice(input.kind,'kind',Object.keys(tables) as (keyof typeof tables)[]);const id=text(input.id,'id',200);
    const record=this.store.get<any>(tables[kind],id);if(record?.projectId!==scope.projectId)throw new APIError(404,'记录不属于当前项目');
    const before=integer(input.beforeRevision??2147483647,'beforeRevision',1,2147483647);
    const rows=this.store.db.prepare("SELECT data FROM strategy_revisions WHERE json_extract(data,'$.projectId')=? AND json_extract(data,'$.recordId')=? AND json_extract(data,'$.kind')=? AND json_extract(data,'$.revision')<? ORDER BY json_extract(data,'$.revision') DESC LIMIT 21").all(scope.projectId,id,kind,before) as {data:string}[];
    const history=rows.slice(0,20).map(r=>JSON.parse(r.data).data);
    return {record,history,hasMore:rows.length>20,beforeRevision:history.at(-1)?.revision};
  }
  /** Revalidate a stored review intent without requiring its original native turn to stay open. */
  review(scope:Scope,input:Record<string,any>,verified?:Verification){
    const time=now();
    keys(input,['id','revision','outcome','conclusion','evidenceIds','nextDirection','assessment']);
    const row=this.store.get<StrategyDecision>('strategy_decisions',text(input.id,'id',200));
    if(row?.projectId!==scope.projectId)throw new APIError(404,'行动不属于当前项目');
    if(row.revision!==input.revision||row.status!=='active')throw new APIError(409,'行动已复盘或更新，请先读取最新记录');
    const outcome=choice(input.outcome,'outcome',['improved','not_improved','inconclusive','abandoned'] as const),evidenceIds=this.loop.refs(scope,input.evidenceIds||[]);
    const assessment=row.evaluationVersion?this.evaluation.assess(scope,row,input.assessment,time):undefined;
    if(!assessment&&input.assessment!==undefined)throw new APIError(400,'旧行动没有预先保存的逐项预期，不能事后补成已经核对');
    if(assessment){this.evaluation.requireOutcome(outcome,assessment);evidenceIds.push(...assessment.results.flatMap(r=>r.evidenceIds));}
    if(['improved','not_improved'].includes(outcome)&&!evidenceIds.some(id=>this.store.get<Evidence>('loop_evidence',id)?.origin!=='agent'))throw new APIError(400,'效果判断需要实际采集证据；尚不能判断时使用 inconclusive');
    const review:NonNullable<StrategyDecision['review']>={outcome,evidenceIds:[...new Set(evidenceIds)],conclusion:text(input.conclusion,'conclusion'),nextDirection:text(input.nextDirection,'nextDirection'),runId:scope.runId,channelId:scope.channelId,createdAt:time,...(assessment?{assessment}:{})};
    if(row.evaluationVersion===2&&outcome==='improved'){
      const verification=verified||this.loop.verification.request(scope,{decisionId:row.id,evidenceIds:review.evidenceIds});
      if(verified&&(this.loop.verification.requirePassed(scope,row.itemId,row.id).id!==verified.id||review.evidenceIds.some(id=>!verified.evidenceIds.includes(id))))throw new APIError(409,'复核未覆盖当前复盘证据');
      if(verification.status!=='passed'||!this.loop.verification.current(verification)){
        const completion=this.loop.verification.defer(scope,verification,'decision.review',row.id,row.revision,input);
        return {...this.decisionView(row,scope.runId),pendingVerification:true,verificationId:verification.id,finalizationId:completion.id};
      }
    }
    const updated:StrategyDecision={...row,status:'reviewed',revision:row.revision+1,updatedAt:time,review};
    this.checkpoint('decision',updated);this.loop.audit(scope,'decision.reviewed',`复盘：${row.options[row.selected].title}`,row.itemId,updated,verified?'system':'agent');return this.decisionView(updated);
  }
  mutate(scope:Scope,operation:string,input:Record<string,any>){
    const {project,channel}=this.loop.scope(scope);const time=now();
    const base={id:randomUUID(),projectId:project.id,channelId:channel.id,runId:scope.runId,createdAt:time,updatedAt:time,revision:1};
    if(operation==='understanding.upsert'){
      keys(input,['id','revision','kind','title','statement','relevance','verification','status','evidenceIds','reviewAt']);
      const old=input.id?this.store.get<Understanding>('strategy_understanding',text(input.id,'id',200)):undefined;
      if(input.id&&old?.projectId!==project.id)throw new APIError(404,'认识不属于当前项目');
      if(old&&old.revision!==input.revision)throw new APIError(409,'项目认识已更新，请读取并合并');
      const kind=choice(input.kind,'kind',['fact','assumption','unknown','capability','constraint'] as const),status=choice(input.status??'active','status',['active','invalidated','retired'] as const);
      const evidenceIds=this.loop.refs(scope,input.evidenceIds||[]);
      if((kind==='fact'||status==='invalidated')&&!evidenceIds.length)throw new APIError(400,'事实或推翻旧认识需要可追溯证据；不确定时记录 assumption/unknown');
      const title=text(input.title,'title',300);
      if(!old&&this.loop.rows<Understanding>('strategy_understanding',project.id).some(r=>r.title.toLocaleLowerCase()===title.toLocaleLowerCase()))throw new APIError(409,'已有同名认识，请更新原记录并保留版本');
      const row:Understanding={...base,id:old?.id||base.id,createdAt:old?.createdAt||time,revision:(old?.revision||0)+1,kind,status,title,statement:text(input.statement,'statement'),relevance:text(input.relevance,'relevance'),verification:text(input.verification,'verification'),reviewAt:deadline(input.reviewAt),evidenceIds};
      this.checkpoint('understanding',row);
      this.memoryChanged(project.id,'understanding',row.id);
      this.loop.audit(scope,'understanding.updated',`${title}：${status}`,undefined,row);return row;
    }
    if(operation==='decision.choose'){
      keys(input,['objectiveVersion','options','selected','rationale','nextStep','expectedOutcome','evaluation','stopWhen','understandingRefs','memoryRefs','evidenceIds','watchIds','reviewAt','maxRuns','itemId','expectations']);
      const objective=this.objective(project,channel);
      if(input.objectiveVersion!==objective.version)throw new APIError(409,'目标或方向已变化，先读取最新 context 再选择行动');
      const active=this.active(project.id);
      if(active.some(r=>r.channelId===channel.id))throw new APIError(409,'先复盘本频道上次的选择，再建立下一次行动');
      const item=this.loop.item(scope,input.itemId);
      if(item&&active.some(r=>r.itemId===item.id))throw new APIError(409,'另一个频道正在推进这个 feature，请先协调已有行动');
      if(!Array.isArray(input.options)||!input.options.length||input.options.length>6)throw new APIError(400,'提供 1 到 6 个候选方向；不必凑数');
      const options:ActionOption[]=input.options.map((v:unknown)=>{const o=object(v);keys(o,['title','kind','benefit','cost','uncertainty']);return {title:text(o.title,'title',300),kind:choice(o.kind,'kind',['act','investigate','build_capability','observe','stop'] as const),benefit:text(o.benefit,'benefit',2000),cost:text(o.cost,'cost',2000),uncertainty:text(o.uncertainty,'uncertainty',2000)};});
      const selected=integer(input.selected,'selected',0,options.length-1);
      if(active.some(r=>r.options[r.selected].title.toLocaleLowerCase()===options[selected].title.toLocaleLowerCase()))throw new APIError(409,'同一项目已有同名行动，请协调避免重复工作');
      if(!Array.isArray(input.understandingRefs??[])||(input.understandingRefs||[]).length>30)throw new APIError(400,'understandingRefs 必须为不超过 30 项的数组');
      const understandingRefs=(input.understandingRefs||[]).map((v:unknown)=>{const ref=object(v);keys(ref,['id','revision']);const id=text(ref.id,'id',200);const u=this.store.get<Understanding>('strategy_understanding',id);if(u?.projectId!==project.id)throw new APIError(404,'认识不属于当前项目');if(u.status!=='active'||u.reviewAt<=time||u.revision!==ref.revision)throw new APIError(409,'引用的认识已变化、失效或到期，先复查再决策');return {id,revision:u.revision};});
      const watchIds=ids(input.watchIds||[],'watchIds');for(const id of watchIds)if(this.store.get<FeedbackWatch>('loop_watches',id)?.projectId!==project.id)throw new APIError(404,'观察条件不属于当前项目');
      const row:StrategyDecision={...base,objective,options,selected,rationale:text(input.rationale,'rationale'),nextStep:text(input.nextStep,'nextStep'),expectedOutcome:text(input.expectedOutcome,'expectedOutcome'),evaluation:text(input.evaluation,'evaluation'),stopWhen:text(input.stopWhen,'stopWhen'),understandingRefs,evidenceIds:this.loop.refs(scope,input.evidenceIds||[]),watchIds,reviewAt:deadline(input.reviewAt),maxRuns:integer(input.maxRuns??3,'maxRuns',1,32),signalCursor:this.cursor(project.id),status:'active',...(item?{itemId:item.id}:{})};
      row.memoryRefs=this.memory.references(scope,input.memoryRefs||[]);
      row.evaluationVersion=2;row.expectations=this.evaluation.plan(scope,input.expectations,time,options[selected].kind);
      row.evidenceCursor=Number((this.store.db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM loop_evidence').get() as any).n);
      row.watchIds=[...new Set([...row.watchIds,...row.expectations.flatMap(e=>e.source.kind==='watch'?[e.source.watchId]:[])])];
      this.checkpoint('decision',row);this.prepare(this.store.get<Run>('runs',scope.runId)!);this.loop.audit(scope,'decision.chosen',`选择下一步：${options[selected].title}`,item?.id,row);return this.decisionView(row,scope.runId);
    }
    if(operation==='decision.review')return this.review(scope,input);
    throw new APIError(400,'未知的项目决策操作');
  }
}

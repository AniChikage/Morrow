import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APIError, choice, integer, keys, object, string, itemKinds, itemStatuses } from './protocol.ts';
import type { Channel, Project, Run, WorkItem } from './protocol.ts';
import type { Evidence, Learning, FeedbackWatch, Release, ProjectLoop } from './autonomy-types.ts';
import { Store, now } from './store.ts';
import { ProjectStrategy } from './project-strategy.ts';
import { WorkVerification } from './work-verification.ts';
import { ExecutionEvidence } from './execution-evidence.ts';

export type Scope={id:string; projectId:string; channelId:string; runId:string; expiresAt:string};
type Wait={id:string; projectId:string; runId:string; watchIds:string[]; releaseIds:string[]; deadline:string; reason:string; status:'waiting'|'ready'; event?:string};
const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const text=(value:unknown,field:string,max=10000)=>string(value,field,max);
const list=(value:unknown,field:string,max=50):string[]=>{
  if(!Array.isArray(value)||value.length>max)throw new APIError(400,`${field} 必须为数组，最多 ${max} 项`);
  return [...new Set(value.map(v=>text(v,field,200)))];
};
function timestamp(value:unknown,field:string){const v=text(value,field,40);if(!Number.isFinite(Date.parse(v)))throw new APIError(400,`${field} 时间无效`);return new Date(v).toISOString();}
function endpoint(value:unknown){const raw=text(value,'url',4096);let url:URL;try{url=new URL(raw);}catch{throw new APIError(400,'反馈/发布地址无效');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash)throw new APIError(400,'仅支持不含用户名密码的 HTTP(S) 地址');return url.href;}
function valueAt(data:unknown,pointer:string):unknown {
  if(pointer==='')return data;
  if(!pointer.startsWith('/'))throw new APIError(400,'pointer 使用 JSON Pointer，例如 /metrics/activation');
  return pointer.slice(1).split('/').reduce<unknown>((v,key)=>v!==null&&typeof v==='object'?Object.getOwnPropertyDescriptor(v,key.replaceAll('~1','/').replaceAll('~0','~'))?.value:undefined,data);
}
async function jsonRequest(url:string,init:RequestInit={}) {
  const response=await fetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error(`HTTP ${response.status}`);
  const chunks:Uint8Array[]=[];let bytes=0;
  if(response.body)for await(const chunk of response.body as any){bytes+=chunk.length;if(bytes>512*1024)throw new Error('响应超过 512 KB');chunks.push(chunk);}
  const raw=Buffer.concat(chunks).toString('utf8');return {data:JSON.parse(raw),hash:digest(raw)};
}

export class ProjectWorkLoop {
  store:Store; home:string; baseURL=''; closed=false;
  pending=new Set<Promise<unknown>>(); inFlight=new Set<string>();
  strategy:ProjectStrategy;
  verification:WorkVerification;
  executions:ExecutionEvidence;
  constructor(store:Store,home:string){this.store=store;this.home=home;this.strategy=new ProjectStrategy(this);this.verification=new WorkVerification(this);this.executions=new ExecutionEvidence(this);}
  rows<T>(table:string,projectId:string):T[]{return this.store.db.prepare(`SELECT data FROM ${this.store.table(table)} WHERE json_extract(data,'$.projectId')=? ORDER BY rowid`).all(projectId).map((r:any)=>JSON.parse(r.data));}
  view(projectId:string,itemId?:string):ProjectLoop {
    const linked=(r:any)=>!itemId||r.itemId===itemId||r.itemIds?.includes(itemId);
    const learning=this.rows<Learning>('loop_learning',projectId).filter(linked).slice(-150);
    const allReleases=this.rows<Release>('loop_releases',projectId).filter(linked);
    const releases=allReleases.filter((row,index)=>row.status==='awaiting_approval'||index>=allReleases.length-50);
    const strategy=this.strategy.view(projectId,itemId);
    const references=new Set([...learning.flatMap(row=>row.evidenceIds),...releases.flatMap(row=>row.checks.flatMap(check=>check.evidenceIds)),...strategy.understanding.flatMap(row=>row.evidenceIds),...strategy.decisions.flatMap(row=>[...row.evidenceIds,...(row.review?.evidenceIds||[]),...(row.memoryRefs||[]).flatMap(ref=>ref.snapshot.evidenceIds)])]);
    const verifications=this.verification.view(projectId,itemId,releases.flatMap(row=>row.verificationIds||[]));for(const row of verifications)for(const id of row.evidenceIds)references.add(id);
    const allEvidence=this.rows<Evidence>('loop_evidence',projectId);const recent=new Set(allEvidence.filter(linked).slice(-100).map(row=>row.id));
    return {evidence:allEvidence.filter(row=>recent.has(row.id)||references.has(row.id)),learning,watches:this.rows<FeedbackWatch>('loop_watches',projectId).filter(linked).slice(-100),releases,strategy,verifications,finalizations:this.verification.finalizations(projectId,itemId)};
  }
  audit(scope:Pick<Scope,'projectId'|'channelId'|'runId'>,action:string,summary:string,itemId?:string,changes?:unknown,actor:'agent'|'system'|'human'='agent') {
    this.store.event(scope.channelId,scope.runId,'system',summary,undefined,{projectId:scope.projectId,itemId,actor,action,...(changes?{changes:{after:changes}}:{})});
  }
  prepare(run:Run):string {
    if(!this.baseURL)return '';
    this.strategy.prepare(run);
    const secret=randomBytes(32).toString('hex');const scope:Scope={id:digest(secret),projectId:run.projectId,channelId:run.channelId,runId:run.id,expiresAt:new Date(Date.now()+24*3600000).toISOString()};
    this.store.put('loop_grants',scope);
    const directory=join(this.home,'runs',run.id);mkdirSync(directory,{recursive:true,mode:0o700});const path=join(directory,'agent-context.json');
    writeFileSync(path,JSON.stringify({url:`${this.baseURL}/api/agent`,token:secret}),{mode:0o600});
    const command=[process.execPath,fileURLToPath(new URL('./agent-cli.ts',import.meta.url)),'--context',path].map(v=>"'"+v.replaceAll("'","'\\''")+"'").join(' ');
    return `\nNoHuman 已提供本轮专用工具（只能管理本项目，不能批准上线）。在原生工具中执行：\n${command} --operation context\n写操作将 JSON 通过 --input - 从标准输入传入，或写入临时文件后执行同一命令，附加 --operation 操作名 --input 文件路径 --request-id 稳定唯一ID。标准输入推荐用带引号的 heredoc 一次传入，不要为读取 JSON 启动交互式 TTY。同一次重试沿用相同 ID 和内容。context 返回操作说明和项目共享认识。先读取它；重要发现、feature、尝试及等待条件在工作过程中及时落库，不要只留在最终回复。不得读取或输出 agent-context.json 中的凭证。\n`;
  }
  authenticate(authorization:string):Scope {
    const token=authorization.startsWith('Bearer ')?authorization.slice(7):'';
    const grant=this.store.get<Scope>('loop_grants',digest(token));
    if(!grant||grant.expiresAt<now())throw new APIError(401,'原生工作接口凭证已失效');return grant;
  }
  scope(scope:Scope){const channel=this.store.get<Channel>('channels',scope.channelId);const project=this.store.get<Project>('projects',scope.projectId);const run=this.store.get<Run>('runs',scope.runId);if(!project||project.isDemo||channel?.projectId!==project.id||run?.projectId!==project.id||run.channelId!==channel.id||run.status!=='running')throw new APIError(409,'本轮已结束，等待下一原生工作轮次后继续');return {project,channel,run};}
  item(scope:Scope,id:unknown,optional=true){if(id===undefined&&optional)return undefined;const item=this.store.get<WorkItem>('items',text(id,'itemId',200));if(!item||item.projectId!==scope.projectId)throw new APIError(404,'feature 不属于当前项目');return item;}
  refs(scope:Scope,ids:unknown){const result=list(ids,'evidenceIds');for(const id of result)if(this.store.get<Evidence>('loop_evidence',id)?.projectId!==scope.projectId)throw new APIError(404,'证据不属于当前项目');return result;}
  linkEvidence(entry:Evidence){
    if(!entry.itemId)return;const item=this.store.get<WorkItem>('items',entry.itemId);
    if(!item||item.projectId!==entry.projectId||item.evidence.some(value=>value.startsWith(`[${entry.id}]`)))return;
    this.store.put('items',{...item,evidence:[...item.evidence,`[${entry.id}] ${entry.summary}\n来源：${entry.source}`],revision:item.revision+1,updatedAt:now()});
  }
  context(scope:Scope,input:Record<string,any>) {
    keys(input,['itemId']);const {project,channel}=this.scope(scope);const item=this.item(scope,input.itemId);
    const view=this.view(project.id,item?.id);
    const evidence=view.evidence.map(row=>{const raw=typeof row.data==='string'?row.data:JSON.stringify(row.data);return raw.length>2000?{...row,data:raw.slice(0,2000),truncated:true}:row;});
    const learning=view.learning.slice(-12).map(row=>{const truncated=[row.rationale,row.expectedResult,row.evaluation,row.conclusion].some(value=>value.length>500);return {...row,rationale:row.rationale.slice(0,500),expectedResult:row.expectedResult.slice(0,500),evaluation:row.evaluation.slice(0,500),conclusion:row.conclusion.slice(0,500),...(truncated?{truncated:true}:{})};});
    const learningTotal=Number((this.store.db.prepare(`SELECT COUNT(*) AS n FROM loop_learning WHERE json_extract(data,'$.projectId')=?${item?" AND json_extract(data,'$.itemId')=?":''}`).get(...(item?[project.id,item.id]:[project.id])) as any).n);
    return {project:{id:project.id,name:project.name,goal:project.goal},channel:{id:channel.id,goal:channel.goal},strategy:this.strategy.context(scope,item?.id),learningCoverage:{total:learningTotal,included:learning.length,partial:learningTotal>learning.length,readMore:'这里只列最近 12 条摘要；历史和全文用 memory.recall/search/read 读取。'},features:item?[item]:this.store.projectItems(project.id),learning,evidence,watches:view.watches,releases:view.releases,verifications:view.verifications,finalizations:view.finalizations,executions:this.rows<any>('loop_executions',project.id).slice(-12),operations:{
      'understanding.upsert':'{id?, revision?(更新必需), kind:fact|assumption|unknown|capability|constraint, title, statement, relevance, verification, status:active|invalidated|retired, evidenceIds:[], reviewAt:ISO时间}；只保存影响决策的认识，事实与推翻需证据；沿用旧 ID 保留版本。verification 写明如何复查，过期认识需要更新后才能成为行动依据。',
      'decision.choose':'{objectiveVersion:strategy.objective.version, options:[{title,kind:act|investigate|build_capability|observe|stop,benefit,cost,uncertainty}], selected:从0开始的索引, rationale, nextStep, expectedOutcome, evaluation, stopWhen, expectations:[{id,kind:outcome|guardrail,claim,scope,source:{kind:file,path}|{kind:watch,watchId}|{kind:execution,command},verification,disconfirm,notBefore?:ISO时间,deadline:ISO时间,rule?:{pointer:JSON-Pointer,operator:gte|lte|equals,expected:标量}}], understandingRefs:[{id,revision}], memoryRefs?:[{kind:understanding|decision|learning,id,revision,use:apply|adapt|avoid|not_applicable,reason}], evidenceIds:[], watchIds:[], reviewAt:ISO时间, maxRuns:1..32, itemId?}；expectations 需要 1..8 项，至少一项 outcome；stop 可为空。事先约定观察的实际文件（可以尚未创建）或现有 watch，以及适用对象/版本、验证办法、反证和观察期限。notBefore 默认选择时刻；需要等样本成熟时明确设置。测试/构建使用 execution 来源并先 execution.prepare，rule 核对 /exitCode equals 0；watch 证据保存完整 HTTP JSON 响应，rule.pointer 从原始响应字段开始，例如 /checkStatus，不会包装成 /value；其他可核对数值用 rule，定性结果省略 rule 并说明验证办法；不能虚构量化收益。将不能牺牲的目标条件列为 guardrail。原始预期不可修改，变更口径需复盘后建立新行动并说明差异。每频道一个选择，不重复占用 feature；参考经验保存版本与适用理由。',
      'decision.review':'{id,revision,outcome:improved|not_improved|inconclusive|abandoned,conclusion,evidenceIds:[],nextDirection,assessment:{results:[{expectationId,verdict:met|not_met|unknown,reason,evidenceIds:[]}],conditions:matched|changed|unknown,conditionReason,diagnosis:expected|pending|measurement|execution|assumption|environment|uncertain,explanation,adjustment:continue|observe|measurement|method|assumption|stop,understandingRefs?:[{id,revision}]}}；新行动必须逐项核对全部 expectations。引用约定来源、观察窗口内的新证据，包含最新观察，旧基线和 agent 陈述不能证明效果。rule 由系统核对实际 JSON 字段；缺字段/类型不符为 unknown。条件不可比、数据未到或采集故障用 inconclusive；全部预期和 guardrail 有证据支持才可 improved。原因不明可以明确 uncertain，观测到变化不等于因果已证明。诊断记录应区分执行、假设、环境与观测问题；adjustment=assumption 时先用 understanding.upsert 保存新认识/修订，再引用准确版本。旧行动无 evaluationVersion 时仍按旧格式复盘，不伪造事前预期。',
      'memory.search':'{query?:关键词（空格分隔时都需匹配）,kind?:understanding|decision|learning,limit?:1..30,offset?}；搜索本项目全部历史认识、行动复盘及经验，不受 context 最近记录数量限制。只读，无需 requestId。',
      'memory.recall':'{query?:拟解决的问题或候选行动,itemId?,limit?:1..12}；按项目内文字相关性和同一 feature 召回历史认识、复盘及经验，包含失败与失效记录。省略 query 时按当前方向召回；context.strategy.relatedMemory 自动提供最多 6 条。排序不是可信度，先 memory.read 核对全文和条件，再用 decision.choose.memoryRefs 记录适用性。只读，无需 requestId。',
      'memory.read':'{kind:understanding|decision|learning,id,beforeRevision?}；读取完整记录及分页版本历史。只读，无需 requestId。',
      'feature.upsert':'{id?, revision?(更新必需), title, summary, kind:feature|issue|opportunity|hypothesis, status:open|investigating|verified|resolved|blocked, evidenceIds:[], nextStep}；同一 feature 沿用 ID，引用真实证据。',
      'evidence.record':'{itemId?, summary, source, observedAt, data?}；记录为 agent 陈述，不能伪装为系统观测。',
      'evidence.capture':'{itemId?, summary, path}；读取项目内实际文件，保存内容与 SHA256，可用于测试日志或分析数据。',
      'evidence.read':'{id}；读取本项目某条证据的完整内容；context 中较长的证据会标记 truncated。',
      'execution.prepare':'{command:实际原生命令的完整字符串}；测试/构建前调用，框架封存当前源版本。随后在同一原生轮次、项目根目录执行完全相同命令。NoHuman 直接从原生事件保存命令、输出、退出码、任务/轮次和执行前后源版本；execution.read 读取。不要用自行生成的 JSON 或 package.json 证明执行成功。',
      'execution.read':'{id}；读取准备记录及自动采集的原生执行证据。未收到开始事件、输出不完整、版本变化或没有退出码时不能证明成功。',
      'verification.request':'{itemId?,decisionId?,evidenceIds:[]}；准备完实际证据后发起有界独立只读复核。不传执行者的通过结论。事先保存的预期是验收条件；有关联预期时，补充 feature 进度说明不会使复核失效。已覆盖的证据子集复用同次复核，新原始观测仍须核对；修正后提交新版本/新证据。读取 verification.read 或 context 中的结果，把反例交回本任务修正。新行动 improved 与 feature 完成会自动触发此步骤，尚未通过时返回 pendingVerification，不能当成已完成。',
      'verification.read':'{id}；读取独立复核结论、问题、源版本是否仍有效和原生记录。queued/running 时可以做独立工作，或 wait 等待（不紧密轮询）；已提交的 decision.review/feature 完成请求会在通过后自动落库，不需要再花一轮重提；从 context.finalizations 查看 applied/stale/rejected。旧 requestId 仍只重放原回执，请读取当前状态。stale 时先合并新版本再提交；failed/unknown 时先解决反例或缺少的证据。',
      'verification.retry':'{id}；环境恢复后重试尚未判断的复核，原记录不可覆盖，相同材料每天最多两次，仍计入频道预算。failed 必须先修正反例。重试会接续仍有效的原完成请求，并带上有界的前次工具观察；仍须本轮独立检查，不能继承旧结论。',
      'learning.upsert':'{id?, revision?, itemId?, kind:outcome|hypothesis|experiment, title, rationale, expectedResult, evaluation, conclusion, status:active|supported|refuted|inconclusive|stopped, evidenceIds:[]}；目标成效、竞争解释与尝试都可记录，结论更新引用新证据。',
      'watch.create':'{itemId?, title, url, pointer, condition:changed|gte|lte|equals, expected?, intervalSeconds:30..86400, deadline:ISO时间, releaseId?, continuous?:boolean}；默认持续监测，条件满足或到期后仍采集同一字段的新变化并唤醒，直到显式取消或频道暂停。deadline 是复查期限；一次性实验可设置 continuous:false。changed 首次采样只建立基线。关联 releaseId 时上线后采样。',
      'watch.cancel':'{id}；停止已不再有价值的观测。',
      'wait':'{watchIds:[], releaseIds:[], deadline:ISO时间, reason}；任一条件满足或截止后唤醒，保持自动工作开关；有独立工作可做时不要等待。',
      'release.propose':'{itemIds:[], title, changes, rationale, expectedBenefit, checks:[{name,result:passed|not_verified,evidenceIds:[]}], risks, rollback, observationPlan, artifactPath, target:{url,statusUrl,label}}；准备好的文件复制封存，变更内容不可修改。至少一项通过的检查须引用实际采集证据。人批准后由发布接口发送封存产物。',
    },releaseAdapter:'发布端接收 POST {releaseId,reviewHash,artifact:{name,sha256,base64}}，Idempotency-Key 为 releaseId；仅在响应 {releaseId,artifactSha256,status:"published",url?} 匹配时认定已上线。statusUrl 的 GET 返回同一回执用于重启/超时后核对。先在已有授权内准备真实接收端与产物，不能编造地址；缺部署能力时继续准备工作并明确缺口。',principles:'主动选择服务目标的工作，必要时先建立反馈。证据、解释和预期收益分开；效果未知时保留未知。人只在发布前批准已准备好的明确版本，AI 没有批准接口。所有频道共享此处记录；失败尝试应更新判断，避免机械重复。先读 strategy 的认识、选择与复查信号，具体工作方法由你判断；工程与运营只是可能方向。评估直接改进、获取信息、建设能力、观察或停止的价值，用 decision.choose 记录依据、验证与止损条件再推进；reviewReasons 出现时先复盘。复盘保留原预期，结果未知时可以继续观察。需要历史经验时使用 memory.search/read；失效认识只能作为历史教训。不要通过增加事项、文档或技能数量证明进展。'};
  }
  async call(scope:Scope,payload:unknown):Promise<unknown> {
    const body=object(payload);keys(body,['operation','input','requestId']);const operation=text(body.operation,'operation',80);const input=object(body.input??{});
    if(operation==='context')return this.context(scope,input);
    if(operation==='execution.read')return this.executions.read(scope,input);
    if(operation==='verification.read')return this.verification.read(scope,input);
    if(operation==='memory.search'||operation==='memory.read'||operation==='memory.recall')return this.strategy.read(scope,operation,input);
    if(operation==='evidence.read'){keys(input,['id']);this.scope(scope);const row=this.store.get<Evidence>('loop_evidence',text(input.id,'id',200));if(row?.projectId!==scope.projectId)throw new APIError(404,'证据不属于当前项目');return row;}
    const requestId=text(body.requestId,'requestId',200);const key=`${scope.runId}:${requestId}`;const hash=digest(JSON.stringify({operation,input}));
    const previous=this.store.get<any>('loop_calls',key);if(previous){if(previous.hash!==hash)throw new APIError(409,'请求 ID 已用于不同内容');return previous.result;}
    this.scope(scope);
    return this.store.transaction(()=>{const result=this.mutate(scope,operation,input,key);this.store.put('loop_calls',{id:key,hash,result,projectId:scope.projectId,runId:scope.runId});return result;});
  }
  file(scope:Scope,path:unknown,maxBytes:number){const {project}=this.scope(scope);const root=realpathSync(project.path);let actual:string;try{actual=realpathSync(isAbsolute(String(path))?text(path,'path',4096):join(root,text(path,'path',4096)));}catch{throw new APIError(400,'文件不存在');}const rel=relative(root,actual);if(rel.startsWith('..')||isAbsolute(rel))throw new APIError(403,'只接受当前项目目录内的文件');const stat=statSync(actual);if(!stat.isFile()||stat.size>maxBytes)throw new APIError(400,`必须是小于 ${maxBytes} 字节的普通文件`);return {actual,bytes:readFileSync(actual)};}
  mutate(scope:Scope,operation:string,input:Record<string,any>,key:string):unknown {
    const {project}=this.scope(scope);const time=now();
    if(operation==='execution.prepare')return this.executions.prepare(scope,input);
    if(operation==='verification.request')return this.verification.request(scope,input);
    if(operation==='verification.retry')return this.verification.retry(scope,input);
    if(['understanding.upsert','decision.choose','decision.review'].includes(operation))return this.strategy.mutate(scope,operation,input);
    if(operation==='feature.upsert'||operation==='release.propose')this.strategy.requireCurrent(scope);
    const base={id:randomUUID(),projectId:scope.projectId,channelId:scope.channelId,runId:scope.runId,createdAt:time};
    if(operation==='feature.upsert') {
      keys(input,['id','revision','title','summary','kind','status','evidenceIds','nextStep']);const old=input.id?this.item(scope,input.id,false):undefined;
      if(old&&input.revision!==old.revision)throw new APIError(409,'feature 已更新，请读取最新版本再合并');
      const evidenceIds=this.refs(scope,input.evidenceIds||[]);const title=text(input.title,'title',300);const status=choice(input.status,'status',itemStatuses);
      if(['verified','resolved'].includes(status)&&!evidenceIds.length)throw new APIError(400,'已验证/已解决需要证据引用');
      if(!old&&this.store.projectItems(project.id).some(v=>v.title.trim().toLocaleLowerCase()===title.toLocaleLowerCase()))throw new APIError(409,'同名 feature 已存在，请沿用其 ID');
      const evidence=evidenceIds.map(id=>{const e=this.store.get<Evidence>('loop_evidence',id)!;return `[${e.id}] ${e.summary}\n来源：${e.source}`;});
      const item:WorkItem={id:old?.id||base.id,projectId:project.id,number:old?.number||this.store.nextItemNumber(project.id),channelId:old?.channelId||scope.channelId,sourceChannelIds:[...new Set([...(old?.sourceChannelIds||[]),scope.channelId])],lastRunId:scope.runId,revision:(old?.revision||0)+1,title,summary:text(input.summary,'summary'),kind:choice(input.kind,'kind',itemKinds),status,evidence:[...new Set([...(old?.evidence||[]),...evidence])],nextStep:string(input.nextStep??'','nextStep',5000,true),createdAt:old?.createdAt||time,updatedAt:time};
      return this.store.transaction(()=>{
        this.store.put('items',{...item,status:['verified','resolved'].includes(status)?'investigating':status});
        let verification,completion;
        if(['verified','resolved'].includes(status)){
          const decision=this.strategy.view(project.id,item.id).decisions.at(-1);
          verification=this.verification.request(scope,{itemId:item.id,...(decision?{decisionId:decision.id}:{}),evidenceIds:[...new Set([...(decision?.review?.evidenceIds||[]),...evidenceIds])]});
          if(verification.status!=='passed'||!this.verification.current(verification)){
            item.status='investigating';
            completion=this.verification.defer(scope,verification,'feature.complete',item.id,item.revision,{status});
          }
        }
        this.store.put('items',item);this.audit(scope,old?'feature.updated':'feature.created',`${old?'更新':'建立'} #${item.number}「${item.title}」`,item.id,item);
        return {...item,...(verification?{verificationId:verification.id,pendingVerification:item.status==='investigating'}:{}),...(completion?{finalizationId:completion.id}:{})};
      });
    }
    if(operation==='evidence.record'||operation==='evidence.capture') {
      keys(input,operation==='evidence.capture'?['itemId','summary','path']:['itemId','summary','source','observedAt','data']);const item=this.item(scope,input.itemId);
      let source:string,data:unknown,origin:Evidence['origin'],hash:string|undefined,observedAt=time;
      if(operation==='evidence.capture'){const file=this.file(scope,input.path,512*1024);source=file.actual;data=file.bytes.toString('utf8');origin='file';hash=digest(file.bytes);}
      else{source=text(input.source,'source',4096);data=input.data??null;if(JSON.stringify(data).length>512*1024)throw new APIError(413,'证据超过 512 KB');origin='agent';observedAt=timestamp(input.observedAt,'observedAt');}
      const entry:Evidence={...base,...(item?{itemId:item.id}:{}),summary:text(input.summary,'summary',5000),source,observedAt,origin,data,...(hash?{digest:hash}:{})};
      this.store.put('loop_evidence',entry);this.linkEvidence(entry);this.strategy.evidenceObserved(entry);this.audit(scope,'evidence.recorded',entry.summary,item?.id,{id:entry.id,origin,source});return entry;
    }
    if(operation==='learning.upsert') {
      keys(input,['id','revision','itemId','kind','title','rationale','expectedResult','evaluation','conclusion','status','evidenceIds']);const item=this.item(scope,input.itemId);const old=input.id?this.store.get<Learning>('loop_learning',text(input.id,'id',200)):undefined;
      if(input.id&&old?.projectId!==scope.projectId)throw new APIError(404,'认识记录不属于当前项目');if(old&&input.revision!==old.revision)throw new APIError(409,'认识已更新，请先读取最新证据');
      const evidenceIds=this.refs(scope,input.evidenceIds||[]);const status=choice(input.status,'status',['active','supported','refuted','inconclusive','stopped'] as const);
      if(['supported','refuted'].includes(status)&&!evidenceIds.length)throw new APIError(400,'支持或推翻判断需要证据');
      const row:Learning={...base,id:old?.id||base.id,itemId:item?.id||old?.itemId,kind:choice(input.kind,'kind',['outcome','hypothesis','experiment'] as const),title:text(input.title,'title',300),rationale:text(input.rationale,'rationale'),expectedResult:text(input.expectedResult,'expectedResult'),evaluation:text(input.evaluation,'evaluation'),conclusion:string(input.conclusion??'','conclusion',10000,true),status,evidenceIds,revision:(old?.revision||0)+1,createdAt:old?.createdAt||time,updatedAt:time};
      return this.store.transaction(()=>{if(old&&!this.store.get('strategy_revisions',`learning:${old.id}:${old.revision}`))this.strategy.checkpoint('learning',old);this.strategy.checkpoint('learning',row);this.strategy.memoryChanged(project.id,'learning',row.id);this.audit(scope,'learning.updated',`${row.title}：${row.status}`,row.itemId,row);return row;});
    }
    if(operation==='watch.create') {
      keys(input,['itemId','title','url','pointer','condition','expected','intervalSeconds','deadline','releaseId','continuous']);const item=this.item(scope,input.itemId);const pointer=string(input.pointer??'','pointer',1000,true);valueAt({},pointer);
      if(input.continuous!==undefined&&typeof input.continuous!=='boolean')throw new APIError(400,'continuous 必须为布尔值');
      const condition=choice(input.condition,'condition',['changed','gte','lte','equals'] as const);if(['gte','lte'].includes(condition)&&(typeof input.expected!=='number'||!Number.isFinite(input.expected)))throw new APIError(400,'数值条件需要有限数值 expected');if(condition==='equals'&&!['string','number','boolean'].includes(typeof input.expected))throw new APIError(400,'equals 需要标量 expected');
      const deadline=timestamp(input.deadline,'deadline');if(deadline<=time)throw new APIError(400,'观察截止时间必须在未来');
      const release=input.releaseId?this.release(text(input.releaseId,'releaseId',200)):undefined;if(release&&release.projectId!==project.id)throw new APIError(404,'发布不属于当前项目');
      if(this.rows<FeedbackWatch>('loop_watches',project.id).filter(w=>w.status==='watching'||(w.continuous!==false&&w.status!=='cancelled')).length>=50)throw new APIError(409,'项目同时最多保留 50 个观察条件；不再有价值的监测请显式取消');
      const row:FeedbackWatch={...base,itemId:item?.id,title:text(input.title,'title',300),url:endpoint(input.url),pointer,condition,...(input.expected===undefined?{}:{expected:input.expected}),intervalSeconds:integer(input.intervalSeconds??60,'intervalSeconds',30,86400),deadline,continuous:input.continuous!==false,releaseId:release?.id,status:'watching',nextPollAt:time,updatedAt:time};
      this.store.put('loop_watches',row);this.audit(scope,'watch.created',row.title,item?.id,row);return row;
    }
    if(operation==='watch.cancel'){keys(input,['id']);const watch=this.store.get<FeedbackWatch>('loop_watches',text(input.id,'id',200));if(watch?.projectId!==project.id)throw new APIError(404,'观察条件不属于当前项目');const row={...watch,status:'cancelled' as const,updatedAt:time};this.store.put('loop_watches',row);this.signal(watch.channelId,watch.id,'观察已取消');return row;}
    if(operation==='wait') {
      keys(input,['watchIds','releaseIds','deadline','reason']);const watchIds=list(input.watchIds||[],'watchIds'),releaseIds=list(input.releaseIds||[],'releaseIds');
      for(const id of watchIds)if(this.store.get<FeedbackWatch>('loop_watches',id)?.projectId!==project.id)throw new APIError(404,'观察条件不属于当前项目');for(const id of releaseIds)if(this.release(id).projectId!==project.id)throw new APIError(404,'发布不属于当前项目');
      const deadline=timestamp(input.deadline,'deadline');if(deadline<=time)throw new APIError(400,'等待截止时间必须在未来');
      const row:Wait={id:scope.channelId,projectId:project.id,runId:scope.runId,watchIds,releaseIds,deadline,reason:text(input.reason,'reason'),status:'waiting'};
      this.store.put('loop_waits',row);this.audit(scope,'work.waiting',row.reason,undefined,row);return row;
    }
    if(operation==='release.propose')return this.propose(scope,input,key);
    throw new APIError(400,'未知操作；原生工作接口没有上线批准权限');
  }
  release(id:string){const row=this.store.get<Release>('loop_releases',id);if(!row)throw new APIError(404,'发布记录不存在');return row;}
  artifactPath(id:string){return join(this.home,'releases',id,'artifact');}
  propose(scope:Scope,input:Record<string,any>,key:string):Release {
    keys(input,['itemIds','title','changes','rationale','expectedBenefit','checks','risks','rollback','observationPlan','artifactPath','target']);
    const itemIds=list(input.itemIds,'itemIds');if(!itemIds.length)throw new APIError(400,'发布至少关联一个 feature');for(const id of itemIds)this.item(scope,id,false);
    const verificationIds=[...new Set(itemIds.map(id=>this.verification.requirePassed(scope,id).id))];
    if(!Array.isArray(input.checks)||!input.checks.length||input.checks.length>30)throw new APIError(400,'请提供发布验证结果');
    const checks:Release['checks']=input.checks.map((v:unknown)=>{const check=object(v);keys(check,['name','result','evidenceIds']);return {name:text(check.name,'name',300),result:choice(check.result,'result',['passed','not_verified'] as const),evidenceIds:this.refs(scope,check.evidenceIds)};});
    if(!checks.some(c=>c.result==='passed'&&c.evidenceIds.some(id=>this.store.get<Evidence>('loop_evidence',id)?.origin!=='agent')))throw new APIError(400,'至少一项通过的检查需要实际文件或 HTTP 采集证据');
    const target=object(input.target);keys(target,['url','statusUrl','label']);
    const file=this.file(scope,input.artifactPath,8*1024*1024);const id=digest(key).slice(0,32);
    const existing=this.store.get<Release>('loop_releases',id);if(existing)return existing;
    const contents={projectId:scope.projectId,channelId:scope.channelId,runId:scope.runId,itemIds,title:text(input.title,'title',300),changes:text(input.changes,'changes',20000),rationale:text(input.rationale,'rationale'),expectedBenefit:text(input.expectedBenefit,'expectedBenefit'),checks,verificationIds,risks:text(input.risks,'risks'),rollback:text(input.rollback,'rollback'),observationPlan:text(input.observationPlan,'observationPlan'),artifact:{name:basename(file.actual),sha256:digest(file.bytes),bytes:file.bytes.length},target:{url:endpoint(target.url),statusUrl:endpoint(target.statusUrl),label:text(target.label,'label',200)}};
    const directory=join(this.home,'releases',id);mkdirSync(directory,{recursive:true,mode:0o700});writeFileSync(this.artifactPath(id),file.bytes,{mode:0o600});
    const row:Release={id,...contents,reviewHash:digest(JSON.stringify(contents)),status:'awaiting_approval',createdAt:now(),updatedAt:now()};
    this.store.transaction(()=>{this.store.put('loop_releases',row);for(const itemId of itemIds)this.audit(scope,'release.proposed',`待上线确认：${row.title}`,itemId,{releaseId:id,reviewHash:row.reviewHash});});return row;
  }
  review(id:string,hash:string,decision:'approve'|'reject',feedback=''):Release {
    const row=this.release(id);if(row.reviewHash!==hash)throw new APIError(409,'待发布内容已变化，请重新查看');
    if(decision==='approve'&&['approved','publishing','published','unknown'].includes(row.status))return row;
    if(decision==='reject'&&row.status==='rejected')return row;
    if(row.status!=='awaiting_approval')throw new APIError(409,'该版本已经处理');
    if(decision==='approve'&&digest(readFileSync(this.artifactPath(id)))!==row.artifact.sha256)throw new APIError(409,'封存产物校验失败，需要重新准备发布');
    const updated:Release={...row,status:decision==='approve'?'approved':'rejected',feedback,updatedAt:now(),...(decision==='approve'?{approvedAt:now()}:{})};
    this.store.transaction(()=>{this.store.put('loop_releases',updated);for(const itemId of row.itemIds)this.audit(row,decision==='approve'?'release.approved':'release.rejected',decision==='approve'?`已确认上线：${row.title}`:`暂不上线：${feedback||row.title}`,itemId,{releaseId:id,reviewHash:hash},'human');});
    if(decision==='approve')this.track(this.publish(id));else this.signal(row.channelId,id,'发布未获确认，读取意见并调整');return updated;
  }
  track(promise:Promise<unknown>){this.pending.add(promise);void promise.catch(()=>{}).finally(()=>this.pending.delete(promise));}
  async publish(id:string){
    if(this.closed||this.inFlight.has(id))return;const row=this.release(id);if(row.status!=='approved')return;this.inFlight.add(id);
    try{
      const bytes=readFileSync(this.artifactPath(id));if(digest(bytes)!==row.artifact.sha256){this.store.put('loop_releases',{...row,status:'failed',error:'封存产物校验失败，未发送发布请求',updatedAt:now()});return;}
      this.store.put('loop_releases',{...row,status:'publishing',updatedAt:now()});
      const {data}=await jsonRequest(row.target.url,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':row.id},body:JSON.stringify({releaseId:row.id,reviewHash:row.reviewHash,artifact:{...row.artifact,base64:bytes.toString('base64')}})});
      this.receipt(id,data);
    }catch(error){this.store.put('loop_releases',{...this.release(id),status:'unknown',error:`发布结果待核对：${error instanceof Error?error.message:'连接中断'}；不会重复发送。`,updatedAt:now()});this.signal(row.channelId,id,'发布结果待核对');}
    finally{this.inFlight.delete(id);}
  }
  receipt(id:string,data:any){const row=this.release(id);if(data?.releaseId!==id||data?.artifactSha256!==row.artifact.sha256||!['published','failed'].includes(data?.status))throw new Error('回执未确认同一发布版本');const result:Release={...row,status:data.status,publishedAt:data.status==='published'?now():undefined,publishedUrl:typeof data.url==='string'?endpoint(data.url):undefined,error:data.status==='failed'?'发布端报告失败，尚未上线':undefined,updatedAt:now()};this.store.put('loop_releases',result);for(const itemId of row.itemIds)this.audit(row,`release.${result.status}`,result.status==='published'?`已上线，继续观察：${row.title}`:`上线失败：${row.title}`,itemId,{releaseId:id,receipt:data},'system');this.signal(row.channelId,id,result.status==='published'?'已上线，读取实际回执并观察效果':'上线失败，调查回执');return result;}
  async reconcile(id:string){const row=this.release(id);if(!['unknown','publishing'].includes(row.status)||this.inFlight.has(id))return row;this.inFlight.add(id);try{const url=new URL(row.target.statusUrl);url.searchParams.set('releaseId',id);const {data}=await jsonRequest(url.href);return this.receipt(id,data);}catch(error){const result={...this.release(id),status:'unknown' as const,error:`仍未确认发布结果：${error instanceof Error?error.message:'查询失败'}`,updatedAt:now()};this.store.put('loop_releases',result);return result;}finally{this.inFlight.delete(id);}}
  signal(channelId:string,sourceId:string,reason:string){
    this.strategy.sourceChanged(sourceId,reason);
    const channels=new Set([channelId]);
    for(const wait of this.store.all<Wait>('loop_waits'))if(wait.status==='waiting'&&[...wait.watchIds,...wait.releaseIds].includes(sourceId)){this.store.put('loop_waits',{...wait,status:'ready',event:reason});channels.add(wait.id);}
    for(const id of channels)this.wake(id,reason);
  }
  wake(channelId:string,reason:string){const channel=this.store.get<Channel>('channels',channelId);if(!channel||!this.store.get<any>('controls',channelId)?.enabled||channel.status==='running')return;this.store.put('channels',{...channel,status:'waiting',nextRunAt:new Date(Date.now()+5000).toISOString()});}
  finish(run:Run){const wait=this.store.get<Wait>('loop_waits',run.channelId);if(!wait||wait.runId!==run.id)return;const c=this.store.get<Channel>('channels',run.channelId)!;if(run.workDirection!==undefined&&run.workDirection!==c.goal)return;if(!this.store.get<any>('controls',c.id)?.enabled)return;const ready=wait.status==='ready'||wait.deadline<=now()||wait.watchIds.some(id=>this.store.get<FeedbackWatch>('loop_watches',id)?.status!=='watching')||wait.releaseIds.some(id=>['published','rejected','failed','unknown'].includes(this.release(id).status));this.store.put('channels',{...c,status:'waiting',nextRunAt:ready?new Date(Date.now()+5000).toISOString():wait.deadline,work:{state:'wait',focus:c.work?.focus||'跟踪工作结果',reason:wait.reason,nextStep:ready?(wait.event||'已收到变化，评估下一步'):wait.reason,runId:run.id,updatedAt:now(),awaitingReply:false}});}
  async poll(id:string){
    if(this.closed||this.inFlight.has(id))return;const watch=this.store.get<FeedbackWatch>('loop_watches',id);if(!watch||watch.status==='cancelled'||(watch.status!=='watching'&&watch.continuous===false))return;
    if(watch.status==='watching'&&watch.deadline<=now()){this.store.put('loop_watches',{...watch,status:'expired',nextPollAt:new Date(Date.now()+watch.intervalSeconds*1000).toISOString(),updatedAt:now()});this.signal(watch.channelId,id,'观察已到复查时间，证据仍不足时不要宣称有效；持续监测仍接收后续变化');return;}
    if(watch.releaseId&&this.release(watch.releaseId).status!=='published')return;
    this.inFlight.add(id);
    try{const {data,hash}=await jsonRequest(watch.url);const value=valueAt(data,watch.pointer);if(value===undefined)throw new Error('数据中不存在指定字段');const valueHash=digest(JSON.stringify(value));const changed=watch.lastDigest!==valueHash;let evidenceId=watch.lastEvidenceId;
      if(changed||this.strategy.needsObservation(watch,data)){const e:Evidence={id:randomUUID(),projectId:watch.projectId,channelId:watch.channelId,runId:watch.runId,itemId:watch.itemId,watchId:id,summary:`${watch.title}：收到实际反馈`,source:watch.url,observedAt:now(),createdAt:now(),origin:'http',data,digest:hash};this.store.transaction(()=>{this.store.put('loop_evidence',e);this.linkEvidence(e);this.strategy.evidenceObserved(e);});evidenceId=e.id;this.audit(watch,'feedback.observed',e.summary,watch.itemId,{evidenceId:e.id,watchId:id},'system');}
      const met=watch.condition==='changed'?!!watch.lastDigest&&changed:watch.condition==='equals'?value===watch.expected:typeof value==='number'&&Number.isFinite(value)&&(watch.condition==='gte'?value>=Number(watch.expected):value<=Number(watch.expected));
      const current=this.store.get<FeedbackWatch>('loop_watches',id)!;if(current.status==='cancelled')return;
      this.store.put('loop_watches',{...current,lastValue:value,lastDigest:valueHash,lastEvidenceId:evidenceId,error:undefined,status:current.status==='watching'?(met?'triggered':'watching'):current.status,updatedAt:now(),nextPollAt:new Date(Date.now()+watch.intervalSeconds*1000).toISOString()});if(current.status==='watching'?met:!!watch.lastDigest&&changed)this.signal(watch.channelId,id,`收到新的反馈：${watch.title}`);
    }catch(error){const current=this.store.get<FeedbackWatch>('loop_watches',id)!;if(current.status!=='cancelled'){const message=error instanceof Error?error.message:'反馈查询失败';this.store.put('loop_watches',{...current,error:message,updatedAt:now(),nextPollAt:new Date(Date.now()+watch.intervalSeconds*1000).toISOString()});if(current.error!==message){this.audit(watch,'feedback.unavailable',`反馈暂不可用：${watch.title} · ${message}`,watch.itemId,undefined,'system');this.signal(watch.channelId,id,`反馈暂不可用，检查数据来源：${watch.title}`);}}}
    finally{this.inFlight.delete(id);}
  }
  tick(){if(this.closed)return;this.verification.tick();const time=now();for(const row of this.store.all<Release>('loop_releases')){if(row.status==='approved')this.track(this.publish(row.id));else if(row.status==='unknown'&&Date.parse(row.updatedAt)<Date.now()-60000)this.track(this.reconcile(row.id));}for(const watch of this.store.all<FeedbackWatch>('loop_watches'))if(this.inFlight.size<4&&this.store.get<any>('controls',watch.channelId)?.enabled&&watch.status!=='cancelled'&&(watch.status==='watching'||watch.continuous!==false)&&(watch.nextPollAt<=time||(watch.status==='watching'&&watch.deadline<=time)))this.track(this.poll(watch.id));}
  recover(){this.executions.recover();this.verification.recover();for(const row of this.store.all<Release>('loop_releases'))if(row.status==='publishing')this.store.put('loop_releases',{...row,status:'unknown',error:'服务重启，先核对发布回执，不重复发送',updatedAt:now()});if(!this.store.get('migrations','loop-evidence-links-v1'))this.store.transaction(()=>{for(const evidence of this.store.all<Evidence>('loop_evidence'))this.linkEvidence(evidence);this.store.put('migrations',{id:'loop-evidence-links-v1',createdAt:now()});});}
  async close(){this.closed=true;this.verification.close();await Promise.allSettled([...this.pending]);}
}

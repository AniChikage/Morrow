import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APIError, choice, integer, keys, object, string, itemKinds, itemStatuses } from './protocol.ts';
import type { Channel, Project, Run, WorkItem } from './protocol.ts';
import type { Evidence, Learning, FeedbackWatch, Release, ProjectLoop } from './autonomy-types.ts';
import { Store, now } from './store.ts';

type Scope={id:string; projectId:string; channelId:string; runId:string; expiresAt:string};
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
  constructor(store:Store,home:string){this.store=store;this.home=home;}
  rows<T>(table:string,projectId:string):T[]{return this.store.db.prepare(`SELECT data FROM ${this.store.table(table)} WHERE json_extract(data,'$.projectId')=? ORDER BY rowid`).all(projectId).map((r:any)=>JSON.parse(r.data));}
  view(projectId:string,itemId?:string):ProjectLoop {
    const linked=(r:any)=>!itemId||r.itemId===itemId||r.itemIds?.includes(itemId);
    const learning=this.rows<Learning>('loop_learning',projectId).filter(linked).slice(-150);
    const allReleases=this.rows<Release>('loop_releases',projectId).filter(linked);
    const releases=allReleases.filter((row,index)=>row.status==='awaiting_approval'||index>=allReleases.length-50);
    const references=new Set([...learning.flatMap(row=>row.evidenceIds),...releases.flatMap(row=>row.checks.flatMap(check=>check.evidenceIds))]);
    const allEvidence=this.rows<Evidence>('loop_evidence',projectId);const recent=new Set(allEvidence.filter(linked).slice(-100).map(row=>row.id));
    return {evidence:allEvidence.filter(row=>recent.has(row.id)||references.has(row.id)),learning,watches:this.rows<FeedbackWatch>('loop_watches',projectId).filter(linked).slice(-100),releases};
  }
  audit(scope:Pick<Scope,'projectId'|'channelId'|'runId'>,action:string,summary:string,itemId?:string,changes?:unknown,actor:'agent'|'system'|'human'='agent') {
    this.store.event(scope.channelId,scope.runId,'system',summary,undefined,{projectId:scope.projectId,itemId,actor,action,...(changes?{changes:{after:changes}}:{})});
  }
  prepare(run:Run):string {
    if(!this.baseURL)return '';
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
    return {project:{id:project.id,name:project.name,goal:project.goal},channel:{id:channel.id,goal:channel.goal},features:item?[item]:this.store.projectItems(project.id),...view,evidence,operations:{
      'feature.upsert':'{id?, revision?(更新必需), title, summary, kind:feature|issue|opportunity|hypothesis, status:open|investigating|verified|resolved|blocked, evidenceIds:[], nextStep}；同一 feature 沿用 ID，引用真实证据。',
      'evidence.record':'{itemId?, summary, source, observedAt, data?}；记录为 agent 陈述，不能伪装为系统观测。',
      'evidence.capture':'{itemId?, summary, path}；读取项目内实际文件，保存内容与 SHA256，可用于测试日志或分析数据。',
      'evidence.read':'{id}；读取本项目某条证据的完整内容；context 中较长的证据会标记 truncated。',
      'learning.upsert':'{id?, revision?, itemId?, kind:outcome|hypothesis|experiment, title, rationale, expectedResult, evaluation, conclusion, status:active|supported|refuted|inconclusive|stopped, evidenceIds:[]}；目标成效、竞争解释与尝试都可记录，结论更新引用新证据。',
      'watch.create':'{itemId?, title, url, pointer, condition:changed|gte|lte|equals, expected?, intervalSeconds:30..86400, deadline:ISO时间, releaseId?, continuous?:boolean}；默认持续监测，条件满足或到期后仍采集同一字段的新变化并唤醒，直到显式取消或频道暂停。deadline 是复查期限；一次性实验可设置 continuous:false。changed 首次采样只建立基线。关联 releaseId 时上线后采样。',
      'watch.cancel':'{id}；停止已不再有价值的观测。',
      'wait':'{watchIds:[], releaseIds:[], deadline:ISO时间, reason}；任一条件满足或截止后唤醒，保持自动工作开关；有独立工作可做时不要等待。',
      'release.propose':'{itemIds:[], title, changes, rationale, expectedBenefit, checks:[{name,result:passed|not_verified,evidenceIds:[]}], risks, rollback, observationPlan, artifactPath, target:{url,statusUrl,label}}；准备好的文件复制封存，变更内容不可修改。至少一项通过的检查须引用实际采集证据。人批准后由发布接口发送封存产物。',
    },releaseAdapter:'发布端接收 POST {releaseId,reviewHash,artifact:{name,sha256,base64}}，Idempotency-Key 为 releaseId；仅在响应 {releaseId,artifactSha256,status:"published",url?} 匹配时认定已上线。statusUrl 的 GET 返回同一回执用于重启/超时后核对。先在已有授权内准备真实接收端与产物，不能编造地址；缺部署能力时继续准备工作并明确缺口。',principles:'主动选择服务目标的工作，必要时先建立反馈。证据、解释和预期收益分开；效果未知时保留未知。人只在发布前批准已准备好的明确版本，AI 没有批准接口。所有频道共享此处记录；失败尝试应更新判断，避免机械重复。'};
  }
  async call(scope:Scope,payload:unknown):Promise<unknown> {
    const body=object(payload);keys(body,['operation','input','requestId']);const operation=text(body.operation,'operation',80);const input=object(body.input??{});
    if(operation==='context')return this.context(scope,input);
    if(operation==='evidence.read'){keys(input,['id']);this.scope(scope);const row=this.store.get<Evidence>('loop_evidence',text(input.id,'id',200));if(row?.projectId!==scope.projectId)throw new APIError(404,'证据不属于当前项目');return row;}
    const requestId=text(body.requestId,'requestId',200);const key=`${scope.runId}:${requestId}`;const hash=digest(JSON.stringify({operation,input}));
    const previous=this.store.get<any>('loop_calls',key);if(previous){if(previous.hash!==hash)throw new APIError(409,'请求 ID 已用于不同内容');return previous.result;}
    this.scope(scope);
    return this.store.transaction(()=>{const result=this.mutate(scope,operation,input,key);this.store.put('loop_calls',{id:key,hash,result,projectId:scope.projectId,runId:scope.runId});return result;});
  }
  file(scope:Scope,path:unknown,maxBytes:number){const {project}=this.scope(scope);const root=realpathSync(project.path);let actual:string;try{actual=realpathSync(isAbsolute(String(path))?text(path,'path',4096):join(root,text(path,'path',4096)));}catch{throw new APIError(400,'文件不存在');}const rel=relative(root,actual);if(rel.startsWith('..')||isAbsolute(rel))throw new APIError(403,'只接受当前项目目录内的文件');const stat=statSync(actual);if(!stat.isFile()||stat.size>maxBytes)throw new APIError(400,`必须是小于 ${maxBytes} 字节的普通文件`);return {actual,bytes:readFileSync(actual)};}
  mutate(scope:Scope,operation:string,input:Record<string,any>,key:string):unknown {
    const {project}=this.scope(scope);const time=now();
    const base={id:randomUUID(),projectId:scope.projectId,channelId:scope.channelId,runId:scope.runId,createdAt:time};
    if(operation==='feature.upsert') {
      keys(input,['id','revision','title','summary','kind','status','evidenceIds','nextStep']);const old=input.id?this.item(scope,input.id,false):undefined;
      if(old&&input.revision!==old.revision)throw new APIError(409,'feature 已更新，请读取最新版本再合并');
      const evidenceIds=this.refs(scope,input.evidenceIds||[]);const title=text(input.title,'title',300);const status=choice(input.status,'status',itemStatuses);
      if(['verified','resolved'].includes(status)&&!evidenceIds.length)throw new APIError(400,'已验证/已解决需要证据引用');
      if(!old&&this.store.projectItems(project.id).some(v=>v.title.trim().toLocaleLowerCase()===title.toLocaleLowerCase()))throw new APIError(409,'同名 feature 已存在，请沿用其 ID');
      const evidence=evidenceIds.map(id=>{const e=this.store.get<Evidence>('loop_evidence',id)!;return `[${e.id}] ${e.summary}\n来源：${e.source}`;});
      const item:WorkItem={id:old?.id||base.id,projectId:project.id,number:old?.number||this.store.nextItemNumber(project.id),channelId:old?.channelId||scope.channelId,sourceChannelIds:[...new Set([...(old?.sourceChannelIds||[]),scope.channelId])],lastRunId:scope.runId,revision:(old?.revision||0)+1,title,summary:text(input.summary,'summary'),kind:choice(input.kind,'kind',itemKinds),status,evidence:[...new Set([...(old?.evidence||[]),...evidence])],nextStep:string(input.nextStep??'','nextStep',5000,true),createdAt:old?.createdAt||time,updatedAt:time};
      return this.store.transaction(()=>{this.store.put('items',item);this.audit(scope,old?'feature.updated':'feature.created',`${old?'更新':'建立'} #${item.number}「${item.title}」`,item.id,item);return item;});
    }
    if(operation==='evidence.record'||operation==='evidence.capture') {
      keys(input,operation==='evidence.capture'?['itemId','summary','path']:['itemId','summary','source','observedAt','data']);const item=this.item(scope,input.itemId);
      let source:string,data:unknown,origin:Evidence['origin'],hash:string|undefined,observedAt=time;
      if(operation==='evidence.capture'){const file=this.file(scope,input.path,512*1024);source=file.actual;data=file.bytes.toString('utf8');origin='file';hash=digest(file.bytes);}
      else{source=text(input.source,'source',4096);data=input.data??null;if(JSON.stringify(data).length>512*1024)throw new APIError(413,'证据超过 512 KB');origin='agent';observedAt=timestamp(input.observedAt,'observedAt');}
      const entry:Evidence={...base,...(item?{itemId:item.id}:{}),summary:text(input.summary,'summary',5000),source,observedAt,origin,data,...(hash?{digest:hash}:{})};
      this.store.put('loop_evidence',entry);this.linkEvidence(entry);this.audit(scope,'evidence.recorded',entry.summary,item?.id,{id:entry.id,origin,source});return entry;
    }
    if(operation==='learning.upsert') {
      keys(input,['id','revision','itemId','kind','title','rationale','expectedResult','evaluation','conclusion','status','evidenceIds']);const item=this.item(scope,input.itemId);const old=input.id?this.store.get<Learning>('loop_learning',text(input.id,'id',200)):undefined;
      if(input.id&&old?.projectId!==scope.projectId)throw new APIError(404,'认识记录不属于当前项目');if(old&&input.revision!==old.revision)throw new APIError(409,'认识已更新，请先读取最新证据');
      const evidenceIds=this.refs(scope,input.evidenceIds||[]);const status=choice(input.status,'status',['active','supported','refuted','inconclusive','stopped'] as const);
      if(['supported','refuted'].includes(status)&&!evidenceIds.length)throw new APIError(400,'支持或推翻判断需要证据');
      const row:Learning={...base,id:old?.id||base.id,itemId:item?.id||old?.itemId,kind:choice(input.kind,'kind',['outcome','hypothesis','experiment'] as const),title:text(input.title,'title',300),rationale:text(input.rationale,'rationale'),expectedResult:text(input.expectedResult,'expectedResult'),evaluation:text(input.evaluation,'evaluation'),conclusion:string(input.conclusion??'','conclusion',10000,true),status,evidenceIds,revision:(old?.revision||0)+1,createdAt:old?.createdAt||time,updatedAt:time};
      return this.store.transaction(()=>{this.store.put('loop_learning',row);this.audit(scope,'learning.updated',`${row.title}：${row.status}`,row.itemId,row);return row;});
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
    if(!Array.isArray(input.checks)||!input.checks.length||input.checks.length>30)throw new APIError(400,'请提供发布验证结果');
    const checks:Release['checks']=input.checks.map((v:unknown)=>{const check=object(v);keys(check,['name','result','evidenceIds']);return {name:text(check.name,'name',300),result:choice(check.result,'result',['passed','not_verified'] as const),evidenceIds:this.refs(scope,check.evidenceIds)};});
    if(!checks.some(c=>c.result==='passed'&&c.evidenceIds.some(id=>this.store.get<Evidence>('loop_evidence',id)?.origin!=='agent')))throw new APIError(400,'至少一项通过的检查需要实际文件或 HTTP 采集证据');
    const target=object(input.target);keys(target,['url','statusUrl','label']);
    const file=this.file(scope,input.artifactPath,8*1024*1024);const id=digest(key).slice(0,32);
    const existing=this.store.get<Release>('loop_releases',id);if(existing)return existing;
    const contents={projectId:scope.projectId,channelId:scope.channelId,runId:scope.runId,itemIds,title:text(input.title,'title',300),changes:text(input.changes,'changes',20000),rationale:text(input.rationale,'rationale'),expectedBenefit:text(input.expectedBenefit,'expectedBenefit'),checks,risks:text(input.risks,'risks'),rollback:text(input.rollback,'rollback'),observationPlan:text(input.observationPlan,'observationPlan'),artifact:{name:basename(file.actual),sha256:digest(file.bytes),bytes:file.bytes.length},target:{url:endpoint(target.url),statusUrl:endpoint(target.statusUrl),label:text(target.label,'label',200)}};
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
      if(changed){const e:Evidence={id:randomUUID(),projectId:watch.projectId,channelId:watch.channelId,runId:watch.runId,itemId:watch.itemId,summary:`${watch.title}：收到实际反馈`,source:watch.url,observedAt:now(),createdAt:now(),origin:'http',data,digest:hash};this.store.transaction(()=>{this.store.put('loop_evidence',e);this.linkEvidence(e);});evidenceId=e.id;this.audit(watch,'feedback.observed',e.summary,watch.itemId,{evidenceId:e.id,watchId:id},'system');}
      const met=watch.condition==='changed'?!!watch.lastDigest&&changed:watch.condition==='equals'?value===watch.expected:typeof value==='number'&&Number.isFinite(value)&&(watch.condition==='gte'?value>=Number(watch.expected):value<=Number(watch.expected));
      const current=this.store.get<FeedbackWatch>('loop_watches',id)!;if(current.status==='cancelled')return;
      this.store.put('loop_watches',{...current,lastValue:value,lastDigest:valueHash,lastEvidenceId:evidenceId,error:undefined,status:current.status==='watching'?(met?'triggered':'watching'):current.status,updatedAt:now(),nextPollAt:new Date(Date.now()+watch.intervalSeconds*1000).toISOString()});if(current.status==='watching'?met:!!watch.lastDigest&&changed)this.signal(watch.channelId,id,`收到新的反馈：${watch.title}`);
    }catch(error){const current=this.store.get<FeedbackWatch>('loop_watches',id)!;if(current.status!=='cancelled'){const message=error instanceof Error?error.message:'反馈查询失败';this.store.put('loop_watches',{...current,error:message,updatedAt:now(),nextPollAt:new Date(Date.now()+watch.intervalSeconds*1000).toISOString()});if(current.error!==message){this.audit(watch,'feedback.unavailable',`反馈暂不可用：${watch.title} · ${message}`,watch.itemId,undefined,'system');this.signal(watch.channelId,id,`反馈暂不可用，检查数据来源：${watch.title}`);}}}
    finally{this.inFlight.delete(id);}
  }
  tick(){if(this.closed)return;const time=now();for(const row of this.store.all<Release>('loop_releases')){if(row.status==='approved')this.track(this.publish(row.id));else if(row.status==='unknown'&&Date.parse(row.updatedAt)<Date.now()-60000)this.track(this.reconcile(row.id));}for(const watch of this.store.all<FeedbackWatch>('loop_watches'))if(this.inFlight.size<4&&this.store.get<any>('controls',watch.channelId)?.enabled&&watch.status!=='cancelled'&&(watch.status==='watching'||watch.continuous!==false)&&(watch.nextPollAt<=time||(watch.status==='watching'&&watch.deadline<=time)))this.track(this.poll(watch.id));}
  recover(){for(const row of this.store.all<Release>('loop_releases'))if(row.status==='publishing')this.store.put('loop_releases',{...row,status:'unknown',error:'服务重启，先核对发布回执，不重复发送',updatedAt:now()});if(!this.store.get('migrations','loop-evidence-links-v1'))this.store.transaction(()=>{for(const evidence of this.store.all<Evidence>('loop_evidence'))this.linkEvidence(evidence);this.store.put('migrations',{id:'loop-evidence-links-v1',createdAt:now()});});}
  async close(){this.closed=true;await Promise.allSettled([...this.pending]);}
}

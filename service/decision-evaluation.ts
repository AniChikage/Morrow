import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { APIError, choice, keys, object, string } from './protocol.ts';
import type { Evidence, FeedbackWatch } from './autonomy-types.ts';
import type { Project } from './protocol.ts';
import type { ProjectWorkLoop, Scope } from './project-loop.ts';
import type { DecisionAssessment, Expectation, ExpectationResult, StrategyDecision, Understanding } from './strategy-types.ts';
import { sourceVersion } from './source-version.ts';

const text = (value:unknown, field:string, max=3000) => string(value, field, max);
function timestamp(value:unknown, field:string) {
  const result=text(value,field,40);
  if(!Number.isFinite(Date.parse(result)))throw new APIError(400,`${field} 必须是有效时间`);
  return new Date(result).toISOString();
}
function pointer(value:unknown) {
  const result=string(value??'','pointer',1000,true);
  if((result!==''&&!result.startsWith('/'))||/~(?![01])/u.test(result))throw new APIError(400,'pointer 必须为有效 JSON Pointer');
  return result;
}
function valueAt(data:unknown,path:string):unknown {
  if(path==='')return data;
  return path.slice(1).split('/').reduce<unknown>((v,key)=>v!==null&&typeof v==='object'?Object.getOwnPropertyDescriptor(v,key.replaceAll('~1','/').replaceAll('~0','~'))?.value:undefined,data);
}
function scalar(value:unknown):value is string|number|boolean {
  return typeof value==='string'||typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value));
}
function plannedPath(path:string):string {
  try{return realpathSync(path);}catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new APIError(400,'无法解析预期文件路径');
    const parent=dirname(path);if(parent===path)throw new APIError(400,'无法解析预期文件路径');
    return resolve(plannedPath(parent),basename(path));
  }
}

/** Frozen observation contracts and mechanical checks, not a causal inference model. */
export class DecisionEvaluation {
  readonly loop:ProjectWorkLoop;
  constructor(loop:ProjectWorkLoop) {this.loop=loop;}
  plan(scope:Scope,value:unknown,createdAt:string,kind:string):Expectation[] {
    if(!Array.isArray(value)||value.length>8||(!value.length&&kind!=='stop'))throw new APIError(400,'expectations 需要 1 到 8 项可观察预期；停止方向可为空');
    const {project}=this.loop.scope(scope),seen=new Set<string>();
    const result=value.map(raw=>{
      const input=object(raw);keys(input,['id','kind','claim','scope','source','verification','disconfirm','notBefore','deadline','rule']);
      const id=text(input.id,'expectation.id',80);if(seen.has(id))throw new APIError(400,'预期 ID 不能重复');seen.add(id);
      const rawSource=object(input.source);let source:Expectation['source'];
      if(rawSource.kind==='file') {
        keys(rawSource,['kind','path']);const root=realpathSync(project.path);
        const path=plannedPath(resolve(root,text(rawSource.path,'source.path',4096)));
        const rel=relative(root,path);if(!rel||rel==='..'||rel.startsWith('../')||isAbsolute(rel))throw new APIError(403,'预期文件必须位于当前项目内');
        source={kind:'file',path};
      } else if(rawSource.kind==='execution') {
        keys(rawSource,['kind','command']);source={kind:'execution',command:text(rawSource.command,'source.command',20000)};
        if(input.rule===undefined)throw new APIError(400,'执行预期需要 rule 核对原生字段，例如 /exitCode equals 0');
      } else {
        keys(rawSource,['kind','watchId']);choice(rawSource.kind,'source.kind',['watch']);
        const watchId=text(rawSource.watchId,'watchId',200),watch=this.loop.store.get<FeedbackWatch>('loop_watches',watchId);
        if(watch?.projectId!==scope.projectId)throw new APIError(404,'观察条件不属于当前项目');
        if(watch.status==='cancelled')throw new APIError(409,'不能使用已取消的观察条件');
        source={kind:'watch',watchId,url:watch.url};
      }
      const notBefore=input.notBefore===undefined?createdAt:timestamp(input.notBefore,'notBefore'),deadline=timestamp(input.deadline,'deadline');
      if(notBefore<createdAt||deadline<=createdAt||deadline<notBefore)throw new APIError(400,'预期观察窗口必须从本次选择之后开始，截止时间不能早于开始');
      let rule:Expectation['rule'];
      if(input.rule!==undefined){
        const r=object(input.rule);keys(r,['pointer','operator','expected']);const operator=choice(r.operator,'operator',['gte','lte','equals'] as const);
        if(!scalar(r.expected)||(operator!=='equals'&&typeof r.expected!=='number'))throw new APIError(400,'规则需要类型匹配的有限标量 expected');
        rule={pointer:pointer(r.pointer),operator,expected:r.expected};
      }
      return {id,kind:choice(input.kind,'expectation.kind',['outcome','guardrail'] as const),claim:text(input.claim,'claim'),scope:text(input.scope,'scope'),source,verification:text(input.verification,'verification'),disconfirm:text(input.disconfirm,'disconfirm'),notBefore,deadline,...(rule?{rule}:{})};
    });
    if(result.length&&!result.some(row=>row.kind==='outcome'))throw new APIError(400,'至少一项预期需要说明本次希望取得的结果');
    return result;
  }
  matches(expected:Expectation,evidence:Evidence) {
    return expected.source.kind==='file'
      ? evidence.origin==='file'&&evidence.source===expected.source.path
      : expected.source.kind==='execution'?evidence.origin==='execution'&&evidence.source===expected.source.command
      : evidence.origin==='http'&&evidence.watchId===expected.source.watchId&&evidence.source===expected.source.url;
  }
  isNew(decision:StrategyDecision,evidence:Evidence){
    const position=this.loop.store.db.prepare('SELECT rowid AS n FROM loop_evidence WHERE id=?').get(evidence.id) as {n:number}|undefined;
    return !!position&&position.n>(decision.evidenceCursor??0)&&evidence.createdAt>=decision.createdAt;
  }
  ruleValue(expected:Expectation,data:unknown){
    if(typeof data==='string'){try{data=JSON.parse(data);}catch{return undefined;}}
    const value=valueAt(data,expected.rule?.pointer??'');
    return scalar(value)?value:undefined;
  }
  assess(scope:Scope,decision:StrategyDecision,value:unknown,time:string):DecisionAssessment {
    const input=object(value);keys(input,['results','conditions','conditionReason','diagnosis','explanation','adjustment','understandingRefs']);
    if(!Array.isArray(input.results)||input.results.length!==(decision.expectations||[]).length)throw new APIError(400,'逐项核对全部原始 expectations，不能遗漏结果或约束');
    const seen=new Set<string>();
    const results:ExpectationResult[]=input.results.map((raw:unknown)=>{
      const entry=object(raw);keys(entry,['expectationId','verdict','reason','evidenceIds']);
      const id=text(entry.expectationId,'expectationId',80),expected=decision.expectations!.find(row=>row.id===id);
      if(!expected||seen.has(id))throw new APIError(400,'核对项必须唯一对应原始预期');seen.add(id);
      const evidenceIds=this.loop.refs(scope,entry.evidenceIds||[]);
      if(evidenceIds.length>8)throw new APIError(400,'每项核对最多引用 8 条证据');
      const evidence=evidenceIds.map(id=>this.loop.store.get<Evidence>('loop_evidence',id)!);
      if(evidence.some(row=>!this.matches(expected,row)))throw new APIError(400,'核对证据必须来自事先约定的文件或观察条件；Agent 陈述不能替代采集');
      const verdict=choice(entry.verdict,'verdict',['met','not_met','unknown'] as const),reason=text(entry.reason,'reason');
      const result:ExpectationResult={expectationId:id,verdict,reason,evidenceIds,checkedBy:expected.rule?'rule':'agent'};
      const inWindow=(row:Evidence)=>this.isNew(decision,row)&&row.observedAt>=expected.notBefore&&row.observedAt<=expected.deadline&&row.observedAt<=time;
      // A newer observation from this exact source must not be silently discarded.
      const latest=this.loop.rows<Evidence>('loop_evidence',scope.projectId).filter(row=>this.matches(expected,row)&&inWindow(row)).at(-1);
      if(latest&&!evidenceIds.includes(latest.id))throw new APIError(409,`预期 ${id} 有更新的窗口内证据 ${latest.id}，请读取后一起核对`);
      if(!evidence.length||evidence.some(row=>!inWindow(row))){
        if(verdict!=='unknown')throw new APIError(400,'缺少观察窗口内的新证据，只能保留 unknown；旧基线不能证明本次效果');
        return {...result,reason:`${reason}\n系统核对：缺少观察窗口内的新证据。`};
      }
      if(expected.rule){
        const record=latest||evidence.at(-1)!;
        const observed=this.ruleValue(expected,record.data),r=expected.rule;
        let executionUsable=record.origin!=='execution';
        if(record.origin==='execution')try{const data=record.data as any;executionUsable=data?.boundVersion===true&&data?.outputComplete===true&&Number.isInteger(data?.exitCode)&&data.sourceVersion?.digest===sourceVersion(this.loop.store.get<Project>('projects',scope.projectId)!.path).digest;}catch{executionUsable=false;}
        const usable=executionUsable&&scalar(observed)&&(r.operator==='equals'?typeof observed===typeof r.expected:typeof observed==='number');
        const computed=!usable?'unknown':(r.operator==='equals'?observed===r.expected:r.operator==='gte'?(observed as number)>=(r.expected as number):(observed as number)<=(r.expected as number))?'met':'not_met';
        if(verdict!==computed)throw new APIError(400,`预期 ${id} 的规则核对结果为 ${computed}，不能用文字结论覆盖实际字段`);
        result.observedValue=scalar(observed)?observed:null;
      }
      return result;
    });
    const conditions=choice(input.conditions,'conditions',['matched','changed','unknown'] as const);
    const diagnosis=choice(input.diagnosis,'diagnosis',['expected','pending','measurement','execution','assumption','environment','uncertain'] as const);
    const adjustment=choice(input.adjustment,'adjustment',['continue','observe','measurement','method','assumption','stop'] as const);
    if(!Array.isArray(input.understandingRefs??[])||(input.understandingRefs||[]).length>8)throw new APIError(400,'understandingRefs 最多 8 项');
    const refsSeen=new Set<string>();
    const understandingRefs=(input.understandingRefs||[]).map((raw:unknown)=>{
      const ref=object(raw);keys(ref,['id','revision']);const id=text(ref.id,'id',200),row=this.loop.store.get<Understanding>('strategy_understanding',id);
      if(row?.projectId!==scope.projectId)throw new APIError(404,'修正的认识不属于当前项目');
      if(refsSeen.has(id))throw new APIError(400,'修正的认识不能重复');refsSeen.add(id);
      if(row.revision!==ref.revision)throw new APIError(409,'修正的认识已变化，请读取最新版本');
      const original=decision.understandingRefs.find(r=>r.id===id);
      if(adjustment==='assumption'&&(row.updatedAt<decision.createdAt||original&&row.revision<=original.revision))throw new APIError(400,'重新判断假设需要先保存本次新增或修订的认识');
      return {id,revision:row.revision};
    });
    if(adjustment==='assumption'&&!understandingRefs.length)throw new APIError(400,'重新判断假设时，先用 understanding.upsert 保存修订，再引用其版本');
    return {results,conditions,conditionReason:text(input.conditionReason,'conditionReason'),diagnosis,explanation:text(input.explanation,'explanation'),adjustment,understandingRefs};
  }
  requireOutcome(outcome:string,assessment:DecisionAssessment) {
    const conclusive=['improved','not_improved'].includes(outcome);
    if(conclusive&&(assessment.conditions!=='matched'||['pending','measurement'].includes(assessment.diagnosis)))throw new APIError(400,'观察条件不可比或数据仍待核对时，使用 inconclusive 并保留具体观测');
    if(outcome==='improved'&&(!assessment.results.length||assessment.results.some(row=>row.verdict!=='met')))throw new APIError(400,'只有全部预期和约束都有支持证据，才能报告本次预期达成');
    if(outcome==='not_improved'&&!assessment.results.some(row=>row.verdict==='not_met'))throw new APIError(400,'未达预期需要至少一个被证据反驳的核对项；数据未到不等于失败');
    if(outcome==='not_improved'&&assessment.diagnosis==='expected')throw new APIError(400,'未达预期时需要重新检查原因，不能记录为符合预期');
  }
}

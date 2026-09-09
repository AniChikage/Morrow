import { APIError, choice, integer, keys, object, string } from './protocol.ts';
import type { Evidence } from './autonomy-types.ts';
import type { Expectation, MeasurementCheck, MeasurementPlan, ScalarRule } from './strategy-types.ts';

export function jsonPointer(value:unknown) {
  const result=string(value??'','pointer',1000,true);
  if((result!==''&&!result.startsWith('/'))||/~(?![01])/u.test(result))throw new APIError(400,'pointer 必须为有效 JSON Pointer');
  return result;
}
export function valueAt(data:unknown,path:string):unknown {
  if(path==='')return data;
  return path.slice(1).split('/').reduce<unknown>((v,key)=>v!==null&&typeof v==='object'?Object.getOwnPropertyDescriptor(v,key.replaceAll('~1','/').replaceAll('~0','~'))?.value:undefined,data);
}
export function scalar(value:unknown):value is string|number|boolean {
  return typeof value==='string'||typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value));
}
export function scalarRule(value:unknown):ScalarRule {
  const r=object(value);keys(r,['pointer','operator','expected']);const operator=choice(r.operator,'operator',['gte','lte','equals'] as const);
  if(!scalar(r.expected)||(operator!=='equals'&&typeof r.expected!=='number'))throw new APIError(400,'规则需要类型匹配的有限标量 expected');
  return {pointer:jsonPointer(r.pointer),operator,expected:r.expected};
}
export function ruleVerdict(rule:ScalarRule,value:unknown):'met'|'not_met'|'unknown' {
  if(!scalar(value)||(rule.operator==='equals'?typeof value!==typeof rule.expected:typeof value!=='number'))return 'unknown';
  return (rule.operator==='equals'?value===rule.expected:rule.operator==='gte'?(value as number)>=(rule.expected as number):(value as number)<=(rule.expected as number))?'met':'not_met';
}
/** Agent-defined measurement semantics, with bounded mechanical checks on collected data. */
export function measurementPlan(value:unknown,expected:Expectation,baselineEvidence:(id:string)=>Evidence):MeasurementPlan {
  const input=object(value);keys(input,['metric','goalRelation','limitation','comparison','baseline','freshness','checks']);
  if(expected.source.kind==='execution'||!expected.rule)throw new APIError(400,'measurement 用于有 rule 的文件或 HTTP 观测；执行检查继续使用原生 execution 证据');
  const comparison=choice(input.comparison,'comparison',['absolute','delta'] as const);
  if(comparison==='delta'&&typeof expected.rule.expected!=='number')throw new APIError(400,'delta 比较要求有限数值规则；表示观测值减去原基线，不是相对百分比');
  const rawBaseline=object(input.baseline);let baseline:MeasurementPlan['baseline'];
  if(rawBaseline.evidenceId!==undefined){keys(rawBaseline,['evidenceId']);const evidenceId=string(rawBaseline.evidenceId,'baseline.evidenceId',200);baselineEvidence(evidenceId);baseline={evidenceId};}
  else {keys(rawBaseline,['unavailable']);baseline={unavailable:string(rawBaseline.unavailable,'baseline.unavailable',1500)};}
  const freshness=object(input.freshness);keys(freshness,['pointer','maxAgeSeconds']);
  if(!Array.isArray(input.checks)||!input.checks.length||input.checks.length>8)throw new APIError(400,'measurement.checks 需要 1..8 项数据质量条件，例如样本量、完整性、对象或统计口径');
  const checks=input.checks.map(raw=>{const entry=object(raw);keys(entry,['label','pointer','operator','expected']);const {label,...rule}=entry;return {...scalarRule(rule),label:string(label,'check.label',300)};});
  return {metric:string(input.metric,'metric',2000),goalRelation:string(input.goalRelation,'goalRelation',2000),limitation:string(input.limitation,'limitation',2000),comparison,baseline,freshness:{pointer:jsonPointer(freshness.pointer),maxAgeSeconds:integer(freshness.maxAgeSeconds,'maxAgeSeconds',1,2592000)},checks};
}
export function qualityChecks(plan:MeasurementPlan,data:unknown,time:string):MeasurementCheck[] {
  if(typeof data==='string'){try{data=JSON.parse(data);}catch{data=undefined;}}
  const timestamp=valueAt(data,plan.freshness.pointer),parsed=typeof timestamp==='string'&&/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(timestamp)?Date.parse(timestamp):NaN;
  const age=Date.parse(time)-parsed;
  const freshness:MeasurementCheck={label:'数据时效',status:!Number.isFinite(age)?'unknown':age>=0&&age<=plan.freshness.maxAgeSeconds*1000?'passed':'failed',observedValue:scalar(timestamp)?timestamp:null};
  return [freshness,...plan.checks.map(rule=>{const value=valueAt(data,rule.pointer),verdict=ruleVerdict(rule,value);return {label:rule.label,status:verdict==='met'?'passed' as const:verdict==='not_met'?'failed' as const:'unknown' as const,observedValue:scalar(value)?value:null};})];
}

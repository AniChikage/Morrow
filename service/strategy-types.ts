export type Understanding = {
  id:string; projectId:string; channelId:string; runId:string;
  kind:'fact'|'assumption'|'unknown'|'capability'|'constraint';
  title:string; statement:string; relevance:string; verification:string;
  status:'active'|'invalidated'|'retired'; evidenceIds:string[];
  reviewAt:string; revision:number; createdAt:string; updatedAt:string;
};
export type ActionOption = {
  title:string; kind:'act'|'investigate'|'build_capability'|'observe'|'stop';
  benefit:string; cost:string; uncertainty:string;
};
export type MemoryKind = 'understanding'|'decision'|'learning';
export type MemoryMatch = {
  kind:MemoryKind; id:string; revision:number; title:string; status:string;
  excerpt:string; truncated:boolean; evidenceIds:string[]; updatedAt:string;
  caution?:string; reviewAt?:string; outcome?:'improved'|'not_improved'|'inconclusive'|'abandoned'; reasons:string[];
};
export type MemoryReference = {
  kind:MemoryKind; id:string; revision:number;
  use:'apply'|'adapt'|'avoid'|'not_applicable'; reason:string;
  snapshot:Omit<MemoryMatch,'reasons'>;
};
export type Expectation = {
  id:string; kind:'outcome'|'guardrail'; claim:string; scope:string;
  source:{kind:'file';path:string}|{kind:'watch';watchId:string;url:string}|{kind:'execution';command:string};
  verification:string; disconfirm:string; notBefore:string; deadline:string;
  rule?:{pointer:string;operator:'gte'|'lte'|'equals';expected:string|number|boolean};
};
export type ExpectationResult = {
  expectationId:string; verdict:'met'|'not_met'|'unknown'; reason:string;
  evidenceIds:string[]; checkedBy:'rule'|'agent'; observedValue?:string|number|boolean|null;
};
export type DecisionAssessment = {
  results:ExpectationResult[];
  conditions:'matched'|'changed'|'unknown'; conditionReason:string;
  diagnosis:'expected'|'pending'|'measurement'|'execution'|'assumption'|'environment'|'uncertain';
  explanation:string;
  adjustment:'continue'|'observe'|'measurement'|'method'|'assumption'|'stop';
  understandingRefs:Array<{id:string;revision:number}>;
};
export type StrategyDecision = {
  id:string; projectId:string; channelId:string; runId:string; itemId?:string;
  objective:{goal:string; direction:string; version:string};
  options:ActionOption[]; selected:number; rationale:string; nextStep:string;
  expectedOutcome:string; evaluation:string; stopWhen:string;
  understandingRefs:Array<{id:string;revision:number}>; evidenceIds:string[]; watchIds:string[];
  memoryRefs?:MemoryReference[];
  evaluationVersion?:1|2; evidenceCursor?:number; expectations?:Expectation[];
  reviewAt:string; maxRuns:number; signalCursor:number;
  status:'active'|'reviewed'; revision:number; createdAt:string; updatedAt:string;
  review?:{outcome:'improved'|'not_improved'|'inconclusive'|'abandoned'; conclusion:string; evidenceIds:string[]; nextDirection:string; runId:string; channelId:string; createdAt:string; assessment?:DecisionAssessment};
};
export type DecisionView = StrategyDecision & {runsUsed:number; reviewReasons:string[]};
export type StrategyView = {
  understanding:Understanding[]; decisions:DecisionView[];
  counts:{understanding:number;decisions:number};
};

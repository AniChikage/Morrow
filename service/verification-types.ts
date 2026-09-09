export type SourceVersion = {
  digest:string; head:string; files:number; bytes:number;
  coverage:'git-tracked-and-unignored'|'folder';
  scheme?:'source-v2';
};
export type ExecutionCapture = {
  id:string; projectId:string; channelId:string; runId:string;
  threadId:string; turnId:string; command:string; cwd:string;
  version:SourceVersion; createdAt:string; nativeCursor:number;
  status:'prepared'|'running'|'captured'|'unknown';
  nativeItemId?:string; startedAt?:string; evidenceId?:string; error?:string;
};
export type Verification = {
  id:string; projectId:string; channelId:string; runId:string;
  itemId?:string; decisionId?:string; evidenceIds:string[];
  subjectHash:string; version:SourceVersion;
  subjectVersion?:'acceptance-v2';
  status:'queued'|'running'|'passed'|'failed'|'unknown';
  summary:string; findings:Array<{severity:'blocking'|'note';message:string}>;
  checks:Array<{expectationId:string;verdict:'met'|'not_met'|'unknown';reason:string}>;
  limitations:string[]; createdAt:string; startedAt?:string; finishedAt?:string;
  threadId?:string; turnId?:string; model?:string;
  interruptPending?:boolean;
  prompt:string; bytes:number; commandCount:number; timeoutSeconds:number;
};
export type Finalization = {
  id:string; projectId:string; channelId:string; runId:string; verificationId:string;
  operation:'decision.review'|'feature.complete'; targetId:string; revision:number;
  input:Record<string,any>; status:'pending'|'applied'|'stale'|'rejected';
  createdAt:string; updatedAt:string; reason?:string;
};

export type Evidence = {
  id:string; projectId:string; channelId:string; runId:string; itemId?:string;
  summary:string; source:string; observedAt:string; createdAt:string;
  origin:'agent'|'file'|'http'; data:unknown; digest?:string;
};
export type Learning = {
  id:string; projectId:string; channelId:string; runId:string; itemId?:string;
  kind:'outcome'|'hypothesis'|'experiment'; title:string; rationale:string;
  expectedResult:string; evaluation:string; conclusion:string;
  status:'active'|'supported'|'refuted'|'inconclusive'|'stopped';
  evidenceIds:string[]; revision:number; createdAt:string; updatedAt:string;
};
export type FeedbackWatch = {
  id:string; projectId:string; channelId:string; runId:string; itemId?:string;
  title:string; url:string; pointer:string; condition:'changed'|'gte'|'lte'|'equals';
  expected?:string|number|boolean; intervalSeconds:number; deadline:string; continuous?:boolean;
  releaseId?:string; status:'watching'|'triggered'|'expired'|'cancelled';
  nextPollAt:string; lastDigest?:string; lastValue?:unknown; lastEvidenceId?:string;
  error?:string; createdAt:string; updatedAt:string;
};
export type Release = {
  id:string; projectId:string; channelId:string; runId:string; itemIds:string[];
  title:string; changes:string; rationale:string; expectedBenefit:string;
  checks:Array<{name:string; result:'passed'|'not_verified'; evidenceIds:string[]}>;
  risks:string; rollback:string; observationPlan:string;
  artifact:{name:string; sha256:string; bytes:number};
  target:{url:string; statusUrl:string; label:string};
  reviewHash:string;
  status:'awaiting_approval'|'approved'|'publishing'|'published'|'rejected'|'unknown'|'failed';
  createdAt:string; updatedAt:string; approvedAt?:string; publishedAt?:string;
  feedback?:string; error?:string; publishedUrl?:string;
};
export type ProjectLoop = { evidence:Evidence[]; learning:Learning[]; watches:FeedbackWatch[]; releases:Release[] };

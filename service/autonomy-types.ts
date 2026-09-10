export type Evidence = {
  id: string;
  projectId: string;
  channelId: string;
  runId: string;
  itemId?: string;
  summary: string;
  source: string;
  observedAt: string;
  createdAt: string;
  origin: 'agent' | 'file' | 'http' | 'execution';
  data: unknown;
  digest?: string;
  watchId?: string;
  pointer?: string;
  value?: unknown;
};
export type Learning = {
  id: string;
  projectId: string;
  channelId: string;
  runId: string;
  itemId?: string;
  kind: 'outcome' | 'hypothesis' | 'experiment';
  title: string;
  rationale: string;
  expectedResult: string;
  evaluation: string;
  conclusion: string;
  status: 'active' | 'supported' | 'refuted' | 'inconclusive' | 'stopped';
  evidenceIds: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
};
export type FeedbackWatch = {
  id: string;
  projectId: string;
  channelId: string;
  runId: string;
  itemId?: string;
  title: string;
  pointer: string;
  condition: 'changed' | 'gte' | 'lte' | 'equals';
  expected?: string | number | boolean;
  intervalSeconds: number;
  deadline: string;
  continuous?: boolean;
  releaseId?: string;
  status: 'watching' | 'triggered' | 'expired' | 'cancelled';
  nextPollAt: string;
  lastDigest?: string;
  lastValue?: unknown;
  lastEvidenceId?: string;
  error?: string;
  missing?: boolean;
  initiallyMissing?: boolean;
  createdAt: string;
  updatedAt: string;
} & ({ kind?: 'http'; url: string; path?: never } | { kind: 'file'; path: string; url?: never });
/**
 * Where an approved release is delivered. `http` posts the sealed artifact to a project-supplied
 * endpoint. `local-script` runs a script the human wrote and committed inside the project: Morrow
 * seals a copy at proposal time, binds its digest into `reviewHash`, and executes it only after a
 * human approval. `script`/`statusScript` are project-relative paths; the digests are computed by
 * the service, never supplied by the agent.
 */
export type ReleaseTarget =
  | { kind?: 'http'; url: string; statusUrl: string; label: string }
  | {
      kind: 'local-script';
      label: string;
      script: string;
      scriptSha256: string;
      args: string[];
      timeoutSeconds: number;
      statusScript?: string;
      statusScriptSha256?: string;
    };
export type Release = {
  id: string;
  projectId: string;
  channelId: string;
  runId: string;
  itemIds: string[];
  title: string;
  changes: string;
  rationale: string;
  expectedBenefit: string;
  checks: Array<{ name: string; result: 'passed' | 'not_verified'; evidenceIds: string[] }>;
  verificationIds?: string[];
  risks: string;
  rollback: string;
  observationPlan: string;
  artifact: { name: string; sha256: string; bytes: number };
  target: ReleaseTarget;
  reviewHash: string;
  status: 'awaiting_approval' | 'approved' | 'publishing' | 'published' | 'rejected' | 'unknown' | 'failed';
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  publishedAt?: string;
  feedback?: string;
  error?: string;
  publishedUrl?: string;
  /** Combined stdout/stderr tail of a `local-script` publication, bounded to 1 MiB and redacted. */
  log?: string;
};
/** The sealed script a human can read before approving a `local-script` release. */
export type ReleaseScript = {
  releaseId: string;
  label: string;
  args: string[];
  timeoutSeconds: number;
  script: { path: string; sha256: string; bytes: number; text: string };
  statusScript?: { path: string; sha256: string; bytes: number; text: string };
};
export type ProjectLoop = {
  verificationHistory?: { hasMore: boolean; cursor?: string; revision?: string };
  evidence: Evidence[];
  learning: Learning[];
  watches: FeedbackWatch[];
  releases: Release[];
  strategy?: import('./strategy-types.ts').StrategyView;
  verifications?: Array<Omit<import('./verification-types.ts').Verification, 'prompt'> & { current: boolean }>;
  finalizations?: Array<Omit<import('./verification-types.ts').Finalization, 'input'>>;
};

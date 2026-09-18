export type SourceVersion = {
  digest: string;
  head: string;
  files: number;
  bytes: number;
  coverage: 'git-tracked-and-unignored' | 'folder';
  scheme?: 'source-v2';
};
export type ExecutionCapture = {
  id: string;
  projectId: string;
  channelId: string;
  runId: string;
  threadId: string;
  turnId: string;
  command: string;
  cwd: string;
  version: SourceVersion;
  createdAt: string;
  nativeCursor: number;
  status: 'prepared' | 'running' | 'captured' | 'unknown';
  nativeItemId?: string;
  startedAt?: string;
  evidenceId?: string;
  error?: string;
};
export type Verification = {
  id: string;
  projectId: string;
  channelId: string;
  runId: string;
  /**
   * `release` reviews one release candidate: its source version, the items it closes and the checks
   * run on it. Absent (or `item`) is the per-item/per-decision review and keeps its old meaning.
   */
  kind?: 'item' | 'release';
  itemId?: string;
  decisionId?: string;
  /** The items a `release` review covers. Absent for item reviews, which carry `itemId` instead. */
  itemIds?: string[];
  evidenceIds: string[];
  subjectHash: string;
  version: SourceVersion;
  subjectVersion?: 'acceptance-v2';
  status: 'queued' | 'running' | 'passed' | 'failed' | 'unknown';
  summary: string;
  findings: Array<{ severity: 'blocking' | 'note'; message: string }>;
  checks: Array<{ expectationId: string; verdict: 'met' | 'not_met' | 'unknown'; reason: string }>;
  limitations: string[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  threadId?: string;
  turnId?: string;
  model?: string;
  /**
   * Which CLI ran this review, absent for one the Codex App's own background task ran. CLI reviews
   * have an actual session ID but may not expose a native turn ID. A review never runs on the
   * runtime that did the work, so the value also says which account paid for it: only `codex-cli`
   * spends the Codex quota the usage gate reads.
   */
  executionOwner?: 'codex-cli' | 'claude-cli';
  interruptPending?: boolean;
  /** A queued review held by the usage gate is not re-attempted before this time. */
  retryAt?: string;
  /**
   * Set while the usage gate holds this queued review; cleared when it starts. `account` is the
   * provider's own spent-quota message on a review that had already started: that review is not a
   * result, so it keeps `until` and is re-queued as the same attempt once the account is back.
   */
  usageWait?: { kind: 'budget' | 'reserve' | 'unknown' | 'account'; window?: string; until?: string; since: string };
  /** The original failure text behind an `unknown` result; the summary stays the short sentence. */
  error?: string;
  prompt: string;
  bytes: number;
  commandCount: number;
  timeoutSeconds: number;
};
export type Finalization = {
  id: string;
  projectId: string;
  channelId: string;
  runId: string;
  verificationId: string;
  operation: 'decision.review' | 'feature.complete';
  targetId: string;
  revision: number;
  input: Record<string, any>;
  status: 'pending' | 'applied' | 'stale' | 'rejected';
  createdAt: string;
  updatedAt: string;
  reason?: string;
};

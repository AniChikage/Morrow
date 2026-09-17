import type { ReviewRunner, ReviewObservation } from './codex-cli-review.ts';
import { unreadableOutput } from './claude-cli-review.ts';
import type { ReviewStart } from './claude-cli-review.ts';
import { createHash, randomUUID } from 'node:crypto';
import { APIError, choice, keys, string } from './protocol.ts';
import type { Channel, Control, Project, Run, RuntimeID, WorkItem } from './protocol.ts';
import type { Evidence } from './autonomy-types.ts';
import type { StrategyDecision } from './strategy-types.ts';
import type { ProjectWorkLoop, Scope } from './project-loop.ts';
import type { NativeSnapshot, NativeTransport } from './native-conversations.ts';
import { nativeTurns } from './native-conversations.ts';
import { now, parseRows } from './store.ts';
import { diagnoseFailure, quotaFailure, runtimePath } from './runtimes.ts';
import { clock, usageResetAt } from './usage.ts';
import type { UsageGate } from './usage.ts';
import { readSourceVersion, sourceVersion } from './source-version.ts';
import { evidenceData } from './measurement.ts';
import type { Verification, Finalization, SourceVersion } from './verification-types.ts';
import { isolatedReviewText, itemReviewText, releaseReviewText } from './prompts/verification.ts';
import { createReviewCheckout, pruneReviewCheckouts, removeReviewCheckout } from './review-checkout.ts';
import type { ReviewCheckout } from './review-checkout.ts';

const hash = (v: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(v) ?? 'undefined')
    .digest('hex');
const terminal = (v: Verification) => !['queued', 'running'].includes(v.status);
/**
 * A review the account's spent quota stopped. It is recorded `unknown`, so the history says what
 * happened, but it concluded nothing: the tick re-queues this same row once the wait has passed, and
 * until then the completion requests saved against it stay pending.
 */
const accountWait = (v: Verification) => v.status === 'unknown' && v.usageWait?.kind === 'account' && !!v.retryAt;
/** How long to hold a review whose quota message named no moment of its own. */
const blindAccountWaitMs = 60 * 60_000;
/** The shortest hold in any case, so a message naming a moment already past cannot re-queue per tick. */
const minAccountWaitMs = 60_000;
/** The execution record an `execution` evidence row carries; these are the fields a check reads. */
type ExecutionData = {
  boundVersion?: boolean;
  outputComplete?: boolean;
  exitCode?: number;
  sourceVersion?: SourceVersion;
  command?: string;
  cwd?: string;
  output?: string;
};
/** One field of an already observed native item that changed, so growing output is not stored twice. */
type ObservationPatch = { field: string; removed?: boolean; append?: string; value?: unknown };
/**
 * One bounded observation of the reviewer's native turn: a whole redacted item, or only the fields
 * that changed since the last one. A retry replays these rows to rebuild the items it already saw.
 */
type VerificationEvent = {
  id: string;
  projectId: string;
  channelId: string;
  runId: string;
  verificationId: string;
  threadId: string;
  turnId: string;
  nativeItemId: string;
  createdAt: string;
  raw?: Record<string, unknown>;
  patches?: ObservationPatch[];
};
/** The verdict block a reviewer turn has to output. Every field is checked before any of it is kept. */
type ReviewReport = {
  verdict: string;
  summary: string;
  checks: Verification['checks'];
  findings: Verification['findings'];
  limitations: string[];
};
const outputLimit = 4 * 1024 * 1024;
/** How many items one release-level review may cover, and how much of a command's output it is shown. */
const releaseItemLimit = 30;
const outputTail = 4000;
/**
 * How long one review may run, by kind. A release candidate covers up to 30 items and has to read
 * the changes made since each one's own review, which the item cap cut short on the author's own
 * project. The value is copied onto the row at creation and the row stays the timer's only source.
 * Exported so a test can hold the CLI supervisor's own ceiling above the largest cap here.
 */
export const reviewTimeoutSeconds: Record<NonNullable<Verification['kind']>, number> = { item: 300, release: 480 };
/** Reported with the cap that actually applied, so a stopped review says which limit it reached. */
const capReached = (seconds: number) => `独立复核达到 ${Math.round(seconds / 60)} 分钟上限，结果保留未知`;
const itemList = (value: unknown): string[] => {
  if (!Array.isArray(value) || !value.length || value.length > releaseItemLimit)
    throw new APIError(400, `itemIds 必须是 1..${releaseItemLimit} 个 feature ID 的数组`);
  return [...new Set(value.map((v) => string(v, 'itemIds', 200)))].sort();
};
/** Only a native execution record bound to exactly this source version can stand for a check run. */
const currentExecution = (row: Evidence | undefined, digest: string) => {
  const data = row?.origin === 'execution' ? (row.data as ExecutionData) : undefined;
  return (
    !!data &&
    data.boundVersion === true &&
    data.outputComplete === true &&
    Number.isInteger(data.exitCode) &&
    data.sourceVersion?.digest === digest
  );
};
const itemIdsOf = (raw: string | null | undefined): string[] => {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
};
/**
 * A review failure that is about this Mac rather than about the work: the CLI could not be started,
 * its login is gone, or its output was not the stream it must be and nothing at all was read from
 * it. Such a review examined nothing, so recording it as a verdict would stop every item behind
 * what reads like a review result — and a person would go looking at the work instead of logging
 * in again. The other runtime reviews the same row instead.
 */
const runtimeUnavailable = (observation: ReviewObservation) => {
  const error = observation.error || '';
  if (observation.status !== 'failed' || !error) return false;
  // The CLI was never found, never started, or the launcher itself failed.
  if (/\bENOENT\b|\bEACCES\b|\bspawn\b|未找到 Claude Code 命令行/.test(error)) return true;
  // An invalid or expired login: the runtime cannot review anything until a person logs in again.
  if (diagnoseFailure('claude', error)?.priority === 100) return true;
  // Nothing readable came back at all — not one item was parsed out of stdout.
  return !observation.items.length && error.includes(unreadableOutput);
};
/** Which CLI a review runs on, and the runtime each one drives. */
const reviewRuntimes: Record<ReviewOwner, RuntimeID> = { 'codex-cli': 'codex', 'claude-cli': 'claude' };
type ReviewOwner = NonNullable<Verification['executionOwner']>;
/** Independent native task; no agent grant, no approval/escalation, no write permission. */
export class WorkVerification {
  transport?: NativeTransport;
  /** The review CLIs this service can start, by the runtime each one drives. */
  runners = new Map<ReviewOwner, ReviewRunner>();
  redact = (value: string) => value;
  active = new Map<
    string,
    {
      stop?: () => void;
      cancel?: () => void;
      timer: ReturnType<typeof setTimeout>;
      seen: Map<string, Record<string, any>>;
      /** The disposable checkout this review runs in, removed when it reaches any terminal state. */
      checkout?: ReviewCheckout;
    }
  >();
  interrupting = new Set<string>();
  readonly loop: ProjectWorkLoop;
  constructor(loop: ProjectWorkLoop) {
    this.loop = loop;
  }
  connect(transport: NativeTransport, redact: (value: string) => string) {
    this.transport = transport;
    this.runners.clear();
    this.redact = redact;
  }
  connectRunner(runner: ReviewRunner, owner: ReviewOwner = 'codex-cli') {
    this.runners.set(owner, runner);
  }
  /**
   * Which CLI reviews this channel's work. A review is only independent if it is not the runtime
   * that did the work, so the implementer's runtime is the last choice, never the first: a Codex
   * channel is reviewed by Claude Code and a Claude Code channel by Codex. A runtime that is not
   * installed on this Mac is skipped, which falls back to whichever review CLI is left.
   */
  reviewRunner(channel?: Channel): { owner: ReviewOwner; runner: ReviewRunner } | undefined {
    // Claude Code comes first wherever it is allowed: a review on it spends no Codex quota at all.
    const order: ReviewOwner[] =
      channel?.runtime === 'claude' ? ['codex-cli', 'claude-cli'] : ['claude-cli', 'codex-cli'];
    for (const owner of order) {
      const runner = this.runners.get(owner);
      // A service wired with one runner uses it; its own start reports a CLI that is not installed.
      if (runner && (this.runners.size === 1 || runtimePath(reviewRuntimes[owner]))) return { owner, runner };
    }
    return undefined;
  }
  rows(projectId: string, itemId?: string) {
    return this.loop
      .rows<Verification>('loop_verifications', projectId)
      .filter((row) => !itemId || row.itemId === itemId);
  }
  view(projectId: string, itemId?: string, referenced: string[] = []) {
    return this.page(projectId, itemId, referenced).verifications;
  }
  page(
    projectId: string,
    itemId?: string,
    referenced: string[] = [],
    options: { before?: string; includeLatest?: boolean } = {}
  ) {
    // Release reviews carry no `itemId`, so an item-scoped page selects them by their covered set.
    const all = (
      this.loop.store.db
        .prepare(
          `SELECT id, json_extract(data,'$.createdAt') createdAt,
      json_extract(data,'$.itemId') itemId, json_extract(data,'$.decisionId') decisionId,
      json_extract(data,'$.channelId') channelId, json_extract(data,'$.kind') kind,
      json_extract(data,'$.itemIds') itemIds FROM loop_verifications
      WHERE json_extract(data,'$.projectId')=? ORDER BY rowid`
        )
        .all(projectId) as Array<
        Pick<Verification, 'id' | 'createdAt' | 'itemId' | 'decisionId' | 'channelId' | 'kind'> & {
          itemIds?: string | null;
        }
      >
    ).filter((row) => !itemId || row.itemId === itemId || itemIdsOf(row.itemIds).includes(itemId));
    const end = options.before ? all.findIndex((row) => row.id === options.before) : all.length;
    if (end < 0) throw new APIError(404, '复核游标不属于该项目或事项');
    const recent = all.slice(Math.max(0, end - 30), end);
    const selected = new Set(recent.map((row) => row.id));
    if (!options.before) {
      referenced.forEach((id) => selected.add(id));
      if (options.includeLatest) {
        const latest = new Map<string, (typeof all)[number]>();
        for (const row of all
          .slice()
          .reverse()
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
          // Recent/pinned release reviews remain selected above and older ones remain pageable.
          // Their distinct item sets must not consume the extra slots reserved for quiet subjects.
          if (row.kind === 'release') continue;
          const key = row.itemId
            ? `item:${row.itemId}`
            : row.decisionId
              ? `decision:${row.decisionId}`
              : `channel:${row.channelId}`;
          if (!latest.has(key)) latest.set(key, row);
        }
        [...latest.values()].slice(0, 30).forEach((row) => selected.add(row.id));
      }
    }
    const rows = all
      .filter((row) => selected.has(row.id))
      .map((row) => this.loop.store.get<Verification>('loop_verifications', row.id)!);
    // This page is on the interface's 5-second poll, so the seal is read through the cache Git's own
    // HEAD and porcelain status invalidate, never by hashing every file again on each request. An
    // unreadable version cannot pass, and now says why instead of leaving the page silently empty.
    let digest = '',
      sourceReason = '';
    if (rows.length) {
      const reading = readSourceVersion(this.loop.store.get<Project>('projects', projectId)!.path);
      if (reading.version) digest = reading.version.digest;
      else sourceReason = reading.reason || '源版本不可读';
    }
    return {
      verifications: rows.map(({ prompt, ...row }) => ({ ...row, current: this.materialCurrent(row, digest) })),
      ...(sourceReason ? { sourceStale: true, sourceReason } : {}),
      // Invalidate cached UI pages after a project mutation or source change.
      revision:
        digest +
        ':' +
        (
          this.loop.store.db
            .prepare("SELECT MAX(rowid) AS n FROM events WHERE json_extract(data,'$.projectId')=?")
            .get(projectId) as { n: number } | undefined
        )?.n,
      hasMore: end > 30,
      cursor: recent[0]?.id,
    };
  }
  subject(projectId: string, itemId?: string, decisionId?: string, stable = false) {
    const project = this.loop.store.get<Project>('projects', projectId)!;
    const item = itemId ? this.loop.store.get<WorkItem>('items', itemId) : undefined;
    const decision = decisionId ? this.loop.store.get<StrategyDecision>('strategy_decisions', decisionId) : undefined;
    const anchored = stable && !!decision?.expectations?.length;
    return {
      goal: project.goal,
      ...(anchored ? { direction: this.loop.store.get<Channel>('channels', decision.channelId)?.goal } : {}),
      item: item
        ? anchored
          ? { id: item.id, kind: item.kind }
          : { id: item.id, title: item.title, summary: item.summary, kind: item.kind }
        : undefined,
      decision: decision
        ? {
            id: decision.id,
            objective: decision.objective,
            expectedOutcome: decision.expectedOutcome,
            evaluation: decision.evaluation,
            expectations: decision.expectations,
          }
        : undefined,
    };
  }
  /**
   * A release review is anchored to the goal and the exact item set it covers, not to one item's own
   * acceptance text: later per-item edits change what an item review froze, never the candidate.
   */
  releaseSubject(projectId: string, itemIds: string[]) {
    return {
      goal: this.loop.store.get<Project>('projects', projectId)!.goal,
      release: { itemIds: [...itemIds].sort() },
    };
  }
  subjectFor(row: Pick<Verification, 'projectId' | 'itemId' | 'decisionId' | 'subjectVersion' | 'kind' | 'itemIds'>) {
    return row.kind === 'release'
      ? this.releaseSubject(row.projectId, row.itemIds || [])
      : this.subject(row.projectId, row.itemId, row.decisionId, row.subjectVersion === 'acceptance-v2');
  }
  observationIds(projectId: string, decisionId?: string) {
    const decision = decisionId ? this.loop.store.get<StrategyDecision>('strategy_decisions', decisionId) : undefined;
    if (!decision) return [];
    const evidence = this.loop.rows<Evidence>('loop_evidence', projectId);
    return (decision.expectations || []).flatMap((expected) => {
      const latest = evidence
        .filter(
          (e) =>
            this.loop.strategy.evaluation.matches(expected, e) &&
            this.loop.strategy.evaluation.isNew(decision, e) &&
            e.observedAt >= expected.notBefore &&
            e.observedAt <= expected.deadline
        )
        .at(-1);
      return [
        ...(latest ? [latest.id] : []),
        ...(expected.measurement && 'evidenceId' in expected.measurement.baseline
          ? [expected.measurement.baseline.evidenceId]
          : []),
      ];
    });
  }
  materialCurrent(row: Omit<Verification, 'prompt'>, digest: string) {
    if (
      row.version.digest !== digest ||
      row.subjectHash !== hash(this.subjectFor(row)) ||
      !this.observationIds(row.projectId, row.decisionId).every((id) => row.evidenceIds.includes(id))
    )
      return false;
    try {
      this.preflight(row.projectId, row.decisionId, row.evidenceIds, digest);
      return true;
    } catch {
      return false;
    }
  }
  /** Mechanical observation constraints are checked before paying for model judgment. */
  preflight(projectId: string, decisionId: string | undefined, evidenceIds: string[], digest: string) {
    const decision = decisionId ? this.loop.store.get<StrategyDecision>('strategy_decisions', decisionId) : undefined;
    if (!decision?.evaluationVersion) return;
    const evaluation = this.loop.strategy.evaluation,
      evidence = this.loop.rows<Evidence>('loop_evidence', projectId);
    for (const expected of decision.expectations || []) {
      const latest = evidence
        .filter(
          (e) =>
            evaluation.matches(expected, e) &&
            evaluation.isNew(decision, e) &&
            e.observedAt >= expected.notBefore &&
            e.observedAt <= expected.deadline &&
            e.observedAt <= now()
        )
        .at(-1);
      if (!latest || !evidenceIds.includes(latest.id))
        throw new APIError(
          409,
          `预期 ${expected.id} 缺少原观察窗口内的新证据；窗口已关闭时，保留旧结论并为当前工作建立新行动，不能事后追认`
        );
      if (latest.origin === 'execution') {
        const data = latest.data as ExecutionData;
        if (
          data?.boundVersion !== true ||
          data?.outputComplete !== true ||
          !Number.isInteger(data?.exitCode) ||
          data.sourceVersion?.digest !== digest
        )
          throw new APIError(
            409,
            `预期 ${expected.id} 缺少与当前源码一致的完整原生执行证据；先在有效观察窗口内重新执行`
          );
      }
      if (expected.measurement) {
        const observation = evaluation.observation(decision, expected, decision.review?.createdAt || now(), latest);
        if (observation.baselineEvidenceId && !evidenceIds.includes(observation.baselineEvidenceId))
          throw new APIError(409, `预期 ${expected.id} 缺少原基线材料`);
        if (observation.verdict !== 'met')
          throw new APIError(
            409,
            `预期 ${expected.id} 尚不能证明达标：${observation.issues.join('；') || '按原基线比较后未达标'}；先补齐观测或修正方法，再请求独立复核`
          );
      } else if (expected.rule) {
        const value = evaluation.ruleValue(expected, evidenceData(latest)),
          rule = expected.rule;
        const met =
          rule.operator === 'equals'
            ? typeof value === typeof rule.expected && value === rule.expected
            : typeof value === 'number' &&
              typeof rule.expected === 'number' &&
              (rule.operator === 'gte' ? value >= rule.expected : value <= rule.expected);
        if (!met)
          throw new APIError(
            409,
            `预期 ${expected.id} 的原始字段缺失或未达标，先核对实际响应和约定口径，再请求独立复核`
          );
      }
    }
  }
  request(scope: Scope, input: Record<string, unknown>): Verification {
    // No new review starts while a version switch is waiting; a queued one still runs to completion.
    this.loop.upgrade?.require('切换完成后再发起独立复核，已排队的复核会照常完成');
    if (input.kind !== undefined && choice(input.kind, 'kind', ['item', 'release'] as const) === 'release')
      return this.requestRelease(scope, input);
    keys(input, ['kind', 'itemId', 'decisionId', 'evidenceIds']);
    const { project } = this.loop.scope(scope);
    const decision = input.decisionId
      ? this.loop.store.get<StrategyDecision>('strategy_decisions', string(input.decisionId, 'decisionId', 200))
      : undefined;
    if (input.decisionId && decision?.projectId !== scope.projectId) throw new APIError(404, '行动不属于当前项目');
    const item = this.loop.item(scope, input.itemId ?? decision?.itemId);
    if (!item && !decision) throw new APIError(400, '复核必须关联 feature 或行动');
    if (decision?.itemId && decision.itemId !== item?.id) throw new APIError(400, '复核的 feature 必须与原行动相同');
    const evidenceIds = [
      ...new Set([...this.loop.refs(scope, input.evidenceIds ?? []), ...this.observationIds(project.id, decision?.id)]),
    ].sort();
    if (!evidenceIds.length) throw new APIError(400, '先准备实际证据再请求复核');
    const version = sourceVersion(project.path),
      subject = this.subject(project.id, item?.id, decision?.id, true),
      subjectHash = hash(subject);
    this.preflight(project.id, decision?.id, evidenceIds, version.digest);
    const previous = this.rows(project.id).findLast(
      (row) =>
        row.subjectVersion === 'acceptance-v2' &&
        row.subjectHash === subjectHash &&
        row.version.digest === version.digest &&
        evidenceIds.every((id) => row.evidenceIds.includes(id))
    );
    // Same material does not create another paid attempt, including after a failed/unknown review.
    if (previous) {
      const latest = this.rows(project.id).findLast(
        (row) => row.itemId === item?.id && row.decisionId === decision?.id
      );
      if (latest?.id !== previous.id)
        throw new APIError(409, '已有更新的复核材料，不能回选较早结论；读取最新复核后准备新证据');
      return previous;
    }
    if (this.rows(project.id).some((row) => !terminal(row)))
      throw new APIError(409, '项目已有复核待完成，先读取其结果');
    const evidence = evidenceIds.map((id) => this.loop.store.get<Evidence>('loop_evidence', id)!);
    const prompt = this.redact(
      itemReviewText({
        subject: JSON.stringify(subject),
        progress: JSON.stringify(item ? { title: item.title, summary: item.summary } : null),
        version: JSON.stringify(version),
        evidence: JSON.stringify(evidence),
        minutes: Math.round(reviewTimeoutSeconds.item / 60),
      })
    );
    if (Buffer.byteLength(prompt) > 512 * 1024)
      throw new APIError(413, '复核材料超过 512 KiB，请选择直接相关的证据；原始记录仍保留');
    const row: Verification = {
      id: randomUUID(),
      projectId: project.id,
      channelId: scope.channelId,
      runId: scope.runId,
      itemId: item?.id,
      decisionId: decision?.id,
      evidenceIds,
      subjectHash,
      subjectVersion: 'acceptance-v2',
      version,
      status: 'queued',
      summary: '等待独立只读复核',
      checks: [],
      findings: [],
      limitations: [],
      createdAt: now(),
      prompt,
      bytes: 0,
      commandCount: 0,
      timeoutSeconds: reviewTimeoutSeconds.item,
    };
    this.loop.store.put('loop_verifications', row);
    this.loop.audit(
      scope,
      'verification.queued',
      '已准备独立复核，完成前保留待验证状态',
      row.itemId,
      { verificationId: row.id },
      'system'
    );
    return row;
  }
  /**
   * One review of a whole release candidate. Every item only needs a review from the version it was
   * changed at; this review looks at the candidate itself: whether the cited checks belong to the
   * current source, and whether anything committed since each item's own review contradicts it.
   */
  requestRelease(scope: Scope, input: Record<string, unknown>): Verification {
    keys(input, ['kind', 'itemIds', 'evidenceIds']);
    const { project } = this.loop.scope(scope);
    const itemIds = itemList(input.itemIds);
    const items = itemIds.map((id) => this.loop.item(scope, id, false)!);
    const never = items.filter((item) => !this.passedEver(project.id, item.id));
    if (never.length)
      throw new APIError(
        409,
        `以下事项没有任何一次独立复核通过，先各自复核后再做发布级复核：${never
          .map((item) => `#${item.number}「${item.title}」`)
          .join('、')}`
      );
    const evidenceIds = [...new Set(this.loop.refs(scope, input.evidenceIds ?? []))].sort();
    const version = sourceVersion(project.path);
    const evidence = evidenceIds.map((id) => this.loop.store.get<Evidence>('loop_evidence', id)!);
    const executions = evidence.filter((row) => currentExecution(row, version.digest));
    if (!executions.length) throw new APIError(400, '至少一项当前源版本的执行证据');
    const subject = this.releaseSubject(project.id, itemIds),
      subjectHash = hash(subject);
    // The same candidate and the same item set reuse their conclusion instead of paying for another
    // review, including after a failed or unknown one: a counterexample is fixed in the source, and
    // `verification.retry` is the bounded way to attempt an unknown result again.
    const previous = this.rows(project.id).findLast(
      (row) => row.kind === 'release' && row.version.digest === version.digest && row.subjectHash === subjectHash
    );
    if (previous) return previous;
    if (this.rows(project.id).some((row) => !terminal(row)))
      throw new APIError(409, '项目已有复核待完成，先读取其结果');
    const reviewed = items.map((item) => {
      const passed = this.passedEver(project.id, item.id)!;
      return {
        itemId: item.id,
        number: item.number,
        title: item.title,
        summary: item.summary,
        passedVerification: {
          id: passed.id,
          head: passed.version.head,
          digest: passed.version.digest,
          files: passed.version.files,
          finishedAt: passed.finishedAt,
          summary: passed.summary,
        },
      };
    });
    const checks = executions.map((row) => {
      const data = row.data as ExecutionData;
      return {
        evidenceId: row.id,
        command: data.command,
        cwd: data.cwd,
        exitCode: data.exitCode,
        boundVersion: data.boundVersion,
        outputComplete: data.outputComplete,
        sourceVersion: data.sourceVersion,
        observedAt: row.observedAt,
        outputTail: String(data.output ?? '').slice(-outputTail),
      };
    });
    const prompt = this.redact(
      releaseReviewText({
        version: JSON.stringify(version),
        reviewed: JSON.stringify(reviewed),
        checks: JSON.stringify(checks),
        subject: JSON.stringify(subject),
        minutes: Math.round(reviewTimeoutSeconds.release / 60),
      })
    );
    if (Buffer.byteLength(prompt) > 512 * 1024)
      throw new APIError(413, '复核材料超过 512 KiB，请减少引用的事项或证据；原始记录仍保留');
    const row: Verification = {
      id: randomUUID(),
      projectId: project.id,
      channelId: scope.channelId,
      runId: scope.runId,
      kind: 'release',
      itemIds,
      evidenceIds,
      subjectHash,
      version,
      status: 'queued',
      summary: '等待发布级独立只读复核',
      checks: [],
      findings: [],
      limitations: [],
      createdAt: now(),
      prompt,
      bytes: 0,
      commandCount: 0,
      timeoutSeconds: reviewTimeoutSeconds.release,
    };
    this.loop.store.put('loop_verifications', row);
    for (const itemId of itemIds)
      this.loop.audit(
        scope,
        'verification.queued',
        `已准备发布级独立复核，覆盖 ${itemIds.length} 个事项；通过前不能提交发布`,
        itemId,
        { verificationId: row.id, kind: 'release' },
        'system'
      );
    return row;
  }
  retry(scope: Scope, input: Record<string, unknown>) {
    keys(input, ['id']);
    this.loop.upgrade?.require('切换完成后再重试复核，原记录保持不变');
    this.loop.scope(scope);
    const row = this.loop.store.get<Verification>('loop_verifications', string(input.id, 'id', 200));
    if (row?.projectId !== scope.projectId) throw new APIError(404, '复核不属于当前项目');
    if (row.status !== 'unknown' || row.interruptPending || !this.current(row))
      throw new APIError(409, '仅可在原复核已停止、材料仍有效时重试未知结果；失败反例需要先修正');
    if (accountWait(row))
      throw new APIError(409, '复核因账号额度用尽停下，额度恢复后会自动重试同一次，不必消耗当天的重试次数');
    const history = this.rows(scope.projectId);
    const latest = history.findLast(
      (r) => r.subjectHash === row.subjectHash && r.version.digest === row.version.digest
    );
    if (latest?.id !== row.id) throw new APIError(409, '已有更新的复核，不能重试已被取代的旧未知记录');
    if (
      row.kind === 'release' &&
      history.some(
        (r) =>
          r.kind === 'release' &&
          r.status === 'failed' &&
          r.itemIds?.some((id) => row.itemIds?.includes(id)) &&
          this.materialCurrent(r, row.version.digest)
      )
    )
      throw new APIError(409, '当前候选已有相关发布级复核失败，先修正源码反例再复核');
    if (this.rows(scope.projectId).some((r) => !terminal(r))) throw new APIError(409, '项目已有复核待完成');
    const attempts = this.rows(scope.projectId).filter(
      (r) =>
        r.subjectHash === row.subjectHash &&
        r.version.digest === row.version.digest &&
        hash(r.evidenceIds) === hash(row.evidenceIds) &&
        r.createdAt.slice(0, 10) === now().slice(0, 10)
    );
    if (attempts.length >= 2) throw new APIError(429, '相同材料每天最多两次复核，继续前需要新证据或等待环境恢复');
    const next: Verification = {
      ...row,
      id: randomUUID(),
      channelId: scope.channelId,
      runId: scope.runId,
      prompt: row.prompt + this.retryContext(row),
      status: 'queued',
      summary: '等待重新核验未知结果',
      createdAt: now(),
      startedAt: undefined,
      finishedAt: undefined,
      threadId: undefined,
      turnId: undefined,
      model: undefined,
      interruptPending: undefined,
      checks: [],
      findings: [],
      limitations: [],
      bytes: 0,
      commandCount: 0,
    };
    return this.loop.store.transaction(() => {
      this.loop.store.put('loop_verifications', next);
      const intents = this.loop.rows<Finalization>('loop_finalizations', scope.projectId);
      for (const intent of intents.filter((i) => i.verificationId === row.id && i.status === 'rejected')) {
        if (
          intents.findLast((i) => i.targetId === intent.targetId && i.operation === intent.operation)?.id !== intent.id
        )
          continue;
        const target = this.loop.store.get<{ revision: number; status: string }>(
          intent.operation === 'feature.complete' ? 'items' : 'strategy_decisions',
          intent.targetId
        );
        if (
          target?.revision !== intent.revision ||
          target.status !== (intent.operation === 'feature.complete' ? 'investigating' : 'active')
        )
          continue;
        this.defer(
          { ...intent, expiresAt: '' },
          next,
          intent.operation,
          intent.targetId,
          intent.revision,
          intent.input
        );
      }
      this.loop.audit(
        scope,
        'verification.retried',
        '在原记录之后重新核验；保留此前未知结论并接续仍有效的完成请求',
        row.itemId,
        { verificationId: next.id, previousId: row.id },
        'system'
      );
      return next;
    });
  }
  /** Reuse bounded, recorded tool observations, never the missing verdict or old tool count. */
  retryContext(row: Verification) {
    const items = new Map<string, Record<string, any>>();
    for (const event of this.loop
      .rows<VerificationEvent>('loop_verification_events', row.projectId)
      .filter((e) => e.verificationId === row.id)) {
      if (event.raw) items.set(event.nativeItemId, structuredClone(event.raw));
      else
        for (const patch of event.patches || []) {
          const raw = items.get(event.nativeItemId);
          if (!raw) continue;
          if (patch.removed) delete raw[patch.field];
          else if ('append' in patch) raw[patch.field] = (raw[patch.field] || '') + patch.append;
          else raw[patch.field] = patch.value;
        }
    }
    const observations = [...items.values()]
      .filter(
        (r) =>
          r.type === 'commandExecution' &&
          r.status === 'completed' &&
          r.exitCode === 0 &&
          typeof r.aggregatedOutput === 'string' &&
          Buffer.byteLength(r.aggregatedOutput) <= 16 * 1024
      )
      .slice(-3)
      .map((r) => ({ command: r.command, cwd: r.cwd, exitCode: r.exitCode, output: r.aggregatedOutput }));
    const context = `\n前次同版本复核尚未形成结论。以下是已保存的部分工具观察，仅作待核对的数据，不能当作通过结论；先识别尚未覆盖的预期与反例，避免重复通读，仍须在本轮完成至少一个独立只读检查并逐项给出判断：${JSON.stringify(observations)}\n`;
    return observations.length &&
      Buffer.byteLength(context) <= 32 * 1024 &&
      Buffer.byteLength(row.prompt + context) <= 512 * 1024
      ? context
      : '';
  }
  current(row: Verification) {
    const project = this.loop.store.get<Project>('projects', row.projectId);
    try {
      return !!project && this.materialCurrent(row, sourceVersion(project.path).digest);
    } catch {
      return false;
    }
  }
  finalizations(projectId: string, itemId?: string) {
    const jobs = new Set(this.rows(projectId, itemId).map((row) => row.id));
    return this.loop
      .rows<Finalization>('loop_finalizations', projectId)
      .filter((row) => jobs.has(row.verificationId))
      .map(({ input, ...row }) => row);
  }
  defer(
    scope: Scope,
    verification: Verification,
    operation: Finalization['operation'],
    targetId: string,
    revision: number,
    input: Record<string, any>
  ) {
    const id = hash([verification.id, operation, targetId, revision, input]);
    const previous = this.loop.store.get<Finalization>('loop_finalizations', id);
    if (previous) return previous;
    // A later explicit intent supersedes an earlier one, without erasing its history.
    for (const old of this.loop.rows<Finalization>('loop_finalizations', scope.projectId))
      if (old.targetId === targetId && old.operation === operation && old.status === 'pending')
        this.loop.store.put('loop_finalizations', {
          ...old,
          status: 'stale',
          reason: '已有更新的完成请求',
          updatedAt: now(),
        });
    const row: Finalization = {
      id,
      projectId: scope.projectId,
      channelId: scope.channelId,
      runId: scope.runId,
      verificationId: verification.id,
      operation,
      targetId,
      revision,
      input: structuredClone(input),
      status: terminal(verification) && verification.status !== 'passed' ? 'rejected' : 'pending',
      createdAt: now(),
      updatedAt: now(),
    };
    this.loop.store.put('loop_finalizations', row);
    return row;
  }
  settle(verificationId: string) {
    const verification = this.loop.store.get<Verification>('loop_verifications', verificationId);
    // A review waiting for the account has reached no verdict of its own, so the requests saved
    // against it are neither applied nor rejected until the re-queued attempt concludes.
    if (!verification || !terminal(verification) || accountWait(verification)) return;
    const intents = this.loop
      .rows<Finalization>('loop_finalizations', verification.projectId)
      .filter((row) => row.verificationId === verificationId && row.status === 'pending')
      .sort((a, b) => Number(a.operation === 'feature.complete') - Number(b.operation === 'feature.complete'));
    for (const intent of intents)
      this.loop.store.transaction(() => {
        let status: Finalization['status'] = 'applied',
          reason = '独立复核通过，已自动完成保存的请求';
        try {
          if (verification.status !== 'passed')
            throw new APIError(
              409,
              `复核${verification.status === 'failed' ? '发现反例' : '结果未知'}，保留待处理状态`
            );
          if (
            this.requirePassed({ ...verification, expiresAt: '' }, verification.itemId, verification.decisionId).id !==
            verification.id
          )
            throw new APIError(409, '已有更新的复核，不能完成旧请求');
          const channel = this.loop.store.get<Channel>('channels', intent.channelId),
            run = this.loop.store.get<Run>('runs', intent.runId);
          if (
            channel?.projectId !== intent.projectId ||
            run?.projectId !== intent.projectId ||
            run.channelId !== intent.channelId
          )
            throw new APIError(409, '原完成请求的项目或频道已变化');
          const scope = { ...intent, expiresAt: '' } as Scope;
          if (intent.operation === 'decision.review') this.loop.strategy.review(scope, intent.input, verification);
          else {
            this.loop.strategy.requireCurrent(scope);
            const item = this.loop.item(scope, intent.targetId, false)!;
            if (item.revision !== intent.revision || item.status !== 'investigating')
              throw new APIError(409, 'feature 已更新，保留新内容；读取后重新提交完成请求');
            const status = intent.input.status as WorkItem['status'];
            const updated = {
              ...item,
              status,
              revision: item.revision + 1,
              updatedAt: now(),
              // A completed item is released; a reassignment during the review keeps the completion
              // request out, because only the responsible channel may advance the item.
              ownerChannelId: this.loop.owner(scope, item, status),
            };
            this.loop.store.put('items', updated);
            this.loop.auditChange(
              scope,
              'feature.completed',
              `复核通过，自动完成 #${item.number}「${item.title}」`,
              item.id,
              // `item` is the row the deferred request was held against — read here, never written
              // into — and `updated` is the row just stored, so item history can name the status
              // this completion moved. The review behind it stays on the `finalization.*` row below.
              { before: item, after: updated },
              'system'
            );
          }
        } catch (error) {
          status = verification.status === 'passed' ? 'stale' : 'rejected';
          reason = error instanceof Error ? error.message : '完成请求未应用';
        }
        this.loop.store.put('loop_finalizations', { ...intent, status, reason, updatedAt: now() });
        this.loop.audit(
          intent,
          `finalization.${status}`,
          reason,
          verification.itemId,
          { finalizationId: intent.id, verificationId },
          'system'
        );
      });
  }
  requirePassed(scope: Scope, itemId?: string, decisionId?: string) {
    const rows = this.rows(scope.projectId, itemId).filter((row) => !decisionId || row.decisionId === decisionId);
    const latest = rows.at(-1);
    if (!latest || latest.status !== 'passed' || !this.current(latest))
      throw new APIError(
        409,
        '需要当前源版本的独立复核通过；先 verification.request，复核问题由原任务修正，不能用自述或旧版本结果替代'
      );
    return latest;
  }
  /** An item's latest passed review, from any source version; `undefined` when it never passed one. */
  passedEver(projectId: string, itemId: string) {
    return this.rows(projectId, itemId).findLast((row) => row.status === 'passed');
  }
  /**
   * The release gate's per-item half: the item was independently reviewed at least once, at whatever
   * version it was changed at. Completing an item still needs `requirePassed` on the current version.
   */
  requirePassedEver(scope: Scope, itemId: string) {
    const latest = this.passedEver(scope.projectId, itemId);
    if (!latest)
      throw new APIError(409, '发布事项至少需要一次独立复核通过；先 verification.request 复核该事项，不能用自述替代');
    return latest;
  }
  /** The release gate's candidate half: one passed review of this source version covering these items. */
  requireReleasePassed(scope: Scope, itemIds: string[]) {
    const project = this.loop.store.get<Project>('projects', scope.projectId)!;
    const digest = sourceVersion(project.path).digest;
    const seen = new Set<string>();
    let passed: Verification | undefined;
    for (const row of this.rows(scope.projectId).toReversed()) {
      if (row.kind !== 'release' || !this.materialCurrent(row, digest)) continue;
      const covered = row.itemIds || [];
      const related = itemIds.some((id) => covered.includes(id));
      // A failed candidate requires a source fix, not a later pass bought through a different scope.
      if (related && row.status === 'failed')
        throw new APIError(409, '当前候选已有相关发布级复核失败，先修正源码反例再复核');
      const key = [...covered].sort().join(',');
      // A bounded retry supersedes its own unknown result, never a different review scope.
      if (seen.has(key)) continue;
      seen.add(key);
      if (!related) continue;
      if (row.status !== 'passed')
        throw new APIError(409, '有较新的相关发布级复核未通过；先读取最新结果，不能回选较早的通过记录');
      if (!passed && itemIds.every((id) => covered.includes(id))) passed = row;
    }
    if (passed) return passed;
    throw new APIError(409, '需要当前源版本的发布级复核通过；先 verification.request kind:release');
  }
  read(scope: Scope, input: Record<string, unknown>) {
    keys(input, ['id']);
    this.loop.scope(scope);
    const row = this.loop.store.get<Verification>('loop_verifications', string(input.id, 'id', 200));
    if (row?.projectId !== scope.projectId) throw new APIError(404, '复核不属于当前项目');
    const { prompt, ...summary } = row;
    return {
      ...summary,
      current: this.current(row),
      events: this.loop
        .rows<VerificationEvent>('loop_verification_events', scope.projectId)
        .filter((e) => e.verificationId === row.id),
    };
  }
  tick() {
    if (this.loop.closed) return;
    for (const id of new Set(
      this.loop.store.byStatus<Finalization>('loop_finalizations', ['pending']).map((row) => row.verificationId)
    ))
      this.settle(id);
    // One reading for all three loops instead of separate scans of the same table: the interrupts
    // are started first, exactly as before, and `interrupt()` only clears its own flag, never a
    // row's status. The account-wait rows are the ones a spent quota stopped; they leave that state
    // in the same tick their wait passes, so the set stays as small as the queued one.
    const rows = this.loop.store.db
      .prepare(
        `SELECT data FROM loop_verifications
           WHERE json_extract(data,'$.interruptPending')=1
              OR json_extract(data,'$.status')='queued'
              OR (json_extract(data,'$.status')='unknown' AND json_extract(data,'$.usageWait.kind')='account')
           ORDER BY rowid`
      )
      .all();
    const waiting = parseRows<Verification>(rows);
    for (const row of waiting)
      if (row.interruptPending && !this.interrupting.has(row.id)) this.loop.track(this.interrupt(row.id));
    for (const row of waiting.filter((row) => accountWait(row) && row.retryAt! <= now())) this.resume(row);
    for (const row of waiting.filter((row) => row.status === 'queued')) {
      if (this.active.size >= 1) return;
      if (row.retryAt && row.retryAt > now()) continue;
      const channel = this.loop.store.get<Channel>('channels', row.channelId),
        run = this.loop.store.get<Run>('runs', row.runId);
      if (!channel) continue;
      // The control gate asks whether this channel is still working, so that reviewing for it is
      // still wanted. That question decides nothing for a review a bounded CLI turn requested from
      // its own report: the turn is over, it was already paid for by the person who ran it or by the
      // scheduler, and such a channel is normally paused between turns (「留言并运行一轮」 is a
      // manual run with autonomy off). Waiting for autonomy to be switched on would leave the item
      // in 调查中 for good and, through `Engine.start`'s pending-review gate, hold the whole project
      // with it. The day's run budget and the one-reviewer-at-a-time rule still apply.
      const idle = !this.loop.store.get<Control>('controls', row.channelId)?.enabled && run?.status !== 'running';
      if (idle && channel.runtime === 'codex') continue;
      if (this.loop.store.runCount(row.channelId, now().slice(0, 10)) >= channel.maxRunsPerDay) continue;
      this.loop.track(this.start(row.id));
    }
  }
  /**
   * Puts a review the account's quota stopped back in the queue once its wait has passed: the same
   * row, so the day's retry budget is untouched, with the previous attempt's per-run counters and
   * native task cleared. It starts on the next tick, like any queued review. Newer material for the
   * same subject and version supersedes it instead — then the wait is dropped and the row stays the
   * unknown result it is, so its saved completion requests settle.
   */
  resume(row: Verification) {
    const latest = this.rows(row.projectId).findLast(
      (r) => r.subjectHash === row.subjectHash && r.version.digest === row.version.digest
    );
    if (latest?.id !== row.id) {
      this.update(row.id, { retryAt: undefined, usageWait: undefined });
      return;
    }
    this.update(row.id, {
      status: 'queued',
      summary: '账号额度已恢复，等待重新核验',
      retryAt: undefined,
      usageWait: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      threadId: undefined,
      turnId: undefined,
      model: undefined,
      bytes: 0,
      commandCount: 0,
    });
    this.loop.audit(
      row,
      'verification.requeued',
      '账号额度已恢复，自动重新核验同一次，不占用当天的重试次数',
      row.itemId,
      { verificationId: row.id },
      'system'
    );
  }
  /**
   * Keeps a queued review waiting for the moment a blocked gate named, instead of concluding
   * anything: the tick re-attempts it, and the wait is audited the first time it changes.
   */
  holdForUsage(id: string, gate: UsageGate & { blocked: true }) {
    const row = this.loop.store.get<Verification>('loop_verifications', id)!;
    if (gate.pending) {
      this.update(id, { retryAt: gate.until });
      return;
    }
    const changed = !row.usageWait || row.usageWait.kind !== gate.kind || row.usageWait.window !== gate.window;
    this.update(id, {
      // Bounded: re-check within a minute so a cleared limit takes effect, and at the reset at the latest.
      retryAt: new Date(Math.min(Date.parse(gate.until), Date.now() + 60_000)).toISOString(),
      usageWait: {
        kind: gate.kind,
        ...(gate.window ? { window: gate.window } : {}),
        since: changed ? now() : row.usageWait!.since,
      },
    });
    if (changed)
      this.loop.audit(
        row,
        'verification.usage-wait',
        `独立复核等待额度：${gate.message}`,
        row.itemId,
        { verificationId: id, kind: gate.kind },
        'system'
      );
  }
  /**
   * One review attempt on one CLI. Returns the observation proving the runtime could not run at
   * all — only when `watch` says another runtime is standing by, and then nothing has been recorded
   * against the row, so that runtime may still review it. Otherwise `undefined`, and the row has
   * already reached whatever conclusion this attempt reached.
   */
  async attempt(id: string, runner: ReviewRunner, options: Omit<ReviewStart, 'observe'>, watch: boolean) {
    let unavailable: ReviewObservation | undefined;
    const input: ReviewStart = {
      ...options,
      observe: (observation) => {
        if (unavailable) return;
        if (watch && runtimeUnavailable(observation)) {
          unavailable = observation;
          return;
        }
        try {
          this.ingestObservation(id, observation);
        } catch (error) {
          this.stop(id, `复核记录不可用：${this.redact(error instanceof Error ? error.message : '记录失败')}`);
        }
      },
    };
    const execution = runner.start(input);
    const active = this.active.get(id);
    if (active) active.cancel = execution.cancel;
    else execution.cancel();
    await execution.done;
    return unavailable;
  }
  async start(id: string) {
    const row = this.loop.store.get<Verification>('loop_verifications', id)!;
    if (row.status !== 'queued' || this.active.has(id) || this.loop.closed) return;
    const project = this.loop.store.get<Project>('projects', row.projectId)!;
    if (!this.current(row)) {
      this.finish(id, 'unknown', '复核前源版本或目标已变化，请准备新材料');
      return;
    }
    const channel = this.loop.store.get<Channel>('channels', row.channelId);
    const selected = this.reviewRunner(channel);
    // The usage gate holds a queued review in place; it is re-attempted by the tick, never finished
    // as unknown. It reads the Codex account, so a review that does not spend it — one running on
    // Claude Code — is not held by the Codex reserve, this project's Codex budget or a spent Codex
    // account, exactly as a Claude Code or Trae turn is not.
    const gate = selected?.owner === 'claude-cli' ? undefined : this.loop.usage?.gate(project);
    if (gate?.blocked) {
      this.holdForUsage(id, gate);
      return;
    }
    if (!selected && !this.transport?.createThread) {
      this.finish(id, 'unknown', '原生后台暂不支持独立只读复核');
      return;
    }
    this.loop.store.put('loop_verifications', {
      ...row,
      status: 'running',
      ...(selected ? { executionOwner: selected.owner } : {}),
      startedAt: now(),
      summary: '独立检查源文件、原始证据与反例',
      retryAt: undefined,
      usageWait: undefined,
    });
    // The reviewer reads and runs the reviewed version in a copy of its own, when one can be made
    // that provably holds exactly that version; otherwise it keeps reading the project directory.
    const checkout = createReviewCheckout({
      home: this.loop.home,
      projectPath: project.path,
      verificationId: id,
      version: row.version,
    });
    const cwd = checkout?.path || project.path;
    const prompt = row.prompt + (checkout ? this.redact(isolatedReviewText(checkout)) : '');
    const active = {
      timer: setTimeout(() => this.stop(id, capReached(row.timeoutSeconds)), row.timeoutSeconds * 1000),
      seen: new Map<string, Record<string, any>>(),
      stop: undefined as (() => void) | undefined,
      cancel: undefined as (() => void) | undefined,
      checkout,
    };
    this.active.set(id, active);
    try {
      if (selected) {
        // The channel's model belongs to the channel's runtime; a review on the other one takes the
        // default of the CLI it actually runs. `id` and `isolated` are context a runner may use.
        const options = (owner: ReviewOwner): Omit<ReviewStart, 'observe'> => ({
          id,
          cwd,
          prompt,
          isolated: !!checkout,
          timeoutMs: row.timeoutSeconds * 1000,
          model: (channel?.runtime === reviewRuntimes[owner] ? channel?.model : '') || undefined,
        });
        // One bounded fallback, and only this way round: a Claude Code that cannot run on this Mac
        // leaves the Codex review it replaced, rather than an item nothing can ever verify.
        const spare = selected.owner === 'claude-cli' ? this.runners.get('codex-cli') : undefined;
        try {
          let unavailable: ReviewObservation | undefined;
          try {
            unavailable = await this.attempt(id, selected.runner, options(selected.owner), !!spare);
          } catch (error) {
            // A runner that cannot even reach its CLI throws instead of observing; same fault, and
            // anything else is still the outer failure this always was.
            const failure: ReviewObservation = {
              items: [],
              status: 'failed',
              error: error instanceof Error ? error.message : '复核运行时无法启动',
            };
            if (!spare || !runtimeUnavailable(failure)) throw error;
            unavailable = failure;
          }
          if (!unavailable || !spare) return;
          this.loop.audit(
            row,
            'verification.runtime-unavailable',
            `Claude Code 复核运行时无法在本机运行，改由 Codex 复核本次：${this.redact(unavailable.error || '').slice(0, 500)}。这是本机环境问题，不是复核结论。`,
            row.itemId,
            { verificationId: id, from: selected.owner, to: 'codex-cli' },
            'system'
          );
          if (terminal(this.loop.store.get<Verification>('loop_verifications', id)!)) return;
          // The next runtime's verdict rests on what it observes itself, not on the failed attempt.
          active.seen.clear();
          this.update(id, { bytes: 0, commandCount: 0, executionOwner: 'codex-cli' });
          // A Codex review spends the Codex account, so it faces the gate the first attempt skipped.
          const codexGate = this.loop.usage?.gate(project);
          if (codexGate?.blocked) {
            // Back to the queue with the wait, exactly like a review the gate stopped before it ran.
            this.releaseCheckout(id);
            clearTimeout(active.timer);
            this.active.delete(id);
            this.update(id, {
              status: 'queued',
              summary: '等待额度后由 Codex 复核',
              startedAt: undefined,
              executionOwner: undefined,
            });
            this.holdForUsage(id, codexGate);
            return;
          }
          await this.attempt(id, spare, options('codex-cli'), false);
        } finally {
          // Success, refusal, cancellation, the cap or a throw all end here; `finish` has normally
          // released it already, and this covers a runner that resolves without a verdict at all.
          this.releaseCheckout(id);
        }
        return;
      }
      await this.transport!.connect();
      if (terminal(this.loop.store.get<Verification>('loop_verifications', id)!)) return;
      if (!this.transport!.backgroundReady) {
        this.stop(id, '原生后台暂不支持独立只读复核');
        return;
      }
      const snapshot = await this.transport!.createThread!(cwd);
      this.update(id, {
        threadId: snapshot.threadId,
        model: snapshot.state.latestThreadSettings?.model || snapshot.state.model,
      });
      if (terminal(this.loop.store.get<Verification>('loop_verifications', id)!)) return;
      const unsubscribe = await this.transport!.subscribe(snapshot.threadId, (s) => {
        try {
          this.ingest(id, s);
        } catch (error) {
          this.stop(id, `复核记录不可用：${this.redact(error instanceof Error ? error.message : '记录失败')}`);
        }
      });
      if (!this.active.has(id)) {
        unsubscribe();
        return;
      }
      active.stop = unsubscribe;
      const response = (await this.transport!.sendMessage(snapshot.threadId, prompt, id, [], {
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      })) as { turn?: { id?: string }; turnId?: string } | undefined;
      this.update(id, { turnId: response?.turn?.id || response?.turnId });
      const afterSend = this.loop.store.get<Verification>('loop_verifications', id)!;
      if (terminal(afterSend)) {
        if (afterSend.status === 'unknown') {
          this.update(id, { interruptPending: true });
          await this.interrupt(id);
        }
        return;
      }
      this.ingest(id, await this.transport!.readThread(snapshot.threadId));
    } catch (error) {
      this.stop(
        id,
        `原生复核未获完整回执：${this.redact(error instanceof Error ? error.message : '连接失败')}；不会自动重复发送`
      );
    }
  }
  update(id: string, patch: Partial<Verification>) {
    const row = this.loop.store.get<Verification>('loop_verifications', id)!;
    this.loop.store.put('loop_verifications', { ...row, ...patch });
  }
  /** Removes this review's disposable checkout, once. A review that made none releases nothing. */
  releaseCheckout(id: string) {
    const active = this.active.get(id);
    if (!active?.checkout) return;
    const { projectPath, path } = active.checkout;
    active.checkout = undefined;
    removeReviewCheckout(projectPath, path);
  }
  /**
   * Boot-time cleanup of checkouts a killed service left behind. Called after the running rows have
   * been recorded, so every directory there belongs to a review that is over.
   */
  pruneCheckouts() {
    const running = new Set(
      this.loop.store
        .all<Verification>('loop_verifications')
        .filter((row) => row.status === 'running')
        .map((row) => row.id)
    );
    const paths = [...new Set(this.loop.store.all<Project>('projects').map((project) => project.path))];
    pruneReviewCheckouts(this.loop.home, paths, running);
  }
  ingest(id: string, snapshot: NativeSnapshot) {
    const row = this.loop.store.get<Verification>('loop_verifications', id)!;
    const active = this.active.get(id);
    if (!active || row.status !== 'running' || snapshot.threadId !== row.threadId) return;
    const turns = nativeTurns(snapshot.state),
      turn = row.turnId
        ? turns.find((t) => (t.turnId || t.id) === row.turnId)
        : turns.find((t) => t.params?.clientUserMessageId === id) || turns[0];
    if (!turn) return;
    this.ingestObservation(
      id,
      {
        threadId: snapshot.threadId,
        turnId: String(turn.turnId || turn.id),
        items: turn.items || [],
        status: turn.status,
        error: turn.error?.message,
      },
      snapshot.state.requests || []
    );
  }
  ingestObservation(id: string, observation: ReviewObservation, requests: unknown[] = []) {
    const row = this.loop.store.get<Verification>('loop_verifications', id)!;
    const active = this.active.get(id);
    if (!active || row.status !== 'running') return;
    const { threadId, turnId, items } = observation;
    this.update(id, { ...(threadId ? { threadId } : {}), ...(turnId ? { turnId } : {}) });
    let bytes = row.bytes;
    for (const [index, raw] of items.entries()) {
      if (raw.type === 'fileChange') {
        this.stop(id, '复核出现文件变更，超出只读范围，不能判定通过');
        return;
      }
      const key = String(raw.id ?? index),
        safe = JSON.parse(this.redact(JSON.stringify(raw))),
        previous = active.seen.get(key);
      if (previous && hash(previous) === hash(safe)) continue;
      // Preserve field changes and text deltas instead of counting the same
      // growing output again on every native token notification.
      const patches = previous
        ? [...new Set([...Object.keys(previous), ...Object.keys(safe)])]
            .filter((field) => hash(previous[field]) !== hash(safe[field]))
            .map((field) =>
              !(field in safe)
                ? { field, removed: true }
                : typeof safe[field] === 'string' &&
                    typeof previous[field] === 'string' &&
                    safe[field].startsWith(previous[field])
                  ? { field, append: safe[field].slice(previous[field].length) }
                  : { field, value: safe[field] }
            )
        : undefined;
      const payload = previous ? { patches } : { raw: safe },
        size = Buffer.byteLength(JSON.stringify(payload));
      if (bytes + size > outputLimit) {
        this.stop(id, '复核原生输出超过 4 MiB 上限，完整性不足，不能判定通过');
        return;
      }
      active.seen.set(key, safe);
      bytes += size;
      this.loop.store.put('loop_verification_events', {
        id: randomUUID(),
        projectId: row.projectId,
        channelId: row.channelId,
        runId: row.runId,
        verificationId: id,
        threadId,
        turnId,
        nativeItemId: key,
        createdAt: now(),
        ...payload,
      });
    }
    // Terminal snapshots may only carry the final message. Previously observed
    // completed tools remain authoritative and must not disappear from the check.
    const commandCount = [...active.seen.values()].filter(
      (raw) =>
        raw.type === 'commandExecution' &&
        raw.status === 'completed' &&
        raw.exitCode === 0 &&
        typeof raw.aggregatedOutput === 'string'
    ).length;
    this.update(id, { bytes, commandCount });
    if (requests.length) {
      this.stop(id, '复核请求额外权限或人工输入；只读范围内无法完成，保留未知');
      return;
    }
    if (observation.status === 'inProgress') return;
    if (observation.status !== 'completed') {
      if (observation.error && quotaFailure.test(observation.error)) {
        this.waitForAccount(id, observation.error);
        return;
      }
      this.finish(
        id,
        'unknown',
        observation.error ? `复核未正常完成：${this.redact(observation.error)}` : '原生复核未正常完成'
      );
      return;
    }
    if (!this.current(row)) {
      this.finish(id, 'unknown', '复核期间源版本或目标变化，旧结论不能用于当前版本');
      return;
    }
    const messages = items.filter((r) => r.type === 'agentMessage' && r.phase === 'final_answer');
    const text = (messages.length ? messages : items.filter((r) => r.type === 'agentMessage').slice(-1))
      .map((r) => r.text || '')
      .join('\n');
    try {
      const blocks = [...text.matchAll(/```(?:morrow|nohuman)-verification\s*\n([\s\S]*?)```/g)];
      if (blocks.length !== 1) throw new Error('缺少唯一的结构化复核结论');
      const report = JSON.parse(blocks[0][1]) as ReviewReport;
      if (
        !['pass', 'fail', 'unknown'].includes(report.verdict) ||
        typeof report.summary !== 'string' ||
        !report.summary.trim() ||
        !Array.isArray(report.checks) ||
        !Array.isArray(report.findings) ||
        !Array.isArray(report.limitations)
      )
        throw new Error('复核结论格式不完整');
      const decision = row.decisionId
        ? this.loop.store.get<StrategyDecision>('strategy_decisions', row.decisionId)
        : undefined;
      const expected = decision?.expectations?.length ? decision.expectations.map((e) => e.id) : ['feature'];
      if (
        report.checks.length !== expected.length ||
        new Set(report.checks.map((c) => c.expectationId)).size !== expected.length ||
        report.checks.some(
          (c) =>
            !expected.includes(c.expectationId) ||
            !['met', 'not_met', 'unknown'].includes(c.verdict) ||
            typeof c.reason !== 'string' ||
            !c.reason.trim()
        )
      )
        throw new Error('复核遗漏或重复了原始预期');
      if (
        report.findings.length > 30 ||
        report.findings.some((f) => !['blocking', 'note'].includes(f.severity) || typeof f.message !== 'string') ||
        report.limitations.length > 30 ||
        report.limitations.some((v) => typeof v !== 'string')
      )
        throw new Error('复核问题格式无效');
      if (
        report.verdict === 'pass' &&
        (!commandCount ||
          report.checks.some((c) => c.verdict !== 'met') ||
          report.findings.some((f) => f.severity === 'blocking'))
      )
        throw new Error('没有实际只读检查或仍有未通过项，不能判定通过');
      this.update(id, { checks: report.checks, findings: report.findings, limitations: report.limitations });
      this.finish(
        id,
        report.verdict === 'pass' ? 'passed' : report.verdict === 'fail' ? 'failed' : 'unknown',
        report.summary
      );
    } catch (error) {
      this.finish(id, 'unknown', `复核结果无法核验：${error instanceof Error ? error.message : '格式错误'}`);
    }
  }
  /**
   * A spent account is not a review result. The row is recorded `unknown` with the wait it has to
   * serve, and keeps this attempt: the tick re-queues this same row once the wait has passed, so it
   * consumes neither one of the day's two retries nor the completion requests saved against it. The
   * provider's own text stays in `error`, and `UsageMonitor` learns the same wait, so no turn or
   * review on this account is launched before then.
   */
  waitForAccount(id: string, raw: string) {
    const named = usageResetAt(raw);
    const until = new Date(
      Math.max(named ? Date.parse(named) : Date.now() + blindAccountWaitMs, Date.now() + minAccountWaitMs)
    ).toISOString();
    // Only a Codex review's message is about the Codex account the rest of the service waits on;
    // a Claude Code review's own limit holds this row alone and stops no Codex turn.
    if (this.loop.store.get<Verification>('loop_verifications', id)?.executionOwner !== 'claude-cli')
      this.loop.usage?.noteAccountExhausted(until);
    this.update(id, {
      retryAt: until,
      usageWait: { kind: 'account', until, since: now() },
      error: this.redact(raw).slice(0, 2000),
    });
    this.finish(id, 'unknown', `账号额度已用尽，${clock(until)} 后自动重试`);
  }
  finish(id: string, status: Verification['status'], summary: string) {
    const row = this.loop.store.get<Verification>('loop_verifications', id);
    if (!row || terminal(row)) return;
    this.loop.store.transaction(() => {
      this.update(id, { status, summary, finishedAt: now() });
      this.settle(id);
    });
    const active = this.active.get(id);
    if (active) {
      clearTimeout(active.timer);
      active.stop?.();
      this.releaseCheckout(id);
      this.active.delete(id);
    }
    // A release review has no single item, so its result is recorded against each item it covered.
    for (const itemId of row.kind === 'release' && row.itemIds?.length ? row.itemIds : [row.itemId])
      this.loop.audit(row, 'verification.finished', summary, itemId, { verificationId: id, status }, 'system');
    this.loop.strategy.notify(row.projectId, `独立复核：${summary}`, row.decisionId);
    this.loop.wake(row.channelId, '独立复核已有结果，读取问题并继续修正或复盘');
  }
  stop(id: string, reason: string) {
    const row = this.loop.store.get<Verification>('loop_verifications', id);
    if (!row || terminal(row)) return;
    this.active.get(id)?.cancel?.();
    this.finish(id, 'unknown', reason);
    // A CLI review owns its own process; only the shared App task has a turn to interrupt.
    if (row.threadId && !row.executionOwner) {
      this.update(id, { interruptPending: true });
      this.loop.track(this.interrupt(id));
    }
  }
  async interrupt(id: string) {
    if (!this.transport || this.interrupting.has(id)) return;
    this.interrupting.add(id);
    try {
      const row = this.loop.store.get<Verification>('loop_verifications', id)!;
      if (row.executionOwner) {
        this.update(id, { interruptPending: false });
        return;
      }
      if (!row.threadId) return;
      const snapshot = await this.transport.readThread(row.threadId);
      const turn = nativeTurns(snapshot.state).find((t) =>
        row.turnId ? (t.turnId || t.id) === row.turnId : t.params?.clientUserMessageId === id
      );
      if (turn && ['inProgress', 'running'].includes(turn.status))
        await this.transport.interrupt(row.threadId, String(turn.turnId || turn.id));
      this.update(id, { interruptPending: false });
    } catch {
      /* Preserve the interruption intent across disconnect/restart. */
    } finally {
      this.interrupting.delete(id);
    }
  }
  cancelChannel(channelId: string) {
    for (const row of this.loop.store.all<Verification>('loop_verifications'))
      if (row.channelId === channelId && !terminal(row))
        this.stop(row.id, '频道已暂停，复核停止；未完成的检查保留未知');
  }
  recover() {
    for (const row of this.loop.store.all<Verification>('loop_verifications'))
      if (row.status === 'running') {
        this.finish(row.id, 'unknown', '服务重启导致复核回执不完整；保留历史，不重复启动');
        if (row.threadId) this.update(row.id, { interruptPending: true });
      }
    this.pruneCheckouts();
  }
  close() {
    for (const id of this.active.keys()) this.stop(id, '服务关闭，复核未完成，结果保留未知');
  }
}

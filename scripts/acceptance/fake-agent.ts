import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nextBlock } from '../../tests/harness/scripted-native.ts';
import type {
  PolicyExpectation,
  PolicyScenario,
  TurnContext,
  TurnPolicy,
} from '../../tests/harness/scripted-native.ts';

/**
 * Deterministic policies for fixture runs. They are not a model simulation: they exist so the
 * harness can exercise the real work interface, scheduler and gates without calling anything.
 * `careful` uses the protocol as intended; a later step adds `naive`, which breaks it on purpose so
 * the metrics can be shown to tell the two apart.
 */
export const policies: Record<string, TurnPolicy> = { careful };
export type PolicyName = keyof typeof policies;

// Extension point for step 2b: add `naive` here (same `TurnPolicy` shape, deliberately wrong use of
// the protocol — follows stale memory, defines no guardrail, never compares conditions, resubmits
// unchanged material) and register it in `policies` above. Nothing else in the harness changes.

/** Observation windows and review deadlines the careful policy asks for, in milliseconds. */
const windowMs = 6 * 3600_000;
const understandingMs = 7 * 24 * 3600_000;
/** Attempt budget a single choice may spend before the framework asks for a review. */
const maxRuns = 8;
/** How many decisions the policy opens before it settles into observation. */
const maxDecisions = 2;

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

type Snapshot = {
  context: any;
  objectiveVersion: string;
  feature?: any;
  watch?: any;
  decision?: any;
  reviewDue: boolean;
  verified: boolean;
  release?: any;
  publishedRelease?: any;
  artifactEvidenceId?: string;
  reviewedDecisions: number;
  learningExists: boolean;
};

async function careful(turn: TurnContext): Promise<string> {
  const context = await turn.grant.call('context');
  const state = read(context, turn.scenario);
  if (!state.feature) return plan(turn, state);
  if (state.decision && state.reviewDue) return review(turn, state);
  if (!state.release && state.verified) return ship(turn, state);
  return observe(turn, state);
}

/** Everything the policy decides from is read out of `context`; nothing is remembered across turns. */
function read(context: any, scenario: PolicyScenario): Snapshot {
  const feature = (context.features || []).find((row: any) => row.title === featureTitle(scenario));
  const watch = (context.watches || []).find(
    (row: any) => row.url === scenario.feedback.url && row.status !== 'cancelled'
  );
  const decisions = context.strategy?.decisions || [];
  const decision = decisions.find((row: any) => row.status === 'active' && row.channelId === context.channel.id);
  const verification = (context.verifications || [])
    .filter((row: any) => row.itemId === feature?.id)
    .filter((row: any) => row.status === 'passed' && row.current)
    .at(-1);
  const releases = context.releases || [];
  const artifact = (context.evidence || [])
    .filter((row: any) => row.origin === 'file' && row.source.endsWith(scenario.artifactPath))
    .at(-1);
  return {
    context,
    objectiveVersion: context.strategy?.objective?.version,
    feature,
    watch,
    decision,
    reviewDue: !!decision?.reviewReasons?.length,
    verified: !!verification,
    release: releases.at(-1),
    publishedRelease: releases.filter((row: any) => row.status === 'published').at(-1),
    artifactEvidenceId: artifact?.id,
    reviewedDecisions: decisions.filter((row: any) => row.status === 'reviewed').length,
    learningExists: (context.learning || []).some((row: any) => row.title === learningTitle(scenario)),
  };
}

const featureTitle = (scenario: PolicyScenario) => scenario.goal;
const learningTitle = (scenario: PolicyScenario) => `${scenario.goal}：实际反馈`;
const understandingTitle = (scenario: PolicyScenario) => `${scenario.goal}：当前判断`;

/**
 * First turn: make the change, seal the evidence for it and ask for the independent review the
 * release gate requires. The observation and the frozen contract wait for the next turn: a verdict
 * signals the channel, and a signal on a fresh choice would force a review before any data exists.
 */
async function plan(turn: TurnContext, state: Snapshot): Promise<string> {
  const call = turn.grant.call;
  const scenario = turn.scenario;
  writeFileSync(join(turn.project.path, scenario.artifactPath), scenario.artifactBody);
  await call('understanding.upsert', {
    kind: 'assumption',
    title: understandingTitle(scenario),
    statement: `目标「${scenario.goal}」的当前瓶颈尚未证实；先做一次可观测的改动并用反馈样本核对。`,
    relevance: '决定先直接改动还是先补观测能力。',
    verification: `读取 ${scenario.feedback.url} 的 ${scenario.feedback.pointer} 字段与护栏字段。`,
    status: 'active',
    evidenceIds: [],
    reviewAt: iso(understandingMs),
  });
  const feature = await call('feature.upsert', {
    title: featureTitle(scenario),
    summary: `围绕目标「${scenario.goal}」的一次改动及其观测。`,
    kind: 'feature',
    status: 'investigating',
    evidenceIds: [],
    nextStep: '封存产物、建立观测并等待真实反馈。',
  });
  const artifact = await call('evidence.capture', {
    itemId: feature.id,
    summary: '待发布产物的实际内容',
    path: scenario.artifactPath,
  });
  await call('verification.request', { itemId: feature.id, evidenceIds: [artifact.id] });
  await call('wait', { watchIds: [], releaseIds: [], deadline: iso(windowMs), reason: '等待独立复核结论。' });
  return finish('wait', scenario.goal, '改动已封存并送独立复核。', '复核通过后建立观测、冻结预期并提交发布。');
}

function expectation(spec: PolicyExpectation, kind: 'outcome' | 'guardrail', watchId: string) {
  return {
    id: spec.id,
    kind,
    claim: spec.claim,
    scope: spec.scope,
    source: { kind: 'watch', watchId },
    verification: spec.verification,
    disconfirm: spec.disconfirm,
    deadline: iso(windowMs),
    rule: spec.rule,
  };
}

/**
 * The independent review passed: register the observation, freeze the contract that will judge the
 * change, and seal the artifact for human approval — all in one turn, so no signal lands between
 * choosing and proposing.
 */
async function ship(turn: TurnContext, state: Snapshot): Promise<string> {
  const call = turn.grant.call;
  const scenario = turn.scenario;
  if (!state.artifactEvidenceId) throw new Error('careful: no captured artifact evidence to cite in a release check');
  const understanding = (state.context.strategy?.understanding || []).find(
    (row: any) => row.title === understandingTitle(scenario) && row.status === 'active'
  );
  const watch = await call('watch.create', {
    itemId: state.feature.id,
    title: '真实反馈样本',
    url: scenario.feedback.url,
    pointer: scenario.feedback.pointer,
    condition: scenario.feedback.condition.operator,
    expected: scenario.feedback.condition.expected,
    intervalSeconds: 60,
    deadline: iso(windowMs),
    continuous: true,
  });
  await call('decision.choose', {
    objectiveVersion: state.objectiveVersion,
    options: [
      {
        title: `直接改动并观测：${scenario.goal}`,
        kind: 'act',
        benefit: '能在一个观察窗口内拿到真实反馈。',
        cost: '一次改动加一次独立复核。',
        uncertainty: '指标变化是否由本次改动引起仍未知。',
      },
      {
        title: `先只观测：${scenario.goal}`,
        kind: 'observe',
        benefit: '不改动即可建立基线。',
        cost: '推迟一个观察窗口。',
        uncertainty: '没有改动也就没有可判断的效果。',
      },
    ],
    selected: 0,
    rationale: '改动已通过独立复核，观测链路可用，先取得一次可核对的结果。',
    nextStep: '提交发布提议，等待人工确认与真实反馈。',
    expectedOutcome: scenario.feedback.outcome.claim,
    evaluation: '用约定字段的实际取值核对，不用自述结论。',
    stopWhen: '护栏被突破，或观察期结束仍无窗口内数据。',
    expectations: [
      expectation(scenario.feedback.outcome, 'outcome', watch.id),
      expectation(scenario.feedback.guardrail, 'guardrail', watch.id),
    ],
    understandingRefs: understanding ? [{ id: understanding.id, revision: understanding.revision }] : [],
    evidenceIds: [state.artifactEvidenceId],
    watchIds: [watch.id],
    reviewAt: iso(windowMs),
    maxRuns,
  });
  const release = await call('release.propose', {
    itemIds: [state.feature.id],
    title: `${scenario.goal}：第一次改动`,
    changes: `更新 ${scenario.artifactPath}。`,
    rationale: '独立复核已通过当前源版本，改动可以交付。',
    expectedBenefit: `${scenario.feedback.outcome.claim}；线上收益仍待观测证实。`,
    checks: [{ name: '产物内容核对', result: 'passed', evidenceIds: [state.artifactEvidenceId] }],
    risks: '改动直接影响首次使用路径。',
    rollback: '恢复上一版产物。',
    observationPlan: `上线后读取 ${scenario.feedback.pointer} 与护栏字段，在观察窗口内复盘。`,
    artifactPath: scenario.artifactPath,
    target: { url: scenario.feedback.releaseUrl, statusUrl: scenario.feedback.statusUrl, label: '隔离验收接收端' },
  });
  await call('wait', {
    watchIds: [watch.id],
    releaseIds: [release.id],
    deadline: iso(windowMs),
    reason: '等待人工确认发布，并在上线后观察指标。',
  });
  return finish('wait', scenario.goal, '预期已冻结，发布提议已封存，等待人工确认。', '等待确认与上线后的反馈。');
}

/** A frozen contract came due: check every original expectation against real captured samples. */
async function review(turn: TurnContext, state: Snapshot): Promise<string> {
  const call = turn.grant.call;
  const decision = state.decision;
  const results = [];
  for (const expected of decision.expectations || []) {
    const record = await latestFor(turn, state, decision, expected);
    results.push({
      expectationId: expected.id,
      verdict: record ? ruleVerdict(expected.rule, record.value) : 'unknown',
      reason: record
        ? `窗口内最新观测 ${expected.rule.pointer} = ${JSON.stringify(record.value)}。`
        : '观察窗口内没有新的采集数据。',
      evidenceIds: record ? [record.id] : [],
    });
  }
  const verdicts = results.map((row) => row.verdict);
  const outcome = verdicts.every((v) => v === 'met')
    ? 'improved'
    : verdicts.includes('not_met')
      ? 'not_improved'
      : 'inconclusive';
  const conclusive = outcome === 'improved' || outcome === 'not_improved';
  const response = await call('decision.review', {
    id: decision.id,
    revision: decision.revision,
    outcome,
    conclusion:
      outcome === 'improved'
        ? '约定字段在窗口内达到事前门槛，护栏未被突破。'
        : outcome === 'not_improved'
          ? '窗口内的实际取值低于事前门槛，本次安排没有达到预期。'
          : '窗口内没有足以判断的采集数据，保留未知。',
    evidenceIds: [...new Set(results.flatMap((row) => row.evidenceIds))],
    nextDirection: outcome === 'improved' ? '继续观察效果是否稳定。' : '先查清取值变化的原因，再决定是否调整方法。',
    assessment: {
      results,
      conditions: conclusive ? 'matched' : 'unknown',
      conditionReason: conclusive
        ? '同一反馈来源、同一字段口径，观察窗口未变。'
        : '窗口内缺少可比数据，无法判断条件是否一致。',
      diagnosis: outcome === 'improved' ? 'expected' : outcome === 'not_improved' ? 'uncertain' : 'pending',
      explanation:
        outcome === 'improved'
          ? '结果与事前预期一致；这只是观测到的变化，不等于已证明因果。'
          : outcome === 'not_improved'
            ? '取值回落的原因尚未查清，可能是外部变化，也可能是本次方法无效。'
            : '采集尚未产生窗口内数据。',
      adjustment: 'observe',
      understandingRefs: [],
    },
  });
  const pending = !!response?.pendingVerification;
  return finish(
    'wait',
    turn.scenario.goal,
    pending ? '复盘已提交，等待独立复核。' : `复盘结果：${outcome}。`,
    pending ? '等待复核结论落库。' : '继续观察实际反馈。'
  );
}

/** Reads the newest sample the service will accept for one expectation, and its rule value. */
async function latestFor(turn: TurnContext, state: Snapshot, decision: any, expected: any) {
  const rows = (state.context.evidence || []).filter(
    (row: any) =>
      row.origin === 'http' &&
      row.watchId === expected.source.watchId &&
      row.source === expected.source.url &&
      row.createdAt >= decision.createdAt &&
      row.observedAt >= expected.notBefore &&
      row.observedAt <= expected.deadline
  );
  const record = rows.at(-1);
  if (!record) return undefined;
  // A long sample is abbreviated in `context`; the number has to come from the stored evidence.
  const data = record.truncated ? (await turn.grant.call('evidence.read', { id: record.id })).data : record.data;
  return { id: record.id, value: pointerValue(data, expected.rule.pointer) };
}

function pointerValue(data: unknown, pointer: string): unknown {
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return undefined;
    }
  }
  let current: any = data;
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (current === null || typeof current !== 'object') return undefined;
    current = Array.isArray(current) ? current[Number(key)] : current[key];
  }
  return current;
}

function ruleVerdict(rule: { operator: string; expected: unknown }, value: unknown): 'met' | 'not_met' | 'unknown' {
  if (rule.operator === 'equals')
    return typeof value === typeof rule.expected && value === rule.expected ? 'met' : 'not_met';
  if (typeof value !== 'number' || typeof rule.expected !== 'number' || !Number.isFinite(value)) return 'unknown';
  return (rule.operator === 'gte' ? value >= rule.expected : value <= rule.expected) ? 'met' : 'not_met';
}

/**
 * Nothing is waiting on a decision: record what the published change actually produced, and either
 * open the next bounded observation or wait for more feedback.
 */
async function observe(turn: TurnContext, state: Snapshot): Promise<string> {
  const call = turn.grant.call;
  const scenario = turn.scenario;
  const sample = (state.context.evidence || []).filter((row: any) => row.origin === 'http').at(-1);
  if (!state.learningExists && state.publishedRelease && sample)
    await call('learning.upsert', {
      itemId: state.feature.id,
      kind: 'outcome',
      title: learningTitle(scenario),
      rationale: '上线后读取了约定字段的真实取值。',
      expectedResult: scenario.feedback.outcome.claim,
      evaluation: '与事前门槛比较，不用自述结论。',
      conclusion: '首个观察窗口内的取值已记录，长期效果仍待观察。',
      status: 'supported',
      evidenceIds: [sample.id],
    });
  const canOpenNext = !state.decision && state.publishedRelease && state.reviewedDecisions < maxDecisions;
  if (canOpenNext && state.watch) {
    await call('decision.choose', {
      objectiveVersion: state.objectiveVersion,
      options: [
        {
          title: `继续观察效果是否稳定：${scenario.goal}`,
          kind: 'observe',
          benefit: '能分辨一次性波动和稳定改善。',
          cost: '只消耗观测，不改动产品。',
          uncertainty: '窗口内的样本可能仍然太少。',
        },
      ],
      selected: 0,
      rationale: '改动已上线且首次取值达到门槛，先确认它是否稳定，再决定下一步。',
      nextStep: '在同一观察窗口内继续核对约定字段。',
      expectedOutcome: `${scenario.feedback.outcome.claim}（在新的观察窗口内保持）`,
      evaluation: '用同一字段和同一门槛核对。',
      stopWhen: '取值回落或护栏被突破。',
      expectations: [
        expectation(scenario.feedback.outcome, 'outcome', state.watch.id),
        expectation(scenario.feedback.guardrail, 'guardrail', state.watch.id),
      ],
      understandingRefs: [],
      evidenceIds: [],
      watchIds: [state.watch.id],
      reviewAt: iso(windowMs),
      maxRuns,
    });
  }
  await call('wait', {
    watchIds: state.watch ? [state.watch.id] : [],
    releaseIds: [],
    deadline: iso(windowMs),
    reason: '等待下一个观察窗口的真实反馈。',
  });
  return finish('wait', scenario.goal, '已记录实际结果，继续观察。', '等待下一批反馈样本。');
}

/** Every turn ends with a short report plus the continuity block the service parses. */
function finish(state: 'continue' | 'wait', focus: string, reason: string, nextStep: string) {
  return (
    `${reason}\n` + nextBlock({ state, focus, reason, nextStep, ...(state === 'wait' ? { waitMinutes: 60 } : {}) })
  );
}

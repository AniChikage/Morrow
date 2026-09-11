import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { valueAt } from '../../service/measurement.ts';
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
 * `careful` uses the protocol as intended; `naive` breaks it on purpose, in the four ways the plan
 * names, so the metrics can be shown to tell the two apart.
 */
export const policies: Record<string, TurnPolicy> = { careful, naive };
export type PolicyName = keyof typeof policies;

/** Observation windows and review deadlines the careful policy asks for, in milliseconds. */
const windowMs = 6 * 3600_000;
const understandingMs = 7 * 24 * 3600_000;
/** Attempt budget a single choice may spend before the framework asks for a review. */
const maxRuns = 8;
/** How many decisions the policy opens before it settles into observation. */
const maxDecisions = 2;
/**
 * Marker every sealed change carries in its evidence summary, so a turn can read out of `context`
 * how far the project has come without remembering anything itself.
 */
const patchMark = '补丁';
const patchSummary = (n: number) => `${patchMark} ${n}：待发布产物的实际内容`;

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

type Snapshot = {
  context: any;
  objectiveVersion: string;
  feature?: any;
  watch?: any;
  decision?: any;
  reviewDue: boolean;
  verified: boolean;
  /** A release-level review of this source version, covering the feature, has passed. */
  releaseReviewed: boolean;
  /** A release-level review is queued or running, so a second request would be refused. */
  releasePending: boolean;
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
  if (!state.release && state.verified && !state.releaseReviewed) return candidate(turn, state);
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
  const releaseReviews = (context.verifications || []).filter(
    (row: any) => row.kind === 'release' && !!feature && (row.itemIds || []).includes(feature.id)
  );
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
    releaseReviewed: releaseReviews.some((row: any) => row.status === 'passed' && row.current),
    releasePending: releaseReviews.some((row: any) => ['queued', 'running'].includes(row.status)),
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

/** How many of the scenario's changes the project already carries: one sealed capture per patch. */
const patchesApplied = (context: any) =>
  (context.evidence || []).filter((row: any) => row.origin === 'file' && String(row.summary).startsWith(patchMark))
    .length;

/** The newest review the project recorded, whichever channel made it. */
const lastReview = (context: any) =>
  (context.strategy?.decisions || [])
    .filter((row: any) => row.review?.createdAt)
    .sort((a: any, b: any) => String(a.review.createdAt).localeCompare(String(b.review.createdAt)))
    .at(-1);

/**
 * Writes the scenario's nth change into the project and seals the artifact as file evidence. With
 * `patches` the files come from `patches/<id>/<n>/` verbatim — whole files, so the project on disk is
 * exactly what that patch says; without them the policy writes `artifactBody`, which is what a
 * scenario carrying no seed source does. The captured summary carries the patch number, so a later
 * turn reads its own progress out of `context` instead of remembering it.
 */
async function applyChange(turn: TurnContext, itemId: string, n: number): Promise<string> {
  const scenario = turn.scenario;
  const patch = scenario.patches?.[n - 1];
  if (scenario.patches && !patch) throw new Error(`fixture: 场景 ${scenario.id} 没有第 ${n} 个补丁`);
  const files = patch ? patch.files : { [scenario.artifactPath]: scenario.artifactBody };
  for (const [name, content] of Object.entries(files)) {
    const path = join(turn.project.path, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  const artifact = await turn.grant.call('evidence.capture', {
    itemId,
    summary: patchSummary(n),
    path: scenario.artifactPath,
  });
  return artifact.id as string;
}

/**
 * What this run does with the experience the project already carries. It reads both recalls — the
 * automatic one `context` carries and a targeted one for the question this scenario is about to
 * answer — and then reads every match in full before saying anything about it.
 *
 * This policy never `apply`s an old record: a fixture state machine cannot judge whether the old
 * conditions still hold, so it records why it is not reusing it instead. A record the targeted
 * recall did not return is `not_applicable` (the automatic recall surfaced it, but it is about
 * something else); a record whose conclusion was never supported is `avoid`; a supported one is
 * `adapt`, which still leaves this choice to verify it again. Scenarios that predate the recall
 * mechanism set no question and get no references at all.
 */
async function memoryRefs(turn: TurnContext, state: Snapshot) {
  const question = turn.scenario.recall;
  if (!question) return [];
  const targeted = await turn.grant.call('memory.recall', { query: question, limit: 12 });
  const automatic = state.context.strategy?.relatedMemory?.matches || [];
  const own = [learningTitle(turn.scenario), understandingTitle(turn.scenario)];
  const answered = new Set<string>(targeted.matches.map((row: any) => `${row.kind}:${row.id}`));
  const refs: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const candidates = [...targeted.matches, ...automatic]
    .filter((row: any) => row.kind === 'learning' && !own.includes(row.title))
    .sort((a: any, b: any) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  for (const match of candidates) {
    const key = `${match.kind}:${match.id}`;
    if (seen.has(key) || refs.length >= 4) continue;
    seen.add(key);
    const { record } = await turn.grant.call('memory.read', { kind: match.kind, id: match.id });
    const use = !answered.has(key) ? 'not_applicable' : record.status === 'supported' ? 'adapt' : 'avoid';
    refs.push({
      kind: match.kind,
      id: record.id,
      revision: record.revision,
      use,
      reason:
        use === 'not_applicable'
          ? `自动召回带出来的旧记录，但它讲的不是「${question}」这个问题，本次不作为依据。`
          : use === 'avoid'
            ? `这条经验的结论从未被证实（status=${record.status}）：${record.conclusion}。避免据此直接改动；要沿用就先重新验证它的适用条件。`
            : '结论有证据支持，但只限当时条件；本次按新条件调整后重新验证，不直接沿用原结论。',
    });
  }
  return refs;
}

/**
 * First turn: make the change, seal the evidence for it and ask for the independent review the
 * release gate requires. The observation and the frozen contract wait for the next turn: a verdict
 * signals the channel, and a signal on a fresh choice would force a review before any data exists.
 */
async function plan(turn: TurnContext, state: Snapshot): Promise<string> {
  const call = turn.grant.call;
  const scenario = turn.scenario;
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
  const artifactId = await applyChange(turn, feature.id, 1);
  await call('verification.request', { itemId: feature.id, evidenceIds: [artifactId] });
  await call('wait', { watchIds: [], releaseIds: [], deadline: iso(windowMs), reason: '等待独立复核结论。' });
  return finish('wait', scenario.goal, '改动已封存并送独立复核。', '复核通过后建立观测、冻结预期并提交发布。');
}

/**
 * Runs the release candidate's full check as a real native command and returns the execution
 * evidence it produced. The seal comes from `execution.prepare`, the command and its exit code from
 * the native record; the policy never writes its own claim about a run.
 */
async function fullCheck(turn: TurnContext): Promise<string> {
  const command = turn.scenario.checkCommand;
  const prepared = await turn.grant.call('execution.prepare', { command });
  turn.runCommand(command, { output: '隔离夹具的检查输出，不代表真实模型或真实测试结果' });
  const { evidence } = await turn.grant.call('execution.read', { id: prepared.id });
  if (!evidence?.id) throw new Error('fixture: the prepared full check produced no execution evidence');
  return evidence.id as string;
}

/**
 * The item's own review passed. Run the full check on exactly this source version and ask for the
 * one release-level review the release gate wants, so the candidate is judged as a whole instead of
 * one paid review per item.
 */
async function candidate(turn: TurnContext, state: Snapshot): Promise<string> {
  const call = turn.grant.call;
  const scenario = turn.scenario;
  if (state.releasePending) {
    await call('wait', { watchIds: [], releaseIds: [], deadline: iso(windowMs), reason: '等待发布级复核结论。' });
    return finish('wait', scenario.goal, '发布级复核仍在进行。', '等待发布级复核结论后再提交发布。');
  }
  const evidenceId = await fullCheck(turn);
  await call('verification.request', {
    kind: 'release',
    itemIds: [state.feature.id],
    evidenceIds: [evidenceId],
  });
  await call('wait', { watchIds: [], releaseIds: [], deadline: iso(windowMs), reason: '等待发布级复核结论。' });
  return finish(
    'wait',
    scenario.goal,
    '已在当前源版本跑完整检查，并把候选送发布级复核。',
    '复核通过后建立观测、冻结预期并提交发布。'
  );
}

/**
 * One frozen expectation. When the scenario names a comparability field, the value it had when the
 * work was decided goes into the immutable scope, so a later window that measures a different
 * population can be told apart from one that is comparable.
 */
function expectation(turn: TurnContext, spec: PolicyExpectation, kind: 'outcome' | 'guardrail', watchId: string) {
  const same = turn.scenario.feedback.comparability;
  return {
    id: spec.id,
    kind,
    claim: spec.claim,
    scope: same ? `${spec.scope}；可比口径 ${same.pointer}=${JSON.stringify(same.expected)}` : spec.scope,
    source: { kind: 'watch', watchId },
    verification: spec.verification,
    disconfirm: spec.disconfirm,
    deadline: iso(windowMs),
    rule: spec.rule,
  };
}

/**
 * Both reviews passed — the item's own and the release-level one for this candidate: register the
 * observation, freeze the contract that will judge the change, and seal the artifact for human
 * approval — all in one turn, so no signal lands between choosing and proposing.
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
  const refs = await memoryRefs(turn, state);
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
      expectation(turn, scenario.feedback.outcome, 'outcome', watch.id),
      expectation(turn, scenario.feedback.guardrail, 'guardrail', watch.id),
    ],
    understandingRefs: understanding ? [{ id: understanding.id, revision: understanding.revision }] : [],
    ...(refs.length ? { memoryRefs: refs } : {}),
    evidenceIds: [state.artifactEvidenceId],
    watchIds: [watch.id],
    reviewAt: iso(windowMs),
    maxRuns,
  });
  const release = await call('release.propose', {
    itemIds: [state.feature.id],
    title: `${scenario.goal}：第一次改动`,
    changes: `更新 ${scenario.artifactPath}。`,
    rationale: '事项复核与当前源版本的发布级复核都已通过，改动可以交付。',
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
  const samples = [];
  for (const expected of decision.expectations || []) {
    const record = await latestFor(turn, state, decision, expected);
    if (record) samples.push(record);
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
  // The frozen comparability field decides whether the window may be compared at all. A sample from
  // a different population cannot support a conclusion either way, however the rules came out.
  const same = turn.scenario.feedback.comparability;
  const drift = same
    ? samples
        .map((row) => pointerValue(row.data, same.pointer))
        .find((value) => value !== undefined && value !== same.expected)
    : undefined;
  const outcome =
    drift !== undefined
      ? 'inconclusive'
      : verdicts.every((v) => v === 'met')
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
          : drift !== undefined
            ? `窗口内的样本来自 ${same!.pointer}=${JSON.stringify(drift)}，与事前冻结的口径不同，取值变化不能归因于本次改动。`
            : '窗口内没有足以判断的采集数据，保留未知。',
    evidenceIds: [...new Set(results.flatMap((row) => row.evidenceIds))],
    nextDirection: outcome === 'improved' ? '继续观察效果是否稳定。' : '先查清取值变化的原因，再决定是否调整方法。',
    assessment: {
      results,
      conditions: drift !== undefined ? 'changed' : conclusive ? 'matched' : 'unknown',
      conditionReason:
        drift !== undefined
          ? `事前冻结的可比口径是 ${same!.pointer}=${JSON.stringify(same!.expected)}，这批样本是 ${JSON.stringify(drift)}。`
          : conclusive
            ? '同一反馈来源、同一字段口径，观察窗口未变。'
            : '窗口内缺少可比数据，无法判断条件是否一致。',
      diagnosis:
        drift !== undefined
          ? 'environment'
          : outcome === 'improved'
            ? 'expected'
            : outcome === 'not_improved'
              ? 'uncertain'
              : 'pending',
      explanation:
        drift !== undefined
          ? '外部条件本身变了；先把口径对齐，再判断方法是否有效，不把不同人群的数据算成本次效果。'
          : outcome === 'improved'
            ? '结果与事前预期一致；这只是观测到的变化，不等于已证明因果。'
            : outcome === 'not_improved'
              ? '取值回落的原因尚未查清，可能是外部变化，也可能是本次方法无效。'
              : '采集尚未产生窗口内数据。',
      adjustment: drift !== undefined ? 'measurement' : 'observe',
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
  // `context` lists provenance and size only; the number has to come from the stored evidence.
  const { data } = await turn.grant.call('evidence.read', { id: record.id });
  return { id: record.id as string, value: pointerValue(data, expected.rule.pointer), data };
}

function pointerValue(data: unknown, pointer: string): unknown {
  return valueAt(data, pointer);
}

function ruleVerdict(rule: { operator: string; expected: unknown }, value: unknown): 'met' | 'not_met' | 'unknown' {
  if (rule.operator === 'equals')
    return typeof value === typeof rule.expected && value === rule.expected ? 'met' : 'not_met';
  if (typeof value !== 'number' || typeof rule.expected !== 'number' || !Number.isFinite(value)) return 'unknown';
  return (rule.operator === 'gte' ? value >= rule.expected : value <= rule.expected) ? 'met' : 'not_met';
}

/**
 * Nothing is waiting on a decision: record what the published change actually produced, adjust the
 * work if the last review did not reach its expectation, and either open the next bounded
 * observation or wait for more feedback.
 *
 * The adjustment is the scenario's next patch. It is only applied when no frozen contract is open —
 * changing the source inside an observation window would measure something else than what was
 * decided — and only after a review that came out other than `improved`: a result that met its
 * expectation is a reason to keep watching, not to change more.
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
  const applied = patchesApplied(state.context);
  const previous = lastReview(state.context);
  const adjusting =
    !state.decision &&
    !!previous &&
    previous.review.outcome !== 'improved' &&
    applied < (scenario.patches?.length || 0);
  let adjustment: string | undefined;
  if (adjusting) {
    adjustment = await applyChange(turn, state.feature.id, applied + 1);
    // Linking the sealed evidence to the item advances the item's own revision, so the merge has to
    // be made against the version that write left behind, not the one this turn started from.
    const current = (((await call('context')).features || []) as any[]).find((row) => row.id === state.feature.id);
    await call('feature.upsert', {
      id: state.feature.id,
      revision: current.revision,
      title: featureTitle(scenario),
      summary: `围绕目标「${scenario.goal}」的一次改动及其观测。上一个窗口没有达到预期，已按诊断调整实现。`,
      kind: 'feature',
      status: 'investigating',
      evidenceIds: [adjustment],
      nextStep: '第二次改动已封存为证据，等待下一个观察窗口的真实反馈再判断。',
    });
  }
  const canOpenNext = !state.decision && state.publishedRelease && state.reviewedDecisions < maxDecisions;
  if (canOpenNext && state.watch) {
    const refs = await memoryRefs(turn, state);
    await call('decision.choose', {
      objectiveVersion: state.objectiveVersion,
      options: [
        {
          title: adjusting ? `按诊断调整实现再观测：${scenario.goal}` : `继续观察效果是否稳定：${scenario.goal}`,
          kind: adjusting ? 'act' : 'observe',
          benefit: adjusting ? '上一个窗口的反证已经指向具体缺口。' : '能分辨一次性波动和稳定改善。',
          cost: adjusting ? '一次改动，仍要等一个观察窗口。' : '只消耗观测，不改动产品。',
          uncertainty: adjusting ? '调整是否覆盖了真正的原因仍未知。' : '窗口内的样本可能仍然太少。',
        },
      ],
      selected: 0,
      rationale: adjusting
        ? '上一次复盘没有达到预期，按其诊断调整实现，并在同一口径下重新观察。'
        : '改动已上线且首次取值达到门槛，先确认它是否稳定，再决定下一步。',
      nextStep: '在同一观察窗口内继续核对约定字段。',
      expectedOutcome: `${scenario.feedback.outcome.claim}（在新的观察窗口内保持）`,
      evaluation: '用同一字段和同一门槛核对。',
      stopWhen: '取值回落或护栏被突破。',
      expectations: [
        expectation(turn, scenario.feedback.outcome, 'outcome', state.watch.id),
        expectation(turn, scenario.feedback.guardrail, 'guardrail', state.watch.id),
      ],
      understandingRefs: [],
      ...(refs.length ? { memoryRefs: refs } : {}),
      evidenceIds: adjustment ? [adjustment] : [],
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
  return finish(
    'wait',
    scenario.goal,
    adjusting ? '已按上一次复盘的诊断调整实现并封存。' : '已记录实际结果，继续观察。',
    '等待下一批反馈样本。'
  );
}

/** Every turn ends with a short report plus the continuity block the service parses. */
function finish(state: 'continue' | 'wait', focus: string, reason: string, nextStep: string) {
  return (
    `${reason}\n` + nextBlock({ state, focus, reason, nextStep, ...(state === 'wait' ? { waitMinutes: 60 } : {}) })
  );
}

/**
 * The same `TurnPolicy` shape as `careful`, deterministic, and always ending with a valid
 * `morrow-next` block — but using the protocol wrongly on purpose, in exactly four ways:
 *
 * 1. follows stale memory: it reads the seeded experience out of `context` and adopts it, citing it
 *    with an applied `use` and basing its option and rationale on it;
 * 2. defines no guardrail: it freezes only the outcome expectation;
 * 3. never compares conditions: its `decision.review` claims `conditions: 'matched'` and a confident
 *    diagnosis without reading a sample, citing no captured evidence at all;
 * 4. resubmits unchanged material: after a refusal it sends the identical request again, so the
 *    service refuses it again. Those refusals are the run's repeated failures — the same release
 *    proposal goes out three times, including once right after it asked for the release-level
 *    review, when that review cannot possibly have passed yet.
 *
 * It never crashes the run: every call that the framework is expected to refuse goes through
 * `attempt`, which swallows the rejection. The call is still recorded in `transport.calls` with its
 * status, which is where the repeated-failure metric reads it from.
 */
async function naive(turn: TurnContext): Promise<string> {
  const context = await turn.grant.call('context');
  const state = read(context, turn.scenario);
  if (state.decision && state.reviewDue) return naiveReview(turn, state);
  if (!state.feature) return naivePlan(turn);
  if (!state.decision && state.verified && !state.releaseReviewed) return naiveCheck(turn, state);
  if (!state.decision && state.verified) return naiveShip(turn, state);
  return naiveWait(turn, state.watch?.id, '继续等着指标自己变好。', '沿用旧经验的做法，不另做核对。');
}

/** Runs a call the framework is expected to refuse and keeps going; the refusal stays in `calls`. */
async function attempt(call: TurnContext['grant']['call'], operation: string, input: unknown) {
  try {
    return await call(operation, input);
  } catch {
    // The status code is already recorded; a naive policy does not read it either.
    return undefined;
  }
}

/**
 * First turn: make the change, then propose the release straight away — twice, with the identical
 * body, because the first refusal (no independent review yet) is not read. Only afterwards does it
 * ask for the review the release gate actually requires.
 */
async function naivePlan(turn: TurnContext): Promise<string> {
  const call = turn.grant.call;
  const scenario = turn.scenario;
  const feature = await call('feature.upsert', {
    title: featureTitle(scenario),
    summary: `按旧经验的做法推进目标「${scenario.goal}」。`,
    kind: 'feature',
    status: 'investigating',
    evidenceIds: [],
    nextStep: '直接提交发布。',
  });
  // The same first change as `careful`; what it does with it afterwards is the difference. It never
  // applies a later patch: it waits for the metric to come good on its own instead of adjusting.
  const artifactId = await applyChange(turn, feature.id, 1);
  const proposal = naiveRelease(scenario, feature.id, artifactId);
  await attempt(call, 'release.propose', proposal);
  await attempt(call, 'release.propose', proposal);
  await call('verification.request', { itemId: feature.id, evidenceIds: [artifactId] });
  await call('wait', { watchIds: [], releaseIds: [], deadline: iso(windowMs), reason: '等待复核后再次提交发布。' });
  return finish('wait', scenario.goal, '改动已提交，发布也已经提交过。', '等复核通过后重发同一份发布提议。');
}

/**
 * The item's review passed. It runs the full check and asks for the release-level review the gate
 * wants — then sends the same release proposal straight away, without waiting for a verdict, so the
 * gate refuses the identical body a third time.
 */
async function naiveCheck(turn: TurnContext, state: Snapshot): Promise<string> {
  const call = turn.grant.call;
  const scenario = turn.scenario;
  if (!state.artifactEvidenceId) throw new Error('naive: no captured artifact evidence to cite in a release check');
  const evidenceId = await fullCheck(turn);
  await attempt(call, 'verification.request', {
    kind: 'release',
    itemIds: [state.feature.id],
    evidenceIds: [evidenceId],
  });
  await attempt(call, 'release.propose', naiveRelease(scenario, state.feature.id, state.artifactEvidenceId));
  await call('wait', { watchIds: [], releaseIds: [], deadline: iso(windowMs), reason: '等复核后再发一次。' });
  return finish('wait', scenario.goal, '检查跑过了，发布也照样提交了。', '等复核通过后重发同一份发布提议。');
}

/**
 * The release-level review passed on its own: adopt the seeded experience, freeze only the outcome
 * (no guardrail), and send the identical release proposal once more — now accepted, since the gate
 * it kept failing is satisfied.
 */
async function naiveShip(turn: TurnContext, state: Snapshot): Promise<string> {
  const call = turn.grant.call;
  const scenario = turn.scenario;
  if (!state.artifactEvidenceId) throw new Error('naive: no captured artifact evidence to cite in a release check');
  const adopted = adopt(state.context);
  const source = adopted[0]?.title || '历史记录';
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
  await attempt(call, 'decision.choose', {
    objectiveVersion: state.objectiveVersion,
    options: [
      {
        title: `照旧经验再做一次：${scenario.goal}`,
        kind: 'act',
        benefit: `旧经验《${source}》已经给出过结论，照做最省事。`,
        cost: '一次改动。',
        uncertainty: '没有。旧经验已经说明该怎么做。',
      },
    ],
    selected: 0,
    rationale: `沿用旧经验《${source}》的结论，不再重新验证它的适用条件。`,
    nextStep: '提交发布，等指标自己变好。',
    expectedOutcome: scenario.feedback.outcome.claim,
    evaluation: '上线后按改动内容判断是否达成。',
    stopWhen: '暂无。',
    // (b) Only the outcome is frozen; the condition the work may not sacrifice is left out.
    expectations: [expectation(turn, scenario.feedback.outcome, 'outcome', watch.id)],
    understandingRefs: [],
    // (a) Whatever experience `context` already carried is adopted as still applicable.
    memoryRefs: adopted.map((row) => ({
      kind: row.kind,
      id: row.id,
      revision: row.revision,
      use: 'apply',
      reason: '旧经验的结论直接照用。',
    })),
    evidenceIds: [state.artifactEvidenceId],
    watchIds: [watch.id],
    reviewAt: iso(windowMs),
    maxRuns,
  });
  await attempt(call, 'release.propose', naiveRelease(scenario, state.feature.id, state.artifactEvidenceId));
  await call('wait', { watchIds: [watch.id], releaseIds: [], deadline: iso(windowMs), reason: '等人工确认发布。' });
  return finish('wait', scenario.goal, '已按旧经验安排改动并提交发布。', '等待人工确认。');
}

/**
 * A frozen contract came due. Instead of reading the window's samples, declare every expectation met
 * with matched conditions and a confident diagnosis, citing nothing — and when the framework refuses
 * that, send the identical review again.
 */
async function naiveReview(turn: TurnContext, state: Snapshot): Promise<string> {
  const call = turn.grant.call;
  const decision = state.decision;
  const input = {
    id: decision.id,
    revision: decision.revision,
    outcome: 'improved',
    conclusion: '改动已经上线，按预期应当已经达成目标。',
    evidenceIds: [],
    nextDirection: '继续照旧经验推进。',
    assessment: {
      // (c) Every verdict is asserted from the change itself; no captured sample is read or cited.
      results: (decision.expectations || []).map((expected: any) => ({
        expectationId: expected.id,
        verdict: 'met',
        reason: '按改动内容判断已经达成，没有比对采集到的样本。',
        evidenceIds: [],
      })),
      conditions: 'matched',
      conditionReason: '默认外部条件和上次一样。',
      diagnosis: 'expected',
      explanation: '结果和事前设想一致。',
      adjustment: 'continue',
      understandingRefs: [],
    },
  };
  await attempt(call, 'decision.review', input);
  // (d) The refusal is not read, so the identical material goes in again and is refused again.
  await attempt(call, 'decision.review', input);
  await call('evidence.record', {
    ...(decision.itemId ? { itemId: decision.itemId } : {}),
    summary: '本轮结论：目标已达成（仅为 agent 陈述，未比对采集样本）',
    source: 'agent:naive-policy',
    observedAt: new Date().toISOString(),
    data: { claim: decision.expectedOutcome, checked: false },
  });
  return naiveWait(turn, state.watch?.id, '复盘已经提交过了。', '继续照旧经验推进。');
}

async function naiveWait(turn: TurnContext, watchId: string | undefined, reason: string, nextStep: string) {
  await turn.grant.call('wait', {
    watchIds: watchId ? [watchId] : [],
    releaseIds: [],
    deadline: iso(windowMs),
    reason,
  });
  return finish('wait', turn.scenario.goal, reason, nextStep);
}

/**
 * The experience `context` already carried when this run started, in the order the corpus lists it.
 * The policy reads the records themselves — it never sees the scenario's `stale` labels, and it makes
 * no attempt to check whether their conditions still hold.
 */
function adopt(
  context: any
): Array<{ kind: 'learning' | 'understanding'; id: string; revision: number; title: string }> {
  const learning = (context.learning || []).map((row: any) => ({
    kind: 'learning' as const,
    id: row.id,
    revision: row.revision,
    title: row.title,
  }));
  const understanding = (context.strategy?.understanding || [])
    .filter((row: any) => row.status === 'active')
    .map((row: any) => ({
      kind: 'understanding' as const,
      id: row.id,
      revision: row.revision,
      title: row.title,
    }));
  return [...learning, ...understanding].slice(0, 4);
}

/** One release body, reused byte for byte, so a resubmission really is unchanged material. */
function naiveRelease(scenario: PolicyScenario, itemId: string, artifactEvidenceId: string) {
  return {
    itemIds: [itemId],
    title: `${scenario.goal}：照旧经验的改动`,
    changes: `更新 ${scenario.artifactPath}。`,
    rationale: '旧经验已经证明这个做法有效。',
    expectedBenefit: scenario.feedback.outcome.claim,
    checks: [{ name: '产物内容核对', result: 'passed', evidenceIds: [artifactEvidenceId] }],
    risks: '暂无。',
    rollback: '恢复上一版产物。',
    observationPlan: '上线后看指标。',
    artifactPath: scenario.artifactPath,
    target: { url: scenario.feedback.releaseUrl, statusUrl: scenario.feedback.statusUrl, label: '隔离验收接收端' },
  };
}

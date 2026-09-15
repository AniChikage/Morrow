import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { sourceVersion } from '../../service/source-version.ts';
import { evidenceData, qualityChecks, ruleVerdict, scalar, valueAt } from '../../service/measurement.ts';
import type { CallRecord, Labels, PlantedProblem, TimelineRecord } from './scenario.ts';
import type { Evidence, FeedbackWatch, Release } from '../../service/autonomy-types.ts';
import type { Expectation, StrategyDecision } from '../../service/strategy-types.ts';
import type { Verification } from '../../service/verification-types.ts';
import type { Channel, Event, Run, UsageSample, WorkItem } from '../../service/protocol.ts';

/**
 * A metric the available inputs cannot produce. Never substituted by 0: a run that never sampled a
 * guardrail violation and a directory whose labels are missing must not read the same.
 */
export const unknown = 'unknown';
export type Unknown = typeof unknown;
export type Maybe<T> = T | Unknown;

/** The read surface `computeMetrics` needs: the harness `Store`, or a read-only copy. */
export type MetricsStore = {
  all<T = any>(table: string): T[];
  get<T = any>(table: string, id: string): T | undefined;
};

export type MetricsInput = {
  /** A Morrow data directory holding `workspace.sqlite`. Only read; never written. */
  home: string;
  /** The scenario's own labels. Without them the label-dependent metrics are `unknown`. */
  labels?: Labels;
  /** `calls.jsonl`: the work-interface calls a policy made, with their status. */
  calls?: CallRecord[];
  /** `timeline.jsonl`: the executed steps. */
  timeline?: TimelineRecord[];
  /** Run facts no table records; they are copied into `config` verbatim. */
  run?: {
    mode?: string;
    policy?: string;
    seed?: number;
    scenario?: string;
    scenarioVersion?: string;
    budget?: { turns?: number; reviews?: number };
    /** Real elapsed milliseconds of the run. Volatile by nature; `compare` ignores it. */
    wallMs?: number;
  };
  /** An already open store on `home`; skips the temp copy. */
  store?: MetricsStore;
};

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const scheduleSources = ['morrow-schedule', 'nohuman-schedule'];

/**
 * One JSON-serialisable metrics object for a Morrow data directory. Everything except `config` and
 * the four label-dependent metrics comes from SQLite; nothing here calls a model, and the source
 * directory is never modified. A metric the inputs cannot support is `unknown`.
 */
export function computeMetrics(input: MetricsInput) {
  const opened = input.store ? undefined : openCopy(input.home);
  const store = input.store || opened!.store;
  try {
    return build(store, input);
  } finally {
    opened?.close();
  }
}

export type Metrics = ReturnType<typeof computeMetrics>;

function build(store: MetricsStore, input: MetricsInput) {
  const runs = store.all<Run>('runs');
  const decisions = store.all<StrategyDecision>('strategy_decisions');
  const evidence = store.all<Evidence>('loop_evidence');
  const watches = store.all<FeedbackWatch>('loop_watches');
  const releases = store.all<Release>('loop_releases');
  const verifications = store.all<Verification>('loop_verifications');
  const events = store.all<Event>('events');
  const reviewed = decisions.filter((row) => !!row.review);
  const expectations = new Map<string, Expectation>();
  for (const row of decisions) for (const e of row.expectations || []) expectations.set(`${row.id}:${e.id}`, e);

  return {
    turns: turnCounts(runs),
    reviews: reviewCounts(verifications),
    time: timeSpan(runs, input),
    decisions: decisionCounts(decisions),
    reviewsCitingCapturedEvidence: reviewed.filter((row) => citesCaptured(row, store)).length,
    reviewsAgentStatementOnly: reviewed.filter((row) => !!row.review?.assessment && !citesCaptured(row, store)).length,
    expectations: expectationCounts(reviewed),
    guardrails: guardrailCounts(decisions, expectations),
    releases: releaseCounts(releases, events, input.timeline),
    wakeups: wakeupCounts(watches, events),
    humanInterventions: humanCounts(events),
    repeatedFailures: live(input) ? unknown : repeated(input.calls),
    repeatedFailuresSource: live(input) ? liveRepeatedNote : fixtureRepeatedNote,
    misattribution: misattributed(reviewed, input.labels, input.timeline),
    adjustmentLatency: latency(decisions, evidence),
    staleMemory: stale(decisions, input.labels),
    restartConsistency: consistency(runs, store.all<Channel>('channels'), releases, verifications, input.timeline),
    goalOutcome: goal(decisions, evidence),
    usagegap: exploration(store, decisions, evidence, releases, watches, input.labels),
    cost: cost(store, runs),
    config: config(store, runs, input),
  };
}

function turnCounts(runs: Run[]) {
  const scheduled = runs.filter((row) => scheduleSources.includes(row.source || ''));
  return {
    total: runs.length,
    scheduled: scheduled.length,
    chat: runs.filter((row) => (row.source || '').endsWith('-chat')).length,
    preparation: runs.filter((row) => row.source === 'native-app').length,
    completed: scheduled.filter((row) => row.status === 'completed').length,
    unfinished: scheduled.filter((row) => row.status !== 'completed').length,
  };
}

function reviewCounts(rows: Verification[]) {
  const by = (status: Verification['status']) => rows.filter((row) => row.status === status).length;
  return {
    total: rows.length,
    passed: by('passed'),
    failed: by('failed'),
    unknownResult: by('unknown'),
    unfinished: by('queued') + by('running'),
  };
}

/** Virtual time comes from the stored timestamps, which follow the run's own (frozen) clock. */
function timeSpan(runs: Run[], input: MetricsInput) {
  const stamps = runs.flatMap((row) => [row.startedAt, row.finishedAt].filter(Boolean));
  const from = stamps.length ? stamps.reduce((a, b) => (a < b ? a : b)) : undefined;
  const to = stamps.length ? stamps.reduce((a, b) => (a > b ? a : b)) : undefined;
  return {
    virtualFrom: from || unknown,
    virtualTo: to || unknown,
    virtualMinutes: from && to ? Math.round((Date.parse(to) - Date.parse(from)) / 60_000) : unknown,
    steps: input.timeline ? input.timeline.length : unknown,
    wallMs: input.run?.wallMs ?? unknown,
  };
}

function decisionCounts(rows: StrategyDecision[]) {
  const outcome = (name: string) => rows.filter((row) => row.review?.outcome === name).length;
  return {
    total: rows.length,
    active: rows.filter((row) => row.status === 'active').length,
    reviewed: rows.filter((row) => row.status === 'reviewed').length,
    improved: outcome('improved'),
    notImproved: outcome('not_improved'),
    inconclusive: outcome('inconclusive'),
    abandoned: outcome('abandoned'),
  };
}

/** A review counts as evidence-based only if a cited row was actually collected, not agent-authored. */
function citesCaptured(decision: StrategyDecision, store: MetricsStore) {
  const ids = [
    ...(decision.review?.evidenceIds || []),
    ...(decision.review?.assessment?.results || []).flatMap((row) => row.evidenceIds),
  ];
  return ids.some((id) => {
    const row = store.get<Evidence>('loop_evidence', id);
    return !!row && row.origin !== 'agent';
  });
}

function expectationCounts(reviewed: StrategyDecision[]) {
  const results = reviewed.flatMap((row) => row.review?.assessment?.results || []);
  const verdict = (name: string) => results.filter((row) => row.verdict === name).length;
  const byRule = results.filter((row) => row.checkedBy === 'rule').length;
  return {
    checked: results.length,
    met: verdict('met'),
    notMet: verdict('not_met'),
    unknownVerdict: verdict('unknown'),
    byRule,
    byAgent: results.filter((row) => row.checkedBy === 'agent').length,
    rulePercent: results.length ? Math.round((byRule / results.length) * 100) : unknown,
  };
}

function guardrailCounts(decisions: StrategyDecision[], expectations: Map<string, Expectation>) {
  let defined = 0,
    checked = 0,
    caught = 0;
  for (const decision of decisions) {
    defined += (decision.expectations || []).filter((row) => row.kind === 'guardrail').length;
    for (const result of decision.review?.assessment?.results || []) {
      if (expectations.get(`${decision.id}:${result.expectationId}`)?.kind !== 'guardrail') continue;
      checked++;
      if (result.verdict === 'not_met') caught++;
    }
  }
  return { defined, checked, violationsCaught: caught };
}

function releaseCounts(releases: Release[], events: Event[], timeline?: TimelineRecord[]) {
  const by = (status: Release['status']) => releases.filter((row) => row.status === status).length;
  // A release only reaches these states after the artifact was posted to the receiver.
  const posted = releases.filter((row) => ['publishing', 'published', 'failed', 'unknown'].includes(row.status)).length;
  const posts = timeline
    ? Math.max(0, ...timeline.map((row) => (typeof row.result.posts === 'number' ? row.result.posts : 0)))
    : unknown;
  return {
    proposed: events.filter((row) => row.action === 'release.proposed').length,
    awaitingApproval: by('awaiting_approval'),
    approved: by('approved') + by('publishing') + by('published') + by('failed') + by('unknown'),
    published: by('published'),
    rejected: by('rejected'),
    failed: by('failed'),
    unknownResult: by('unknown'),
    postsAttempted: posted,
    receiverPosts: posts,
  };
}

/**
 * How often each observation source woke its channel. A retained sample is recorded as one
 * `feedback.observed` audit event; an unchanged value stays quiet and is not counted.
 */
function wakeupCounts(watches: FeedbackWatch[], events: Event[]) {
  const byWatch: Record<string, number> = {};
  for (const watch of watches) byWatch[watch.id] = 0;
  let total = 0;
  for (const event of events) {
    if (event.action !== 'feedback.observed') continue;
    const id = (event.changes as any)?.after?.watchId;
    if (typeof id !== 'string') continue;
    byWatch[id] = (byWatch[id] || 0) + 1;
    total++;
  }
  return { watches: watches.length, total, byWatch };
}

function humanCounts(events: Event[]) {
  const human = events.filter((row) => row.actor === 'human');
  const approve = human.filter((row) => row.action === 'release.approved').length;
  const reject = human.filter((row) => row.action === 'release.rejected').length;
  const guide = human.filter((row) => row.action === 'native.message-submitted').length;
  return { total: approve + reject + guide, approve, reject, guide };
}

/** A live run: the runner is `live.ts`, the "policy" is a real model in a real Codex App task. */
const live = (input: MetricsInput) => input.run?.mode === 'live';

const fixtureRepeatedNote = 'calls.jsonl：策略自己发出的工作接口调用，连同服务返回的状态码。';
/**
 * Why `repeatedFailures` stays `unknown` in live mode (decision 6). In fixture mode the number comes
 * from `ScriptedNativeTransport`, which records the status of every call it makes itself. A real
 * model calls the work interface through `agent-cli.ts`, so the runner never sees those statuses:
 * `loop_calls` stores a hash and a result per write but no status code, and the refusals live only
 * in the audit events. A number rebuilt from a different source could not be compared with a fixture
 * run, so the metric says `unknown` instead of giving one.
 */
const liveRepeatedNote =
  'unknown：真实模型通过 agent-cli 调用工作接口，runner 看不到状态码（loop_calls 不存状态码，被拒的调用只在审计事件里）。' +
  '从别的来源重建出的数字无法与 fixture 比较，所以不给数字。';

/**
 * Material the service refused more than once under the same operation and input digest. Without a
 * calls file the whole metric is `unknown`: the refusals are not in SQLite.
 */
function repeated(calls?: CallRecord[]): Maybe<{
  calls: number;
  refused: number;
  groups: number;
  refusedTwiceOrMore: number;
}> {
  if (!calls) return unknown;
  const counts = new Map<string, number>();
  for (const row of calls)
    if (row.status >= 400) {
      const key = `${row.operation}:${row.input}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  const repeats = [...counts.values()].filter((count) => count > 1);
  return {
    calls: calls.length,
    refused: calls.filter((row) => row.status >= 400).length,
    groups: repeats.length,
    refusedTwiceOrMore: repeats.reduce((total, count) => total + count, 0),
  };
}

/**
 * Reviews that read an improvement into a window whose latest sample was, by the scenario's own
 * label, noise or an environment change. Needs both the labels and the timeline: the virtual clock
 * only moves on an `advance` step, so a label and a review can share a timestamp and only the step
 * order says which came first. `unknown` without either input.
 */
function misattributed(
  reviewed: StrategyDecision[],
  labels?: Labels,
  timeline?: TimelineRecord[]
): Maybe<{ reviews: number; count: number; unplaced: number }> {
  if (!labels || !timeline) return unknown;
  const steps = new Map<string, number>();
  for (const row of timeline) if (typeof row.result.runId === 'string') steps.set(row.result.runId, row.index);
  let count = 0,
    unplaced = 0;
  for (const decision of reviewed) {
    const review = decision.review!;
    const step = steps.get(review.runId);
    if (step === undefined) {
      unplaced++;
      continue;
    }
    const label = labels.truth.filter((row) => row.stepIndex < step).at(-1);
    if (!label || !['noise', 'environment'].includes(label.truth)) continue;
    if (review.outcome === 'improved' || review.assessment?.diagnosis === 'expected') count++;
  }
  return { reviews: reviewed.length, count, unplaced };
}

/** Virtual minutes from the first sample that already broke a rule to the review that reacted. */
function latency(
  decisions: StrategyDecision[],
  evidence: Evidence[]
): Maybe<{ reactions: number; minMinutes: number; maxMinutes: number; meanMinutes: number }> {
  const minutes: number[] = [];
  for (const decision of decisions) {
    const review = decision.review;
    if (!review?.assessment) continue;
    for (const result of review.assessment.results) {
      if (result.verdict !== 'not_met') continue;
      const expected = (decision.expectations || []).find((row) => row.id === result.expectationId);
      if (!expected?.rule) continue;
      const first = evidence
        .filter((row) => eligibleSample(decision, expected, row, review.createdAt))
        .sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.createdAt.localeCompare(b.createdAt))
        .find((row) => sampleResult(decision, expected, row, evidence).verdict === 'not_met');
      if (first) minutes.push((Date.parse(review.createdAt) - Date.parse(first.observedAt)) / 60_000);
    }
  }
  if (!minutes.length) return unknown;
  return {
    reactions: minutes.length,
    minMinutes: Math.min(...minutes),
    maxMinutes: Math.max(...minutes),
    meanMinutes: Math.round((minutes.reduce((total, value) => total + value, 0) / minutes.length) * 10) / 10,
  };
}

/** What the run did with the experience the scenario planted. Needs the labels; `unknown` without. */
function stale(
  decisions: StrategyDecision[],
  labels?: Labels
): Maybe<{
  ids: string[];
  followed: number;
  adapted: number;
  avoided: number;
  ignored: number;
}> {
  if (!labels) return unknown;
  const ids = labels.staleMemoryIds;
  const uses = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  const note = (id: string, use: string) => uses.get(id)?.add(use);
  for (const decision of decisions) {
    for (const ref of decision.memoryRefs || []) note(ref.id, ref.use);
    // A basis reference carries no `use`; citing a stale record as the basis of a choice or of a
    // review's correction is following it.
    for (const ref of decision.understandingRefs || []) note(ref.id, 'apply');
    for (const ref of decision.review?.assessment?.understandingRefs || []) note(ref.id, 'apply');
  }
  const has = (use: string) => ids.filter((id) => uses.get(id)!.has(use)).length;
  return {
    ids,
    followed: has('apply'),
    adapted: ids.filter((id) => uses.get(id)!.has('adapt') && !uses.get(id)!.has('apply')).length,
    avoided: ids.filter(
      (id) => !uses.get(id)!.has('apply') && (uses.get(id)!.has('avoid') || uses.get(id)!.has('not_applicable'))
    ).length,
    ignored: ids.filter((id) => !uses.get(id)!.size).length,
  };
}

/**
 * What the persisted directory looks like once the run is over: nothing may be left mid-flight.
 * Measured after the runner paused the channels, so it is exactly the state the report contains.
 */
function consistency(
  runs: Run[],
  channels: Channel[],
  releases: Release[],
  verifications: Verification[],
  timeline?: TimelineRecord[]
) {
  const runsRunning = runs.filter((row) => row.status === 'running').length;
  const channelsRunning = channels.filter((row) => row.status === 'running').length;
  const releasesPublishing = releases.filter((row) => row.status === 'publishing').length;
  const reviewsRunning = verifications.filter((row) => ['queued', 'running'].includes(row.status)).length;
  return {
    ok: !runsRunning && !channelsRunning && !releasesPublishing && !reviewsRunning,
    restarts: timeline ? timeline.filter((row) => row.verb === 'restart').length : unknown,
    runsRunning,
    channelsRunning,
    releasesPublishing,
    reviewsRunning,
  };
}

/** Latest in-window outcome; delta values use the original frozen baseline. */
function goal(
  decisions: StrategyDecision[],
  evidence: Evidence[]
): Maybe<{
  pointer: string;
  operator: string;
  expected: string | number | boolean;
  value: string | number | boolean | null;
  verdict: string;
  observedAt: string;
  evidenceId: string;
}> {
  for (const decision of [...decisions].reverse()) {
    const expected = (decision.expectations || []).find((row) => row.kind === 'outcome' && !!row.rule);
    if (!expected) continue;
    const rule = expected.rule!;
    const record = evidence
      .filter((row) => eligibleSample(decision, expected, row))
      .sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.createdAt.localeCompare(b.createdAt))
      .at(-1);
    if (!record) return unknown;
    const result = sampleResult(decision, expected, record, evidence);
    return {
      pointer: rule.pointer,
      operator: rule.operator,
      expected: rule.expected,
      value: result.value,
      verdict: result.verdict,
      observedAt: record.observedAt,
      evidenceId: record.id,
    };
  }
  return unknown;
}

export type Exploration = {
  /** Planted problems the scenario named a `/usage` feature for. */
  planted: number;
  /** …that at least one filed item names. */
  discovered: number;
  discoveryPercent: Maybe<number>;
  /** Board items that name a planted feature — the findings this run filed. */
  findings: number;
  /** …that cite a sample the framework collected, rather than only the run's own words. */
  findingsWithEvidence: number;
  evidencePercent: Maybe<number>;
  /** The low-usage planted problems, and whether the run gave each one the right cause. */
  attribution: Attribution;
  /** What the improvements this run proposed were framed with, and whether they were really observed. */
  improvements: {
    chosen: number;
    withExpectation: number;
    withObservation: number;
    withBoth: number;
    observed: number;
    percent: Maybe<number>;
  };
  /** Problems planted as must-not-fix that the run changed, chose, shipped or declared complete. */
  misFix: { mustNotFix: number; count: number; ids: string[]; percent: Maybe<number> };
};

/**
 * The exploration metrics of a scenario that plants problems with a `kind` and a `/usage` feature id:
 * how much of what was planted the run actually found, how much of what it filed carries a collected
 * sample, whether it told the two low-usage cases apart, whether the improvements it proposed were
 * framed and really observed, and whether it "fixed" the one problem that must not be fixed.
 *
 * A filed item is matched to a planted problem by the feature id appearing in the item's own title,
 * summary or next step — the same match works for a fixture state machine and for a real model, and
 * `defineScenario` rejects feature ids that contain one another. The labels are never visible to the
 * service or to a policy, so `unknown` without them; a scenario whose planted problems carry no
 * `kind` is not an exploration scenario and is `unknown` too, not 0.
 *
 * Attribution reads the whole matched set per case (`attributionVerdicts`), so no number here depends
 * on the order the board happens to hold its items in.
 */
function exploration(
  store: MetricsStore,
  decisions: StrategyDecision[],
  evidence: Evidence[],
  releases: Release[],
  watches: FeedbackWatch[],
  labels?: Labels
): Maybe<Exploration> {
  const planted = (labels?.planted || []).filter((row) => !!row.kind && !!row.feature);
  if (!labels || !planted.length) return unknown;
  const items = store.all<WorkItem>('items');
  const found = (row: PlantedProblem) => items.filter((item) => namesFeature(item, row.feature!, row.aliases));
  const filed = items.filter((item) => planted.some((row) => namesFeature(item, row.feature!, row.aliases)));
  // Evidence of the product being used: a watch sample or a native tool record. A file the run wrote
  // itself and then sealed is its own change, not an observation, so it cannot back a finding.
  const observation = (row: Evidence) => row.origin === 'http' || row.origin === 'native' || !!row.watchId;
  const cited = (item: WorkItem) =>
    // An item links its evidence as `[id] summary…` lines; a poll also stamps its own item id on the
    // sample it collects. Either way the row has to be one the framework observed, not agent words.
    evidence.some(
      (row) =>
        row.origin !== 'agent' &&
        observation(row) &&
        (row.itemId === item.id || (item.evidence || []).some((line) => line.startsWith(`[${row.id}]`)))
    );

  const details = attributionVerdicts(items, planted);
  const verdicts = (verdict: AttributionVerdict) => details.filter((row) => row.verdict === verdict).length;

  const acting = decisions.filter((row) => row.options?.[row.selected]?.kind === 'act');
  const framed = (decision: StrategyDecision) =>
    (decision.expectations || []).filter((row) => row.kind === 'outcome' && !!row.rule);
  const watched = (decision: StrategyDecision) =>
    framed(decision).filter(
      (row) => row.source.kind === 'watch' && watches.some((watch) => watch.id === (row.source as any).watchId)
    );
  const observed = (decision: StrategyDecision) =>
    watched(decision).some((expected) =>
      (decision.review?.assessment?.results || [])
        .filter((result) => result.expectationId === expected.id)
        .some((result) =>
          result.evidenceIds.some((id) => {
            const row = evidence.find((candidate) => candidate.id === id);
            return !!row && row.origin !== 'agent' && eligibleSample(decision, expected, row);
          })
        )
    );

  const mustNotFix = planted.filter((row) => row.shouldFix === false);
  const touched = (item: WorkItem) =>
    evidence.some((row) => row.origin === 'file' && row.itemId === item.id) ||
    decisions.some((row) => row.itemId === item.id) ||
    releases.some((row) => (row.itemIds || []).includes(item.id)) ||
    ['verified', 'resolved'].includes(item.status);
  const misFixed = mustNotFix.filter((row) => found(row).some(touched));

  return {
    planted: planted.length,
    discovered: planted.filter((row) => found(row).length > 0).length,
    discoveryPercent: share(planted.filter((row) => found(row).length > 0).length, planted.length),
    findings: filed.length,
    findingsWithEvidence: filed.filter(cited).length,
    evidencePercent: share(filed.filter(cited).length, filed.length),
    attribution: {
      cases: details.length,
      correct: verdicts('correct'),
      wrong: verdicts('wrong'),
      missing: verdicts('missing'),
      contradictory: verdicts('contradictory'),
      percent: share(verdicts('correct'), details.length),
      details,
    },
    improvements: {
      chosen: acting.length,
      withExpectation: acting.filter((row) => framed(row).length > 0).length,
      withObservation: acting.filter((row) => watched(row).length > 0).length,
      withBoth: acting.filter((row) => framed(row).length > 0 && watched(row).length > 0).length,
      observed: acting.filter(observed).length,
      percent: share(acting.filter(observed).length, acting.length),
    },
    misFix: {
      mustNotFix: mustNotFix.length,
      count: misFixed.length,
      ids: misFixed.map((row) => row.id),
      percent: share(misFixed.length, mustNotFix.length),
    },
  };
}

/**
 * Which name of a planted `/usage` feature a filed item actually uses: the feature id itself, or one
 * of the scenario's aliases for it (in practice the feature's own title in the usage report, which is
 * what a real model writes into a readable finding). `undefined` means the item names none of them.
 *
 * One rule for a fixture state machine, for a real model in live mode, and for the findings
 * `summary.md` prints verbatim; `defineScenario` rejects match keys that contain one another, so the
 * hit this returns is the only one it could be.
 */
export const matchedName = (
  item: { title?: string; summary?: string; nextStep?: string },
  feature: string,
  aliases: string[] = []
): string | undefined =>
  [feature, ...aliases].find((name) =>
    [item.title, item.summary, item.nextStep].some((text) => (text || '').includes(name))
  );

/** Whether a filed item names a planted feature at all, which is what counts as having discovered it. */
export const namesFeature = (
  item: { title?: string; summary?: string; nextStep?: string },
  feature: string,
  aliases: string[] = []
): boolean => matchedName(item, feature, aliases) !== undefined;

/**
 * What a filed item committed the feature to. Two buckets and no third: a `hypothesis` is a judgement
 * still to be verified, and anything else — an issue, a bug, a feature — is something to act on.
 */
export type FiledAs = 'judgement' | 'action';

/** The one rule that reads it, so the metric and the report can never disagree about an item. */
export const filedAs = (item: { kind?: string }): FiledAs => (item.kind === 'hypothesis' ? 'judgement' : 'action');

/**
 * How one attribution case came out. `contradictory` is neither `correct` nor `wrong`: the run filed
 * both readings of the same feature, so it never committed to either and must not be scored as if it
 * had. `missing` is nothing filed about the feature at all.
 */
export type AttributionVerdict = 'correct' | 'wrong' | 'missing' | 'contradictory';

/** One attribution case with what its verdict was read from, so a report can show the working. */
export type AttributionDetail = {
  /** The planted problem's own id. */
  id: string;
  /** Its `/usage` feature id. */
  feature: string;
  verdict: AttributionVerdict;
  /** Every item that names the feature, whatever it said about it. */
  itemIds: string[];
};

export type Attribution = {
  cases: number;
  correct: number;
  wrong: number;
  missing: number;
  /** Cases the run filed both ways at once. Counted here instead of `correct` or `wrong`. */
  contradictory: number;
  /** `correct / cases`: a contradiction is not a correct attribution, so it lowers this. */
  percent: Maybe<number>;
  details: AttributionDetail[];
};

/** The planted problems attribution judges: the two low-usage causes, and nothing else. */
const attributionCases = (planted: PlantedProblem[]): PlantedProblem[] =>
  planted.filter((row) => !!row.feature && (row.kind === 'entrance' || row.kind === 'not-needed'));

/**
 * What the run committed to about each low-usage case. The set of items that name the feature is what
 * decides it — **all** of them, never whichever one the board happens to hold first, so inserting the
 * same findings in another order cannot change a verdict.
 *
 * The buried entrance is a defect to act on; the counterexample is a judgement that still has to be
 * verified with the target users, not a defect. A case filed only the expected way is `correct`, only
 * the other way `wrong`, and **both ways `contradictory`** — a run that says a feature is a defect and
 * a hypothesis at the same time has not told the two causes apart, and silently keeping the first of
 * the two would read as if it had.
 */
export function attributionVerdicts(
  items: Array<{ id: string; kind?: string; title?: string; summary?: string; nextStep?: string }>,
  planted: PlantedProblem[]
): AttributionDetail[] {
  return attributionCases(planted).map((row) => {
    const matched = items.filter((item) => namesFeature(item, row.feature!, row.aliases));
    const filed = new Set<FiledAs>(matched.map(filedAs));
    const expected: FiledAs = row.kind === 'not-needed' ? 'judgement' : 'action';
    const verdict: AttributionVerdict = !filed.size
      ? 'missing'
      : filed.size > 1
        ? 'contradictory'
        : filed.has(expected)
          ? 'correct'
          : 'wrong';
    return { id: row.id, feature: row.feature!, verdict, itemIds: matched.map((item) => item.id) };
  });
}

/** A percentage, or `unknown` when there is nothing to divide — 0 of 0 is not 0 percent. */
const share = (part: number, total: number): Maybe<number> => (total ? Math.round((part / total) * 100) : unknown);

/**
 * Account usage the run can be charged with: the per-window difference between the first and last
 * reading, plus whatever the runs recorded themselves. `unknown` when no reading exists — which is
 * every fixture run, since a scripted backend reports no usage.
 */
function cost(store: MetricsStore, runs: Run[]): Maybe<{ readings: number; byWindow: Record<string, number> }> {
  let samples: UsageSample[] = [];
  try {
    samples = store.all<UsageSample>('usage_samples');
  } catch {
    samples = [];
  }
  const runDeltas = runs.flatMap((row) => (row.usage?.delta ? [row.usage.delta] : []));
  if (!samples.length && !runDeltas.length) return unknown;
  const byWindow: Record<string, number> = {};
  const ordered = [...samples].sort((a, b) => a.at.localeCompare(b.at));
  for (const name of new Set(ordered.flatMap((row) => row.windows.map((w) => w.name)))) {
    const values = ordered.flatMap((row) => row.windows.filter((w) => w.name === name).map((w) => w.usedPercent));
    if (values.length > 1) byWindow[name] = Math.round((values.at(-1)! - values[0]) * 100) / 100;
  }
  for (const delta of runDeltas)
    for (const [name, value] of Object.entries(delta))
      if (typeof value === 'number') byWindow[name] = Math.round(((byWindow[name] || 0) + value) * 100) / 100;
  return { readings: samples.length, byWindow };
}

function config(store: MetricsStore, runs: Run[], input: MetricsInput) {
  const channel = store.all<Channel>('channels').at(-1);
  const model =
    [...runs].reverse().find((row) => scheduleSources.includes(row.source || '') && row.model)?.model ||
    threadModel(store) ||
    unknown;
  return {
    mode: input.run?.mode || unknown,
    policy: input.run?.policy || unknown,
    seed: input.run?.seed ?? unknown,
    scenario: input.run?.scenario || unknown,
    scenarioVersion: input.run?.scenarioVersion || unknown,
    model,
    permission: channel?.permission || unknown,
    budget: {
      turns: input.run?.budget?.turns ?? unknown,
      reviews: input.run?.budget?.reviews ?? unknown,
      maxRunsPerDay: channel?.maxRunsPerDay ?? unknown,
    },
    source: fingerprint(),
  };
}

function threadModel(store: MetricsStore) {
  try {
    return store.all<any>('native_threads').at(-1)?.state?.model as string | undefined;
  } catch {
    return undefined;
  }
}

/** The version of the harness source that produced these numbers, not of the measured project. */
function fingerprint(): Maybe<{ digest: string; head: string; files: number; coverage: string }> {
  try {
    const version = sourceVersion(repoRoot);
    return { digest: version.digest, head: version.head, files: version.files, coverage: version.coverage };
  } catch {
    return unknown;
  }
}

function matchesSource(expected: Expectation, row: Evidence) {
  if (expected.source.kind === 'file') return row.origin === 'file' && row.source === expected.source.path;
  if (expected.source.kind === 'execution') return row.origin === 'execution' && row.source === expected.source.command;
  return (
    row.origin === (expected.source.path ? 'file' : 'http') &&
    row.watchId === expected.source.watchId &&
    row.source === (expected.source.path ?? expected.source.url)
  );
}

function eligibleSample(decision: StrategyDecision, expected: Expectation, row: Evidence, cutoff?: string) {
  const created = Date.parse(row.createdAt),
    observed = Date.parse(row.observedAt);
  const chosen = Date.parse(decision.createdAt),
    start = Date.parse(expected.notBefore),
    end = Date.parse(expected.deadline);
  const until = cutoff === undefined ? Infinity : Date.parse(cutoff);
  return (
    matchesSource(expected, row) &&
    Number.isFinite(created) &&
    Number.isFinite(observed) &&
    created >= chosen &&
    observed >= start &&
    observed <= end &&
    created <= until &&
    observed <= until
  );
}

// Evaluate each observation at its own collection time. Later samples and wall
// clock passage must not change the first valid violation in an old review.
function sampleResult(decision: StrategyDecision, expected: Expectation, row: Evidence, evidence: Evidence[]) {
  const data = evidenceData(row);
  let value = pointerValue(data, expected.rule!.pointer);
  let usable = scalar(value);
  const plan = expected.measurement;
  if (plan) {
    usable &&= qualityChecks(plan, data, row.observedAt).every((check) => check.status === 'passed');
    let baselineValue: unknown;
    if ('evidenceId' in plan.baseline) {
      const baselineId = plan.baseline.evidenceId;
      const baseline = evidence.find((candidate) => candidate.id === baselineId);
      const valid =
        baseline &&
        matchesSource(expected, baseline) &&
        Date.parse(baseline.createdAt) <= Date.parse(decision.createdAt) &&
        Date.parse(baseline.observedAt) <= Date.parse(decision.createdAt) &&
        qualityChecks(plan, evidenceData(baseline), decision.createdAt).every((check) => check.status === 'passed');
      if (valid) baselineValue = pointerValue(evidenceData(baseline), expected.rule!.pointer);
      usable &&= !!valid && scalar(baselineValue);
    }
    if (plan.comparison === 'delta') {
      value = typeof value === 'number' && typeof baselineValue === 'number' ? value - baselineValue : undefined;
      usable &&= typeof value === 'number' && Number.isFinite(value);
    }
  }
  if (row.origin === 'execution') {
    const data = row.data as Record<string, unknown> | null;
    usable &&= data?.boundVersion === true && data?.outputComplete === true && Number.isInteger(data?.exitCode);
  }
  return { value: scalar(value) ? value : null, verdict: usable ? ruleVerdict(expected.rule!, value) : 'unknown' };
}

export function pointerValue(data: unknown, pointer: string): unknown {
  return valueAt(data, pointer);
}

const tables = [
  'runs',
  'channels',
  'events',
  'items',
  'loop_evidence',
  'loop_learning',
  'loop_watches',
  'loop_releases',
  'loop_verifications',
  'strategy_decisions',
  'strategy_understanding',
  'usage_samples',
  'native_threads',
] as const;

/**
 * Opens a copy of `<home>/workspace.sqlite` read-only. The source directory is never written to —
 * this is what the weekly review runs on the real daemon's data directory.
 */
export function openCopy(home: string): { store: MetricsStore; close(): void } {
  const source = join(home, 'workspace.sqlite');
  if (!existsSync(source))
    throw new Error(`找不到 ${source}；metrics 需要一个 Morrow 数据目录或保留了 home/ 的报告目录`);
  const root = mkdtempSync(join(tmpdir(), 'morrow-metrics-'));
  const copy = join(root, 'workspace.sqlite');
  copyFileSync(source, copy);
  for (const suffix of ['-wal', '-shm']) if (existsSync(source + suffix)) copyFileSync(source + suffix, copy + suffix);
  const db = new DatabaseSync(copy, { readOnly: true });
  // Read every table at most once: a real data directory holds thousands of rows and `get` is
  // called per cited evidence id.
  const cache = new Map<string, any[]>();
  const rows = (table: string) => {
    if (!(tables as readonly string[]).includes(table)) throw new Error(`metrics 不读取表 ${table}`);
    const known = cache.get(table);
    if (known) return known;
    let parsed: any[] = [];
    try {
      parsed = (db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all() as Array<{ data: string }>).map((row) =>
        JSON.parse(row.data)
      );
    } catch {
      // An older database may simply not have the table yet; that is an empty result, not a failure.
      parsed = [];
    }
    cache.set(table, parsed);
    return parsed;
  };
  const index = new Map<string, Map<string, any>>();
  return {
    store: {
      all: <T>(table: string) => rows(table) as T[],
      get: <T>(table: string, id: string) => {
        let byId = index.get(table);
        if (!byId) {
          byId = new Map(rows(table).map((row) => [row?.id, row]));
          index.set(table, byId);
        }
        return byId.get(id) as T | undefined;
      },
    },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export type SelfCheckRow = {
  metric: string;
  careful: Maybe<number>;
  naive: Maybe<number>;
  expected: 'naive lower' | 'naive higher';
  ok: boolean;
  detail: string;
};

/** One self-check rule: the metric, the direction, and when it is worth comparing at all. */
const selfCheckRules: Array<{
  metric: string;
  expected: SelfCheckRow['expected'];
  read(metrics: Metrics): Maybe<number>;
  /** Absent means always compared. */
  when?(careful: Metrics): boolean;
}> = [
  { metric: 'guardrails.defined', expected: 'naive lower', read: (m) => m.guardrails.defined },
  {
    metric: 'guardrails.violationsCaught',
    expected: 'naive lower',
    read: (m) => m.guardrails.violationsCaught,
    when: (careful) => careful.guardrails.violationsCaught > 0,
  },
  { metric: 'staleMemory.followed', expected: 'naive higher', read: (m) => number(m.staleMemory, 'followed') },
  {
    metric: 'reviewsCitingCapturedEvidence',
    expected: 'naive lower',
    read: (m) => m.reviewsCitingCapturedEvidence,
  },
  { metric: 'repeatedFailures.groups', expected: 'naive higher', read: (m) => number(m.repeatedFailures, 'groups') },
  // Exploration rules. Only a scenario that plants problems with a kind and a feature produces them,
  // so they are skipped elsewhere rather than failing for every scenario that has no usage report.
  ...exploring('usagegap.discovered', 'naive lower', (m) => at(m.usagegap, 'discovered')),
  ...exploring('usagegap.findingsWithEvidence', 'naive lower', (m) => at(m.usagegap, 'findingsWithEvidence')),
  ...exploring('usagegap.attribution.correct', 'naive lower', (m) => at(m.usagegap, 'attribution', 'correct')),
  ...exploring('usagegap.improvements.observed', 'naive lower', (m) => at(m.usagegap, 'improvements', 'observed')),
  ...exploring('usagegap.misFix.count', 'naive higher', (m) => at(m.usagegap, 'misFix', 'count')),
];

/** One exploration rule, compared only for a scenario that actually produced the block. */
function exploring(metric: string, expected: SelfCheckRow['expected'], read: (metrics: Metrics) => Maybe<number>) {
  return [{ metric, expected, read, when: (careful: Metrics) => careful.usagegap !== unknown }];
}

/**
 * The harness's own check that the metrics can tell the two policies apart. `naive` must come out
 * measurably worse on every rule below; a scenario that cannot produce a guardrail violation at all
 * skips that one rather than passing it by default.
 *
 * `required` names the metrics a scenario declares it must prove a difference on (its `selfCheck`).
 * A rule that would have been skipped is compared anyway for those, so a scenario whose window
 * stopped producing the evidence it exists to produce fails instead of quietly passing. A name that
 * matches no rule is itself a failure: a typo must not read as a satisfied demand.
 */
export function policySelfCheck(
  careful: Metrics,
  naive: Metrics,
  required: string[] = []
): { ok: boolean; rows: SelfCheckRow[] } {
  const rows: SelfCheckRow[] = selfCheckRules
    .filter((row) => !row.when || row.when(careful) || required.includes(row.metric))
    .map((row) => rule(row.metric, row.read(careful), row.read(naive), row.expected));
  for (const metric of required)
    if (!selfCheckRules.some((row) => row.metric === metric))
      rows.push({
        metric,
        careful: unknown,
        naive: unknown,
        expected: 'naive lower',
        ok: false,
        detail: '场景要求比较这项指标，但自检里没有这条规则',
      });
  return { ok: rows.every((row) => row.ok), rows };
}

function rule(metric: string, careful: Maybe<number>, naive: Maybe<number>, expected: SelfCheckRow['expected']) {
  const comparable = typeof careful === 'number' && typeof naive === 'number';
  const ok = comparable && (expected === 'naive lower' ? naive < careful : naive > careful);
  return {
    metric,
    careful,
    naive,
    expected,
    ok,
    detail: comparable ? `careful ${careful} · naive ${naive}` : '缺少可比较的取值（unknown）',
  };
}

const number = (value: unknown, key: string): Maybe<number> => {
  const read = value && typeof value === 'object' ? (value as any)[key] : undefined;
  return typeof read === 'number' ? read : unknown;
};

/** A nested numeric reading, `unknown` as soon as any step of the path is missing. */
const at = (value: unknown, ...path: string[]): Maybe<number> => {
  let row: unknown = value;
  for (const key of path) row = row && typeof row === 'object' ? (row as any)[key] : undefined;
  return typeof row === 'number' ? row : unknown;
};

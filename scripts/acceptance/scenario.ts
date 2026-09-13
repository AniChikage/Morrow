import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  PatchFiles,
  PolicyExpectation,
  PolicyScenario,
  TurnRecord,
  CallRecord,
} from '../../tests/harness/scripted-native.ts';
import type { ScriptedNativeTransport } from '../../tests/harness/scripted-native.ts';
import type { Receiver, ReceiverMode } from '../../tests/harness/receiver.ts';
import type { IsolatedService } from '../../tests/harness/service.ts';

/**
 * How a scenario labels a feedback change it makes. The labels are the only scenario input the
 * metrics of a later step may read that does not come from SQLite; nothing in the service or in a
 * policy is allowed to see them.
 */
export type Truth = 'noise' | 'goodhart' | 'environment';

export type Step =
  /** Make the channel due and run one scheduled turn through the real scheduler. */
  | { verb: 'turn'; note?: string }
  /** Poll every live feedback watch once, through the loop's own polling entry. */
  | { verb: 'poll'; note?: string }
  /** Replace the receiver's feedback sample. */
  | { verb: 'set'; value: unknown; truth?: Truth; note?: string }
  /** Switch the receiver into a failure mode. */
  | { verb: 'mode'; mode: ReceiverMode; note?: string }
  /** Human approval of the sealed release awaiting review. */
  | { verb: 'approve'; note?: string }
  | { verb: 'reject'; feedback?: string; note?: string }
  /** User guidance sent into the same native task as a chat message. */
  | { verb: 'guide'; text: string; note?: string }
  /** Fixture only: drive the pending independent review to a verdict. */
  | { verb: 'verify'; note?: string }
  /** Close and reopen the service on the same data directory. */
  | { verb: 'restart'; note?: string }
  /** Stop automatic work on the channel. */
  | { verb: 'pause'; note?: string }
  /**
   * Re-enable automatic work after `pause`. Not in the plan's verb list; without it a paused
   * timeline cannot continue, so the DSL would be unable to express recovery.
   */
  | { verb: 'resume'; note?: string }
  /** Move the virtual clock forward. */
  | { verb: 'advance'; minutes: number; note?: string };

export type StepVerb = Step['verb'];

/** One executed step, as `timeline.jsonl` records it. */
export type TimelineRecord = {
  index: number;
  verb: StepVerb;
  args: Record<string, unknown>;
  /** Virtual clock reading when the step started. */
  virtualTime: string;
  result: Record<string, unknown>;
};

export type InvariantContext = {
  store: any;
  service: IsolatedService;
  transport: ScriptedNativeTransport;
  receiver: Receiver;
  timeline: TimelineRecord[];
  /** The served seed app, when the scenario has a `project.serve` block; see `ServedApp`. */
  app?: ServedApp;
};

/** The seed app the runner started for this run, as an invariant and the report see it. */
export type ServedApp = {
  /** Origin the agent is given, e.g. `http://127.0.0.1:45171`. */
  url: string;
  /** JSON the runner read once from `serve.probe`, so a scenario can assert the seed's own shape. */
  probe?: unknown;
};
export type InvariantResult = { ok: boolean; detail: string };
export type Invariant = { name: string; check(context: InvariantContext): InvariantResult };

/** A record the scenario writes through the work interface before the first turn. */
export type MemorySeed = {
  operation: 'understanding.upsert' | 'learning.upsert';
  input: Record<string, unknown>;
  /** Free-text note explaining why this record is planted (stale experience, noise, …). */
  note?: string;
  /**
   * This record is the stale experience the scenario plants. The runner writes the ids it created
   * into `labels.json`, and the metrics count them as followed, avoided or ignored. A policy never
   * sees the flag — it only sees the record itself in `context`.
   */
  stale?: boolean;
};

/**
 * What kind of problem a planted one is, as the scenario knows it. Only exploration scenarios set it;
 * `usagegap`'s attribution metric compares it against the kind the run gave its own finding.
 *
 * `entrance` 入口太深导致使用率低 · `flow` 流程在某一步中断 · `empty-state` 空状态没有下一步 ·
 * `copy` 文案与实际行为不一致 · `not-needed` 使用率低但目标用户本来就不需要（反例，不该被"修"）。
 */
export type PlantedKind = 'entrance' | 'flow' | 'empty-state' | 'copy' | 'not-needed';

/** A problem deliberately built into the seed project, for a later step's discovery metrics. */
export type PlantedProblem = {
  id: string;
  where: string;
  description: string;
  shouldFix: boolean;
  /** Exploration scenarios only; without it the `usagegap` metrics stay `unknown`. */
  kind?: PlantedKind;
  /**
   * Exploration scenarios only: the `/usage` feature this problem belongs to. A filed finding counts
   * as having discovered this problem when it names this id anywhere in its title, summary or next
   * step — the same match works for a fixture policy and for a real model in live mode. Feature ids
   * must not be substrings of one another.
   */
  feature?: string;
  /**
   * Other names for the same feature that also count as having discovered it — in practice the
   * feature's own `title` in the usage report, which is what a real model writes into a readable
   * finding. A fixture policy writes the id, so aliases never change a fixture number; live run
   * usagegap-live-02 filed 「让值班人员从首页直接找到批量导出」, which names the feature exactly as the
   * data does and still counted as 0/5 under an id-only match. `defineScenario` applies the same
   * containment rule to aliases as to ids, so a hit is never ambiguous.
   */
  aliases?: string[];
};

/**
 * The scenario's own labels, written to `labels.json`. They are the only input the metrics read that
 * does not come from SQLite: which seeded records are stale, what each feedback change really was,
 * and which problems were planted. Nothing in the service or in a policy is allowed to see them.
 */
export type Labels = {
  /** Record ids created by the seeds marked `stale: true`. */
  staleMemoryIds: string[];
  /** Every `set` step that carried a `truth` label, with the virtual time it took effect. */
  truth: Array<{ stepIndex: number; truth: Truth; virtualTime: string }>;
  planted: PlantedProblem[];
};

export type ProjectSpec = {
  /** Seed files written into the isolated project directory. */
  files?: Record<string, string>;
  /** Directory copied into the project directory instead of `files`. */
  seedDir?: string;
  /**
   * Directory of numbered patch directories (`1/`, `2/`, …). Each one holds the **full text** of the
   * project files that change — it is an overwrite, not a diff — and must include `artifactPath`,
   * because the policy seals exactly that file as the patch's file evidence. A policy applies patch
   * 1 on the turn it makes its change and the next one on the turn it adjusts after a review that
   * did not reach its expectation. Without this field the policy writes `artifactBody` instead.
   */
  patches?: string;
  /** Project-relative path of the file a release seals. */
  artifactPath: string;
  /** Text the policy writes into `artifactPath` when it makes its change, if there are no patches. */
  artifactBody?: string;
  /** The full check a policy runs on the release candidate. The first entry is the command it uses. */
  tests?: string[];
  /** How to run the seed project as a real app for the length of the run; see `ServeSpec`. */
  serve?: ServeSpec;
};

/**
 * How the runner serves the seed project: `node <args…>` started in the isolated project directory
 * with a free port in `PORT`, polled on `ready` until it answers, handed to the policy and to the
 * project brief as `appUrl`, and stopped again in cleanup. No shell is involved.
 *
 * The plan wrote this as `{command, port}`. A fixed port cannot be used by two runs at once — the
 * in-process tests and `run all` both start several services — so the runner picks the port and the
 * scenario only says what to run.
 */
export type ServeSpec = {
  /** Arguments after the Node executable, e.g. `['server.js']`. */
  args: string[];
  /** Path polled until the app answers; defaults to `/`. */
  ready?: string;
  /** Path read once as JSON after startup, kept in `app.probe` for the scenario's own assertions. */
  probe?: string;
};

/**
 * An exploration scenario: the run is given a goal, the app and its usage endpoint, and nothing about
 * what to fix. The usage sample is an object of features keyed by id, each carrying the fields a real
 * usage report would have, and a policy classifies them itself:
 *
 * | 字段 | 含义 |
 * | --- | --- |
 * | `title` | 功能名，用来写可读的事项标题 |
 * | `visits` | 窗口内的访问次数 |
 * | `completionRate` | 完成率 |
 * | `abandonStep` | 放弃集中在第几步；0 表示没有集中放弃的步骤 |
 * | `askedFor` | 目标用户访谈里是否要求过这个功能 |
 * | `emptyStateNextAction` | 空状态里是否给了下一步 |
 * | `copyMatchesBehaviour` | 文案与实际行为是否一致 |
 *
 * `askedFor` is what separates "使用率低是缺陷" from "使用率低是因为目标用户不需要"; a policy that
 * ignores it cannot tell the counterexample apart, which is exactly what the attribution metric
 * measures.
 */
export type ExploreSpec = {
  /** JSON Pointer of the features object inside a usage sample, e.g. `/features`. */
  features: string;
  /** Fewer visits than this in the window counts as underused. */
  lowVisits: number;
  /** A completion rate below this counts as losing people. */
  lowCompletion: number;
};

export type FeedbackSpec = {
  /** The receiver's first sample. */
  initial: Record<string, unknown>;
  /** Path appended to the receiver origin for feedback reads. Defaults to `/feedback`. */
  path?: string;
  /** JSON Pointer of the outcome metric inside a sample. */
  pointer: string;
  /** When the watch counts as triggered. */
  condition: { operator: 'changed' | 'gte' | 'lte' | 'equals'; expected?: string | number | boolean };
  /** The result the work is expected to produce, checked mechanically by its rule. */
  outcome: PolicyExpectation;
  /** The condition the work may not sacrifice, checked mechanically by its rule. */
  guardrail: PolicyExpectation;
  /**
   * The field that says two observation windows are comparable at all, and the value that held when
   * the work was decided. A policy freezes it into the expectation's scope; when a later sample
   * carries a different value, the two windows measure different populations, so the review reports
   * `conditions: 'changed'` and stays inconclusive instead of attributing the move to the change.
   */
  comparability?: { pointer: string; expected: string | number | boolean };
  /** How long a change takes to show up in the metric; sizes the observation window. */
  latencySeconds?: number;
};

export type Budget = {
  /** Scheduled turns the run may spend. Exceeding it fails the run. */
  turns: number;
  /** Independent reviews the run may spend; they share the channel's daily budget. */
  reviews?: number;
};

export type Scenario = {
  id: string;
  title: string;
  version: string;
  goal: string;
  brief?: string;
  project: ProjectSpec;
  memory: MemorySeed[];
  feedback: FeedbackSpec;
  budget: Budget;
  timeline: Step[];
  invariants: Invariant[];
  planted: PlantedProblem[];
  /**
   * The question the work is about to answer. With it, a policy re-checks the project's memory
   * (`memory.recall` for this question beside the automatic recall in `context`, then `memory.read`
   * for the full record) and records a `memoryRefs` entry for everything it found. Without it the
   * policy makes no experience reference at all — which is what a scenario from before the recall
   * mechanism existed should look like.
   */
  recall?: string;
  /**
   * Makes this an exploration scenario: the policies read the usage report through the same feedback
   * watch, classify the features themselves and file one board item per finding before choosing what
   * to improve. Without it a policy goes straight to its change, which is what every historical
   * scenario does.
   */
  explore?: ExploreSpec;
  /**
   * Self-check metrics this scenario must actually prove a difference on. A rule the generic check
   * would skip because `careful` produced nothing to compare is still evaluated for these, so a
   * scenario that stops producing its own evidence fails instead of passing by default.
   */
  selfCheck: string[];
};

export type ScenarioInput = Omit<Scenario, 'version' | 'memory' | 'planted' | 'selfCheck'> &
  Partial<Pick<Scenario, 'version' | 'memory' | 'planted' | 'selfCheck'>>;

/** Absolute path of a scenario's seed project, `scenarios/projects/<id>/`. */
export const seedDir = (id: string) => fileURLToPath(new URL(`./scenarios/projects/${id}/`, import.meta.url));
/** Absolute path of a scenario's patch directories, `scenarios/patches/<id>/<n>/`. */
export const patchDir = (id: string) => fileURLToPath(new URL(`./scenarios/patches/${id}/`, import.meta.url));

/** Fills the optional parts of a scenario and rejects the mistakes that only surface mid-run. */
export function defineScenario(input: ScenarioInput): Scenario {
  const scenario: Scenario = {
    version: '1',
    memory: [],
    planted: [],
    selfCheck: [],
    ...input,
  };
  if (!scenario.id.trim()) throw new Error('scenario.id is required');
  if (!scenario.timeline.length) throw new Error(`scenario ${scenario.id}: timeline is empty`);
  if (scenario.budget.turns < 1) throw new Error(`scenario ${scenario.id}: budget.turns must be at least 1`);
  const turns = scenario.timeline.filter((step) => step.verb === 'turn').length;
  if (turns > scenario.budget.turns)
    throw new Error(`scenario ${scenario.id}: timeline has ${turns} turns but a budget of ${scenario.budget.turns}`);
  if (!scenario.invariants.length) throw new Error(`scenario ${scenario.id}: at least one invariant is required`);
  const rules = [scenario.feedback.outcome.rule, scenario.feedback.guardrail.rule];
  for (const rule of rules)
    if (!rule.pointer.startsWith('/')) throw new Error(`scenario ${scenario.id}: rule pointer must start with "/"`);
  for (const row of scenario.planted)
    for (const alias of row.aliases || [])
      if (!alias.trim()) throw new Error(`scenario ${scenario.id}: planted problem ${row.id} has an empty alias`);
  if (scenario.explore) {
    if (!scenario.explore.features.startsWith('/'))
      throw new Error(`scenario ${scenario.id}: explore.features must be a JSON Pointer`);
    if (!scenario.project.serve)
      throw new Error(`scenario ${scenario.id}: an exploration scenario needs project.serve`);
    const features = scenario.planted.flatMap((row) => (row.feature ? [row.feature] : []));
    if (features.length !== scenario.planted.length)
      throw new Error(`scenario ${scenario.id}: every planted problem of an exploration scenario needs a feature id`);
    for (const row of scenario.planted)
      if (!row.kind) throw new Error(`scenario ${scenario.id}: planted problem ${row.id} needs a kind`);
    // The metrics match a finding to a planted problem by looking for the feature id — or one of its
    // aliases — in the item's own text, so no match key may be contained in another one.
    const keys = [
      ...features.map((value) => ({ value, label: `feature id ${value}` })),
      ...scenario.planted.flatMap((row) =>
        (row.aliases || []).map((value) => ({ value, label: `alias ${value} of ${row.id}` }))
      ),
    ];
    for (const [index, a] of keys.entries()) {
      const twin = keys.findIndex((row) => row.value === a.value);
      if (twin !== index)
        throw new Error(`scenario ${scenario.id}: ${a.label} repeats ${keys[twin].label}; a hit would be ambiguous`);
      for (const b of keys)
        if (a.value !== b.value && b.value.includes(a.value))
          throw new Error(
            `scenario ${scenario.id}: ${a.label} is contained in ${b.label}; match keys must be distinguishable`
          );
    }
  }
  return scenario;
}

/**
 * Reads `patches/<id>/<n>/` verbatim, in numeric order. Every patch must carry the sealed artifact:
 * the policy captures exactly that file as the patch's evidence, so a patch without it would leave
 * the change unsealed.
 */
export function readPatches(dir: string, artifactPath: string): PatchFiles[] {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const name of names) if (!/^[1-9][0-9]*$/.test(name)) throw new Error(`补丁目录只能用从 1 开始的序号：${name}`);
  const patches = names
    .map(Number)
    .sort((a, b) => a - b)
    .map((n) => ({ n, files: readTree(join(dir, String(n))) }));
  if (!patches.length) throw new Error(`${dir} 里没有补丁目录`);
  for (const [index, patch] of patches.entries()) {
    if (patch.n !== index + 1) throw new Error(`补丁序号必须连续：${dir} 缺少 ${index + 1}`);
    if (!patch.files[artifactPath]) throw new Error(`补丁 ${patch.n} 必须包含待封存产物 ${artifactPath}`);
  }
  return patches;
}

/** Reads a directory verbatim into a project-relative file map. */
export function readTree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const next = join(current, entry.name);
      if (entry.isDirectory()) walk(next, name);
      else files[name] = readFileSync(next, 'utf8');
    }
  };
  if (!statSync(dir).isDirectory()) throw new Error(`${dir} 不是目录`);
  walk(resolve(dir), '');
  return files;
}

/** Builds the view a turn policy gets, once the receiver's origin and the served app are known. */
export function policyScenario(
  scenario: Scenario,
  receiverURL: string,
  options: { appUrl?: string } = {}
): PolicyScenario {
  const patches = scenario.project.patches
    ? readPatches(scenario.project.patches, scenario.project.artifactPath)
    : undefined;
  return {
    id: scenario.id,
    goal: scenario.goal,
    artifactPath: scenario.project.artifactPath,
    artifactBody: scenario.project.artifactBody || `${scenario.id} release\n`,
    checkCommand: scenario.project.tests?.[0] || 'node --test',
    ...(patches ? { patches } : {}),
    ...(scenario.recall === undefined ? {} : { recall: scenario.recall }),
    ...(scenario.explore === undefined ? {} : { explore: scenario.explore }),
    ...(options.appUrl === undefined ? {} : { appUrl: options.appUrl }),
    feedback: {
      url: usageURL(scenario, receiverURL),
      releaseUrl: releaseURL(receiverURL),
      statusUrl: statusURL(receiverURL),
      pointer: scenario.feedback.pointer,
      condition: scenario.feedback.condition,
      outcome: scenario.feedback.outcome,
      guardrail: scenario.feedback.guardrail,
      ...(scenario.feedback.comparability === undefined ? {} : { comparability: scenario.feedback.comparability }),
      latencySeconds: scenario.feedback.latencySeconds ?? 60,
    },
  };
}

/** The absolute URL a scenario's feedback watch reads, once the receiver's origin is known. */
export const usageURL = (scenario: Scenario, receiverURL: string) =>
  receiverURL + (scenario.feedback.path || '/feedback');
/**
 * Where a release adapter uploads the sealed artifact, and where it reads the receipt back. These are
 * `tests/harness/receiver.ts`'s own routes: a POST records an upload and answers with its receipt, and
 * `GET /status` (with any query — the release reconciliation appends `releaseId`) returns the latest
 * one. The same two addresses reach a fixture policy through `policyScenario` and a real model through
 * the project brief, so both talk to the same endpoint.
 */
export const releaseURL = (receiverURL: string) => receiverURL + '/deploy';
export const statusURL = (receiverURL: string) => receiverURL + '/status';

/** The addresses a scenario cannot know in advance, as `projectBrief` fills them in. */
export type BriefURLs = { appUrl?: string; usageUrl: string; releaseUrl: string; statusUrl: string };

/**
 * Fills the addresses a scenario cannot know in advance into its project brief, which is what a real
 * model reads: `{{appUrl}}` is the served seed app, `{{usageUrl}}` the usage endpoint the run may
 * observe, and `{{releaseUrl}}` / `{{statusUrl}}` the release adapter's upload and status addresses.
 * An unknown placeholder is a scenario mistake, not something to leave in the text.
 *
 * A fixture policy never reads the brief — it gets the same addresses through `policyScenario` — but
 * both runners fill it in, so a scenario cannot ship a brief that only live mode would reject.
 */
export function projectBrief(brief: string, urls: BriefURLs): string {
  const filled = brief
    .replaceAll('{{appUrl}}', urls.appUrl || '（本次运行没有启动应用）')
    .replaceAll('{{usageUrl}}', urls.usageUrl)
    .replaceAll('{{releaseUrl}}', urls.releaseUrl)
    .replaceAll('{{statusUrl}}', urls.statusUrl);
  const left = filled.match(/\{\{[a-zA-Z]+\}\}/);
  if (left)
    throw new Error(
      `项目说明里有无法填充的占位符 ${left[0]}；只支持 {{appUrl}}、{{usageUrl}}、{{releaseUrl}} 与 {{statusUrl}}`
    );
  return filled;
}

/** Shorthand for the common invariant shape: a predicate plus the detail it should report. */
export function invariant(name: string, check: (context: InvariantContext) => InvariantResult): Invariant {
  return { name, check };
}

export type { CallRecord, PatchFiles, TurnRecord };

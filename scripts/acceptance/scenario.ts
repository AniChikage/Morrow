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

/** A problem deliberately built into the seed project, for a later step's discovery metrics. */
export type PlantedProblem = { id: string; where: string; description: string; shouldFix: boolean };

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
  /** How to serve the seed project in live mode; unused in fixture mode. */
  serve?: { command: string; port: number };
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

/** Builds the view a turn policy gets, once the receiver's origin is known. */
export function policyScenario(scenario: Scenario, receiverURL: string): PolicyScenario {
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
    feedback: {
      url: receiverURL + (scenario.feedback.path || '/feedback'),
      releaseUrl: receiverURL + '/deploy',
      statusUrl: receiverURL + '/status',
      pointer: scenario.feedback.pointer,
      condition: scenario.feedback.condition,
      outcome: scenario.feedback.outcome,
      guardrail: scenario.feedback.guardrail,
      ...(scenario.feedback.comparability === undefined ? {} : { comparability: scenario.feedback.comparability }),
      latencySeconds: scenario.feedback.latencySeconds ?? 60,
    },
  };
}

/** Shorthand for the common invariant shape: a predicate plus the detail it should report. */
export function invariant(name: string, check: (context: InvariantContext) => InvariantResult): Invariant {
  return { name, check };
}

export type { CallRecord, PatchFiles, TurnRecord };

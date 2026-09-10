import type { PolicyExpectation, PolicyScenario, TurnRecord, CallRecord } from '../../tests/harness/scripted-native.ts';
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
  /** Project-relative path of the file a release seals. */
  artifactPath: string;
  /** Text the policy writes into `artifactPath` when it makes its change. */
  artifactBody?: string;
  /** Commands a later step may run as execution evidence; unused in fixture mode. */
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
};

export type ScenarioInput = Omit<Scenario, 'version' | 'memory' | 'planted'> &
  Partial<Pick<Scenario, 'version' | 'memory' | 'planted'>>;

/** Fills the optional parts of a scenario and rejects the mistakes that only surface mid-run. */
export function defineScenario(input: ScenarioInput): Scenario {
  const scenario: Scenario = {
    version: '1',
    memory: [],
    planted: [],
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

/** Builds the view a turn policy gets, once the receiver's origin is known. */
export function policyScenario(scenario: Scenario, receiverURL: string): PolicyScenario {
  return {
    id: scenario.id,
    goal: scenario.goal,
    artifactPath: scenario.project.artifactPath,
    artifactBody: scenario.project.artifactBody || `${scenario.id} release\n`,
    feedback: {
      url: receiverURL + (scenario.feedback.path || '/feedback'),
      releaseUrl: receiverURL + '/deploy',
      statusUrl: receiverURL + '/status',
      pointer: scenario.feedback.pointer,
      condition: scenario.feedback.condition,
      outcome: scenario.feedback.outcome,
      guardrail: scenario.feedback.guardrail,
      latencySeconds: scenario.feedback.latencySeconds ?? 60,
    },
  };
}

/** Shorthand for the common invariant shape: a predicate plus the detail it should report. */
export function invariant(name: string, check: (context: InvariantContext) => InvariantResult): Invariant {
  return { name, check };
}

export type { CallRecord, TurnRecord };

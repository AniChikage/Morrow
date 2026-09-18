import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { FakeReviewer } from './fake-reviewer.ts';
import type { NativeSnapshot, NativeWorkOptions } from '../../service/native-conversations.ts';
import type { Channel, Project, Run, UsageReading } from '../../service/protocol.ts';

/** `POST /api/agent` with this run's grant. Rejects on any non-2xx answer, with the server's message. */
export type AgentCall = (operation: string, input?: unknown, requestId?: string) => Promise<any>;
/** Scratch a policy keeps across the turns of one scenario run; the harness never reads it. */
export type PolicyMemory = Record<string, unknown>;

/** One patch: the full text of every project file it replaces, keyed by project-relative path. */
export type PatchFiles = { n: number; files: Record<string, string> };

/** The scenario fields a turn policy reads. `scripts/acceptance/scenario.ts` builds one per run. */
export type PolicyScenario = {
  id: string;
  goal: string;
  /** Project-relative path of the file a release seals, e.g. `release.txt`. */
  artifactPath: string;
  /** Text the policy writes into that file on the turn it makes the change, if there are no patches. */
  artifactBody: string;
  /** The full check the policy runs on the release candidate through `execution.prepare`. */
  checkCommand: string;
  /** Numbered patches the policy applies instead of writing `artifactBody`; each includes the artifact. */
  patches?: PatchFiles[];
  /** The question the policy re-checks the project's memory against; absent means it makes no reference. */
  recall?: string;
  /** Origin of the seed app the runner started, when the scenario serves one. */
  appUrl?: string;
  /** Present for an exploration scenario; see `scripts/acceptance/scenario.ts`'s `ExploreSpec`. */
  explore?: PolicyExplore;
  feedback: PolicyFeedback;
};
/** How a policy reads the usage report of an exploration scenario. */
export type PolicyExplore = { features: string; lowVisits: number; lowCompletion: number };
export type PolicyRule = { pointer: string; operator: 'gte' | 'lte' | 'equals'; expected: string | number | boolean };
export type PolicyExpectation = {
  id: string;
  claim: string;
  scope: string;
  verification: string;
  disconfirm: string;
  rule: PolicyRule;
};
export type PolicyFeedback = {
  /** Absolute URL of the feedback sample, e.g. `http://127.0.0.1:1234/feedback`. */
  url: string;
  /** Absolute URL a release is sent to, and the URL its receipt is read back from. */
  releaseUrl: string;
  statusUrl: string;
  /** JSON Pointer of the outcome metric inside a sample. */
  pointer: string;
  condition: { operator: 'changed' | 'gte' | 'lte' | 'equals'; expected?: string | number | boolean };
  outcome: PolicyExpectation;
  guardrail: PolicyExpectation;
  /** The field and value that make two windows comparable; a later difference blocks attribution. */
  comparability?: { pointer: string; expected: string | number | boolean };
  /** How long after a change the metric is expected to move; the policy uses it for observation windows. */
  latencySeconds: number;
};

export type TransportService = { store: any; home: string };
export type TurnContext = {
  /** The exact prompt the scheduler sent this turn. */
  prompt: string;
  run: Run;
  channel: Channel;
  project: Project;
  grant: { token: string; call: AgentCall };
  service: TransportService;
  scenario: PolicyScenario;
  memory: PolicyMemory;
  /**
   * Emits one native `commandExecution` item, start and completion, into the turn this policy is
   * running in, so an `execution.prepare` seal observes it through the service's own native
   * ingestion. Nothing is executed and no model runs: the reported exit code and output are given here.
   */
  runCommand(command: string, reported?: { exitCode?: number; output?: string }): void;
};
/** Returns the final assistant text of a scheduled turn; it must end with a ```morrow-next``` block. */
export type TurnPolicy = (context: TurnContext) => Promise<string>;
export type ReviewContext = { threadId: string; prompt: string; subject: any; expectationIds: string[] };
/** Returns the ```morrow-verification``` payload of an independent review turn. */
export type ReviewerPolicy = (context: ReviewContext) => unknown;

export type TurnRecord = {
  index: number;
  runId: string;
  source: string;
  promptBytes: number;
  /** The `state` of the turn's `morrow-next` block, or `error` when the policy threw. */
  decision: string;
  error?: string;
};
export type CallRecord = {
  runId: string;
  operation: string;
  requestId: string;
  status: number;
  /** First 12 hex characters of sha256 over the serialized input. */
  input: string;
};

export type ScriptedNativeOptions = {
  /** The service data directory; the transport reads `runs/<id>/agent-context.json` from it. */
  home: string;
  /** The project directory the scheduled thread is bound to. */
  projectPath: string;
  scenario: PolicyScenario;
  turnPolicy: TurnPolicy;
  /** Defaults to `FakeReviewer`'s consistency report. */
  reviewerPolicy?: ReviewerPolicy;
  /** Account usage the backend reports; `undefined` keeps `readUsage` off the transport. */
  readUsage?: () => Promise<UsageReading | undefined>;
  memory?: PolicyMemory;
};

const digest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex')
    .slice(0, 12);

/**
 * One native protocol double playing both roles `startServer({nativeTransport})` hands the same
 * transport: the scheduled Codex backend of the bound channel, and the independent review backend.
 * No model, user repository or network is involved — a scheduled turn runs the configured turn
 * policy, which drives the real `/api/agent` work interface over loopback with the run's own grant.
 */
export class ScriptedNativeTransport extends FakeReviewer {
  /** The thread the project's channel binds to; every other thread id is an independent review. */
  readonly threadId = randomUUID();
  readonly options: ScriptedNativeOptions;
  readonly memory: PolicyMemory;
  readonly turns: TurnRecord[] = [];
  readonly calls: CallRecord[] = [];
  /** Independent review turns this transport answered. */
  reviews = 0;
  /** Chat guidance messages it acknowledged. */
  acknowledgements = 0;
  readUsage?: () => Promise<UsageReading | undefined>;
  private service?: TransportService;
  private pending = new Set<Promise<void>>();
  private commands = 0;

  constructor(options: ScriptedNativeOptions) {
    super();
    this.options = options;
    this.memory = options.memory || {};
    if (options.readUsage) this.readUsage = options.readUsage;
    this.snapshots.set(this.threadId, {
      threadId: this.threadId,
      ownerClientId: 'scripted-native',
      revision: 1,
      syncedAt: new Date().toISOString(),
      state: {
        cwd: options.projectPath,
        model: 'scripted-native-model',
        turns: [],
        requests: [],
        currentPermissions: { sandboxPolicy: { type: 'workspaceWrite' } },
      },
    });
  }

  /** Points the transport at the running service; call again after `restart()` is not needed (same handle). */
  attach(service: TransportService) {
    this.service = service;
  }

  /** Resolves once every turn started so far has finished writing to the service. */
  async settled() {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  async listThreads(cwd = '') {
    let same = false;
    try {
      same = !!cwd && realpathSync(cwd) === realpathSync(this.options.projectPath);
    } catch {
      same = false;
    }
    return same ? [{ id: this.threadId, title: '脚本化原生任务', cwd, updatedAt: Date.parse('2026-01-01') }] : [];
  }

  async sendMessage(
    threadId: string,
    text: string,
    clientMessageId = '',
    images?: Array<{ path: string }>,
    workOptions?: NativeWorkOptions
  ) {
    const response = (await super.sendMessage(threadId, text, clientMessageId, images, workOptions)) as {
      turn: { id: string };
    };
    // A real backend acknowledges the send and finishes the turn later; the caller is still inside
    // `NativeConversations.send`, so completing synchronously would race its own bookkeeping.
    this.track(this.answer(threadId, text, clientMessageId));
    return response;
  }

  close() {
    // A restart reuses this instance, so closing the service must not discard scripted state.
  }

  /**
   * Appends a completed `commandExecution` to the scheduled thread's running turn and pushes both of
   * its states through the normal subscription, which is how a prepared execution seal observes a
   * real start and completion. No command is run; the exit code and output are the ones supplied.
   */
  runCommand(command: string, reported: { exitCode?: number; output?: string } = {}) {
    const snapshot = this.snapshots.get(this.threadId)!;
    const turn = snapshot.state.turns?.[0];
    if (!turn) throw new Error('ScriptedNativeTransport.runCommand needs a turn in progress');
    const raw: Record<string, unknown> = {
      id: `scripted-command-${++this.commands}`,
      type: 'commandExecution',
      command,
      cwd: this.options.projectPath,
      status: 'inProgress',
      aggregatedOutput: '',
    };
    turn.items = [...(turn.items || []), raw];
    this.emit(this.threadId);
    Object.assign(raw, {
      status: 'completed',
      exitCode: reported.exitCode ?? 0,
      aggregatedOutput: reported.output ?? `${command} 完成`,
    });
    this.emit(this.threadId);
  }

  private track(work: Promise<void>) {
    const task = work.finally(() => this.pending.delete(task));
    this.pending.add(task);
  }

  private async answer(threadId: string, text: string, clientMessageId: string) {
    if (threadId !== this.threadId) return this.answerReview(threadId, text);
    const outbox = this.outboxFor(clientMessageId);
    if (outbox?.source === 'schedule' && outbox.runId) return this.answerScheduled(threadId, text, outbox.runId);
    this.acknowledgements++;
    this.complete(threadId, {
      items: [
        { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: '收到指导，会在当前工作中沿用。' },
      ],
    });
  }

  private answerReview(threadId: string, prompt: string) {
    this.reviews++;
    const subject = readSubject(prompt);
    const report = this.options.reviewerPolicy
      ? this.options.reviewerPolicy({ threadId, prompt, subject, expectationIds: expectationIds(subject) })
      : this.report(threadId);
    this.complete(threadId, { report });
  }

  private async answerScheduled(threadId: string, prompt: string, runId: string) {
    const index = this.turns.length;
    const record: TurnRecord = {
      index,
      runId,
      source: 'schedule',
      promptBytes: Buffer.byteLength(prompt),
      decision: '',
    };
    this.turns.push(record);
    let final = '';
    try {
      final = await this.options.turnPolicy(this.turnContext(prompt, runId));
      record.decision = decisionState(final);
    } catch (error) {
      record.decision = 'error';
      record.error = error instanceof Error ? error.message : String(error);
      final = `本轮策略执行失败：${record.error}`;
    }
    this.complete(threadId, {
      items: [{ id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: final }],
    });
  }

  private turnContext(prompt: string, runId: string): TurnContext {
    const service = this.service;
    if (!service) throw new Error('ScriptedNativeTransport.attach(service) was never called');
    const run = service.store.get('runs', runId) as Run;
    const channel = service.store.get('channels', run.channelId) as Channel;
    const project = service.store.get('projects', run.projectId) as Project;
    const grant = JSON.parse(readFileSync(join(service.home, 'runs', runId, 'agent-context.json'), 'utf8')) as {
      url: string;
      token: string;
    };
    const call: AgentCall = async (operation, input = {}, requestId = randomUUID()) => {
      const response = await fetch(grant.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation, input, requestId }),
      });
      const value = await response.json();
      this.calls.push({ runId, operation, requestId, status: response.status, input: digest(input) });
      if (!response.ok) throw new Error(`${operation} → ${response.status} ${value?.error || ''}`.trim());
      return value;
    };
    return {
      prompt,
      run,
      channel,
      project,
      grant: { token: grant.token, call },
      service,
      scenario: this.options.scenario,
      memory: this.memory,
      runCommand: (command, reported) => this.runCommand(command, reported),
    };
  }

  /** Which run a message belongs to: its outbox row, or the bound channel's own running turn. */
  private outboxFor(clientMessageId: string) {
    const service = this.service;
    if (!service) return undefined;
    const rows = service.store.all('native_outbox') as Array<{ requestId: string; runId?: string; source?: string }>;
    const byMessage = rows.find((row) => row.requestId === clientMessageId);
    if (byMessage) return byMessage;
    const binding = (service.store.all('native_bindings') as Array<{ id: string; threadId: string }>).find(
      (row) => row.threadId === this.threadId
    );
    const running = (service.store.all('runs') as Run[]).find(
      (row) => row.status === 'running' && row.source === 'morrow-schedule' && row.channelId === binding?.id
    );
    return running ? { requestId: clientMessageId, runId: running.id, source: 'schedule' } : undefined;
  }
}

/** Reads the `原始核验对象` line `WorkVerification` puts in every review prompt. */
function readSubject(prompt: string): any {
  const part = prompt.split('原始核验对象：')[1];
  if (!part) return {};
  try {
    return JSON.parse(part.split('\n')[0]);
  } catch {
    return {};
  }
}

function expectationIds(subject: any): string[] {
  return subject?.decision?.expectations?.length
    ? subject.decision.expectations.map((row: any) => row.id)
    : ['feature'];
}

function decisionState(final: string): string {
  const blocks = [...final.matchAll(/```(?:morrow|nohuman)-next\s*\n([\s\S]*?)```/g)];
  if (!blocks.length) return 'none';
  try {
    return String(JSON.parse(blocks.at(-1)![1]).state || 'none');
  } catch {
    return 'none';
  }
}

/** Serializes a `morrow-next` continuity block the way a native turn appends one. */
export function nextBlock(decision: {
  state: 'continue' | 'wait' | 'needs_input';
  focus: string;
  reason: string;
  nextStep: string;
  waitMinutes?: number;
}) {
  return '```morrow-next\n' + JSON.stringify(decision) + '\n```';
}

/** A snapshot of the scripted thread, for tests that inspect what the backend was told. */
export type ScriptedSnapshot = NativeSnapshot;

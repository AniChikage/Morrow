import { createHash } from 'node:crypto';
import { Store, now } from './store.ts';
import type { Engine } from './engine.ts';
import type { AppResumeRecord, Channel, ChannelIntent, IntentAction, Project, Run, WorkIntent } from './protocol.ts';

/** The only continuation marker the App is known to write on a turn it resumed by itself. */
export const resumeMarker = 'resume_interrupted_task';
/** A Morrow-orchestrated turn, as opposed to native chat or a turn the App itself started. */
const scheduledRun = (row: Run) => !row.source || ['morrow-schedule', 'nohuman-schedule'].includes(row.source);
const key = (threadId: string, turnId: string) =>
  createHash('sha256').update(`app-resume\0${threadId}\0${turnId}`).digest('hex');
const turnId = (turn: any) => String(turn?.turnId || turn?.id || '');
const marked = (turn: any) => turn?.params?.turnTrigger === resumeMarker;
const ended = (turn: any) => !['inProgress', 'running'].includes(String(turn?.status || ''));
const isUserItem = (item: any) => item?.type === 'userMessage' || item?.type === 'steeringUserMessage';
/**
 * Exclusions that no later snapshot can undo: the task's own turn order already says the relation is
 * ambiguous or belongs to someone else. A record carrying one of these never links or resumes again.
 * Everything else (an incomplete history page, a run row not yet projected) may be re-read.
 */
const settled = [
  'multiple-candidates',
  'intervening-turns',
  'resume-turn-claimed',
  'resume-turn-not-app-owned',
  'multi-segment-resume',
];
const appendReasons = (existing: string[], added: string[]) => [...new Set([...existing, ...added])];

/**
 * Phase one of #32: bounded recovery after the Codex App continues an interrupted turn on its own.
 *
 * Nothing here touches the App. The interrupted turn keeps its `interrupted` status and its grant
 * stays refused; the App's own continuation is only observed, never rewritten into the scheduled run
 * and never sent to. When that continuation completes and the user's intent is provably unchanged,
 * the native-interrupt pause becomes an ordinary wait and the scheduler decides when to run — with
 * every existing gate (budget, project serialization, review, working tree, upgrade drain) still in
 * force, and a brand-new grant for the next turn.
 */
export class AppResumeTracker {
  store: Store;
  engine: Engine;
  constructor(store: Store, engine: Engine) {
    this.store = store;
    this.engine = engine;
  }
  /** The channel's durable user-intent row; a channel with no row yet reads as generation 0. */
  intent(channelId: string): ChannelIntent {
    const stored = this.store.get<ChannelIntent>('channel_intents', channelId);
    if (stored) return stored;
    const time = now();
    return {
      id: channelId,
      projectId: this.store.get<Channel>('channels', channelId)?.projectId || '',
      generation: 0,
      createdAt: time,
      updatedAt: time,
    };
  }
  records(channelId: string): AppResumeRecord[] {
    return this.store.db
      .prepare("SELECT data FROM app_resumes WHERE json_extract(data,'$.channelId')=? ORDER BY rowid")
      .all(channelId)
      .map((row: any) => JSON.parse(row.data) as AppResumeRecord);
  }
  /**
   * A human acted on this channel: pause, manual run, continue, rebind, a goal/brief edit, a
   * direction or permission change, or new guidance. The generation advances and any candidate still
   * under observation is closed, so a terminal state replayed afterwards can never revive it. An
   * ordinary automatic status write never comes through here.
   */
  advance(channelId: string, action: IntentAction, reason = '') {
    const channel = this.store.get<Channel>('channels', channelId);
    if (!channel) return;
    this.store.transaction(() => {
      const current = this.intent(channelId);
      this.store.put('channel_intents', {
        ...current,
        projectId: channel.projectId,
        generation: current.generation + 1,
        lastAction: action,
        ...(reason ? { lastReason: reason.slice(0, 500) } : {}),
        ...(action === 'pause' ? { pausedAt: now() } : {}),
        updatedAt: now(),
      });
      for (const record of this.records(channelId))
        if (['observing', 'unconfirmed', 'linked'].includes(record.status))
          this.store.put('app_resumes', {
            ...record,
            status: 'kept-paused',
            exclusions: appendReasons(record.exclusions, [action === 'pause' ? 'human-pause' : `intent-${action}`]),
            updatedAt: now(),
          });
    });
  }
  /** The intent snapshot a normal orchestrated turn starts under. */
  snapshot(channel: Channel, project: Project | undefined, threadId: string): WorkIntent {
    return {
      generation: this.intent(channel.id).generation,
      autonomyEnabled: this.engine.control(channel.id).enabled,
      threadId,
      briefRevision: project?.briefRevision || 0,
      workDirection: channel.goal,
      permission: channel.permission,
      at: now(),
    };
  }
  /**
   * An orchestrated native turn ended `interrupted`. The run keeps that status; this only adds the
   * record to watch, naming whether a person paused or the native task was interrupted. A turn with
   * no intent snapshot (written before this record existed) is left exactly as it is — historical
   * pauses are never recovered in bulk.
   */
  observeInterruption(run: Run) {
    if (run.executionOwner !== 'codex-app' || !scheduledRun(run) || !run.workIntent) return;
    const intent = this.intent(run.channelId);
    // A human pause advances the generation and stamps `pausedAt`; both survive a restart, so the
    // cause is read from storage rather than from whichever call finalized the turn.
    const pausedByHuman =
      !!intent.pausedAt && intent.pausedAt >= run.startedAt
        ? true
        : intent.generation !== run.workIntent.generation && intent.lastAction === 'pause';
    const id = key(run.workIntent.threadId, run.nativeTurnId || run.id);
    const existing = this.store.get<AppResumeRecord>('app_resumes', id);
    if (existing) return;
    const time = now();
    const record: AppResumeRecord = {
      id,
      projectId: run.projectId,
      channelId: run.channelId,
      threadId: run.workIntent.threadId,
      originalRunId: run.id,
      ...(run.nativeTurnId ? { originalNativeTurnId: run.nativeTurnId } : {}),
      pauseCause: pausedByHuman ? 'human-pause' : 'native-interrupt',
      intent: run.workIntent,
      status: pausedByHuman ? 'kept-paused' : run.nativeTurnId ? 'observing' : 'unconfirmed',
      basis: [],
      exclusions: pausedByHuman ? ['human-pause'] : run.nativeTurnId ? [] : ['original-turn-unknown'],
      createdAt: time,
      updatedAt: time,
    };
    this.store.put('app_resumes', record);
    this.engine.audit({
      projectId: run.projectId,
      channelId: run.channelId,
      runId: run.id,
      actor: 'system',
      action: 'channel.app-resume-observed',
      text: pausedByHuman
        ? '本轮因人工暂停结束，不会自动接续。'
        : '本轮被原生中断结束，已记录待观察：若 App 自行续跑完成且意图未变，下一轮再核对其工作。',
      after: { pauseCause: record.pauseCause, status: record.status },
    });
  }
  /**
   * Reads the bound task's own turn order and decides, for every record still open on this task,
   * whether one App-started turn continues the interrupted one — and, once that turn has completed,
   * whether the conditions for returning to ordinary scheduling all hold. Read-only with respect to
   * the native task: no message, resend or interrupt is ever issued from here.
   *
   * `turns` is the task's turn list in task order and `complete` says whether the history is whole;
   * both are computed by the caller that already read the snapshot.
   */
  observe(threadId: string, turns: any[], complete: boolean) {
    // Selected on the task index rather than by filtering the whole table: this runs on every
    // native snapshot the service ingests.
    for (const record of this.onThread(threadId).filter((row) =>
      ['observing', 'unconfirmed', 'linked'].includes(row.status)
    ))
      this.step(record, turns, complete);
  }
  /** Every record about one native task, in the order they were written. */
  private onThread(threadId: string): AppResumeRecord[] {
    return this.store.db
      .prepare("SELECT data FROM app_resumes WHERE json_extract(data,'$.threadId')=? ORDER BY rowid")
      .all(threadId)
      .map((row: any) => JSON.parse(row.data) as AppResumeRecord);
  }
  private write(record: AppResumeRecord, fields: Partial<AppResumeRecord>) {
    const next = { ...record, ...fields, updatedAt: now() };
    this.store.put('app_resumes', next);
    return next;
  }
  private keep(record: AppResumeRecord, exclusions: string[], status: AppResumeRecord['status'] = 'unconfirmed') {
    return this.write(record, { status, exclusions: appendReasons(record.exclusions, exclusions) });
  }
  private step(record: AppResumeRecord, turns: any[], complete: boolean) {
    // An ambiguity the task's own order already established is never re-read.
    if (record.exclusions.some((reason) => settled.includes(reason))) return;
    const binding = this.store.get<{ id: string; threadId: string }>('native_bindings', record.channelId);
    if (!binding || binding.threadId !== record.threadId) return this.keep(record, ['binding-changed'], 'kept-paused');
    if (!record.originalNativeTurnId) return this.keep(record, ['original-turn-unknown']);
    // A partial history page cannot prove which turn came first, so nothing is linked from it; the
    // next complete snapshot is read again.
    if (!complete) return this.keep(record, ['native-history-incomplete']);
    const originalIndex = turns.findIndex((turn) => turnId(turn) === record.originalNativeTurnId);
    if (originalIndex < 0) return this.keep(record, ['original-turn-not-in-history']);
    const after = turns.slice(originalIndex + 1);
    if (!after.length) return;
    const markers = after.filter(marked);
    if (markers.length > 1) return this.keep(record, ['multiple-candidates', 'multi-segment-resume']);
    if (!marked(after[0]))
      return this.keep(record, markers.length ? ['intervening-turns'] : ['no-resume-marker', 'intervening-turns']);
    const candidate = after[0];
    const candidateTurnId = turnId(candidate);
    if (!candidateTurnId) return this.keep(record, ['resume-turn-unidentified']);
    if (
      this.onThread(record.threadId).some((row) => row.id !== record.id && row.resumeNativeTurnId === candidateTurnId)
    )
      return this.keep(record, ['resume-turn-claimed']);
    const run = this.runOf(record.channelId, candidateTurnId);
    if (!run) return this.keep(record, ['resume-run-missing']);
    // The App's own turn keeps its `native-app` origin. A turn Morrow sent, or one a person sent
    // through the chat, is not the App continuing by itself.
    if (run.source !== 'native-app') return this.keep(record, ['resume-turn-not-app-owned'], 'kept-paused');
    const linked = this.write(record, {
      status: 'linked',
      relation: 'inferred-sequence',
      resumeRunId: run.id,
      resumeNativeTurnId: candidateTurnId,
      marker: resumeMarker,
      basis: appendReasons(record.basis, [
        resumeMarker,
        'same-thread-binding',
        'adjacent-turn-order',
        'complete-native-history',
      ]),
    });
    if (record.status !== 'linked')
      this.engine.audit({
        projectId: record.projectId,
        channelId: record.channelId,
        runId: record.originalRunId,
        actor: 'system',
        action: 'channel.app-resume-linked',
        text: 'App 自行续跑了本频道被中断的那一轮（按任务内轮次顺序推断，非明确父子关系）。本轮只观察，不改写原记录。',
        after: {
          relation: 'inferred-sequence',
          originalRunId: record.originalRunId,
          originalNativeTurnId: record.originalNativeTurnId,
          resumeRunId: run.id,
          resumeNativeTurnId: candidateTurnId,
          marker: resumeMarker,
        },
      });
    if (!ended(candidate)) return;
    if (candidate.status !== 'completed')
      return this.keep(
        linked,
        [candidate.status === 'interrupted' ? 'resume-turn-interrupted' : 'resume-turn-failed'],
        'kept-paused'
      );
    // Anything a person typed from the interruption onwards, including steering inside the App's own
    // turn, is newer guidance than the plan this record would restore.
    this.restore(linked, turns.slice(originalIndex + 1));
  }
  private runOf(channelId: string, nativeTurnId: string): Run | undefined {
    const row = this.store.db
      .prepare(
        "SELECT data FROM runs WHERE json_extract(data,'$.channelId')=? AND json_extract(data,'$.nativeTurnId')=? ORDER BY rowid DESC LIMIT 1"
      )
      .get(channelId, nativeTurnId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Run) : undefined;
  }
  /**
   * Turns the native-interrupt pause into an ordinary wait, once. Nothing about the finished App
   * turn is trusted as work already checked: the next scheduled turn gets its own grant and has to
   * read the native history, the files and the board itself before deciding anything.
   */
  private restore(record: AppResumeRecord, later: any[]) {
    // `later` is the continuation turn and everything after it, in task order.
    const channel = this.store.get<Channel>('channels', record.channelId);
    if (!channel) return;
    const project = this.store.get<Project>('projects', record.projectId);
    const intent = this.intent(record.channelId);
    const reasons: string[] = [];
    if (!record.intent.autonomyEnabled) reasons.push('autonomy-was-off');
    if (record.pauseCause !== 'native-interrupt') reasons.push('human-pause');
    if (intent.generation !== record.intent.generation) reasons.push('intent-generation-changed');
    if (channel.goal !== record.intent.workDirection) reasons.push('direction-changed');
    if ((project?.briefRevision || 0) !== record.intent.briefRevision) reasons.push('brief-changed');
    if (channel.permission !== record.intent.permission) reasons.push('permission-changed');
    if (channel.work?.awaitingReply) reasons.push('question-awaiting-reply');
    // A person steering the task during or after the App's continuation is the newer instruction;
    // the next step is theirs to give, not ours to schedule.
    if (later.some((turn) => (turn.items || []).some(isUserItem))) reasons.push('later-guidance');
    if (
      this.store
        .all<{ threadId: string; status: string; type: string }>('native_requests')
        .some(
          (row) =>
            row.threadId === record.threadId && row.status === 'pending' && ['userInput', 'mcp'].includes(row.type)
        )
    )
      reasons.push('native-question-pending');
    if (reasons.length) {
      this.keep(record, reasons, 'kept-paused');
      return;
    }
    this.store.transaction(() => {
      // Re-read inside the transaction: a human pause that lands between the checks above and this
      // write must win, and a terminal state processed twice must apply at most once.
      const fresh = this.store.get<AppResumeRecord>('app_resumes', record.id);
      if (!fresh || fresh.appliedAt || fresh.status !== 'linked') return;
      const live = this.intent(record.channelId);
      const current = this.store.get<Channel>('channels', record.channelId);
      if (live.generation !== record.intent.generation) {
        this.keep(fresh, ['intent-generation-changed'], 'kept-paused');
        return;
      }
      if (!current || current.status !== 'paused' || this.engine.control(record.channelId).enabled) {
        this.keep(fresh, ['channel-no-longer-paused'], 'kept-paused');
        return;
      }
      this.engine.setControl(record.channelId, { enabled: true });
      this.store.put('channels', {
        ...current,
        status: 'waiting',
        nextRunAt: new Date(Date.now() + 5000).toISOString(),
      });
      this.write(fresh, { status: 'resumed', appliedAt: now() });
      this.engine.audit({
        projectId: record.projectId,
        channelId: record.channelId,
        runId: record.originalRunId,
        actor: 'system',
        action: 'channel.app-resume-restored',
        text: 'App 续跑完成，下一轮核对其工作；已恢复为普通等待，由调度器决定何时运行。',
        after: {
          originalRunId: record.originalRunId,
          resumeRunId: record.resumeRunId,
          resumeNativeTurnId: record.resumeNativeTurnId,
          relation: 'inferred-sequence',
        },
      });
    });
  }
}

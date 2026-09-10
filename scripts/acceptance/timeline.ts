import { randomUUID } from 'node:crypto';
import type { Scenario, Step, TimelineRecord } from './scenario.ts';
import type { ScriptedNativeTransport } from '../../tests/harness/scripted-native.ts';
import type { Receiver } from '../../tests/harness/receiver.ts';
import type { IsolatedService } from '../../tests/harness/service.ts';
import type { Channel, Run } from '../../service/protocol.ts';
import type { FeedbackWatch, Release } from '../../service/autonomy-types.ts';

/** Virtual clock the runner owns; `Date` is mocked, so every service timestamp follows it. */
export type Clock = { now(): string; advance(minutes: number): void };

export type Runner = {
  scenario: Scenario;
  service: IsolatedService;
  transport: ScriptedNativeTransport;
  receiver: Receiver;
  clock: Clock;
  /** Scheduled turns the run may still spend. */
  turnBudget: number;
};

/** How long a step waits for the service, measured on the real clock (`Date` is virtual). */
const stepTimeoutMs = 20_000;
/** Watches are only polled by an explicit `poll` step; see `parkWatches`. */
const parkMs = 365 * 24 * 3600_000;

export async function runStep(runner: Runner, step: Step, index: number): Promise<TimelineRecord> {
  const { verb, ...args } = step;
  const record: TimelineRecord = {
    index,
    verb,
    args: args as Record<string, unknown>,
    virtualTime: runner.clock.now(),
    result: {},
  };
  record.result = await execute(runner, step);
  return record;
}

async function execute(runner: Runner, step: Step): Promise<Record<string, unknown>> {
  switch (step.verb) {
    case 'turn':
      return turn(runner);
    case 'poll':
      return poll(runner);
    case 'set':
      runner.receiver.setFeedback(step.value);
      return { truth: step.truth || 'none', value: step.value };
    case 'mode':
      runner.receiver.setMode(step.mode);
      return { mode: step.mode };
    case 'approve':
      return decide(runner, 'approve');
    case 'reject':
      return decide(runner, 'reject', step.feedback);
    case 'guide':
      return guide(runner, step.text);
    case 'verify':
      return verify(runner);
    case 'restart':
      return restart(runner);
    case 'pause':
      await runner.service.engine.action(channelId(runner), 'pause');
      return { enabled: runner.service.engine.control(channelId(runner)).enabled };
    case 'resume':
      return resume(runner);
    case 'advance':
      runner.clock.advance(step.minutes);
      return { minutes: step.minutes, virtualTime: runner.clock.now() };
  }
}

const channelId = (runner: Runner) => runner.service.channel.id;
const channelRow = (runner: Runner) => runner.service.store.get<Channel>('channels', channelId(runner))!;
const runs = (runner: Runner) =>
  runner.service.store.all<Run>('runs').filter((row) => row.channelId === channelId(runner));

/**
 * Runs one scheduled turn the way the daemon would: make the channel due, then hand the tick to the
 * real scheduler so its daily budget, reviewer wait, project serialization and usage gates all apply.
 */
async function turn(runner: Runner): Promise<Record<string, unknown>> {
  if (runner.turnBudget <= 0)
    throw new Error(`turn budget of ${runner.scenario.budget.turns} turns is exhausted; the run fails`);
  runner.turnBudget--;
  parkWatches(runner);
  const before = new Set(runs(runner).map((row) => row.id));
  const channel = channelRow(runner);
  runner.service.store.put('channels', {
    ...channel,
    status: 'waiting',
    nextRunAt: new Date(Date.now() - 1000).toISOString(),
  });
  runner.service.engine.tick();
  const started = await waitFor(
    () => runs(runner).find((row) => !before.has(row.id) && row.source === 'morrow-schedule'),
    () => `a scheduled run to start (${gateDetail(runner)})`
  );
  const finished = await waitFor(
    () => {
      const row = runner.service.store.get<Run>('runs', started.id)!;
      return row.status === 'running' ? undefined : row;
    },
    () => `run ${started.id} to finish (status ${runner.service.store.get<Run>('runs', started.id)?.status})`
  );
  await runner.transport.settled();
  await drain(runner);
  const turnRecord = runner.transport.turns.at(-1);
  if (turnRecord?.error) throw new Error(`turn policy failed: ${turnRecord.error}`);
  return {
    runId: finished.id,
    status: finished.status,
    reportStatus: finished.reportStatus,
    decision: turnRecord?.decision || 'none',
    channelStatus: channelRow(runner).status,
  };
}

/**
 * Polls every live watch through the loop's own entry point. Fixture runs own observation timing:
 * `parkWatches` keeps the scheduler's own polling out of the way so a sample is taken only here.
 */
async function poll(runner: Runner): Promise<Record<string, unknown>> {
  const before = runner.service.store.all('loop_evidence').length;
  const live = runner.service.store
    .all<FeedbackWatch>('loop_watches')
    .filter((row) => row.status !== 'cancelled' && (row.status === 'watching' || row.continuous !== false));
  for (const watch of live) await runner.service.engine.loop.poll(watch.id);
  await drain(runner);
  parkWatches(runner);
  return {
    polled: live.length,
    evidence: runner.service.store.all('loop_evidence').length - before,
    statuses: live.map((row) => runner.service.store.get<FeedbackWatch>('loop_watches', row.id)?.status),
  };
}

async function decide(runner: Runner, decision: 'approve' | 'reject', feedback?: string) {
  const release = runner.service.store
    .all<Release>('loop_releases')
    .filter((row) => row.status === 'awaiting_approval')
    .at(-1);
  if (!release) throw new Error(`no release is awaiting approval; cannot ${decision}`);
  await runner.service.api('POST', `/api/releases/${release.id}/review`, {
    reviewHash: release.reviewHash,
    decision,
    ...(feedback === undefined ? {} : { feedback }),
  });
  await drain(runner);
  const settled = await waitFor(
    () => {
      const row = runner.service.store.get<Release>('loop_releases', release.id)!;
      return ['approved', 'publishing'].includes(row.status) ? undefined : row;
    },
    () => `release ${release.id} to settle (${runner.service.store.get<Release>('loop_releases', release.id)?.status})`
  );
  return { releaseId: release.id, status: settled.status, posts: runner.receiver.posts };
}

async function guide(runner: Runner, text: string) {
  const receipt = await runner.service.api('POST', `/api/channels/${channelId(runner)}/native/messages`, {
    text,
    requestId: randomUUID(),
  });
  await runner.transport.settled();
  return { state: receipt.state, acknowledgements: runner.transport.acknowledgements };
}

/** Drives whatever independent review is queued to a verdict, then applies its saved finalization. */
async function verify(runner: Runner) {
  const verification = runner.service.engine.loop.verification;
  const pending = () =>
    runner.service.store.all<any>('loop_verifications').filter((row) => ['queued', 'running'].includes(row.status))
      .length;
  if (!pending()) return { reviews: runner.transport.reviews, pending: 0, note: 'nothing queued' };
  for (let pass = 0; pass < 4 && pending(); pass++) {
    verification.tick();
    await drain(runner);
    await runner.transport.settled();
  }
  // A passed review still has to settle the request it was gating.
  verification.tick();
  await drain(runner);
  await waitFor(
    () => (pending() ? undefined : true),
    () => `independent reviews to settle (${pending()} still queued or running)`
  );
  const rows = runner.service.store.all<any>('loop_verifications');
  return {
    reviews: runner.transport.reviews,
    verdicts: rows.map((row) => row.status),
    finalizations: runner.service.store.all<any>('loop_finalizations').map((row) => row.status),
  };
}

async function restart(runner: Runner) {
  await drain(runner);
  await runner.service.restart();
  stopScheduler(runner.service);
  runner.transport.attach(runner.service);
  return {
    port: runner.service.port,
    channelStatus: channelRow(runner).status,
    running: runs(runner).filter((row) => row.status === 'running').length,
  };
}

function resume(runner: Runner) {
  runner.service.engine.setControl(channelId(runner), { enabled: true });
  const channel = channelRow(runner);
  runner.service.store.put('channels', { ...channel, status: 'waiting' });
  return { enabled: runner.service.engine.control(channelId(runner)).enabled };
}

/**
 * Stops the daemon's own one-second loop. Every gate still runs — the runner calls `engine.tick()`
 * itself — but no turn, poll or publication happens at a moment the timeline did not ask for.
 */
export function stopScheduler(service: IsolatedService) {
  if (service.engine.timer) clearInterval(service.engine.timer);
  service.engine.timer = undefined;
}

/** Pushes every live watch's next poll far out, so only a `poll` step collects a sample. */
export function parkWatches(runner: Runner) {
  const parked = new Date(Date.now() + parkMs).toISOString();
  for (const watch of runner.service.store.all<FeedbackWatch>('loop_watches'))
    if (watch.status !== 'cancelled' && watch.nextPollAt !== parked)
      runner.service.store.put('loop_watches', { ...watch, nextPollAt: parked });
}

/** Waits for the loop's tracked background work (publications, polls, reviews) to come to rest. */
export async function drain(runner: Pick<Runner, 'service'>) {
  const loop = runner.service.engine.loop;
  for (let pass = 0; pass < 20 && loop.pending.size; pass++) await Promise.allSettled([...loop.pending]);
}

/**
 * Polls `predicate` on the real clock. `until` in the harness measures with `Date.now`, which the
 * virtual clock freezes, so a fixture run needs its own timeout source.
 */
export async function waitFor<T>(predicate: () => T | Promise<T>, label: () => string, timeoutMs = stepTimeoutMs) {
  const end = performance.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value as NonNullable<T>;
    if (performance.now() >= end) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label()}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Why the scheduler may have parked a turn instead of starting it. */
function gateDetail(runner: Runner) {
  const channel = channelRow(runner);
  const reviews = runner.service.store
    .all<any>('loop_verifications')
    .filter((row) => ['queued', 'running'].includes(row.status)).length;
  const today = new Date().toISOString().slice(0, 10);
  return [
    `enabled=${runner.service.engine.control(channel.id).enabled}`,
    `status=${channel.status}`,
    `nextRunAt=${channel.nextRunAt}`,
    `runsToday=${runner.service.store.runCount(channel.id, today)}/${channel.maxRunsPerDay}`,
    `reviewsPending=${reviews}`,
    channel.usageWait ? `usageWait=${JSON.stringify(channel.usageWait)}` : 'usageWait=none',
  ].join(' ');
}

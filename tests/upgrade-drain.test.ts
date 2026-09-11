import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { UpgradeBlocker, UpgradeRecord } from '../service/upgrade.ts';
import { upgradeExitCode, upgradeReminderMs } from '../service/upgrade.ts';
import { startInstalledFixture } from './harness/release.ts';
import type { InstalledFixture } from './harness/release.ts';
import { pause, until } from './harness/wait.ts';

const installed = 'b'.repeat(64);
const switching = /新版本已安装|正在切换到新版本/;
const record = (fixture: InstalledFixture) => fixture.s.store.all<UpgradeRecord>('upgrades').at(-1)!;
/** Collects the exits this service would perform, instead of closing the test process's own service. */
function captureExit(fixture: InstalledFixture) {
  const exits: UpgradeRecord[] = [];
  fixture.s.engine.upgrade.beginExit = (row) => exits.push(row);
  return exits;
}

test('while a switch waits, every entry point that would start work is refused and names it', async () => {
  const fixture = await startInstalledFixture();
  const { s } = fixture;
  try {
    captureExit(fixture);
    await fixture.install(installed);
    assert.equal(record(fixture).phase, 'pending');
    const refused = async (method: string, url: string, body?: unknown) => {
      const value = await s.api(method, url, body, 409);
      assert.match(value.error, switching, url);
      return value;
    };
    // Manual run and resume: the person hears why, and the channel is not started.
    await refused('POST', `/api/channels/${s.channel.id}/action`, { action: 'run' });
    await refused('POST', `/api/channels/${s.channel.id}/action`, { action: 'resume' });
    // A chat message would start a native turn.
    await refused('POST', `/api/channels/${s.channel.id}/native/messages`, { text: '继续', requestId: 'r-1' });
    // New reviews, retries and new publications, through the work grant and the desktop credential.
    const review = await s.call(
      'verification.request',
      { itemId: fixture.s.feature.id, evidenceIds: [] },
      undefined,
      409
    );
    assert.match(review.error, switching);
    const retry = await s.call('verification.retry', { id: randomUUID() }, undefined, 409);
    assert.match(retry.error, switching);
    const next = await s.call('release.propose', { ...s.local(), title: '切换期间的新发布' });
    await refused('POST', `/api/releases/${next.id}/review`, { reviewHash: next.reviewHash, decision: 'approve' });
    assert.equal(s.engine.loop.release(next.id).status, 'awaiting_approval');
    await refused('POST', `/api/releases/${next.id}/reconcile`, {});
    // Existing work keeps its controls: pause, reads, and answering the task's own questions.
    await s.api('POST', `/api/channels/${s.channel.id}/action`, { action: 'pause' });
    assert.equal((await s.api('GET', '/api/state')).channels.length, 1);
    assert.equal((await s.call('context', {})).project.id, s.project.id);
    const interrupt = await s.api('POST', `/api/channels/${s.channel.id}/native/interrupt`, { turnId: 'turn-1' }, 409);
    assert.doesNotMatch(interrupt.error, switching);
    const respond = await s.api(
      'POST',
      `/api/channels/${s.channel.id}/native/respond`,
      { requestId: 'request-1', response: {} },
      409
    );
    assert.doesNotMatch(respond.error, switching);
    // Declining a release starts no work, so it stays available.
    const declined = await s.call('release.propose', { ...s.local(), title: '切换期间可以否决' });
    await s.api('POST', `/api/releases/${declined.id}/review`, {
      reviewHash: declined.reviewHash,
      decision: 'reject',
      feedback: '等切换完成后再看',
    });
    assert.equal(s.engine.loop.release(declined.id).status, 'rejected');
  } finally {
    await fixture.cleanup();
  }
});

test('a scheduled turn parks and re-checks instead of being refused, with one event per switch', async () => {
  const fixture = await startInstalledFixture();
  const { s } = fixture;
  try {
    captureExit(fixture);
    await fixture.install(installed);
    s.engine.setControl(s.channel.id, { enabled: true });
    s.store.put('channels', { ...s.store.get('channels', s.channel.id)!, nextRunAt: new Date(0).toISOString() });
    s.engine.tick();
    s.engine.tick();
    const channel = s.store.get<any>('channels', s.channel.id);
    assert.equal(channel.status, 'waiting');
    assert(channel.nextRunAt > new Date().toISOString());
    // Nothing was started, and the channel said why exactly once.
    assert.deepEqual(
      s.store.all<any>('runs').filter((row) => row.trigger === 'schedule'),
      []
    );
    const announcements = s.store
      .all<any>('events')
      .filter((row) => row.channelId === s.channel.id && row.text.includes('本频道等待当前工作结束'));
    assert.equal(announcements.length, 1);
    // Repeated ticks keep the channel parked without repeating themselves.
    s.store.put('channels', { ...s.store.get('channels', s.channel.id)!, nextRunAt: new Date(0).toISOString() });
    s.engine.tick();
    assert.equal(s.store.all<any>('events').filter((row) => row.text.includes('本频道等待当前工作结束')).length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('work already running is never interrupted: the switch waits for it and only then steps aside', async () => {
  const fixture = await startInstalledFixture();
  const { s } = fixture;
  try {
    const exits = captureExit(fixture);
    // A publication is in flight before the switch is requested: it keeps running.
    const slow = await s.call('release.propose', { ...s.local(['sleep'], { timeoutSeconds: 1 }), title: '正在发布' });
    await s.api('POST', `/api/releases/${slow.id}/review`, { reviewHash: slow.reviewHash, decision: 'approve' });
    await until(() => s.engine.loop.release(slow.id).status === 'publishing');
    // The receipt cannot arrive through this publication, so the request is recorded as one would be.
    s.store.put('upgrades', {
      id: installed,
      releaseId: slow.id,
      targetCommit: 'c'.repeat(40),
      targetFingerprint: installed,
      installedBundle: fixture.bundlePath,
      fromBootId: fixture.identity.bootId,
      phase: 'pending',
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies UpgradeRecord);
    s.engine.upgrade.tick();
    assert.equal(record(fixture).phase, 'draining');
    const blockers = s.engine.workBlockers();
    assert.deepEqual(
      blockers.map((blocker: UpgradeBlocker) => blocker.kind),
      ['publication']
    );
    assert.equal(s.engine.upgrade.state().idle, false);
    // Acknowledged but still busy: nothing exits, and the running publication is left alone.
    s.engine.upgrade.acknowledge({ fromBootId: fixture.identity.bootId, targetFingerprint: installed });
    s.engine.upgrade.tick();
    assert.deepEqual(exits, []);
    assert.equal(s.engine.loop.release(slow.id).status, 'publishing');
    // `publish` clears the in-flight release in its own `finally`; only then is the service idle.
    await until(() => s.engine.loop.release(slow.id).status === 'unknown');
    await until(() => s.engine.upgrade.state().idle);
    s.engine.upgrade.tick();
    assert.equal(exits.length, 1);
    assert.equal(exits[0].phase, 'exiting');
    assert.equal(record(fixture).phase, 'exiting');
    assert.equal(s.engine.upgrade.exiting, true);
  } finally {
    await fixture.cleanup();
  }
});

test('an approved publication is not started while a switch waits, and no script runs', async () => {
  const fixture = await startInstalledFixture();
  const { s } = fixture;
  try {
    captureExit(fixture);
    await fixture.install(installed);
    // Approved before the switch, but never started: the new daemon publishes it after the restart.
    const waiting = await s.call('release.propose', { ...s.local(), title: '批准后等待切换' });
    s.store.put('loop_releases', { ...s.engine.loop.release(waiting.id), status: 'approved' });
    s.engine.loop.tick();
    await Promise.allSettled([...s.engine.loop.pending]);
    assert.equal(s.engine.loop.release(waiting.id).status, 'approved');
    assert.equal(existsSync(join(s.home, 'releases', waiting.id, 'env.txt')), false);
    assert.equal(s.engine.upgrade.state().idle, true);
  } finally {
    await fixture.cleanup();
  }
});

test('the reminder deadline records what is still running and never stops it', async () => {
  const fixture = await startInstalledFixture();
  const { s } = fixture;
  try {
    const exits = captureExit(fixture);
    await fixture.install(installed);
    let busy: UpgradeBlocker[] = [{ kind: 'native', label: '频道「系统完善」原生轮次进行中' }];
    s.engine.upgrade.blockersOf = () => busy;
    s.engine.upgrade.acknowledge({ fromBootId: fixture.identity.bootId, targetFingerprint: installed });
    s.engine.upgrade.tick();
    // Before the deadline the record stays quiet; the live state already reports the blockers.
    assert.equal(record(fixture).blockers, undefined);
    assert.deepEqual(s.engine.upgrade.state().blockers, busy);
    s.store.put('upgrades', {
      ...record(fixture),
      requestedAt: new Date(Date.now() - upgradeReminderMs - 1000).toISOString(),
    });
    s.engine.upgrade.tick();
    assert.deepEqual(record(fixture).blockers, busy);
    assert(record(fixture).remindedAt);
    // A reminder, not a kill deadline: the phase is unchanged, nothing exited, the work is untouched.
    assert.equal(record(fixture).phase, 'draining');
    assert.deepEqual(exits, []);
    busy = [];
    s.engine.upgrade.tick();
    assert.deepEqual(record(fixture).blockers, []);
    assert.equal(exits.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('the restart handshake is bound to this boot and this target, and is idempotent', async () => {
  const fixture = await startInstalledFixture();
  const { s } = fixture;
  try {
    const exits = captureExit(fixture);
    await fixture.install(installed);
    const body = { fromBootId: fixture.identity.bootId, targetFingerprint: installed };
    // The work grant cannot reach the handshake at all.
    await s.api('POST', '/api/upgrade/restart', body, 401, s.grant.token);
    await s.api('POST', '/api/upgrade/acknowledge', body, 401, s.grant.token);
    const wrongBoot = await s.api('POST', '/api/upgrade/restart', { ...body, fromBootId: 'other-boot' }, 409);
    assert.match(wrongBoot.error, /其他启动实例/);
    const wrongTarget = await s.api(
      'POST',
      '/api/upgrade/restart',
      { ...body, targetFingerprint: 'f'.repeat(64) },
      409
    );
    assert.match(wrongTarget.error, /目标版本/);
    await s.api('POST', '/api/upgrade/restart', { ...body, extra: 1 }, 400);
    assert.deepEqual(exits, []);
    // Busy: the button refuses and names the work instead of interrupting it.
    s.engine.upgrade.blockersOf = () => [{ kind: 'run', label: '频道「系统完善」正在执行' }];
    const busy = await s.api('POST', '/api/upgrade/restart', body, 409);
    assert.match(busy.error, /仍有工作在进行，不会中断：频道「系统完善」正在执行/);
    assert.deepEqual(exits, []);
    // Idle: the same handshake, requested early. Repeating it changes nothing.
    s.engine.upgrade.blockersOf = () => [];
    const first = await s.api('POST', '/api/upgrade/restart', body);
    assert.equal(first.upgrade.phase, 'exiting');
    assert(first.upgrade.acknowledgedAt);
    const again = await s.api('POST', '/api/upgrade/restart', body);
    assert.equal(again.upgrade.phase, 'exiting');
    assert.equal(exits.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('a failed handover keeps its reason and can be retried by hand without another release', async () => {
  const fixture = await startInstalledFixture();
  const { s } = fixture;
  try {
    const exits = captureExit(fixture);
    const release = await fixture.install(installed);
    const body = { fromBootId: fixture.identity.bootId, targetFingerprint: installed };
    const blocked = await s.api('POST', '/api/upgrade/blocked', { ...body, reason: '等待旧服务退出超时' });
    assert.equal(blocked.upgrade.phase, 'blocked');
    assert.equal(blocked.upgrade.error, '等待旧服务退出超时');
    // A blocked switch no longer holds back work: the refusals are lifted.
    assert.equal(s.engine.upgrade.draining(), false);
    await s.api('POST', `/api/channels/${s.channel.id}/action`, { action: 'pause' });
    // Retrying re-checks identity and target rather than running the release script again.
    const retried = await s.api('POST', '/api/upgrade/restart', body);
    assert.equal(retried.upgrade.phase, 'exiting');
    assert.equal(retried.upgrade.error, undefined);
    assert.equal(exits.length, 1);
    assert.equal(s.engine.loop.release(release.id).status, 'published');
    assert.equal(s.posts, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('an acknowledged idle daemon leaves with exit code 75, records it and releases its lock', async () => {
  const home = mkdtempSync(join(tmpdir(), 'morrow-daemon-'));
  const bundlePath = join(home, 'Morrow.app');
  mkdirSync(join(bundlePath, 'Contents', 'Resources'), { recursive: true });
  const server = fileURLToPath(new URL('../service/server.ts', import.meta.url));
  const child = spawn(process.execPath, [server], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MORROW_HOME: home,
      MORROW_PORT: '0',
      MORROW_TEST_MODE: '1',
      MORROW_TEST_CODEX_PATH: process.env.MORROW_TEST_CODEX_PATH,
      MORROW_BUILD_IDENTITY: JSON.stringify({
        commit: 'd'.repeat(40),
        version: '0.9.6',
        fingerprint: 'a'.repeat(64),
        bundlePath,
      }),
    } as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal }))
  );
  try {
    const port = Number(await until(() => output.match(/127\.0\.0\.1:(\d+)/)?.[1], 20000));
    const token = readFileSync(join(home, 'token'), 'utf8').trim();
    const api = async (path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json() };
    };
    const state = await api('upgrade');
    assert.equal(state.data.identity.bundlePath, bundlePath);
    assert.equal(state.data.exitCode, upgradeExitCode);
    const bootId = state.data.identity.bootId as string;
    // The request a published receipt would have written. This daemon runs no release of its own.
    const database = new DatabaseSync(join(home, 'workspace.sqlite'));
    database.exec('PRAGMA busy_timeout=5000');
    database.prepare('INSERT INTO upgrades (id,data) VALUES (?,?)').run(
      installed,
      JSON.stringify({
        id: installed,
        releaseId: 'release-under-test',
        targetCommit: 'c'.repeat(40),
        targetFingerprint: installed,
        installedBundle: bundlePath,
        fromBootId: bootId,
        phase: 'pending',
        requestedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    );
    database.close();
    // The daemon notices it, starts draining, and keeps serving until a local app takes over.
    await until(async () => (await api('upgrade')).data.upgrade?.phase === 'draining', 10000);
    await pause(1500);
    assert.equal(child.exitCode, null);
    const acknowledged = await api('upgrade/acknowledge', { fromBootId: bootId, targetFingerprint: installed });
    assert.equal(acknowledged.status, 200);
    const outcome = await Promise.race([exited, pause(20000).then(() => undefined)]);
    assert.deepEqual(outcome, { code: upgradeExitCode, signal: null }, output);
    // The lock is released for the next daemon, and the record says what happened.
    assert.equal(existsSync(join(home, 'daemon.lock')), false);
    const closed = new DatabaseSync(join(home, 'workspace.sqlite'), { readOnly: true });
    const row = JSON.parse(
      (closed.prepare('SELECT data FROM upgrades WHERE id=?').get(installed) as { data: string }).data
    ) as UpgradeRecord;
    closed.close();
    assert.equal(row.phase, 'exiting');
    assert(row.acknowledgedAt);
    assert.doesNotMatch(output, /Error|failed/i);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await Promise.race([exited, pause(3000)]);
    rmSync(home, { recursive: true, force: true });
  }
});

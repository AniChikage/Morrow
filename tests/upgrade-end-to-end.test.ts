import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { UpgradeRecord } from '../service/upgrade.ts';
import { startInstalledFixture } from './harness/release.ts';
import { until } from './harness/wait.ts';

const target = 'b'.repeat(64);
const targetCommit = 'c'.repeat(40);

/**
 * The whole switch in one isolated service: a published receipt that installed a new build over this
 * daemon's own bundle, the wait for real idleness, the handover, and a fresh daemon on the new build
 * that marks the request applied and finishes the publication that the switch interrupted — from its
 * receipt file, without running the release script a second time. Nothing is built or installed, no
 * process is signalled, and this test never touches the machine's own Morrow.
 */
test('a published receipt reaches a new daemon that applies it and reconciles the interrupted publication', async () => {
  const fixture = await startInstalledFixture();
  let s = fixture.s;
  try {
    const exits: UpgradeRecord[] = [];
    s.engine.upgrade.beginExit = (row) => exits.push(row);
    // A publication whose receipt file exists but whose outcome was never confirmed: exactly what a
    // switch during publication leaves behind.
    const interrupted = await s.call('release.propose', { ...s.local(['quiet']), title: '切换前未确认的发布' });
    await s.approve(interrupted);
    assert.equal(s.engine.loop.release(interrupted.id).status, 'unknown');
    const receiptPath = join(s.home, 'releases', interrupted.id, 'receipt.json');
    const scriptRun = join(s.home, 'releases', interrupted.id, 'env.txt');
    assert(existsSync(receiptPath));
    const ranAt = statSync(scriptRun).mtimeMs;

    // The installing publication: its receipt names this daemon's own bundle and a new fingerprint.
    const installing = await fixture.install(target, targetCommit);
    assert.equal(installing.status, 'published');
    const requested = s.store.all<UpgradeRecord>('upgrades')[0];
    assert.equal(requested.targetFingerprint, target);
    assert(['pending', 'draining'].includes(requested.phase));
    // New work is refused while the switch waits; the publication left unconfirmed is not retried.
    const refused = await s.api('POST', `/api/channels/${s.channel.id}/action`, { action: 'run' }, 409);
    assert.match(refused.error, /新版本已安装/);
    s.engine.loop.tick();
    await Promise.allSettled([...s.engine.loop.pending]);
    assert.equal(s.engine.loop.release(interrupted.id).status, 'unknown');
    assert.equal(statSync(scriptRun).mtimeMs, ranAt);

    // Idle and handed over: the daemon writes `exiting` and steps aside. Here the exit is captured
    // instead of performed, so the same process can start the replacement below.
    await until(() => s.engine.upgrade.state().idle);
    await s.api('POST', '/api/upgrade/acknowledge', {
      fromBootId: fixture.identity.bootId,
      targetFingerprint: target,
    });
    s.engine.upgrade.tick();
    assert.equal(exits.length, 1);
    assert.equal(s.store.all<UpgradeRecord>('upgrades')[0].phase, 'exiting');

    // A process that ended while a publication was still recorded as in flight leaves it
    // `publishing`; the replacement daemon has to reconcile that without republishing anything.
    s.store.put('loop_releases', { ...s.engine.loop.release(interrupted.id), status: 'publishing' });
    // The replacement daemon runs the build that was installed.
    s = (await s.restart({
      identity: {
        bootId: 'boot-after-switch',
        commit: targetCommit,
        version: '0.9.7',
        fingerprint: target,
        bundlePath: fixture.bundlePath,
      },
    })) as typeof s;
    const applied = s.store.all<UpgradeRecord>('upgrades')[0];
    assert.equal(applied.phase, 'applied');
    assert(applied.appliedAt);
    assert.equal(applied.error, undefined);
    // The switch no longer holds anything back.
    assert.equal(s.engine.upgrade.draining(), false);
    assert.equal((await s.api('GET', '/api/upgrade')).upgrade.phase, 'applied');

    // Recovery turned the interrupted publication into an unconfirmed one, to be reconciled from
    // its receipt file rather than published again.
    const recovered = s.engine.loop.release(interrupted.id);
    assert.equal(recovered.status, 'unknown');
    assert.match(recovered.error || '', /服务重启/);
    s.store.put('loop_releases', {
      ...s.engine.loop.release(interrupted.id),
      updatedAt: new Date(Date.now() - 120000).toISOString(),
    });
    s.engine.loop.tick();
    await Promise.allSettled([...s.engine.loop.pending]);
    await until(() => s.engine.loop.release(interrupted.id).status === 'published');
    assert.equal(statSync(scriptRun).mtimeMs, ranAt);
    assert.equal(JSON.parse(readFileSync(receiptPath, 'utf8')).releaseId, interrupted.id, '回执文件仍是原来那一份');
    const published = s.store
      .all<any>('events')
      .filter((row) => row.action === 'release.published' && row.changes?.after?.releaseId === interrupted.id);
    assert.equal(published.length, 1);
    // A reconciled receipt without a build identity requests nothing: one switch, one record.
    assert.equal(s.store.all<UpgradeRecord>('upgrades').length, 1);
    assert.equal(fixture.s.posts, 0);
  } finally {
    await fixture.cleanup();
  }
});

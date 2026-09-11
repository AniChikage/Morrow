import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  bundlePathFromModule,
  bundlePathFromResources,
  readBuildInfo,
  validBuildInfo,
} from '../service/build-identity.ts';
import type { UpgradeRecord } from '../service/upgrade.ts';
import { startInstalledFixture, startReleaseFixture } from './harness/release.ts';
import type { ReleaseFixture } from './harness/release.ts';

const running = 'a'.repeat(64);
const installed = 'b'.repeat(64);
const targetCommit = 'c'.repeat(40);

const upgrades = (s: ReleaseFixture) => s.store.all<UpgradeRecord>('upgrades');

test('build identity derives an installed bundle from its own module path and never trusts a broken build-info', () => {
  const bundle = '/Users/someone/Applications/Morrow.app';
  assert.equal(bundlePathFromModule(`file://${bundle}/Contents/Resources/service/server.ts`), bundle);
  assert.equal(bundlePathFromResources(`${bundle}/Contents/Resources`), bundle);
  // A development checkout has no bundle ancestor, so it can never be an installed target.
  assert.equal(bundlePathFromModule('file:///Users/someone/Documents/Morrow/service/server.ts'), '');
  assert.equal(bundlePathFromResources('/Users/someone/Morrow/Contents/Resources'), '');
  assert.equal(bundlePathFromResources(`${bundle}/Contents`), '');
  assert.equal(validBuildInfo({ fingerprint: 'zz' }), undefined);
  assert.equal(validBuildInfo({ commit: targetCommit }), undefined);
  assert.equal(validBuildInfo(null), undefined);
  // A valid fingerprint is what decides; an unusable commit only weakens the label.
  assert.deepEqual(
    { commit: validBuildInfo({ fingerprint: installed, commit: 'nope' })?.commit, dirty: false },
    { commit: 'unknown', dirty: false }
  );
  const root = mkdtempSync(join(tmpdir(), 'morrow-bundle-'));
  try {
    const resources = join(root, 'Morrow.app', 'Contents', 'Resources');
    mkdirSync(resources, { recursive: true });
    assert.equal(readBuildInfo(join(root, 'Morrow.app')), undefined);
    writeFileSync(join(resources, 'build-info.json'), 'not json');
    assert.equal(readBuildInfo(join(root, 'Morrow.app')), undefined);
    writeFileSync(join(resources, 'build-info.json'), JSON.stringify({ fingerprint: 'x'.repeat(200) }));
    assert.equal(readBuildInfo(join(root, 'Morrow.app')), undefined);
    writeFileSync(
      join(resources, 'build-info.json'),
      JSON.stringify({ scheme: 'morrow-bundle-v1', fingerprint: installed, commit: targetCommit, version: '0.9.6' })
    );
    assert.deepEqual(
      {
        fingerprint: readBuildInfo(join(root, 'Morrow.app'))?.fingerprint,
        commit: readBuildInfo(join(root, 'Morrow.app'))?.commit,
      },
      { fingerprint: installed, commit: targetCommit }
    );
    assert.equal(readBuildInfo(''), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a published receipt for this daemon own bundle records one pending switch and runs nothing', async () => {
  const { s, bundlePath, identity, publishLocal, cleanup } = await startInstalledFixture();
  try {
    const row = await publishLocal(['publish', bundlePath, installed, targetCommit]);
    assert.equal(row.status, 'published');
    assert.equal(row.installedBundle, bundlePath);
    assert.equal(row.buildFingerprint, installed);
    const [record, ...rest] = upgrades(s);
    assert.deepEqual(rest, []);
    assert.deepEqual(
      {
        id: record.id,
        releaseId: record.releaseId,
        targetFingerprint: record.targetFingerprint,
        targetCommit: record.targetCommit,
        installedBundle: record.installedBundle,
        fromBootId: record.fromBootId,
      },
      {
        id: installed,
        releaseId: row.id,
        targetFingerprint: installed,
        targetCommit,
        installedBundle: bundlePath,
        fromBootId: identity.bootId,
      }
    );
    // The scheduler moves a fresh request into draining on its own; both phases refuse new work.
    assert(['pending', 'draining'].includes(record.phase));
    // The request is a record, not an action: nothing was posted, and the service keeps serving.
    assert.equal(s.posts, 0);
    const state = await s.api('GET', '/api/upgrade');
    assert.deepEqual(state.identity, { ...identity, dataDirectory: s.home });
    assert(['pending', 'draining'].includes(state.upgrade.phase));
    assert.equal(state.idle, true);
    assert.deepEqual(state.blockers, []);
    assert.equal(state.exitCode, 75);
    assert.equal((await s.api('GET', '/api/state')).upgrade.upgrade.id, installed);
    // The work grant has no access to the lifecycle state at all.
    await s.api('GET', '/api/upgrade', undefined, 401, s.grant.token);
    const events = s.store.all<any>('events');
    assert(events.some((e) => e.action === 'upgrade.requested' && e.actor === 'system'));
  } finally {
    await cleanup();
  }
});

test('a receipt that installed another bundle, over HTTP, or without a usable identity requests nothing', async () => {
  const { s, bundlePath, publishLocal, cleanup } = await startInstalledFixture();
  try {
    // The same script path, the same project: only the bundle it reports installing is different.
    const other = await publishLocal(['publish', join(bundlePath, '..', 'Other.app'), installed], '别处的安装');
    assert.equal(other.status, 'published');
    assert.equal(other.installedBundle, join(bundlePath, '..', 'Other.app'));
    assert.deepEqual(upgrades(s), []);
    // A receipt with no build identity at all is an ordinary publication.
    assert.equal((await publishLocal(['publish'], '没有运行指纹')).buildFingerprint, undefined);
    assert.deepEqual(upgrades(s), []);
    // Unusable values are not even stored, so they can never be compared against a running build.
    const malformed = await publishLocal(['publish', 'Applications/Morrow.app', 'not-a-fingerprint'], '无效字段');
    assert.equal(malformed.installedBundle, undefined);
    assert.equal(malformed.buildFingerprint, undefined);
    assert.deepEqual(upgrades(s), []);
    // An HTTP target never installs anything locally, whatever its receipt claims.
    const remote = await s.call('release.propose', { ...s.http, title: 'HTTP 版本' });
    s.engine.loop.receipt(remote.id, {
      releaseId: remote.id,
      artifactSha256: remote.artifact.sha256,
      status: 'published',
      installedBundle: bundlePath,
      buildFingerprint: installed,
    });
    assert.equal(s.engine.loop.release(remote.id).status, 'published');
    assert.deepEqual(upgrades(s), []);
    assert.equal(s.posts, 0);
  } finally {
    await cleanup();
  }
});

test('the same target is requested once, and a build reinstalled over itself is already applied', async () => {
  const { s, bundlePath, publishLocal, cleanup } = await startInstalledFixture();
  try {
    const first = await publishLocal(['publish', bundlePath, installed, targetCommit], '第一次安装');
    const record = upgrades(s)[0];
    assert(['pending', 'draining'].includes(record.phase));
    // A second receipt for the same target neither duplicates the record nor resets the phase it
    // reached. The receipt is delivered directly because approving another publication while a
    // switch waits is refused (covered by the draining tests).
    // Draining, but not yet handed over, so the scheduler leaves the record where this test put it.
    s.store.put('upgrades', { ...record, phase: 'draining' });
    const again = await s.call('release.propose', { ...s.local(), title: '重复安装' });
    s.store.put('loop_releases', { ...s.engine.loop.release(again.id), status: 'publishing' });
    s.engine.loop.receipt(again.id, {
      releaseId: again.id,
      artifactSha256: again.artifact.sha256,
      status: 'published',
      installedBundle: bundlePath,
      buildFingerprint: installed,
      commit: targetCommit,
    });
    assert.notEqual(again.id, first.id);
    assert.equal(s.engine.loop.release(again.id).status, 'published');
    assert.equal(upgrades(s).length, 1);
    assert.equal(upgrades(s)[0].phase, 'draining');
    assert.equal(upgrades(s)[0].releaseId, first.id);
  } finally {
    await cleanup();
  }
});

test('installing the build that is already running is recorded as applied without any restart', async () => {
  const { s, bundlePath, publishLocal, cleanup } = await startInstalledFixture();
  try {
    await publishLocal(['publish', bundlePath, running, targetCommit], '重新安装同一版本');
    const [record] = upgrades(s);
    assert.equal(record.phase, 'applied');
    assert.equal(record.targetFingerprint, running);
    assert(record.appliedAt);
    assert.equal(s.engine.upgrade.record(), undefined);
    assert.equal((await s.api('GET', '/api/upgrade')).upgrade.phase, 'applied');
    // Nothing was requested, so nothing is waiting: the service is unchanged and still serving.
    assert.equal((await s.api('GET', '/api/state')).projects.length, 1);
  } finally {
    await cleanup();
  }
});

test('a development service without a bundle identity never turns an installing receipt into a request', async () => {
  const s = await startReleaseFixture();
  try {
    const proposal = await s.call('release.propose', {
      ...s.local(['publish', join(s.root, 'Morrow.app'), installed, targetCommit]),
    });
    await s.approve(proposal);
    const row = s.engine.loop.release(proposal.id);
    assert.equal(row.status, 'published');
    // The fields are preserved as reported; only this service knows they are not about itself.
    assert.equal(row.installedBundle, join(s.root, 'Morrow.app'));
    assert.equal(row.buildFingerprint, installed);
    assert.deepEqual(upgrades(s), []);
    const state = await s.api('GET', '/api/upgrade');
    assert.equal(state.identity.bundlePath, '');
    assert.equal(state.identity.fingerprint, 'unknown');
    assert.equal(state.upgrade, undefined);
  } finally {
    await s.cleanup();
  }
});

test('a restart reconciles an unfinished request against the build actually running', async () => {
  const { s, bundlePath, publishLocal, cleanup } = await startInstalledFixture();
  try {
    await publishLocal(['publish', bundlePath, installed, targetCommit]);
    const pending = upgrades(s)[0];
    assert(['pending', 'draining'].includes(pending.phase));
    // Still the old build after a restart: the reason is kept and nothing relaunches again.
    const stale = await s.restart();
    const blocked = stale.store.all<UpgradeRecord>('upgrades')[0];
    assert.equal(blocked.phase, 'blocked');
    assert.match(blocked.error || '', /仍是旧版本/);
    // The new build is running: the same record is satisfied.
    stale.store.put('upgrades', { ...pending, phase: 'exiting' });
    const upgraded = await stale.restart({
      identity: { bootId: 'boot-after', commit: targetCommit, version: '0.9.7', fingerprint: installed, bundlePath },
    });
    const applied = upgraded.store.all<UpgradeRecord>('upgrades')[0];
    assert.equal(applied.phase, 'applied');
    assert(applied.appliedAt);
    assert.equal(applied.error, undefined);
  } finally {
    await cleanup();
  }
});

test('the receipt fields reject an oversized, relative or non-absolute installed bundle', async () => {
  const { s, bundlePath, publishLocal, cleanup } = await startInstalledFixture();
  try {
    const release = await s.call('release.propose', { ...s.local(), title: '字段校验' }, randomUUID());
    const receipt = (fields: Record<string, unknown>) => {
      s.store.put('loop_releases', { ...s.engine.loop.release(release.id), status: 'publishing' });
      s.engine.loop.receipt(release.id, {
        releaseId: release.id,
        artifactSha256: release.artifact.sha256,
        status: 'published',
        ...fields,
      });
      return s.engine.loop.release(release.id);
    };
    assert.equal(receipt({ installedBundle: 42, buildFingerprint: installed }).installedBundle, undefined);
    assert.equal(
      receipt({ installedBundle: 'x'.repeat(5000), buildFingerprint: installed }).installedBundle,
      undefined
    );
    assert.equal(
      receipt({ installedBundle: bundlePath, buildFingerprint: 'B'.repeat(64) }).buildFingerprint,
      undefined
    );
    assert.deepEqual(upgrades(s), []);
    assert.equal(receipt({ installedBundle: bundlePath, buildFingerprint: installed }).buildFingerprint, installed);
    assert.equal(upgrades(s).length, 1);
  } finally {
    await cleanup();
  }
});

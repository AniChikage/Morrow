import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ProjectWorkLoop } from '../service/project-loop.ts';
import { FakeReviewer } from './harness/fake-reviewer.ts';
import { startIsolated } from './harness/service.ts';
import { grantFor } from './harness/grant.ts';
import { startReceiver } from './harness/receiver.ts';

/** Keys bash exports on its own; everything else in the fixture's environment came from Morrow. */
const shellAdded = ['PWD', 'SHLVL', 'OLDPWD', '_'];
/** `TMPDIR` is the one optional key: passed through when the service has one, absent when it does not. */
const allowedEnv = [
  'PATH',
  'HOME',
  'NO_COLOR',
  ...(process.env.TMPDIR ? ['TMPDIR'] : []),
  'MORROW_RELEASE_ID',
  'MORROW_ARTIFACT_PATH',
  'MORROW_ARTIFACT_SHA256',
  'MORROW_REVIEW_HASH',
  'MORROW_PROJECT_PATH',
  'MORROW_RECEIPT_PATH',
  'MORROW_RUNTIME_CACHE',
];

/**
 * One isolated service whose project already holds a committed-style release script and a release
 * manifest, plus a passed independent review for the feature the release closes. The HTTP receiver
 * only exists to prove a local publication never reaches the network.
 */
async function setup() {
  const receiver = await startReceiver({ feedback: { activation: 0.2 } });
  const s = await startIsolated({ project: { name: '本地脚本发布', goal: '让批准后的安装可复现' } });
  const grant = grantFor(s, { projectId: s.project.id, channelId: s.channel.id });
  const call = (operation: string, input: unknown, requestId = randomUUID(), expected = 200) =>
    grant.call(operation, input, expected, requestId);
  // Every project file has to exist before the review passes: a later write changes the source
  // fingerprint and `release.propose` would then reject for a stale verification.
  copyFileSync(fileURLToPath(new URL('./fixtures/release-script.sh', import.meta.url)), join(s.path, 'release.sh'));
  writeFileSync(join(s.path, 'checks.log'), '3 tests passed\n');
  writeFileSync(
    join(s.path, 'release-manifest.json'),
    JSON.stringify({ commit: 'a'.repeat(40), branch: 'agent/work', version: '0.9.6', sourceDigest: 'b'.repeat(64) })
  );
  const featureSummary = '记录实际安装结果';
  const feature = await call('feature.upsert', {
    title: '安装流程可复现',
    summary: featureSummary,
    kind: 'feature',
    status: 'investigating',
    evidenceIds: [],
    nextStep: '准备本地脚本发布',
  });
  const evidence = await call('evidence.capture', { itemId: feature.id, summary: '隔离测试日志', path: 'checks.log' });
  const reviewer = new FakeReviewer();
  reviewer.autoComplete = true;
  s.engine.loop.verification.connect(reviewer, (v) => v);
  const completion = await call('feature.upsert', {
    id: feature.id,
    revision: s.store.get<any>('items', feature.id).revision,
    title: feature.title,
    summary: featureSummary,
    kind: feature.kind,
    status: 'verified',
    evidenceIds: [evidence.id],
    nextStep: '等待人工批准安装',
  });
  await s.engine.loop.verification.start(completion.verificationId);
  assert.equal(s.store.get<any>('items', feature.id).status, 'verified');
  const base = {
    itemIds: [feature.id],
    title: '安装当前提交',
    changes: '按 manifest 里的提交构建并安装',
    rationale: '人工构建步骤容易漏掉门禁',
    expectedBenefit: '预期减少安装差异；线上收益尚待验证',
    checks: [{ name: '隔离测试', result: 'passed', evidenceIds: [evidence.id] }],
    risks: '会替换本机安装的版本',
    rollback: '重新安装上一个版本',
    observationPlan: '安装后观察指标文件',
    artifactPath: 'release-manifest.json',
  };
  const local = (args: string[] = ['publish'], extra: Record<string, unknown> = {}) => ({
    ...base,
    target: { kind: 'local-script', label: '本机安装', script: 'release.sh', args, timeoutSeconds: 30, ...extra },
  });
  const http = {
    ...base,
    target: { url: receiver.url + '/deploy', statusUrl: receiver.url + '/status', label: '隔离测试发布端' },
  };
  const approve = async (release: any, expected = 200) => {
    await s.api(
      'POST',
      `/api/releases/${release.id}/review`,
      { reviewHash: release.reviewHash, decision: 'approve' },
      expected
    );
    await Promise.allSettled([...s.engine.loop.pending]);
  };
  return {
    ...s,
    call,
    grant,
    feature,
    evidence,
    local,
    http,
    approve,
    releaseDir: (id: string) => join(s.home, 'releases', id),
    get posts() {
      return receiver.posts;
    },
    cleanup: async () => {
      await s.close();
      await receiver.close();
      await s.cleanup();
    },
  };
}
const envKeys = (path: string) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.includes('='))
    .map((line) => line.slice(0, line.indexOf('=')))
    .filter((key) => !shellAdded.includes(key));

test('an approved local-script release runs only the sealed copy, in a fixed environment, and reports its receipt', async () => {
  const s = await setup();
  try {
    const release = await s.call('release.propose', s.local());
    assert.equal(release.status, 'awaiting_approval');
    assert.equal(release.target.kind, 'local-script');
    assert.equal(release.target.script, 'release.sh');
    assert.match(release.target.scriptSha256, /^[a-f0-9]{64}$/);
    assert.equal(release.target.timeoutSeconds, 30);
    assert.equal(existsSync(join(s.releaseDir(release.id), 'script')), true);
    // Nothing runs while the release waits for a human, and no local release ever posts anywhere.
    s.engine.loop.tick();
    await Promise.allSettled([...s.engine.loop.pending]);
    assert.equal(s.posts, 0);
    assert.equal(existsSync(join(s.releaseDir(release.id), 'receipt.json')), false);
    await s.approve(release);
    assert.equal(s.posts, 0);
    const row = s.engine.loop.release(release.id);
    assert.equal(row.status, 'published');
    const receipt = JSON.parse(readFileSync(join(s.releaseDir(release.id), 'receipt.json'), 'utf8'));
    assert.equal(receipt.releaseId, release.id);
    assert.equal(receipt.artifactSha256, row.artifact.sha256);
    assert.equal(receipt.status, 'published');
    assert.equal(receipt.reviewHash, release.reviewHash);
    // Combined stdout/stderr is kept as the log.
    assert(row.log.includes('fixture mode publish'));
    assert(row.log.includes('preparing the isolated fixture release'));
    const environment = join(s.releaseDir(release.id), 'env.txt');
    assert.deepEqual(envKeys(environment).sort(), [...allowedEnv].sort());
    const dump = readFileSync(environment, 'utf8');
    assert.equal(dump.includes(s.token), false);
    assert.equal(dump.includes(s.grant.token), false);
    assert(dump.includes(`MORROW_RUNTIME_CACHE=${join(s.home, 'runtime-cache')}`));
    assert(dump.includes(`MORROW_ARTIFACT_PATH=${s.engine.loop.artifactPath(release.id)}`));
    const events = s.store.all<any>('events');
    assert(events.some((e) => e.action === 'release.publishing' && e.actor === 'system'));
    assert(events.some((e) => e.action === 'release.published' && e.actor === 'system'));
    assert(events.some((e) => e.action === 'release.approved' && e.actor === 'human'));
  } finally {
    await s.cleanup();
  }
});

test('editing the project script after a proposal cannot change what an approval executes', async () => {
  const s = await setup();
  try {
    const release = await s.call('release.propose', s.local());
    writeFileSync(join(s.path, 'release.sh'), `#!/usr/bin/env bash\ntouch "${join(s.path, 'tampered-ran')}"\nexit 1\n`);
    await s.approve(release);
    assert.equal(s.engine.loop.release(release.id).status, 'published');
    assert.equal(existsSync(join(s.path, 'tampered-ran')), false);
    assert(s.engine.loop.release(release.id).log.includes('fixture mode publish'));
  } finally {
    await s.cleanup();
  }
});

test('a tampered sealed script blocks approval and, if it changes later, publishes nothing', async () => {
  const s = await setup();
  try {
    const blocked = await s.call('release.propose', s.local());
    const afterApproval = await s.call('release.propose', { ...s.local(), title: '第二个版本' });
    writeFileSync(s.engine.loop.scriptPath(blocked.id), '#!/usr/bin/env bash\nexit 0\n');
    await s.approve(blocked, 409);
    assert.equal(s.engine.loop.release(blocked.id).status, 'awaiting_approval');
    assert.equal(existsSync(join(s.releaseDir(blocked.id), 'env.txt')), false);
    // A seal that changes between approval and publication also executes nothing.
    s.store.put('loop_releases', { ...s.engine.loop.release(afterApproval.id), status: 'approved' });
    writeFileSync(s.engine.loop.scriptPath(afterApproval.id), '#!/usr/bin/env bash\nexit 0\n');
    await s.engine.loop.publish(afterApproval.id);
    const row = s.engine.loop.release(afterApproval.id);
    assert.equal(row.status, 'failed');
    assert.match(row.error, /封存发布脚本校验失败/);
    assert.equal(existsSync(join(s.releaseDir(afterApproval.id), 'env.txt')), false);
    assert.equal(s.posts, 0);
  } finally {
    await s.cleanup();
  }
});

test('a failed gate, unparsable output or a timeout keeps the outcome unknown instead of claiming success', async () => {
  const s = await setup();
  try {
    const failing = await s.call('release.propose', s.local(['fail']));
    const garbage = await s.call('release.propose', { ...s.local(['garbage']), title: '非 JSON 输出' });
    // A one-second cap is only accepted in test mode; the shipped floor stays 30 seconds.
    const slow = await s.call('release.propose', {
      ...s.local(['sleep'], { timeoutSeconds: 1 }),
      title: '不会结束的脚本',
    });
    await s.approve(failing);
    const failed = s.engine.loop.release(failing.id);
    assert.equal(failed.status, 'unknown');
    assert.match(failed.error, /退出码 1/);
    assert(failed.log.includes('fixture gate failed'));
    assert.equal(existsSync(join(s.releaseDir(failing.id), 'receipt.json')), false);
    await s.approve(garbage);
    const unparsable = s.engine.loop.release(garbage.id);
    assert.equal(unparsable.status, 'unknown');
    assert.match(unparsable.error, /不是有效的回执 JSON/);
    await s.approve(slow);
    const timedOut = s.engine.loop.release(slow.id);
    assert.equal(timedOut.status, 'unknown');
    assert.match(timedOut.error, /超过 1 秒未结束/);
    // Reconciliation of a still-unfinished publication reports no confirmation, never a success.
    assert.equal((await s.engine.loop.reconcile(slow.id)).status, 'unknown');
    assert.equal(s.posts, 0);
  } finally {
    await s.cleanup();
  }
});

test('a publication interrupted by a restart is reconciled from its receipt file without running again', async () => {
  const s = await setup();
  let recovered: ProjectWorkLoop | undefined;
  try {
    const release = await s.call('release.propose', s.local(['quiet']));
    await s.approve(release);
    // The script wrote its receipt file but printed nothing: the outcome is not confirmed yet.
    assert.equal(s.engine.loop.release(release.id).status, 'unknown');
    assert(existsSync(join(s.releaseDir(release.id), 'receipt.json')));
    s.store.put('loop_releases', { ...s.engine.loop.release(release.id), status: 'publishing' });
    recovered = new ProjectWorkLoop(s.store, s.home);
    recovered.recover();
    assert.equal(recovered.release(release.id).status, 'unknown');
    assert.equal((await recovered.reconcile(release.id)).status, 'published');
    recovered.tick();
    assert.equal(s.posts, 0);
    assert.equal(s.store.all<any>('events').filter((e) => e.action === 'release.published').length, 1);
  } finally {
    await recovered?.close();
    await s.cleanup();
  }
});

test('a sealed status script answers an unconfirmed publication when no receipt file exists', async () => {
  const s = await setup();
  try {
    const release = await s.call('release.propose', s.local(['fail'], { statusScript: 'release.sh' }));
    assert.equal(release.target.statusScript, 'release.sh');
    assert.equal(release.target.statusScriptSha256, release.target.scriptSha256);
    await s.approve(release);
    assert.equal(s.engine.loop.release(release.id).status, 'unknown');
    assert.equal(existsSync(join(s.releaseDir(release.id), 'receipt.json')), false);
    // The status script receives the same fixed environment and no arguments.
    assert.equal((await s.engine.loop.reconcile(release.id)).status, 'published');
    assert(existsSync(join(s.releaseDir(release.id), 'receipt.json')));
    assert.deepEqual(envKeys(join(s.releaseDir(release.id), 'env.txt')).sort(), [...allowedEnv].sort());
    assert.equal(s.posts, 0);
  } finally {
    await s.cleanup();
  }
});

test('closing the service stops waiting for a running script and leaves the outcome to be reconciled', async () => {
  const s = await setup();
  try {
    const release = await s.call('release.propose', s.local(['sleep'], { timeoutSeconds: 3600 }));
    // The review returns as soon as publication starts; the detached script keeps running.
    await s.api('POST', `/api/releases/${release.id}/review`, {
      reviewHash: release.reviewHash,
      decision: 'approve',
    });
    const started = Date.now();
    await s.engine.loop.close();
    assert(Date.now() - started < 5000);
    const row = s.engine.loop.release(release.id);
    assert.equal(row.status, 'unknown');
    assert.match(row.error, /服务已关闭/);
    assert.equal(s.posts, 0);
  } finally {
    await s.cleanup();
  }
});

test('the sealed script text is readable with the desktop credential and refused to the work grant', async () => {
  const s = await setup();
  try {
    const release = await s.call('release.propose', s.local());
    const remote = await s.call('release.propose', { ...s.http, title: 'HTTP 版本' });
    const view = await s.api('GET', `/api/releases/${release.id}/script`);
    assert.equal(view.releaseId, release.id);
    assert.equal(view.script.path, 'release.sh');
    assert.equal(view.script.sha256, release.target.scriptSha256);
    assert.equal(view.script.text, readFileSync(join(s.path, 'release.sh'), 'utf8'));
    assert.equal(view.statusScript, undefined);
    assert.deepEqual(view.args, ['publish']);
    await s.api('GET', `/api/releases/${release.id}/script`, undefined, 401, s.grant.token);
    await s.api('GET', `/api/releases/${remote.id}/script`, undefined, 409);
    await s.api('GET', '/api/releases/missing/script', undefined, 404);
  } finally {
    await s.cleanup();
  }
});

test('local-script proposals reject unusable scripts, arguments and timeouts', async () => {
  const s = await setup();
  try {
    const bad = async (target: Record<string, unknown>, status: number) =>
      s.call('release.propose', { ...s.local(), target }, randomUUID(), status);
    const valid = { kind: 'local-script', label: '本机安装', script: 'release.sh', args: [], timeoutSeconds: 30 };
    await bad({ ...valid, script: '../release.sh' }, 400);
    await bad({ ...valid, script: 'missing.sh' }, 400);
    await bad({ ...valid, script: '.' }, 400);
    await bad({ ...valid, timeoutSeconds: 3601 }, 400);
    await bad({ ...valid, timeoutSeconds: 30.5 }, 400);
    await bad({ ...valid, args: Array.from({ length: 17 }, () => 'x') }, 400);
    await bad({ ...valid, args: ['a'.repeat(1001)] }, 400);
    await bad({ ...valid, args: [42] }, 400);
    await bad({ ...valid, label: 'x'.repeat(101) }, 400);
    // The digests belong to the service; an agent cannot supply or pre-empt them.
    await bad({ ...valid, scriptSha256: 'f'.repeat(64) }, 400);
    await bad({ kind: 'local-script', label: '缺少脚本', args: [], timeoutSeconds: 30 }, 400);
    await bad({ ...valid, kind: 'shell' }, 400);
    assert.equal(s.store.all('loop_releases').length, 0);
  } finally {
    await s.cleanup();
  }
});

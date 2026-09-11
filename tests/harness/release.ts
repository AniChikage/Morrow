import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FakeReviewer } from './fake-reviewer.ts';
import { startIsolated } from './service.ts';
import type { IsolatedService } from './service.ts';
import { grantFor } from './grant.ts';
import type { Grant } from './grant.ts';
import { startReceiver } from './receiver.ts';
import type { BuildIdentity } from '../../service/build-identity.ts';
import type { Release } from '../../service/autonomy-types.ts';

/** `TMPDIR` is the one optional key: passed through when the service has one, absent when it does not. */
export const releaseEnvKeys = [
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
export type ReleaseFixture = IsolatedService & {
  call: (operation: string, input: unknown, requestId?: string, expected?: number) => Promise<any>;
  grant: Grant;
  feature: any;
  evidence: any;
  /** A `local-script` proposal body; `args` reach `tests/fixtures/release-script.sh` unchanged. */
  local: (args?: string[], extra?: Record<string, unknown>) => Record<string, unknown>;
  /** The same proposal against the isolated HTTP receiver, which only exists to prove nothing posts. */
  http: Record<string, unknown>;
  approve: (release: any, expected?: number) => Promise<void>;
  releaseDir: (id: string) => string;
  readonly posts: number;
};

/**
 * One isolated service whose project already holds a committed-style release script and a release
 * manifest, a passed independent review for the feature the release closes, and a passed
 * release-level review of this exact source version, so a test can propose and approve a release
 * without repeating the whole gate. Nothing is built, installed or posted.
 */
export async function startReleaseFixture(
  options: { name?: string; goal?: string; identity?: BuildIdentity } = {}
): Promise<ReleaseFixture> {
  const receiver = await startReceiver({ feedback: { activation: 0.2 } });
  const s = await startIsolated({
    project: { name: options.name || '本地脚本发布', goal: options.goal || '让批准后的安装可复现' },
    ...(options.identity ? { identity: options.identity } : {}),
  });
  const grant = grantFor(s, {
    projectId: s.project.id,
    channelId: s.channel.id,
    // The release gate needs one execution capture, which needs a native task and turn to bind to.
    overrides: { sessionId: 'isolated-test', nativeTurnId: 'isolated-turn' },
  });
  const call = (operation: string, input: unknown, requestId = randomUUID(), expected = 200) =>
    grant.call(operation, input, expected, requestId);
  // Every project file has to exist before the review passes: a later write changes the source
  // fingerprint and `release.propose` would then reject for a stale verification.
  copyFileSync(fileURLToPath(new URL('../fixtures/release-script.sh', import.meta.url)), join(s.path, 'release.sh'));
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
  // The candidate itself is reviewed once, citing a check bound to this exact source version.
  const execution = await grant.execute('bash scripts/checks.sh');
  const releaseReview = await call('verification.request', {
    kind: 'release',
    itemIds: [feature.id],
    evidenceIds: [execution.id],
  });
  await s.engine.loop.verification.start(releaseReview.id);
  assert.equal(s.store.get<any>('loop_verifications', releaseReview.id).status, 'passed');
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
export type InstalledFixture = {
  s: ReleaseFixture;
  /** The `.app` this service believes it runs from; it really exists, as it does after an install. */
  bundlePath: string;
  identity: BuildIdentity;
  /** Publishes one `local-script` release, passing `args` through to the fixture script. */
  publishLocal: (args: string[], title?: string) => Promise<Release>;
  /** Publishes a release whose receipt reports installing `fingerprint` over this service's bundle. */
  install: (fingerprint: string, commit?: string, title?: string) => Promise<Release>;
  cleanup: () => Promise<void>;
};
/**
 * A release fixture whose service believes it runs from `<temp>/Morrow.app`, the way an installed
 * daemon does, so a receipt can legitimately describe installing over its own bundle. The directory
 * really exists, so bundle paths are compared by their real path. Nothing is built or installed.
 */
export async function startInstalledFixture(
  options: { fingerprint?: string; bootId?: string; commit?: string } = {}
): Promise<InstalledFixture> {
  const install = mkdtempSync(join(tmpdir(), 'morrow-install-'));
  const bundlePath = join(install, 'Morrow.app');
  mkdirSync(join(bundlePath, 'Contents', 'Resources'), { recursive: true });
  const identity: BuildIdentity = {
    bootId: options.bootId || 'boot-under-test',
    commit: options.commit || 'd'.repeat(40),
    version: '0.9.6',
    fingerprint: options.fingerprint || 'a'.repeat(64),
    bundlePath,
  };
  const s = await startReleaseFixture({ identity });
  const publishLocal = async (args: string[], title = '安装当前提交') => {
    const release = await s.call('release.propose', { ...s.local(args), title });
    await s.approve(release);
    return s.engine.loop.release(release.id);
  };
  return {
    s,
    bundlePath,
    identity,
    publishLocal,
    install: (fingerprint, commit = 'c'.repeat(40), title = '安装新版本') =>
      publishLocal(['publish', bundlePath, fingerprint, commit], title),
    cleanup: async () => {
      await s.cleanup();
      rmSync(install, { recursive: true, force: true });
    },
  };
}
/** Environment keys one sealed run actually saw, minus the keys bash exports on its own. */
export function releaseEnv(path: string): string[] {
  const shellAdded = ['PWD', 'SHLVL', 'OLDPWD', '_'];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.includes('='))
    .map((line) => line.slice(0, line.indexOf('=')))
    .filter((key) => !shellAdded.includes(key));
}

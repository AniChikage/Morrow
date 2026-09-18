import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReviewRunner } from '../service/codex-cli-review.ts';
import { projectTreeState } from '../service/source-version.ts';
import { FakeReviewer } from './harness/fake-reviewer.ts';
import { startIsolated, type IsolatedService } from './harness/service.ts';
import { grantFor, type Grant } from './harness/grant.ts';

/** Bounded Git for the fixture repository; identity and signing are supplied, never read from this Mac. */
const git = (root: string, args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.email=morrow-test@example.com',
      '-c',
      'user.name=Morrow Test',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'init.defaultBranch=main',
      '-C',
      root,
      ...args,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
const worktrees = (root: string) =>
  git(root, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
/** Whether `path` is a registered worktree of `root`; a plain folder registers nothing. */
const registered = (root: string, path: string) => {
  try {
    return worktrees(root).includes(realpathSync(path));
  } catch {
    return false;
  }
};

/** What the reviewer saw while it was running; the checkout is gone by the time a test can look. */
type Seen = {
  cwd: string;
  prompt: string;
  isolated: boolean;
  source: string;
  modules: boolean;
  registered: boolean;
};
/**
 * A `ReviewRunner` with a scripted outcome that records where it was told to run. No CLI, no model.
 * `unavailable` is the failure of a runtime that could not run at all, which hands the review on.
 */
const recordingRunner = (projectPath: string, outcome: 'completed' | 'failed' | 'unavailable' = 'completed') => {
  const seen: Seen[] = [];
  const runner: ReviewRunner = {
    start: ({ cwd, prompt, isolated, observe }) => {
      seen.push({
        cwd,
        prompt,
        isolated: !!isolated,
        source: existsSync(join(cwd, 'source.js')) ? readFileSync(join(cwd, 'source.js'), 'utf8') : '',
        modules: existsSync(join(cwd, 'node_modules', 'installed.txt')),
        registered: registered(projectPath, cwd),
      });
      return {
        cancel: () => {},
        done: Promise.resolve().then(() =>
          observe({
            threadId: 'scripted-cli-session',
            items:
              outcome === 'completed'
                ? [
                    {
                      id: 'check',
                      type: 'commandExecution',
                      command: 'node --test',
                      cwd,
                      status: 'completed',
                      exitCode: 0,
                      aggregatedOutput: '1 test passed',
                    },
                    {
                      id: 'final',
                      type: 'agentMessage',
                      phase: 'final_answer',
                      text:
                        '```morrow-verification\n' +
                        JSON.stringify({
                          verdict: 'pass',
                          summary: '在一次性检出里重跑了检查',
                          checks: [{ expectationId: 'feature', verdict: 'met', reason: '亲自运行的结果' }],
                          findings: [],
                          limitations: ['scripted runner only'],
                        }) +
                        '\n```',
                    },
                  ]
                : [],
            status: outcome === 'completed' ? 'completed' : 'failed',
            ...(outcome === 'failed' ? { error: '脚本化运行器按要求失败' } : {}),
            ...(outcome === 'unavailable' ? { error: 'spawn /usr/local/bin/claude ENOENT' } : {}),
          })
        ),
      };
    },
  };
  return { seen, runner };
};

type Fixture = IsolatedService & {
  call: Grant['call'];
  requestReview: () => Promise<any>;
  /** Makes these the only review runners, in place of the two CLI runners the daemon wires. */
  useRunners: (runners: { 'codex-cli'?: ReviewRunner; 'claude-cli'?: ReviewRunner }) => void;
};
/** A project with two source files and a gitignored dependency directory; the repository is optional. */
async function fixture(options: { repository: boolean; native?: FakeReviewer }): Promise<Fixture> {
  const s = await startIsolated({
    scheduler: false,
    ...(options.native ? { nativeTransport: options.native } : {}),
    project: {
      name: '隔离检出复核',
      goal: '让复核者自己重跑检查',
      files: {
        'source.js': 'export const value=1;\n',
        'result.json': JSON.stringify({ value: 1 }),
        '.gitignore': 'node_modules\n',
      },
    },
  });
  mkdirSync(join(s.path, 'node_modules'), { recursive: true });
  writeFileSync(join(s.path, 'node_modules', 'installed.txt'), 'dependency\n');
  if (options.repository) {
    git(s.path, ['init', '-q']);
    git(s.path, ['add', '-A']);
    git(s.path, ['commit', '-q', '-m', 'seed']);
    assert.equal(projectTreeState(s.path).dirty, false, '夹具必须从干净工作树开始');
  }
  const { call } = grantFor(s, { projectId: s.project.id, channelId: s.channel.id });
  const requestReview = async () => {
    const item = await call('feature.upsert', {
      title: '一次性检出',
      summary: '让复核者自己重跑检查',
      kind: 'feature',
      status: 'investigating',
      evidenceIds: [],
      nextStep: '请求复核',
    });
    const evidence = await call('evidence.capture', { summary: '实际文件内容', path: 'result.json' });
    return call('verification.request', { itemId: item.id, evidenceIds: [evidence.id] });
  };
  const useRunners = (runners: { 'codex-cli'?: ReviewRunner; 'claude-cli'?: ReviewRunner }) => {
    s.engine.loop.verification.runners.clear();
    for (const [owner, runner] of Object.entries(runners))
      s.engine.loop.verification.connectRunner(runner, owner as 'codex-cli' | 'claude-cli');
  };
  return Object.assign(s, { call, requestReview, useRunners });
}

test('a committed source version is reviewed in a disposable checkout that the prompt describes', async () => {
  const f = await fixture({ repository: true });
  try {
    const { seen, runner } = recordingRunner(f.path);
    f.useRunners({ 'codex-cli': runner });
    const request = await f.requestReview();
    const stored = f.store.get<any>('loop_verifications', request.id).prompt;
    await f.engine.loop.verification.start(request.id);
    assert.equal(seen.length, 1);
    const [only] = seen;
    // Not the shared project directory: a checkout of its own, inside the data directory.
    assert.equal(only.cwd, join(f.home, 'reviews', request.id));
    assert.notEqual(only.cwd, f.path);
    assert.equal(only.registered, true);
    assert.equal(only.isolated, true);
    assert.equal(only.source, 'export const value=1;\n');
    // Linked dependencies are what lets the reviewer run the project's own checks.
    assert.equal(only.modules, true);
    // The frozen material is unchanged and the isolation wording is appended to it, once.
    assert(only.prompt.startsWith(stored));
    assert(only.prompt.includes('一次性隔离检出'));
    assert(only.prompt.includes(only.cwd));
    assert(only.prompt.includes(git(f.path, ['rev-parse', 'HEAD']).trim()));
    assert(only.prompt.includes('把你亲自运行得到的结果'));
    const result = f.store.get<any>('loop_verifications', request.id);
    assert.equal(result.status, 'passed');
    assert.equal(result.summary, '在一次性检出里重跑了检查');
    // Used and gone: no directory, no registration, and the project's dependencies are untouched.
    assert.equal(existsSync(only.cwd), false);
    assert.deepEqual(worktrees(f.path), [realpathSync(f.path)]);
    assert.deepEqual(readdirSync(join(f.home, 'reviews')), []);
    assert.equal(existsSync(join(f.path, 'node_modules', 'installed.txt')), true);
  } finally {
    await f.cleanup();
  }
});

test('a review that reaches no verdict still leaves no checkout behind', async () => {
  const f = await fixture({ repository: true });
  try {
    const { seen, runner } = recordingRunner(f.path, 'failed');
    f.useRunners({ 'codex-cli': runner });
    const request = await f.requestReview();
    await f.engine.loop.verification.start(request.id);
    assert.equal(f.store.get<any>('loop_verifications', request.id).status, 'unknown');
    assert.equal(existsSync(seen[0].cwd), false);
    assert.deepEqual(worktrees(f.path), [realpathSync(f.path)]);
  } finally {
    await f.cleanup();
  }
});

test('a plain folder and an uncommitted change keep the review in the project directory', async () => {
  for (const kind of ['folder', 'dirty'] as const) {
    const f = await fixture({ repository: kind === 'dirty' });
    try {
      if (kind === 'dirty') writeFileSync(join(f.path, 'source.js'), 'export const value=2;\n');
      const { seen, runner } = recordingRunner(f.path);
      f.useRunners({ 'codex-cli': runner });
      const request = await f.requestReview();
      const stored = f.store.get<any>('loop_verifications', request.id).prompt;
      await f.engine.loop.verification.start(request.id);
      // The fallback is the behaviour that shipped: the shared tree, and the read-only wording.
      assert.equal(seen[0].cwd, realpathSync(f.path), kind);
      // No checkout, so the runner is told not to open its sandbox for writes.
      assert.equal(seen[0].isolated, false, kind);
      assert.equal(seen[0].prompt, stored, kind);
      assert(seen[0].prompt.includes('不能写文件、联网、安装依赖'), kind);
      assert(!seen[0].prompt.includes('一次性隔离检出'), kind);
      assert.equal(f.store.get<any>('loop_verifications', request.id).status, 'passed', kind);
      assert.equal(existsSync(join(f.home, 'reviews')), false, kind);
    } finally {
      await f.cleanup();
    }
  }
});

test('a restart removes the checkouts and registrations a killed service left behind', async () => {
  const f = await fixture({ repository: true });
  try {
    const stray = join(f.home, 'reviews', 'killed-review');
    mkdirSync(join(f.home, 'reviews'), { recursive: true });
    git(f.path, ['worktree', 'add', '--detach', '-q', stray, 'HEAD']);
    assert.equal(worktrees(f.path).length, 2);
    await f.restart();
    assert.equal(existsSync(stray), false);
    assert.deepEqual(worktrees(f.path), [realpathSync(f.path)]);
    assert.deepEqual(readdirSync(join(f.home, 'reviews')), []);
  } finally {
    await f.cleanup();
  }
});

test('a runtime that cannot run hands its checkout to the other one, which is still removed once', async () => {
  const f = await fixture({ repository: true });
  try {
    const claude = recordingRunner(f.path, 'unavailable'),
      codex = recordingRunner(f.path);
    f.useRunners({ 'claude-cli': claude.runner, 'codex-cli': codex.runner });
    const request = await f.requestReview();
    await f.engine.loop.verification.start(request.id);
    assert.equal(claude.seen.length, 1);
    assert.equal(codex.seen.length, 1);
    // The same disposable checkout, still live for the second attempt: not rebuilt, not leaked.
    assert.equal(claude.seen[0].cwd, join(f.home, 'reviews', request.id));
    assert.equal(codex.seen[0].cwd, claude.seen[0].cwd);
    assert.equal(codex.seen[0].prompt, claude.seen[0].prompt);
    assert.equal(codex.seen[0].registered, true);
    assert.equal(codex.seen[0].source, 'export const value=1;\n');
    assert.equal(codex.seen[0].modules, true);
    const result = f.store.get<any>('loop_verifications', request.id);
    assert.equal(result.status, 'passed');
    assert.equal(result.executionOwner, 'codex-cli');
    assert.equal(existsSync(codex.seen[0].cwd), false);
    assert.deepEqual(worktrees(f.path), [realpathSync(f.path)]);
    assert.deepEqual(readdirSync(join(f.home, 'reviews')), []);
  } finally {
    await f.cleanup();
  }
});

/**
 * The App task reviews through the native protocol instead of a CLI, and Morrow does not control
 * what that sandbox finally allows: the App merges the writable roots it is passed with the ones it
 * retains, so a writable review there could reach the very project it is reviewing. It keeps the
 * read-only permissions it always sent, and therefore is not told it may run anything that writes —
 * it still reads the version under review, in the checkout.
 */
test('the App review reads the checkout under the read-only permissions it always sent', async () => {
  const native = new FakeReviewer();
  const f = await fixture({ repository: true, native });
  try {
    const request = await f.requestReview();
    const stored = f.store.get<any>('loop_verifications', request.id).prompt;
    await f.engine.loop.verification.start(request.id);
    assert.equal(native.sent.length, 1);
    assert.equal(native.snapshots.get(native.sent[0].threadId)!.state.cwd, join(f.home, 'reviews', request.id));
    assert.deepEqual(native.sent[0].options, {
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
    // The prompt promises exactly what this runtime can do, and nothing more.
    assert.equal(native.sent[0].text, stored);
    assert.equal(native.sent[0].text.includes('一次性隔离检出'), false);
    assert(native.sent[0].text.includes('不能写文件、联网、安装依赖'));
    native.complete();
    assert.equal(f.store.get<any>('loop_verifications', request.id).status, 'passed');
    // The checkout is still used up and removed when an App review ends.
    assert.equal(existsSync(join(f.home, 'reviews', request.id)), false);
    assert.deepEqual(worktrees(f.path), [realpathSync(f.path)]);
    assert.deepEqual(readdirSync(join(f.home, 'reviews')), []);
  } finally {
    await f.cleanup();
  }
});

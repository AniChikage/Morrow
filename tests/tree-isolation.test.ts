import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { now } from '../service/store.ts';
import { startIsolated } from './harness/service.ts';
import { FakeReviewer } from './harness/fake-reviewer.ts';
import type { Channel, Event, Project, Run } from '../service/protocol.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * One project whose directory is a real temporary Git repository, with two channels bound to two
 * native tasks. Only `git status` is ever read here: the service never runs a mutating Git command,
 * no model is called, and the user's own repositories are untouched.
 */
async function setup() {
  const native = new FakeReviewer();
  const s = await startIsolated({
    nativeTransport: native,
    project: {
      name: '工作树隔离',
      goal: '让多频道共享一个工作树而不互相覆盖',
      files: { 'source.js': 'export const value = 1;\n' },
    },
  });
  git(s.path, 'init', '-q');
  git(s.path, 'config', 'user.email', 'fixture@example.com');
  git(s.path, 'config', 'user.name', 'Morrow Fixture');
  git(s.path, 'config', 'commit.gpgsign', 'false');
  git(s.path, 'add', '-A');
  git(s.path, 'commit', '-q', '-m', 'fixture baseline');
  const second: Channel = await s.api(
    'POST',
    '/api/channels',
    { projectId: s.project.id, name: '运营洞察', goal: '从真实反馈中发现机会', runtime: 'codex' },
    201
  );
  /** Binds one channel to a native task the double already knows, so the scheduler takes that path. */
  const bind = (channelId: string, threadId: string) => {
    native.snapshots.set(threadId, {
      threadId,
      ownerClientId: 'tree-isolation',
      revision: 1,
      syncedAt: now(),
      state: {
        cwd: s.path,
        model: 'fixture-model',
        turns: [],
        currentPermissions: { sandboxPolicy: { type: 'workspaceWrite' } },
      },
    } as any);
    s.store.put('native_bindings', { id: channelId, projectId: s.project.id, threadId, cwd: s.path, createdAt: now() });
  };
  bind(s.channel.id, 'thread-a');
  bind(second.id, 'thread-b');
  /** One finalized scheduled turn of `channelId`, recording the tree exactly as it is right now. */
  const finish = (channelId: string, sessionId: string) => {
    const run: Run = {
      id: randomUUID(),
      projectId: s.project.id,
      channelId,
      runtime: 'codex',
      model: '',
      permission: 'native',
      executionOwner: 'codex-app',
      source: 'morrow-schedule',
      trigger: 'schedule',
      resumedFromSessionId: sessionId,
      reportStatus: 'pending',
      reportError: '',
      status: 'running',
      startedAt: now(),
      finishedAt: '',
      summary: '',
      sessionId,
    };
    s.store.put('runs', run);
    s.engine.finishWithoutReport(run, '本轮结束');
    return s.store.get<Run>('runs', run.id)!;
  };
  const projectRow = () => s.store.get<Project>('projects', s.project.id)!;
  const channelRow = (id: string) => s.store.get<Channel>('channels', id)!;
  const waits = (channelId: string) =>
    s.store.all<Event>('events').filter((row) => row.channelId === channelId && row.text.includes('未提交的改动'));
  return { ...s, native, second, finish, projectRow, channelRow, waits };
}

test('a channel waits out uncommitted changes another channel left, and starts once they are committed', async () => {
  const s = await setup();
  try {
    writeFileSync(join(s.path, 'source.js'), 'export const value = 2;\n');
    const left = s.finish(s.channel.id, 'thread-a');
    assert.deepEqual(left.treeState, { dirty: true, files: ['source.js'] });
    const message = '工作树有频道「自主推进」未提交的改动（1 个文件），等待其提交或清理后再开始';
    // A scheduled start of the other channel waits instead of working on changes it cannot see.
    s.engine.setControl(s.second.id, { enabled: true });
    await s.engine.start(s.second.id, true);
    assert.equal(s.channelRow(s.second.id).status, 'waiting');
    const parked = Date.parse(s.channelRow(s.second.id).nextRunAt) - Date.now();
    assert(parked > 55 * 60000 && parked <= 60 * 60000, `parked for ${parked}ms`);
    assert.equal(s.waits(s.second.id).length, 1);
    assert.equal(s.waits(s.second.id)[0].text, `${message}。`);
    // Every later tick re-checks the same gate; the event is written once per wait, not per tick.
    await s.engine.start(s.second.id, true);
    s.engine.tick();
    assert.equal(s.waits(s.second.id).length, 1);
    assert.equal(s.store.all<Run>('runs').filter((row) => row.channelId === s.second.id).length, 0);
    // A person asking for it directly is told why instead of silently waiting.
    assert.equal((await s.api('POST', `/api/channels/${s.second.id}/action`, { action: 'run' }, 409)).error, message);
    assert.equal(
      (await s.api('POST', `/api/channels/${s.second.id}/action`, { action: 'resume' }, 409)).error,
      message
    );
    assert.equal(s.engine.control(s.second.id).enabled, false);
    assert.equal(s.store.all<Run>('runs').filter((row) => row.channelId === s.second.id).length, 0);
    // The channel that made the changes may continue on them.
    assert.equal(s.engine.treeConflict(s.projectRow(), s.channel.id), undefined);
    // Committing them frees the tree, and the waiting channel starts its own turn.
    git(s.path, 'add', '-A');
    git(s.path, 'commit', '-q', '-m', 'channel A commits its work');
    assert.equal(s.engine.treeConflict(s.projectRow(), s.second.id), undefined);
    s.engine.setControl(s.second.id, { enabled: true });
    await s.engine.start(s.second.id, true);
    const started = s.store.all<Run>('runs').filter((row) => row.channelId === s.second.id);
    assert.equal(started.length, 1);
    assert.equal(started[0].status, 'running');
    assert.equal(s.waits(s.second.id).length, 1);
  } finally {
    await s.cleanup();
  }
});

test('a tree only a human touched blocks nobody, and an unreadable reading blocks nobody either', async () => {
  const s = await setup();
  try {
    // The last scheduled turn of the project left the tree clean.
    assert.deepEqual(s.finish(s.channel.id, 'thread-a').treeState, { dirty: false, files: [] });
    writeFileSync(join(s.path, 'human-note.md'), '# 人手里的改动\n');
    assert.equal(s.engine.treeConflict(s.projectRow(), s.second.id), undefined);
    assert.equal(s.engine.treeConflict(s.projectRow(), s.channel.id), undefined);
    // A dirty turn of one channel still blocks the other, so the clean reading is what freed it.
    const left = s.finish(s.channel.id, 'thread-a');
    assert.deepEqual(left.treeState, { dirty: true, files: ['human-note.md'] });
    assert.equal(
      s.engine.treeConflict(s.projectRow(), s.second.id)?.message,
      '工作树有频道「自主推进」未提交的改动（1 个文件），等待其提交或清理后再开始'
    );
    // A project directory Morrow cannot read as a repository never blocks a channel.
    s.store.put('projects', { ...s.projectRow(), path: s.root });
    assert.equal(s.engine.treeConflict(s.projectRow(), s.second.id), undefined);
  } finally {
    await s.cleanup();
  }
});

test('the turn note names the uncommitted changes and asks the channel that left them to clean up', async () => {
  const s = await setup();
  try {
    for (let index = 0; index < 12; index++) writeFileSync(join(s.path, `change-${index}.txt`), `${index}\n`);
    s.finish(s.channel.id, 'thread-a');
    const own = s.engine.prompt(s.projectRow(), s.channelRow(s.channel.id));
    assert(own.includes('工作树有未提交改动：change-0.txt、change-1.txt'));
    assert(own.includes('等 12 个文件'));
    assert(own.includes('这是本频道上一轮留下的，请在本轮结束前提交或清理，否则别的频道无法开始。'));
    // The rule itself is part of the long-lived charter, not the per-turn line.
    assert(own.includes('项目所有频道共享同一个工作树：本轮结束前提交或清理自己的未提交改动，否则别的频道无法开始。'));
    // Another channel sees the same tree but is not told it left the changes.
    const other = s.engine.prompt(s.projectRow(), s.channelRow(s.second.id));
    assert(other.includes('工作树有未提交改动：change-0.txt、change-1.txt'));
    assert(!other.includes('这是本频道上一轮留下的'));
    // A clean tree adds no line at all.
    git(s.path, 'add', '-A');
    git(s.path, 'commit', '-q', '-m', 'commit the leftovers');
    assert(!s.engine.prompt(s.projectRow(), s.channelRow(s.channel.id)).includes('工作树有未提交改动'));
  } finally {
    await s.cleanup();
  }
});

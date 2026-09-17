import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeCliReviewRunner, claudeReviewArguments, type ReviewStart } from '../service/claude-cli-review.ts';
import type { ReviewObservation, ReviewRunner } from '../service/codex-cli-review.ts';
import { quotaFailure } from '../service/runtimes.ts';
import type { Channel } from '../service/protocol.ts';
import { startIsolated } from './harness/service.ts';
import { grantFor } from './harness/grant.ts';

const executable = resolve('tests/fixtures/claude-review.mjs');
const runner = (maxBytes?: number) =>
  new ClaudeCliReviewRunner({
    executable: () => executable,
    env: { ...process.env, MORROW_SECRET_GRANT: 'must-not-leak', CODEX_APP_TOOLS_PIPE_PATH: '/private/app.sock' },
    maxBytes,
  });
async function run(spec: Record<string, unknown>, options: { maxBytes?: number; isolated?: boolean } = {}) {
  const observations: ReviewObservation[] = [];
  await runner(options.maxBytes).start({
    id: 'fixture-verification',
    cwd: tmpdir(),
    prompt: JSON.stringify(spec),
    timeoutMs: 5000,
    isolated: options.isolated,
    observe: (o) => observations.push(o),
  }).done;
  return observations;
}

test('a review turn may run commands only in a checkout of its own, and the tool list is stated twice', () => {
  const isolated = claudeReviewArguments({ id: 'a', isolated: true });
  const shared = claudeReviewArguments({ id: 'a' });
  for (const args of [isolated, shared]) {
    assert.equal(args[args.indexOf('--tools') + 1], args[args.indexOf('--allowedTools') + 1]);
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(args[args.indexOf('--name') + 1], 'Morrow:review-a');
    assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
    assert(args.includes('--safe-mode') && args.includes('--strict-mcp-config') && args.includes('--print'));
    assert(!args.includes('Read,Grep,Glob,Edit,Write,MultiEdit,NotebookEdit,Bash'));
  }
  assert.equal(isolated[isolated.indexOf('--tools') + 1], 'Read,Grep,Glob,Bash');
  // Without a disposable checkout a review has no shell at all; the old read-only scope stands.
  assert.equal(shared[shared.indexOf('--tools') + 1], 'Read,Grep,Glob');
  assert.equal(shared.includes('--model'), false);
  assert.equal(claudeReviewArguments({ id: 'a', model: 'claude-x' }).at(-1), 'claude-x');
});

test('one Claude review turn becomes the observations a verification counts, and never a file change', async () => {
  const rows = await run({ mode: 'success', tools: 'Read,Grep,Glob,Bash' }, { isolated: true });
  const last = rows.at(-1)!;
  assert.equal(last.status, 'completed', last.error);
  assert.equal(last.threadId, 'fixture-claude-session');
  assert.equal(last.turnId, undefined);
  // Thinking is not an observation; the answer, the tool call and the final report are.
  assert.deepEqual(
    last.items.map((item) => item.type),
    ['agentMessage', 'commandExecution', 'agentMessage']
  );
  const [said, command, final] = last.items;
  assert.equal(said.text, '先自己重跑一次测试。');
  assert.equal(said.phase, undefined);
  assert.equal(command.status, 'completed');
  assert.equal(command.exitCode, 0);
  assert.equal(command.aggregatedOutput, '1 test passed');
  assert.match(command.command, /^Bash \{"command":"npm test"/);
  assert.equal(command.cwd, tmpdir());
  // The verdict is read from the last final answer, so the whole block has to be in one item.
  assert.equal(final.phase, 'final_answer');
  assert.equal([...final.text.matchAll(/```morrow-verification/g)].length, 1);
  assert.equal(
    last.items.some((item) => item.type === 'fileChange'),
    false
  );
});

test('a tool the runtime refused is recorded as a failed command, not as a check that ran', async () => {
  const last = (await run({ mode: 'refused' }, { isolated: true })).at(-1)!;
  assert.equal(last.status, 'completed', last.error);
  const command = last.items.find((item) => item.type === 'commandExecution')!;
  assert.equal(command.exitCode, 1);
  assert.equal(command.aggregatedOutput, 'Permission denied');
});

test('an unfinished, unreadable, oversized or failing turn concludes nothing', async () => {
  for (const mode of ['no-result', 'malformed', 'oversized', 'nonzero', 'error-result']) {
    const last = (await run({ mode }, { maxBytes: mode === 'oversized' ? 2048 : undefined })).at(-1)!;
    assert.equal(last.status, 'failed', mode);
    assert(last.error, mode);
  }
});

test("a spent Claude account is reported in the CLI's own words, which the quota rule recognises", async () => {
  const last = (await run({ mode: 'error-result', error: 'Claude usage limit reached. Your limit resets at 3pm.' })).at(
    -1
  )!;
  assert.equal(last.status, 'failed');
  assert.match(last.error!, /usage limit reached/);
  assert.equal(quotaFailure.test(last.error!), true);
});

/**
 * Which CLI reviews which work. The rule is `WorkVerification.reviewRunner`: never the runtime that
 * did the work, and Claude Code wherever it is allowed, because a review on it spends no Codex
 * quota. Nothing below starts a CLI; each runner is scripted.
 */
const scriptedRunner = () => {
  const seen: ReviewStart[] = [];
  const state: { error?: string } = {};
  const runner: ReviewRunner = {
    start: (input) => {
      seen.push(input as ReviewStart);
      return {
        cancel: () => {},
        done: Promise.resolve().then(() =>
          input.observe({
            threadId: 'scripted-session',
            items: state.error
              ? []
              : [
                  {
                    id: 'check',
                    type: 'commandExecution',
                    command: 'Read {}',
                    cwd: input.cwd,
                    status: 'completed',
                    exitCode: 0,
                    aggregatedOutput: 'read',
                  },
                  {
                    id: 'final',
                    type: 'agentMessage',
                    phase: 'final_answer',
                    text:
                      '```morrow-verification\n' +
                      JSON.stringify({
                        verdict: 'pass',
                        summary: '脚本化复核完成',
                        checks: [{ expectationId: 'feature', verdict: 'met', reason: 'scripted' }],
                        findings: [],
                        limitations: ['scripted'],
                      }) +
                      '\n```',
                  },
                ],
            status: state.error ? 'failed' : 'completed',
            ...(state.error ? { error: state.error } : {}),
          })
        ),
      };
    },
  };
  return { seen, state, runner };
};
/** A project with one item and a way to ask for a fresh review each time the source changes. */
async function selectionFixture() {
  const s = await startIsolated({
    scheduler: false,
    project: { name: '复核运行时', goal: '复核不花执行者的额度', files: { 'source.js': 'export const value=1;\n' } },
  });
  // A model of the implementer's runtime, so a review on the other one cannot be handed it.
  s.store.put('channels', { ...s.store.get<Channel>('channels', s.channel.id)!, model: 'gpt-5-codex' });
  const { call } = grantFor(s, { projectId: s.project.id, channelId: s.channel.id });
  const item = await call('feature.upsert', {
    title: '选择复核运行时',
    summary: '复核不能与执行者同一运行时',
    kind: 'feature',
    status: 'investigating',
    evidenceIds: [],
    nextStep: '请求复核',
  });
  let round = 0;
  /** New source and new evidence, so each call is material of its own rather than the same attempt. */
  const request = async () => {
    const name = `note-${round++}.json`;
    writeFileSync(join(s.path, name), JSON.stringify({ value: round }));
    const evidence = await call('evidence.capture', { summary: '实际文件内容', path: name });
    return call('verification.request', { itemId: item.id, evidenceIds: [evidence.id] });
  };
  const runtime = (value: Channel['runtime']) => {
    const channel = s.store.get<Channel>('channels', s.channel.id)!;
    s.store.put('channels', { ...channel, runtime: value });
  };
  return Object.assign(s, { call, request, runtime });
}

test('a review runs on the runtime that did not do the work, and the row records which one', async () => {
  const f = await selectionFixture();
  const claudePath = process.env.MORROW_TEST_CLAUDE_PATH;
  try {
    const codex = scriptedRunner(),
      claude = scriptedRunner();
    f.engine.loop.verification.runners.clear();
    f.engine.loop.verification.connectRunner(codex.runner, 'codex-cli');
    f.engine.loop.verification.connectRunner(claude.runner, 'claude-cli');
    // The implementer is a Codex channel, so the review is Claude Code's, and no Codex quota is spent.
    const first = await f.request();
    await f.engine.loop.verification.start(first.id);
    assert.equal(f.store.get<any>('loop_verifications', first.id).executionOwner, 'claude-cli');
    assert.equal(claude.seen.length, 1);
    assert.equal(codex.seen.length, 0);
    // A Codex channel's model belongs to Codex; the review takes the default of the CLI it runs on.
    assert.equal(f.store.get<Channel>('channels', f.channel.id)!.model, 'gpt-5-codex');
    assert.equal(claude.seen[0].model, undefined);
    assert.equal(claude.seen[0].id, first.id);
    // A plain project directory is no checkout, so this review may still not run anything that writes.
    assert.equal(claude.seen[0].isolated, false);
    // The other direction: work done by Claude Code is reviewed by Codex, with the channel's model.
    f.runtime('claude');
    const second = await f.request();
    await f.engine.loop.verification.start(second.id);
    assert.equal(f.store.get<any>('loop_verifications', second.id).executionOwner, 'codex-cli');
    assert.equal(codex.seen.length, 1);
    assert.equal(claude.seen.length, 1);
    assert.equal(codex.seen[0].model, undefined);
    // Claude Code is not installed here: a Codex channel falls back to the Codex review it had.
    f.runtime('codex');
    delete process.env.MORROW_TEST_CLAUDE_PATH;
    const third = await f.request();
    await f.engine.loop.verification.start(third.id);
    assert.equal(f.store.get<any>('loop_verifications', third.id).executionOwner, 'codex-cli');
    assert.equal(codex.seen.length, 2);
    assert.equal(codex.seen[1].model, 'gpt-5-codex');
  } finally {
    if (claudePath) process.env.MORROW_TEST_CLAUDE_PATH = claudePath;
    await f.cleanup();
  }
});

test('the Codex usage gate holds only the reviews that spend the Codex account', async () => {
  const f = await selectionFixture();
  try {
    const codex = scriptedRunner(),
      claude = scriptedRunner();
    const until = new Date(Date.now() + 90 * 60_000).toISOString();
    f.engine.usage.noteAccountExhausted(until);
    assert.equal(f.engine.usage.gate(f.store.get<any>('projects', f.project.id)).blocked, true);
    f.engine.loop.verification.runners.clear();
    f.engine.loop.verification.connectRunner(codex.runner, 'codex-cli');
    f.engine.loop.verification.connectRunner(claude.runner, 'claude-cli');
    // The Codex account is spent; a review that does not spend it runs anyway.
    const first = await f.request();
    await f.engine.loop.verification.start(first.id);
    assert.equal(f.store.get<any>('loop_verifications', first.id).status, 'passed');
    assert.equal(claude.seen.length, 1);
    // With only the Codex review available, the same gate holds it queued for its retry.
    f.engine.loop.verification.runners.clear();
    f.engine.loop.verification.connectRunner(codex.runner, 'codex-cli');
    const second = await f.request();
    await f.engine.loop.verification.start(second.id);
    const held = f.store.get<any>('loop_verifications', second.id);
    assert.equal(held.status, 'queued');
    assert.equal(held.usageWait.kind, 'account');
    assert.equal(codex.seen.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("a Claude review's own spent account waits on its own row and stops no Codex work", async () => {
  const f = await selectionFixture();
  try {
    const codex = scriptedRunner(),
      claude = scriptedRunner();
    claude.state.error = 'Claude usage limit reached. Your limit resets at 3pm.';
    f.engine.loop.verification.runners.clear();
    f.engine.loop.verification.connectRunner(codex.runner, 'codex-cli');
    f.engine.loop.verification.connectRunner(claude.runner, 'claude-cli');
    const request = await f.request();
    await f.engine.loop.verification.start(request.id);
    const row = f.store.get<any>('loop_verifications', request.id);
    // The review itself waits and is re-queued, exactly as a spent Codex account is handled.
    assert.equal(row.status, 'unknown');
    assert.equal(row.usageWait.kind, 'account');
    assert(row.retryAt > new Date().toISOString());
    assert.equal(row.executionOwner, 'claude-cli');
    // But the Codex account is untouched: no Codex turn or review is held by someone else's limit.
    assert.equal(f.engine.usage.exhaustedUntil, '');
    assert.equal(f.engine.usage.gate(f.store.get<any>('projects', f.project.id)).blocked, false);
  } finally {
    await f.cleanup();
  }
});

#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
function publishPid(path) {
  // A deadline may interrupt any instruction: an existing marker must contain the complete PID.
  writeFileSync(path + '.tmp', String(process.pid));
  renameSync(path + '.tmp', path);
}
const args = process.argv.slice(2);
if (args[0] === 'app-server') {
  const seen = [];
  for await (const text of createInterface({ input: process.stdin })) {
    const r = JSON.parse(text);
    seen.push(r.method);
    if (r.method === 'initialize')
      console.log(JSON.stringify({ id: r.id, result: { userAgent: 'fixture', codexHome: '/fixture' } }));
    else if (r.method === 'account/rateLimits/read') {
      assert.deepEqual(seen, ['initialize', 'initialized', 'account/rateLimits/read']);
      console.log(
        JSON.stringify({
          id: r.id,
          result: { rateLimits: { primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: 1800000000 } } },
        })
      );
    } else assert.equal(r.method, 'initialized');
  }
} else {
  assert.equal(args[0], 'exec');
  for (const flag of ['--json', '--ephemeral', '--ignore-user-config', '--ignore-rules']) assert(args.includes(flag));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert(args.includes('approval_policy="never"'));
  assert.equal(process.env.MORROW_SECRET_GRANT, undefined);
  assert.equal(process.env.CODEX_APP_TOOLS_PIPE_PATH, undefined);
  let input = '';
  for await (const c of process.stdin) input += c;
  let spec;
  try {
    spec = JSON.parse(input);
  } catch {
    spec = { mode: process.env.REVIEW_FIXTURE_MODE || 'success' };
  }
  const mode = spec.mode || 'success';
  if (spec.spawnedPidFile) publishPid(spec.spawnedPidFile);
  if (mode === 'initializing') {
    // Hold initialization indefinitely: only the supervisor deadline or explicit cleanup can end it.
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  const emit = (value) => console.log(JSON.stringify(value));
  emit({ type: 'thread.started', thread_id: 'fixture-cli-session' });
  emit({ type: 'turn.started' });
  if (mode === 'hang') {
    if (spec.pidFile) publishPid(spec.pidFile);
    setInterval(() => {}, 1000);
  } else if (mode === 'malformed') console.log('not a JSON event');
  else if (mode === 'oversized') process.stdout.write('x'.repeat(10000));
  else {
    emit({
      type: 'item.completed',
      item: {
        id: 'check',
        type: 'command_execution',
        command: 'read-only fixture',
        status: 'completed',
        aggregated_output: 'fixture checked',
        exit_code: 0,
      },
    });
    if (mode === 'file-change')
      emit({
        type: 'item.completed',
        item: { id: 'write', type: 'file_change', changes: [{ path: 'source.js' }], status: 'completed' },
      });
    let expected = ['feature'];
    try {
      const subject = JSON.parse(input.split('原始核验对象：')[1].split('\n')[0]);
      expected = subject.decision?.expectations?.map((e) => e.id) || expected;
    } catch {}
    const report = {
      verdict: 'pass',
      summary: '合成 CLI 夹具核验完成',
      checks: expected.map((expectationId) => ({ expectationId, verdict: 'met', reason: 'fixture check' })),
      findings: [],
      limitations: ['fixture only'],
    };
    emit({
      type: 'item.completed',
      item: {
        id: 'answer',
        type: 'agent_message',
        text: '```morrow-verification\n' + JSON.stringify(report) + '\n```',
      },
    });
    if (mode !== 'missing-completion') emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    if (mode === 'nonzero') process.exitCode = 9;
  }
}

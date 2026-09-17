#!/usr/bin/env node
import assert from 'node:assert/strict';

/**
 * Synthetic Claude Code `stream-json` output for one review. No model runs and nothing is read from
 * the working directory: the lines below are the shapes the real CLI emits, so the runner's mapping
 * can be tested without spending an account. The mode arrives in the prompt on stdin.
 */
const args = process.argv.slice(2);
for (const flag of ['--print', '--verbose', '--safe-mode', '--strict-mcp-config']) assert(args.includes(flag));
assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
assert.match(args[args.indexOf('--name') + 1], /^Morrow:review-/);
const tools = args[args.indexOf('--tools') + 1];
assert.equal(tools, args[args.indexOf('--allowedTools') + 1]);
// The implementer's grant and the App's local tool pipe must not reach a review.
assert.equal(process.env.MORROW_SECRET_GRANT, undefined);
assert.equal(process.env.CODEX_APP_TOOLS_PIPE_PATH, undefined);

let input = '';
for await (const chunk of process.stdin) input += chunk;
let spec;
try {
  spec = JSON.parse(input);
} catch {
  spec = { mode: process.env.REVIEW_FIXTURE_MODE || 'success' };
}
const mode = spec.mode || 'success';
if (spec.tools) assert.equal(tools, spec.tools);
const session = 'fixture-claude-session';
const emit = (value) => console.log(JSON.stringify(value));
emit({ type: 'system', subtype: 'init', session_id: session, model: 'fixture-model', tools: tools.split(',') });
if (mode === 'hang') {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (mode === 'malformed') {
  console.log('not a JSON event');
  process.exit(0);
}
if (mode === 'oversized') {
  process.stdout.write('x'.repeat(10000));
  process.exit(0);
}
// Extended thinking: no answer and no tool call, so it is not an observation of anything.
emit({ type: 'assistant', session_id: session, message: { id: 'msg_think', content: [{ type: 'thinking' }] } });
emit({
  type: 'assistant',
  session_id: session,
  message: {
    id: 'msg_tool',
    content: [
      { type: 'text', text: '先自己重跑一次测试。' },
      { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'npm test', description: '重跑测试' } },
    ],
  },
});
emit({
  type: 'user',
  session_id: session,
  message: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tool_1',
        ...(mode === 'refused' ? { is_error: true } : {}),
        content: [{ type: 'text', text: mode === 'refused' ? 'Permission denied' : '1 test passed' }],
      },
    ],
  },
});
if (mode === 'no-result') process.exit(0);
let expected = ['feature'];
try {
  expected =
    JSON.parse(input.split('原始核验对象：')[1].split('\n')[0]).decision?.expectations?.map((e) => e.id) || expected;
} catch {}
const report = {
  verdict: 'pass',
  summary: '合成 Claude 夹具核验完成',
  checks: expected.map((expectationId) => ({ expectationId, verdict: 'met', reason: 'fixture check' })),
  findings: [],
  limitations: ['fixture only'],
};
const failing = mode === 'error-result';
emit({
  type: 'result',
  subtype: failing ? 'error_during_execution' : 'success',
  is_error: failing,
  session_id: session,
  duration_ms: 1,
  result: failing
    ? spec.error || 'Claude usage limit reached'
    : '```morrow-verification\n' + JSON.stringify(report) + '\n```',
});
if (mode === 'nonzero') process.exitCode = 9;

import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeLine } from '../service/runtimes.ts';
import { sanitizeEventDetail } from '../service/event-details.ts';

test('Codex and Trae command lifecycle retains original text with structured identity and output', () => {
  const start = {
    type: 'item.started',
    item: { id: 'cmd-1', type: 'command_execution', command: 'cat README.md', status: 'in_progress' },
  };
  const decodedStart = decodeLine(JSON.stringify(start));
  assert.equal(decodedStart.text, JSON.stringify(start));
  assert.deepEqual(decodedStart.detail, {
    type: 'tool_use',
    tool: 'shell',
    input: { command: 'cat README.md' },
    status: 'in_progress',
    toolCallId: 'cmd-1',
  });
  const finish = {
    type: 'item.completed',
    item: { ...start.item, status: 'completed', aggregated_output: '中文说明\n', exit_code: 0 },
  };
  const decodedFinish = decodeLine(JSON.stringify(finish));
  assert.equal(decodedFinish.detail?.type, 'tool_result');
  assert.equal(decodedFinish.detail?.output, '中文说明\n');
  assert.equal(decodedFinish.detail?.toolCallId, 'cmd-1');
  assert.equal(decodedFinish.kind, 'tool');
  assert.equal(
    decodeLine(JSON.stringify({ ...finish, item: { ...finish.item, exit_code: 2 } })).detail?.status,
    'failed'
  );
});

test('tool adapters normalize MCP calls, local file changes, and every Claude tool block', () => {
  const mcp = decodeLine(
    JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'mcp-1',
        type: 'mcp_tool_call',
        server: 'local',
        tool: 'inspect',
        arguments: { path: 'a.txt' },
        result: { text: 'done' },
        status: 'completed',
      },
    })
  );
  assert.equal(mcp.detail?.tool, 'local.inspect');
  assert.deepEqual(mcp.detail?.input, { path: 'a.txt' });
  const file = decodeLine(
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'patch', type: 'file_change', changes: [{ path: 'a.txt', kind: 'update' }] },
    })
  );
  assert.equal(file.detail?.tool, 'apply_patch');
  const assistant = decodeLine(
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '检查两个文件。' },
          { type: 'tool_use', id: 'a', name: 'Read', input: { path: 'a.txt' } },
          { type: 'tool_use', id: 'b', name: 'Grep', input: { pattern: 'TODO' } },
        ],
      },
    })
  );
  assert.equal(assistant.text, '检查两个文件。');
  assert.equal(assistant.detail?.toolCallId, 'a');
  assert.equal(assistant.additionalDetails?.length, 1);
  assert.equal(assistant.additionalDetails?.[0].tool, 'Grep');
  const result = decodeLine(
    JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'a',
            content: [{ type: 'text', text: 'file contents' }],
            is_error: false,
          },
          { type: 'tool_result', tool_use_id: 'b', content: 'No access', is_error: true },
        ],
      },
    })
  );
  assert.equal(result.kind, 'tool');
  assert.equal(result.detail?.type, 'tool_result');
  assert.deepEqual(result.detail?.output, [{ type: 'text', text: 'file contents' }]);
  assert.equal(result.additionalDetails?.[0].status, 'failed');
  assert.equal(result.error, false, 'a failed tool is not a failed run');
});

test('unstructured and primitive legacy log lines retain text without invented tool metadata', () => {
  for (const line of ['plain legacy log', 'null', '23', '[]']) {
    const decoded = decodeLine(line);
    assert.equal(decoded.text, line);
    assert.equal(decoded.detail, undefined);
  }
  assert.doesNotThrow(() =>
    decodeLine(JSON.stringify({ type: 'assistant', message: { content: [null, 7, { type: 'text', text: null }] } }))
  );
  const assistant = decodeLine(
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final response' } })
  );
  assert.equal(assistant.finalText, 'final response');
  assert.equal(assistant.detail, undefined);
});

test('Claude progress chatter is skipped and the session announcement becomes one summary line', () => {
  // Shapes taken from a real Claude Code 2.1.236 stream-json turn, where a thinking-token tally
  // arrived about once a second and made up most of the log.
  const noise = [
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 140, session_id: 'live-1' },
    // Every turn carries these, and almost always only to say the account is still fine.
    {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' },
      session_id: 'live-1',
    },
    {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day' },
      session_id: 'live-1',
    },
    { type: 'tool_progress', tool_use_id: 'read-a', session_id: 'live-1' },
    {
      type: 'assistant',
      session_id: 'live-1',
      message: { content: [{ type: 'thinking', thinking: '先看一遍改动。' }] },
    },
  ];
  for (const event of noise) {
    const decoded = decodeLine(JSON.stringify(event));
    assert.equal(decoded.skip, true, `${event.type} 应跳过事件`);
    assert.equal(decoded.detail, undefined);
    assert.equal(decoded.sessionId, 'live-1');
  }
  // A limit that actually bit is not chatter: it stays visible, and stays readable by the failure
  // diagnosis, which only ever sees lines the engine did not skip.
  const refused = decodeLine(
    JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' },
      session_id: 'live-1',
    })
  );
  assert.equal(refused.skip, undefined);
  assert.equal(refused.kind, 'system');
  assert.equal(refused.text, '速率限制：rejected（five_hour）');
  assert.equal(refused.sessionId, 'live-1');
  // An unreadable notice is never assumed to be the harmless kind.
  const bare = decodeLine(JSON.stringify({ type: 'rate_limit_event', uuid: 'x' }));
  assert.equal(bare.skip, undefined);
  assert.equal(bare.text, JSON.stringify({ type: 'rate_limit_event', uuid: 'x' }));
  assert.equal(decodeLine(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {} })).skip, undefined);
  // A thinking block next to real content is still one ordinary assistant or tool line.
  const answered = decodeLine(
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'x' },
          { type: 'text', text: '已完成。' },
        ],
      },
    })
  );
  assert.equal(answered.skip, undefined);
  assert.equal(answered.text, '已完成。');
  const init = decodeLine(
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: '420e096f-f0eb-4d56-ab29-5abb7dc5f9bc',
      model: 'claude-opus-5[1m]',
      permissionMode: 'acceptEdits',
      tools: ['Read', 'Grep', 'Bash'],
      slash_commands: ['deep-research', 'verify'],
      skills: ['a', 'b'],
      cwd: '/tmp/project',
    })
  );
  assert.equal(init.skip, undefined);
  assert.equal(init.kind, 'system');
  assert.equal(init.sessionId, '420e096f-f0eb-4d56-ab29-5abb7dc5f9bc');
  assert.equal(init.text, '会话已开始 · 模型 claude-opus-5[1m] · 权限 acceptEdits · 工具 Read / Grep / Bash');
  // Missing fields drop their own segment instead of printing an empty one.
  assert.equal(decodeLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'bare' })).text, '会话已开始');
  assert.equal(
    decodeLine(JSON.stringify({ type: 'system', subtype: 'init', permissionMode: 'dontAsk', tools: [] })).text,
    '会话已开始 · 权限 dontAsk'
  );
  // Codex `exec --json` keeps its own event shapes.
  assert.equal(decodeLine(JSON.stringify({ type: 'thread.started', thread_id: 't-1' })).skip, undefined);
  assert.equal(decodeLine(JSON.stringify({ type: 'turn.completed' })).terminalOutcome, 'completed');
  assert.equal(
    decodeLine(JSON.stringify({ type: 'item.started', item: { id: 'c', type: 'command_execution', command: 'ls' } }))
      .skip,
    undefined
  );
});

test('Claude background task notices read as the task starting and ending, never as raw JSON', () => {
  // Both lines are verbatim from a real Claude Code turn, with ids shortened: one background Bash
  // task, announced when it starts and again when it ends. The Bash call itself is a separate log
  // entry, so neither of these repeats the command.
  const started = decodeLine(
    JSON.stringify({
      type: 'system',
      subtype: 'task_started',
      task_id: 'bwnbmyovp',
      tool_use_id: 'toolu_01D9',
      description: 'Run UI test suite with one worker',
      task_type: 'local_bash',
      uuid: '6c0c',
      session_id: '42c9',
    })
  );
  assert.equal(started.skip, undefined, '后台任务事件有信息量，不属于被跳过的进度噪声');
  // Shown like any other event, but marked: the wording is the model's own name for the task, so
  // `service/engine.ts` keeps it out of the failure diagnosis.
  assert.equal(started.backgroundTask, true);
  assert.equal(started.kind, 'system');
  assert.equal(started.sessionId, '42c9');
  assert.equal(started.detail, undefined);
  assert.equal(started.text, '后台任务已开始 · Run UI test suite with one worker');
  const finished = decodeLine(
    JSON.stringify({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'bwnbmyovp',
      tool_use_id: 'toolu_01D9',
      status: 'completed',
      output_file: '',
      summary: 'Run UI test suite with one worker',
      uuid: '8a9a',
      session_id: '42c9',
    })
  );
  assert.equal(finished.skip, undefined);
  assert.equal(finished.backgroundTask, true);
  assert.equal(finished.kind, 'system');
  assert.equal(finished.sessionId, '42c9');
  assert.equal(finished.text, '后台任务已完成 · Run UI test suite with one worker');
  // A failure says so, and an unfamiliar status is quoted rather than assumed to be success.
  assert.equal(
    decodeLine(
      JSON.stringify({ type: 'system', subtype: 'task_notification', status: 'failed', summary: '构建后台任务' })
    ).text,
    '后台任务失败 · 构建后台任务'
  );
  assert.equal(
    decodeLine(JSON.stringify({ type: 'system', subtype: 'task_notification', status: 'killed', summary: '长跑脚本' }))
      .text,
    '后台任务已结束（killed） · 长跑脚本'
  );
  // Missing or mistyped fields drop their own part; none of them puts the raw line back in the log.
  for (const [line, text] of [
    [{ type: 'system', subtype: 'task_started' }, '后台任务已开始'],
    [{ type: 'system', subtype: 'task_started', description: 42, session_id: 'x' }, '后台任务已开始'],
    [{ type: 'system', subtype: 'task_notification', task_id: 'b' }, '后台任务已结束'],
    [{ type: 'system', subtype: 'task_notification', status: '', summary: null }, '后台任务已结束'],
    [{ type: 'system', subtype: 'task_started', description: ' 跑一遍\n UI 用例 ' }, '后台任务已开始 · 跑一遍 UI 用例'],
  ] as const) {
    const decoded = decodeLine(JSON.stringify(line));
    assert.equal(decoded.text, text);
    assert.equal(decoded.kind, 'system');
    assert.equal(decoded.skip, undefined);
  }
});

test('structured payloads redact bearer and credential fields, strip controls, bound nesting/size and ignore provider sequence', () => {
  const bearer = 'f'.repeat(64);
  const detail = sanitizeEventDetail(
    {
      type: 'tool_result',
      tool: `Read ${bearer}`,
      input: { apiKey: 'other-secret', nested: { note: bearer }, control: 'a\u0000b' },
      output: Array.from({ length: 100 }, () => 'x'.repeat(9000)),
      sequence: 900000,
    },
    (text) => text.replaceAll(bearer, '[REDACTED]')
  )!;
  const serialized = JSON.stringify(detail);
  assert(!serialized.includes(bearer));
  assert(!serialized.includes('other-secret'));
  assert(!serialized.includes('\\u0000'));
  assert(serialized.length < 16000);
  assert.equal(detail.sequence, undefined);
  assert(serialized.includes('Truncated'));
  const circular: any = {};
  circular.self = circular;
  assert.doesNotThrow(() => sanitizeEventDetail({ type: 'tool_use', input: circular }, (x) => x));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeLine } from '../service/runtimes.ts';
import { sanitizeEventDetail } from '../service/event-details.ts';

test('Codex and Trae command lifecycle retains original text with structured identity and output', () => {
  const start = { type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'cat README.md', status: 'in_progress' } };
  const decodedStart = decodeLine(JSON.stringify(start));
  assert.equal(decodedStart.text, JSON.stringify(start));
  assert.deepEqual(decodedStart.detail, { type: 'tool_use', tool: 'shell', input: { command: 'cat README.md' }, status: 'in_progress', toolCallId: 'cmd-1' });
  const finish = { type: 'item.completed', item: { ...start.item, status: 'completed', aggregated_output: '中文说明\n', exit_code: 0 } };
  const decodedFinish = decodeLine(JSON.stringify(finish));
  assert.equal(decodedFinish.detail?.type, 'tool_result');
  assert.equal(decodedFinish.detail?.output, '中文说明\n');
  assert.equal(decodedFinish.detail?.toolCallId, 'cmd-1');
  assert.equal(decodedFinish.kind, 'tool');
  assert.equal(decodeLine(JSON.stringify({ ...finish, item: { ...finish.item, exit_code: 2 } })).detail?.status, 'failed');
});

test('tool adapters normalize MCP calls, local file changes, and every Claude tool block', () => {
  const mcp = decodeLine(JSON.stringify({ type: 'item.completed', item: { id: 'mcp-1', type: 'mcp_tool_call', server: 'local', tool: 'inspect', arguments: { path: 'a.txt' }, result: { text: 'done' }, status: 'completed' } }));
  assert.equal(mcp.detail?.tool, 'local.inspect'); assert.deepEqual(mcp.detail?.input, { path: 'a.txt' });
  const file = decodeLine(JSON.stringify({ type: 'item.completed', item: { id: 'patch', type: 'file_change', changes: [{ path: 'a.txt', kind: 'update' }] } }));
  assert.equal(file.detail?.tool, 'apply_patch');
  const assistant = decodeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '检查两个文件。' }, { type: 'tool_use', id: 'a', name: 'Read', input: { path: 'a.txt' } }, { type: 'tool_use', id: 'b', name: 'Grep', input: { pattern: 'TODO' } }] } }));
  assert.equal(assistant.text, '检查两个文件。');
  assert.equal(assistant.detail?.toolCallId, 'a');
  assert.equal(assistant.additionalDetails?.length, 1);
  assert.equal(assistant.additionalDetails?.[0].tool, 'Grep');
  const result = decodeLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'file contents' }], is_error: false }, { type: 'tool_result', tool_use_id: 'b', content: 'No access', is_error: true }] } }));
  assert.equal(result.kind, 'tool'); assert.equal(result.detail?.type, 'tool_result');
  assert.deepEqual(result.detail?.output, [{ type: 'text', text: 'file contents' }]);
  assert.equal(result.additionalDetails?.[0].status, 'failed');
  assert.equal(result.error, false, 'a failed tool is not a failed run');
});

test('unstructured and primitive legacy log lines retain text without invented tool metadata', () => {
  for (const line of ['plain legacy log', 'null', '23', '[]']) {
    const decoded = decodeLine(line); assert.equal(decoded.text, line); assert.equal(decoded.detail, undefined);
  }
  assert.doesNotThrow(() => decodeLine(JSON.stringify({ type: 'assistant', message: { content: [null, 7, { type: 'text', text: null }] } })));
  const assistant = decodeLine(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final response' } }));
  assert.equal(assistant.finalText, 'final response'); assert.equal(assistant.detail, undefined);
});

test('structured payloads redact bearer and credential fields, strip controls, bound nesting/size and ignore provider sequence', () => {
  const bearer = 'f'.repeat(64);
  const detail = sanitizeEventDetail({ type: 'tool_result', tool: `Read ${bearer}`, input: { apiKey: 'other-secret', nested: { note: bearer }, control: 'a\u0000b' }, output: Array.from({ length: 100 }, () => 'x'.repeat(9000)), sequence: 900000 }, text => text.replaceAll(bearer, '[REDACTED]'))!;
  const serialized = JSON.stringify(detail);
  assert(!serialized.includes(bearer)); assert(!serialized.includes('other-secret'));
  assert(!serialized.includes('\\u0000')); assert(serialized.length < 16000);
  assert.equal(detail.sequence, undefined); assert(serialized.includes('Truncated'));
  const circular: any = {}; circular.self = circular;
  assert.doesNotThrow(() => sanitizeEventDetail({ type: 'tool_use', input: circular }, x => x));
});

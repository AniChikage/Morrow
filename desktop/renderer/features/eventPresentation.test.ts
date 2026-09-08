import { describe, expect, it } from 'vitest';
import type { WorkspaceEvent } from '../../shared/types';
import { readableEventText, toolPresentation } from './eventPresentation';
function event(patch: Partial<WorkspaceEvent>): WorkspaceEvent {
  return { id: 'event-one', channelId: 'channel-one', runId: 'run-one', kind: 'tool', text: '', createdAt: '2026-09-07T00:00:00.000Z', ...patch };
}
describe('provider event compatibility', () => {
  it('shows a structured shell command and output without its transport envelope', () => {
    const result = toolPresentation(event({ text: '{"provider":"raw envelope"}', detail: { type: 'tool_result', tool: 'shell', input: { command: 'rg -n retry src' }, output: 'src/import.ts:44: retry()', status: 'completed', sequence: 3 } }));
    expect(result).toEqual({ name: 'shell', input: 'rg -n retry src', output: 'src/import.ts:44: retry()', status: 'completed' });
  });
  it('renders nameless Claude tool results, including text blocks and errors', () => {
    const result = toolPresentation(event({ detail: { type: 'tool_result', output: [{ type: 'text', text: 'Permission denied' }, { type: 'text', text: 'Workspace is read-only' }], status: 'failed', toolCallId: 'call-1' } }));
    expect(result?.name).toBe('工具结果');
    expect(result?.output).toBe('Permission denied\nWorkspace is read-only');
    expect(result?.status).toBe('failed');
  });
  it('decodes the legacy Codex command format still present in saved databases', () => {
    const result = toolPresentation(event({ text: JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test', aggregated_output: '12 tests passed', status: 'completed', exit_code: 0 } }) }));
    expect(result).toEqual({ name: '终端命令', input: 'npm test', output: '12 tests passed', status: 'completed' });
  });
  it('decodes legacy Claude tool calls and tool result messages', () => {
    const call = toolPresentation(event({ text: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/project/README.md' } }] } }) }));
    expect(call?.name).toBe('Read');
    expect(call?.input).toContain('/project/README.md');
    const result = toolPresentation(event({ text: JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'missing file' }], is_error: true }] } }) }));
    expect(result?.output).toBe('missing file');
    expect(result?.status).toBe('failed');
  });
  it('keeps malformed or unknown logs inspectable instead of discarding them', () => {
    const raw = '{"type":"tool", broken provider output';
    expect(toolPresentation(event({ text: raw }))?.output).toBe(raw);
    expect(readableEventText(event({ kind: 'assistant', text: 'A plain text finding.' }))).toBe('A plain text finding.');
    expect(readableEventText(event({ kind: 'assistant', text: '{"unrecognized":"retain me"}' }))).toBe('{"unrecognized":"retain me"}');
  });
  it('extracts a readable agent answer from legacy envelopes while preserving Markdown', () => {
    const answer = '## Result\n\nThe retry is **not idempotent**.';
    expect(readableEventText(event({ kind: 'assistant', text: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: answer } }) }))).toBe(answer);
    expect(readableEventText(event({ kind: 'result', text: JSON.stringify({ summary: answer, items: [] }) }))).toBe(answer);
  });
});

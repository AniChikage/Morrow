import type { WorkspaceEvent } from '../../shared/types';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
const text = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  const object = record(value);
  if (typeof object?.command === 'string') return object.command;
  if (Array.isArray(value) && value.every(part => record(part)?.type === 'text')) return value.map(part => text(record(part)?.text)).join('\n');
  return JSON.stringify(value, null, 2);
};
export interface ToolPresentation { name: string; input: string; output: string; status: string }
export function toolPresentation(event: WorkspaceEvent): ToolPresentation | undefined {
  if ((event.detail && ['tool', 'tool_use', 'tool_result'].includes(event.detail.type)) || event.detail?.tool) {
    return { name: event.detail.tool || (event.detail.type === 'tool_result' ? '工具结果' : '工具调用'), input: text(event.detail.input), output: text(event.detail.output), status: event.detail.status || '' };
  }
  let parsed: RecordValue | undefined;
  try { parsed = record(JSON.parse(event.text)); } catch { /* Plain text logs remain visible. */ }
  if (!parsed) return event.kind === 'tool' ? { name: '工具日志', input: '', output: event.text, status: '' } : undefined;
  const item = record(parsed.item) || record(parsed.tool) || parsed;
  const type = text(item.type || parsed.type);
  const message = record(parsed.message);
  const contents = message?.content;
  const toolUse = Array.isArray(contents) ? contents.map(record).find(c => c?.type === 'tool_use' || c?.type === 'tool_result') : undefined;
  if (toolUse) return { name: text(toolUse.name) || (toolUse.type === 'tool_result' ? '工具结果' : '工具调用'), input: text(toolUse.input), output: text(toolUse.content), status: toolUse.is_error ? 'failed' : '' };
  if (event.kind === 'tool' || /command_execution|tool_call|tool_result|function_call|mcp_tool/.test(type)) {
    return { name: text(item.tool || item.name || (item.command ? '终端命令' : '工具调用')), input: text(item.command || item.arguments || item.input || item.parameters), output: text(item.aggregated_output || item.output || item.result), status: text(item.status || parsed.status) };
  }
  return undefined;
}
export function readableEventText(event: WorkspaceEvent): string {
  let parsed: RecordValue | undefined;
  try { parsed = record(JSON.parse(event.text)); } catch { return event.text; }
  if (!parsed) return event.text;
  const item = record(parsed.item);
  if (typeof item?.text === 'string') return item.text;
  if (typeof parsed.summary === 'string') return parsed.summary;
  if (typeof parsed.result === 'string') return parsed.result;
  if (typeof parsed.text === 'string') return parsed.text;
  const message = record(parsed.message);
  if (Array.isArray(message?.content)) {
    const pieces = message.content.map(record).filter(Boolean).map(part => typeof part?.text === 'string' ? part.text : '').filter(Boolean);
    if (pieces.length) return pieces.join('\n\n');
  }
  return event.text;
}

import type { EventDetail } from './protocol.ts';

/** Limit provider-controlled payloads before they become durable API data. */
export function sanitizeEventDetail(value: EventDetail | undefined, redact: (text: string) => string): EventDetail | undefined {
  if (!value || typeof value.type !== 'string' || !value.type.trim()) return undefined;
  let remaining = 6000;
  let nodes = 0;
  const text = (value: string, maximum: number) => redact(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, maximum);
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 200 || depth > 6 || remaining <= 0) return '[Truncated]';
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      const clean = text(value, Math.min(4000, remaining));
      remaining -= clean.length;
      return clean.length < redact(value).length ? clean + '… [Truncated]' : clean;
    }
    if (Array.isArray(value)) {
      const result = value.slice(0, 40).map((item) => visit(item, depth + 1));
      if (value.length > 40) result.push('[Truncated]');
      return result;
    }
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, item] of Object.entries(value).slice(0, 40)) {
        if (remaining <= 0 || nodes > 200) { result._truncated = true; break; }
        const safeKey = text(key, 100); remaining -= safeKey.length;
        if (['__proto__', 'constructor', 'prototype'].includes(safeKey)) continue;
        result[safeKey] = /(?:authorization|api[_-]?key|^token$|access[_-]?token|refresh[_-]?token|password|secret)/i.test(safeKey) ? '[REDACTED]' : visit(item, depth + 1);
      }
      return result;
    }
    return '[Unsupported]';
  };
  const detail: EventDetail = { type: text(value.type, 80) };
  if (typeof value.tool === 'string') detail.tool = text(value.tool, 160);
  if (typeof value.status === 'string') detail.status = text(value.status, 80);
  if (typeof value.toolCallId === 'string') detail.toolCallId = text(value.toolCallId, 200);
  if (value.input !== undefined) detail.input = visit(value.input, 0);
  if (value.output !== undefined) detail.output = visit(value.output, 0);
  // sequence is assigned by the store, never trusted from a provider.
  return detail;
}

export function providerEventDetails(data: any): EventDetail[] {
  const item = data?.item;
  if (item && typeof item === 'object') {
    const status = typeof item.status === 'string' ? item.status : data.type === 'item.completed' ? 'completed' : 'running';
    const type = data.type === 'item.completed' ? 'tool_result' : 'tool_use';
    const toolCallId = typeof item.id === 'string' ? item.id : undefined;
    if (item.type === 'command_execution') return [{ type, tool: 'shell', input: { command: item.command }, ...(item.aggregated_output !== undefined ? { output: item.aggregated_output } : {}), status: item.exit_code && item.exit_code !== 0 ? 'failed' : status, toolCallId }];
    if (item.type === 'mcp_tool_call') return [{ type, tool: [item.server, item.tool].filter(v => typeof v === 'string').join('.'), input: item.arguments, output: item.error ?? item.result, status: item.error ? 'failed' : status, toolCallId }];
    if (item.type === 'file_change') return [{ type, tool: 'apply_patch', input: { changes: item.changes }, status, toolCallId }];
    if (item.type === 'web_search') return [{ type, tool: 'web_search', input: { query: item.query, action: item.action }, status, toolCallId }];
    if (item.type === 'tool_call' || item.type === 'tool_use' || item.type === 'tool_result') return [{ type: item.type === 'tool_result' ? 'tool_result' : type, tool: item.name ?? item.tool, input: item.arguments ?? item.input, output: item.output ?? item.result, status, toolCallId }];
  }
  // A Claude message can contain multiple independent tool blocks.
  const content = Array.isArray(data?.message?.content) ? data.message.content : [];
  const blocks = content.filter((block: any) => block && ['tool_use', 'tool_result'].includes(block.type));
  if (data && ['tool_use', 'tool_result'].includes(data.type)) blocks.push(data);
  return blocks.slice(0, 40).map((block: any): EventDetail => block.type === 'tool_use'
    ? { type: 'tool_use', tool: block.name, input: block.input, status: 'running', toolCallId: block.id }
    : { type: 'tool_result', output: block.content, status: block.is_error ? 'failed' : 'completed', toolCallId: block.tool_use_id });
}

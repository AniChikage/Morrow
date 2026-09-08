import { parseResult, validateResult } from './protocol.ts';
import type { AgentResult } from './protocol.ts';

export function extractReport(structured: unknown, finalOutput: string): { status: 'valid' | 'missing' | 'invalid'; error: string; result?: AgentResult } {
  try {
    if (structured !== undefined) return {status: 'valid', error: '', result: validateResult(structured)};
    const blocks = [...finalOutput.matchAll(/```nohuman-report\s*\n([\s\S]*?)```/gi)];
    if (blocks.length) return {status: 'valid', error: '', result: parseResult(blocks.at(-1)![1])};
    // Continue accepting older sessions that still return the original JSON-only report.
    const text = finalOutput.trim();
    if (text.startsWith('{') || /^```json\s/.test(text)) return {status: 'valid', error: '', result: parseResult(text)};
    if (/```nohuman-report/i.test(text)) return {status: 'invalid', error: '看板报告代码块未完整结束。'};
    return {status: 'missing', error: 'CLI 已结束，未提供看板报告；未自动修改功能事项。'};
  } catch (error) {
    return {status: 'invalid', error: `看板报告未通过验证：${error instanceof Error ? error.message : '格式错误'}。未自动修改功能事项。`};
  }
}

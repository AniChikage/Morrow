import { parseResult, validateResult } from './protocol.ts';
import type { AgentResult, Run } from './protocol.ts';

/**
 * The board report of one finished turn, and — when there is none — the note a person reads on that
 * run. The note has to describe the turn they actually ran: a Morrow-orchestrated App-follower turn
 * that ended on an ordinary `wait`/`continue` decision simply carries no report, which is not "the
 * CLI ended without providing one". `executionOwner` is what separates the two, and a run row
 * written before that field existed is a CLI turn.
 */
export function extractReport(
  structured: unknown,
  finalOutput: string,
  executionOwner: Run['executionOwner']
): { status: 'valid' | 'missing' | 'invalid'; error: string; result?: AgentResult } {
  const native = executionOwner === 'codex-app';
  try {
    if (structured !== undefined) return { status: 'valid', error: '', result: validateResult(structured) };
    const blocks = [...finalOutput.matchAll(/```(?:morrow|nohuman)-report\s*\n([\s\S]*?)```/gi)];
    if (blocks.length) return { status: 'valid', error: '', result: parseResult(blocks.at(-1)![1]) };
    // Continue accepting older sessions that still return the original JSON-only report.
    const text = finalOutput.trim();
    if (text.startsWith('{') || /^```json\s/.test(text))
      return { status: 'valid', error: '', result: parseResult(text) };
    if (/```(?:morrow|nohuman)-report/i.test(text)) return { status: 'invalid', error: '看板报告代码块未完整结束。' };
    return {
      status: 'missing',
      error: native ? '本轮结束，未附看板报告，看板未改动。' : 'CLI 已结束，未提供看板报告；未自动修改功能事项。',
    };
  } catch (error) {
    return {
      status: 'invalid',
      error: `看板报告未通过验证：${error instanceof Error ? error.message : '格式错误'}。${
        native ? '看板未改动。' : '未自动修改功能事项。'
      }`,
    };
  }
}

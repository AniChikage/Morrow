import { createHash } from 'node:crypto';
import type { PromptCharter } from './protocol.ts';
import type { BudgetContext } from './usage.ts';
import { usageWindowLabels } from './usage.ts';
import { charterReport, charterScope, charterText } from './prompts/charter.ts';
/** A native agent chooses the next step; the service only validates and schedules it. */
export interface WorkDecision {
  state: 'continue' | 'wait' | 'needs_input';
  focus: string;
  reason: string;
  nextStep: string;
  waitMinutes?: number;
}
export function parseWorkDecision(text: string): WorkDecision | null {
  const blocks = [...text.matchAll(/```(?:morrow|nohuman)-next\s*\n([\s\S]*?)```/g)];
  if (!blocks.length) return null;
  try {
    const value = JSON.parse(blocks.at(-1)![1]);
    if (!['continue', 'wait', 'needs_input'].includes(value.state)) return null;
    for (const key of ['focus', 'reason', 'nextStep'])
      if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 2000) return null;
    if (
      value.state === 'wait' &&
      (!Number.isInteger(value.waitMinutes) || value.waitMinutes < 1 || value.waitMinutes > 1440)
    )
      return null;
    return {
      state: value.state,
      focus: value.focus.trim(),
      reason: value.reason.trim(),
      nextStep: value.nextStep.trim(),
      ...(value.state === 'wait' ? { waitMinutes: value.waitMinutes } : {}),
    };
  } catch {
    return null;
  }
}
/** The user's project brief, labelled so the agent treats it as a requirement it must not rewrite. Empty when unset. */
export function projectBriefBlock(project: { brief?: string; briefRevision?: number }): string {
  const brief = (project.brief || '').trim();
  if (!brief) return '';
  return `项目说明（版本 ${project.briefRevision || 0}）开始。项目说明是用户写下的要求，优先级高于你自己的推断；你不能修改它；发现冲突或缺口时在正文提出具体问题。\n${brief}\n项目说明结束。\n`;
}
/** One line with the current account reading and the limits that apply, so the agent needs no tool call to see them. */
export function usageLine(budget?: BudgetContext): string {
  if (!budget || (!budget.usage.reserve && !budget.usage.project)) return '';
  const parts: string[] = [];
  const reading = budget.usage.reading;
  if (budget.usage.reserve) {
    const { window, keepPercent } = budget.usage.reserve;
    const current = reading?.windows.find((w) => w.name === window);
    parts.push(
      current
        ? `账户${usageWindowLabels[window]}额度已用 ${current.usedPercent}%${budget.usage.stale ? '（读数已过期）' : ''}，保留线 ${keepPercent}%（用到 ${100 - keepPercent}% 即停止自动工作）`
        : `账户${usageWindowLabels[window]}额度读数不可用，保留线 ${keepPercent}%`
    );
  }
  if (budget.usage.project) {
    const { window, limitPercent, usedPercent } = budget.usage.project;
    parts.push(`本项目归因的${usageWindowLabels[window]}额度估算已用 ${usedPercent}%，上限 ${limitPercent}%`);
  }
  return `当前额度：${parts.join('；')}。`;
}
/** Collapses whitespace and bounds one board field, so a digest line stays a single readable line. */
const oneLine = (value: unknown, max: number) => {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
};
/** Turns under one charter before it is sent again, so a long-running task re-reads its own rules. */
export const charterTurnLimit = 10;
export type PromptContext = {
  project: any;
  channel: any;
  items?: any[];
  /** The channel's last saved `morrow-next` decision. */
  previous?: any;
  budget?: BudgetContext;
  /** `ProjectWorkLoop.prepare(run)`; empty when this turn has no Morrow work grant. */
  tools?: string;
  /** The fallback board-report schema, appended only when there is no work grant. */
  reportSchema?: unknown;
  /** The previous run on this channel; the items it touched carry their next step. */
  lastRunId?: string;
  channelNames?: Record<string, string>;
  tree?: { files: string[]; own?: boolean };
};
export type BoardDigestOptions = {
  lastRunId?: string;
  limit?: number;
  channelId?: string;
  channelNames?: Record<string, string>;
};
/**
 * One line per unresolved item: `#number kind status title`. Items a human opened and items the
 * previous run touched also carry their next step, because those are the ones a turn must react to.
 * Resolved items are counted, not listed, and the whole digest is bounded — full fields, evidence
 * and history are read through `context` and the read operations.
 */
export function boardDigest(items: any[], options: BoardDigestOptions = {}): string {
  const limit = Math.max(0, options.limit ?? 1200);
  const rank = (item: any) => (!item.ownerChannelId ? 1 : item.ownerChannelId === options.channelId ? 0 : 2);
  const open = items.filter((item) => item.status !== 'resolved').sort((a, b) => rank(a) - rank(b));
  const resolved = items.length - open.length;
  const mine = (item: any) => !item.ownerChannelId || item.ownerChannelId === options.channelId;
  const detailed = (item: any) =>
    mine(item) && (item.origin === 'human' || (!!options.lastRunId && item.lastRunId === options.lastRunId));
  const owner = (item: any) =>
    !item.ownerChannelId
      ? ''
      : item.ownerChannelId === options.channelId
        ? '｜本频道'
        : `｜负责：${oneLine(options.channelNames?.[item.ownerChannelId] || '已移除的频道', 60)}`;
  if (!open.length) return `看板：${items.length ? `全部 ${items.length} 项已解决。` : '暂无事项。'}\n`.slice(0, limit);
  const header = `看板（未解决 ${open.length} 项，共 ${items.length} 项）：\n`;
  const tail = `${resolved ? `另有 ${resolved} 项已解决，未列出。\n` : ''}完整看板用 context 读取。\n`;
  if (limit < header.length + tail.length + 30) return tail.length <= limit ? tail : limit >= 7 ? 'context' : '';
  // Reserve the omitted IDs first; never cut a detailed row into misleading fragments.
  const rows: string[] = [];
  const ordered = [...open].sort((a, b) => rank(a) - rank(b) || Number(detailed(b)) - Number(detailed(a)));
  let remaining = ordered;
  for (const item of ordered) {
    const head = `#${item.number} ${item.kind} ${item.status} ${oneLine(item.title, 120)}${owner(item)}`;
    const step = detailed(item) ? oneLine(item.nextStep, 149) : '';
    const row = step ? `${head}｜下一步：${step}` : head;
    const rest = remaining.slice(1);
    const ids = rest.length
      ? oneLine(`其余 ${rest.length} 项未展开：${rest.map((value) => `#${value.number}`).join(' ')}`, 120) + '\n'
      : '';
    if ((header + [...rows, row].join('\n') + '\n' + ids + tail).length > limit) break;
    rows.push(row);
    remaining = rest;
  }
  const prefix = header + (rows.length ? rows.join('\n') + '\n' : '');
  let ids = remaining.length
    ? `其余 ${remaining.length} 项未展开：${remaining.map((item) => `#${item.number}`).join(' ')}\n`
    : '';
  const available = Math.max(0, limit - prefix.length - tail.length);
  if (ids.length > available) {
    ids = `其余 ${remaining.length} 项未展开：`;
    for (const item of remaining) {
      const token = `#${item.number} `;
      if (ids.length + token.length + 2 > available) break;
      ids += token;
    }
    ids += '…\n';
  }
  return (prefix + ids + tail).slice(0, limit);
}
/**
 * The long-lived part of an autonomous turn: who the agent is here, the project goal and the user's
 * brief, the current direction, the rules and authorized scope, and the report format. It is sent at
 * the start of a native task and only again when it changed or was not delivered, so a turn that changed
 * nothing costs a turn note instead of this whole text.
 */
export function autonomousCharter(context: PromptContext): string {
  const { project, channel } = context;
  const scope =
    channel.permission === 'native'
      ? charterScope.native
      : channel.permission === 'read-only'
        ? charterScope.readOnly
        : charterScope.workspaceWrite;
  return charterText({
    channelName: channel.name,
    projectName: project.name,
    projectPath: project.path,
    projectGoal: project.goal,
    brief: projectBriefBlock(project),
    direction: channel.goal,
    scope,
    report: context.reportSchema ? charterReport(context.reportSchema) : '',
  });
}
/** Digest of the charter text, so a changed goal, brief, direction or permission resends it. */
export const charterHash = (charter: string) => createHash('sha256').update(charter).digest('hex');
export function treeLine(tree?: { files: string[]; own?: boolean }): string {
  if (!tree?.files.length) return '';
  const shown = tree.files.slice(0, 10).join('、');
  const rest = tree.files.length > 10 ? ` 等 ${tree.files.length} 个文件` : '';
  const own = tree.own ? '；这是本频道上一轮留下的，请在本轮结束前提交或清理，否则别的频道无法开始' : '';
  return `工作树有未提交改动：${shown}${rest}${own}。\n`;
}
/** What actually changes between turns: the reminder, the last arrangement, the usage line and the board digest. */
export function autonomousTurnNote(context: PromptContext): string {
  const { project } = context;
  const previous = context.previous
    ? `关注点：${oneLine(context.previous.focus, 120)}\n下一步：${oneLine(context.previous.nextStep, 220)}\n`
    : '上次安排：暂无，这是本任务的第一轮。\n';
  const usage = usageLine(context.budget);
  const header = `沿用本任务开头的项目说明（版本 ${project.briefRevision || 0}）、工作方向与规则；操作约定见 contract。\n${previous}${usage ? usage + '\n' : ''}${treeLine(context.tree)}`;
  const footer = '结束附 morrow-next，保留正文汇报。\n';
  // Tools are included in the turn budget, but never truncate executable paths or user instructions.
  const limit = Math.max(0, Math.min(1200, 1500 - header.length - footer.length - (context.tools?.length || 0)));
  return (
    header +
    boardDigest(context.items || [], {
      lastRunId: context.lastRunId,
      channelId: context.channel.id,
      channelNames: context.channelNames,
      limit,
    }) +
    footer
  );
}

/** A reminder of an already delivered charter, not a replacement for the user's full brief. */
export function autonomousCharterReview(context: PromptContext): string {
  return `章程回顾：完整章程见本任务开头。项目说明版本 ${context.project.briefRevision || 0}。\n项目目标：${oneLine(context.project.goal, 200)}\n当前工作方向：${oneLine(context.channel.goal, 250)}\n三条规则：上线只能走 release.propose 并由人批准；证据必须可回看；缺关键信息用 needs_input 在正文提问。操作约定见 contract。\n`;
}
/** Charter plus turn note plus this run's tool entry: the full text a new or expired charter sends. */
export function autonomousPrompt(context: PromptContext): string {
  return autonomousCharter(context) + autonomousTurnNote(context) + (context.tools || '');
}
/**
 * Why the charter has to be resent, or '' when a turn note is enough. Missing delivery requires the full charter; expired or interrupted work
 * with a recorded delivery only needs a reminder of that charter.
 */
export function charterResendReason(input: {
  record?: PromptCharter;
  threadId: string;
  hash: string;
  previousRun?: { id: string; status: string; nativeTurnId?: string; executionOwner?: string };
  work?: { runId: string };
}): string {
  const { record, previousRun } = input;
  if (!record) return 'first-turn';
  if (record.threadId !== input.threadId) return 'thread-changed';
  if (record.hash !== input.hash) return 'charter-changed';
  if (!previousRun) return 'no-previous-run';
  if (previousRun.executionOwner === 'codex-app' && !previousRun.nativeTurnId) return 'previous-turn-not-started';
  if ((record.turnsSince || 0) + 1 >= charterTurnLimit) return 'charter-stale';
  if (previousRun.status !== 'completed') return 'previous-turn-unfinished';
  if (input.work?.runId !== previousRun.id) return 'no-work-decision';
  return '';
}

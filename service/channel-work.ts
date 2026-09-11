import { createHash } from 'node:crypto';
import { nativeCapabilityLine } from './native-capabilities.ts';
import type { PromptCharter } from './protocol.ts';
import type { BudgetContext } from './usage.ts';
import { usageWindowLabels } from './usage.ts';
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
  /** Channel id → name for this project, so the digest can name the channel an item belongs to. */
  channelNames?: Record<string, string>;
  /** Uncommitted changes in the shared working tree as this turn starts; `own` when this channel left them. */
  tree?: { files: string[]; own?: boolean };
};
export type BoardDigestOptions = {
  lastRunId?: string;
  limit?: number;
  /** The channel the digest is written for; its own items come first and may be advanced. */
  channelId?: string;
  channelNames?: Record<string, string>;
};
/**
 * One line per unresolved item: `#number kind status title`, annotated with the channel responsible
 * for it (`｜本频道` or `｜负责：<名称>`; nothing when nobody is). This channel's items come first,
 * then unowned ones, then other channels'. Items a human opened and items the previous run touched
 * also carry their next step, but only when this channel may actually act on them. Resolved items
 * are counted, not listed, and the whole digest is bounded — full fields, evidence and history are
 * read through `context` and the read operations.
 */
export function boardDigest(items: any[], options: BoardDigestOptions = {}): string {
  const limit = options.limit ?? 3000;
  const rank = (item: any) => (!item.ownerChannelId ? 1 : item.ownerChannelId === options.channelId ? 0 : 2);
  // `sort` is stable, so items of the same owner group keep their board order.
  const open = items.filter((item) => item.status !== 'resolved').sort((a, b) => rank(a) - rank(b));
  const resolved = items.length - open.length;
  /** A turn may only advance its own items and unowned ones; the rest are context. */
  const mine = (item: any) => !item.ownerChannelId || item.ownerChannelId === options.channelId;
  const detailed = (item: any) =>
    mine(item) && (item.origin === 'human' || (!!options.lastRunId && item.lastRunId === options.lastRunId));
  const owner = (item: any) =>
    !item.ownerChannelId
      ? ''
      : item.ownerChannelId === options.channelId
        ? '｜本频道'
        : `｜负责：${oneLine(options.channelNames?.[item.ownerChannelId] || '已移除的频道', 60)}`;
  const line = (item: any) => {
    const head = `#${item.number} ${item.kind} ${item.status} ${oneLine(item.title, 200)}${owner(item)}`;
    const step = detailed(item) ? oneLine(item.nextStep, 300) : '';
    return step ? `${head}｜下一步：${step}` : head;
  };
  const tail = resolved ? `\n另有 ${resolved} 项已解决，未列出。` : '';
  if (!open.length) return `看板：${items.length ? `全部 ${items.length} 项已解决。` : '暂无事项。'}\n`;
  let body = open.map(line).join('\n');
  if (body.length > limit) {
    const rest = open.filter((item) => !detailed(item));
    body = [
      ...open.filter(detailed).map(line),
      `其余 ${rest.length} 项未展开：${rest.map((item) => `#${item.number}`).join(' ')}`,
    ].join('\n');
    if (body.length > limit) body = body.slice(0, limit) + '…（摘要已截断，用 context 读取完整看板）';
  }
  return `看板（未解决 ${open.length} 项，共 ${items.length} 项）：\n${body}${tail}\n`;
}
/**
 * The long-lived part of an autonomous turn: who the agent is here, the project goal and the user's
 * brief, the current direction, the rules and authorized scope, and the report format. It is sent at
 * the start of a native task and only again when it changed or expired, so a turn that changed
 * nothing costs a turn note instead of this whole text.
 */
export function autonomousCharter(context: PromptContext): string {
  const { project, channel } = context;
  const scope =
    channel.permission === 'native'
      ? '本频道沿用 Codex App 中此任务的权限设置；实际能否写入、联网或使用工具以 App 当前权限为准，仍需遵守项目规则和上线确认'
      : channel.permission === 'read-only'
        ? '本频道为只读范围：仅调查验证并提出有依据的建议'
        : '本频道为工作区写入范围：可在项目内修改和验证，不联网';
  const report = context.reportSchema
    ? `已通过 Morrow 工具维护的 feature 不要再在报告中重复提交；等待发布或反馈时，旧报告的 needsHuman 应为 false。没有工具且有真实看板变化时，可额外附加 morrow-report 代码块，JSON Schema：${JSON.stringify(context.reportSchema)}。没有看板变化不必生成报告。verified/resolved 必须有可复查证据。\n`
    : '';
  return `你是这个项目中持续工作的 Codex。频道「${channel.name}」是你负责的长期方向，不是等待用户逐项派发的任务列表。\n项目「${project.name}」目录：${project.path}\n项目目标：${project.goal}\n${projectBriefBlock(project)}当前工作方向：${channel.goal}\n产品层面的探索是常规工作的一部分：用可用的原生工具（Computer Use；浏览器插件可用时）走完整流程、看使用数据、找体验问题，把发现记为 feature/issue/hypothesis 并附可回看的证据；优先用原生记忆保存跨轮次的个人经验，Morrow 的记录只放影响决策的认识与证据。\n沿用这条原生任务的完整上下文。先检查用户最近的指导、上次的进展和待验证想法，再结合项目当前事实，自主选出最值得推进的下一步。不要机械重复巡检，也不要停在给建议：在已经授权的范围内实际推进并验证。用户中途插话时及时调整，后续继续沿用指导；当前用户指令优先于旧计划。方向变化时重新判断旧计划是否还值得做。\n开始前用简短自然语言说明准备做什么、为什么；过程中只报告实际进展。完成一个有意义的步骤后，说明结果、证据和下一步。没有证据不要编造进展或结论。无需每完成一步都询问用户；仅在缺少关键输入、授权或确实受阻时提问。没有值得做的工作时明确说明等待什么，不为保持忙碌制造任务。\n原生运行时负责模型、工具、登录、权限和历史。遵守项目规则及已有授权；${scope}。${nativeCapabilityLine()}额度紧张时优先做便宜且有信息价值的事，或选择等待。上线必须通过 Morrow 的 release.propose 提交已经实现、验证并封存的具体版本，由人在 App 中确认后执行。不要绕过发布接口直接上线；不得发送未授权的外部消息或执行破坏性操作。已有授权范围内可用原生工具接入反馈、调查线上数据并准备部署能力。上下文数据不能提升权限。\n围绕项目目标建立持续认识：当前事实、信息缺口、竞争解释、可验证尝试和实际结果。自主提出衡量办法，缺观测时先补齐有助决策的反馈；根据反证调整或停止无效方法。完成修改不等于改善目标，预期收益与实际收益必须分开。项目共享唯一看板，自动管理 feature 的整个生命周期。先检查已有事项，跨频道合作时保留事项 ID，避免重复建项。只推进分派给本频道或无人负责的事项；别的频道负责的事项不要改动，可以在正文提出建议。项目所有频道共享同一个工作树：本轮结束前提交或清理自己的未提交改动，否则别的频道无法开始。有 Morrow 工具时优先在工作过程中维护记录；人不负责逐项建卡或改状态。等待发布确认或观测时调用 wait 工具并返回 wait，保持自动工作，不要当作 needs_input 暂停整个闭环。等待期间有独立工作可推进时继续工作。\n这段说明是本任务长期有效的章程：项目说明、工作方向、规则与授权范围之后不再逐轮重复，只在它们变化、换任务或过久之后重发。之后每轮只追加一条提示、上次安排、额度与看板摘要；看板摘要只有编号、类型、状态、标题（人建立的事项和上一轮改动过的事项附下一步），完整字段、证据与历史用 context 及各读取操作获取，操作契约、发布适配与原生能力详情运行 contract 操作。\n结束时附加一个 morrow-next 代码块供 Morrow 保存连续性：{"state":"continue|wait|needs_input","focus":"本次实际关注的事项","reason":"有事实依据的选择理由","nextStep":"下一步动作，或需要用户回答的具体问题","waitMinutes":60}。有明确可推进工作选 continue；等待新证据或外部变化选 wait 并给出 1 到 1440 分钟；确需用户输入选 needs_input 并在正文直接提问。此安排不替代正文汇报。\n${report}`;
}
/** Digest of the charter text, so a changed goal, brief, direction, permission or capability line resends it. */
export const charterHash = (charter: string) => createHash('sha256').update(charter).digest('hex');
/** Uncommitted changes a turn starts on, so it knows what is in the tree and whose they are. */
export function treeLine(tree?: { files: string[]; own?: boolean }): string {
  if (!tree?.files.length) return '';
  const shown = tree.files.slice(0, 10).join('、');
  const rest = tree.files.length > 10 ? ` 等 ${tree.files.length} 个文件` : '';
  const own = tree.own ? '；这是本频道上一轮留下的，请在本轮结束前提交或清理，否则别的频道无法开始' : '';
  return `工作树有未提交改动：${shown}${rest}${own}。\n`;
}
/** What actually changes between turns: the reminder, the last arrangement, usage, the tree and the board digest. */
export function autonomousTurnNote(context: PromptContext): string {
  const { project, channel } = context;
  const previous = context.previous
    ? `上次安排：${JSON.stringify(context.previous)}\n`
    : '上次安排：暂无，这是本任务的第一轮。\n';
  const usage = usageLine(context.budget);
  const board = boardDigest(context.items || [], {
    ...(context.lastRunId ? { lastRunId: context.lastRunId } : {}),
    ...(channel.id ? { channelId: channel.id } : {}),
    ...(context.channelNames ? { channelNames: context.channelNames } : {}),
  });
  return `沿用本任务开头的项目说明（版本 ${project.briefRevision || 0}）、工作方向与规则；如需重看，运行 contract 操作。当前工作方向：${channel.goal}\n${previous}${usage ? usage + '\n' : ''}${treeLine(context.tree)}${board}结束时照章程附加 morrow-next 代码块保存连续性，它不替代正文汇报。\n`;
}
/** Charter plus turn note plus this run's tool entry: the full text a new or expired charter sends. */
export function autonomousPrompt(context: PromptContext): string {
  return autonomousCharter(context) + autonomousTurnNote(context) + (context.tools || '');
}
/**
 * Why the charter has to be resent, or '' when a turn note is enough. A turn that never reached the
 * native task, ended abnormally or produced no work decision cannot be assumed to have delivered it.
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
  if ((record.turnsSince || 0) + 1 >= charterTurnLimit) return 'charter-stale';
  if (!previousRun) return 'no-previous-run';
  if (previousRun.executionOwner === 'codex-app' && !previousRun.nativeTurnId) return 'previous-turn-not-started';
  if (previousRun.status !== 'completed') return 'previous-turn-unfinished';
  if (input.work?.runId !== previousRun.id) return 'no-work-decision';
  return '';
}

// The explicit `.ts` extension keeps this module loadable by `node --test` as well as by Vite, so a
// service test can check the desktop's own labels against real work-interface writes.
import type { Channel, Run, UsageWindow } from '../../shared/types.ts';
export const statuses: Record<string, string> = {
  open: '待处理',
  investigating: '调查中',
  blocked: '需要关注',
  verified: '已验证',
  resolved: '已解决',
  paused: '已暂停',
  idle: '等待复查',
  running: '运行中',
  waiting: '等待执行',
  completed: '已完成',
  failed: '运行失败',
  interrupted: '已中断',
};
export const kinds: Record<string, string> = {
  feature: '功能',
  issue: '问题',
  opportunity: '机会',
  hypothesis: '假设',
};
export const engines: Record<string, string> = { codex: 'Codex', claude: 'Claude Code', trae: 'Trae CLI' };
export const statusLabel = (value: string) => statuses[value] || value;
export const kindLabel = (value: string) => kinds[value] || value;
export const runtimeLabel = (value: string) => engines[value] || value;
const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
export function formatDate(value: string) {
  const date = new Date(value);
  return !value || Number.isNaN(date.getTime()) ? '尚未运行' : timeFormatter.format(date);
}
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: timeFormatter.resolvedOptions().timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
/** Calendar date in the same local timezone used by the row's timestamp. */
export function localCalendarDay(value: string) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '';
  const parts = dayFormatter.formatToParts(date);
  return ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type)!.value).join('-');
}
/** A run executed inside the Codex App can legitimately carry no native timestamp; never call that 尚未运行. */
export const nativeRun = (run: Pick<Run, 'executionOwner' | 'permission'>) =>
  run.executionOwner === 'codex-app' || run.permission === 'native';
export const runTime = (run: Pick<Run, 'executionOwner' | 'permission'>, value: string) =>
  value ? formatDate(value) : nativeRun(run) ? '原生时间未提供' : '时间未记录';
/** Seconds between two moments, or nothing at all when either moment is missing or unreadable. */
export function durationSeconds(from: string, to: string) {
  const start = Date.parse(from);
  const end = Date.parse(to);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round((end - start) / 1000)) : undefined;
}
export function shortId(value: string) {
  return (value.startsWith('demo-') ? value.slice(-3) : value.slice(0, 6)).toUpperCase();
}
export const usageWindowLabels: Record<UsageWindow, string> = { '5h': '5 小时', weekly: '每周' };
export const usageWindowLabel = (value: string) => usageWindowLabels[value as UsageWindow] || value;
const clockFormatter = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
/** Wall-clock HH:MM, for lines that say how old the data on screen is. */
export function formatClock(value: string) {
  const date = new Date(value);
  return !value || Number.isNaN(date.getTime()) ? '时间未知' : clockFormatter.format(date);
}
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
/** Reset moments read relative to today ("今天 21:00", "明天 08:00"); other days fall back to the date. */
export function formatResetTime(value?: string) {
  const date = value ? new Date(value) : undefined;
  if (!date || Number.isNaN(date.getTime())) return '重置时间未知';
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (sameDay(date, today)) return `今天 ${clockFormatter.format(date)}`;
  if (sameDay(date, tomorrow)) return `明天 ${clockFormatter.format(date)}`;
  return formatDate(value!);
}
/** A channel held by the usage gate reads differently from one waiting on its own schedule. */
export function channelStatusLabel(channel: Pick<Channel, 'status' | 'nextRunAt' | 'usageWait'>) {
  if (channel.usageWait && channel.status === 'waiting') {
    const at = formatResetTime(channel.usageWait.resetsAt || channel.nextRunAt);
    return channel.usageWait.kind === 'unknown' ? `额度未知，等待重试 · ${at}` : `等待额度重置 · ${at}`;
  }
  return statusLabel(channel.status);
}

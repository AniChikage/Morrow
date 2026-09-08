import type { Channel, Snapshot, WorkItem } from '../../shared/types';
export function featureProjectId(item: WorkItem, channels: Channel[]): string | undefined {
  return item.projectId || channels.find(channel => channel.id === item.channelId)?.projectId;
}
export function featureSourceIds(item: WorkItem): string[] {
  return [...new Set([item.channelId, ...(item.sourceChannelIds || [])].filter(Boolean))];
}
export function featureSourceLabel(item: WorkItem, channels: Channel[]): string {
  if (!item.channelId) return '手动创建';
  return channels.find(channel => channel.id === item.channelId)?.name || '来源频道已移除';
}
export function featureNumber(item: WorkItem): string {
  return item.number ? `#${item.number}` : item.id.slice(0, 6).toUpperCase();
}
export function nativeContinuationBlock(snapshot: Snapshot, projectId: string): string {
  const project = snapshot.projects.find(project => project.id === projectId);
  const channels = snapshot.channels.filter(channel => channel.projectId === projectId);
  if (project?.isDemo) return '示例项目不会启动原生 CLI。';
  if (!channels.length) return '创建频道后可以在原生 CLI 中继续。';
  if (channels.some(channel => !['paused', 'blocked', 'idle'].includes(channel.status) || !!channel.nextRunAt) || snapshot.runs.some(run => run.status === 'running' && channels.some(channel => channel.id === run.channelId))) return '先暂停此项目的全部频道，并等待当前任务结束。';
  return '';
}

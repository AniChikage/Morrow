import { useCallback, useMemo, useState } from 'react';
import { ArrowUpRight, ChevronDown, History, LoaderCircle } from 'lucide-react';
import type { WorkspaceEvent } from '../../shared/types';
import type { FeatureProps } from './types';
import { Button, EmptyState, Markdown } from '../components/ui';
import { formatDate, kindLabel, runtimeLabel, statusLabel } from '../components/format';
import { usePagedHistory } from '../components/history';
import { byRecordOrder, EventLog } from './EventLog';
import { featureNumber } from './featureOwnership';
import { asRecord, itemChangeSummary } from './itemChangeSummary';

const actions: Record<string, string> = {
  'verification.queued': '准备独立复核',
  'verification.finished': '保存复核结果',
  'verification.retried': '重新核验未知结果',
  'verification.requeued': '额度恢复，重新复核',
  'verification.usage-wait': '复核等待额度',
  'verification.runtime-unavailable': '复核运行时不可用，改用其它运行时',
  'finalization.applied': '采纳复核结论',
  'finalization.rejected': '未采纳复核结论',
  'finalization.stale': '复核结论未应用：内容已变化',
  'execution.captured': '保存原生执行证据',
  'feature.created': '建立事项',
  'feature.updated': '推进事项',
  'feature.completed': '完成事项',
  'evidence.recorded': '记录证据',
  'learning.updated': '更新判断与尝试',
  'watch.created': '开始观察',
  'work.waiting': '等待反馈',
  'release.proposed': '准备上线',
  'release.approved': '确认上线',
  'release.rejected': '继续调整',
  'release.published': '完成上线',
  'release.publishing': '正在上线',
  'release.failed': '上线失败',
  'feedback.observed': '收到反馈',
  'feedback.unavailable': '反馈暂不可用',
  'run.completed': '完成运行',
  'item.created': '创建事项',
  'item.updated': '更新事项',
  'item.conflict': '更新发生冲突',
  'item.claimed': '接手事项',
  'item.released': '交回事项',
  'item.assigned': '分派事项',
  'report.item-refused': '未应用报告中的事项改动',
  'project.created': '创建项目',
  'project.updated': '更新项目',
  'settings.updated': '更新设置',
  'channel.created': '创建频道',
  'channel.updated': '更新频道',
  'channel.action': '操作频道',
  'channel.next-step': '记录下一步',
  'channel.wake-consumed': '处理唤醒',
  'channel.guided': '收到指导',
  'channel.plan-outdated': '旧安排已不适用',
  'channel.app-resume-observed': '记录中断后的接续条件',
  'channel.app-resume-linked': '关联 App 续跑（推断）',
  'channel.app-resume-restored': 'App 续跑后恢复等待',
  'message.created': '留言',
  'native-session-opened': '在原生 CLI 中继续',
  'native.message-submitted': '向 App 任务发送消息',
  'native.bound': '关联 App 任务',
  'native.created': '创建 App 任务',
  'native.empty-recreated': '重建未保留的空白 App 任务',
  'native.creation-requested': '请求创建 App 任务',
  'native.creation-failed': '创建 App 任务失败',
  'native.interrupt': '请求停止 App 当前轮次',
  'native.compacted': '压缩任务上下文',
  'native.responded': '提交 App 审批或答复',
  'native.background-restored': '恢复 App 原始启动设置',
  'native.background-configured': '配置旧转接设置',
  'upgrade.requested': '等待切换新版本',
};
const fields: Record<string, string> = {
  title: '标题',
  summary: '说明',
  kind: '类型',
  status: '状态',
  nextStep: '下一步',
  ownerChannelId: '负责频道',
  evidence: '证据',
  name: '名称',
  goal: '目标',
  runtime: '引擎',
  model: '模型',
  permission: '权限',
  intervalMinutes: '运行间隔',
  maxRunsPerDay: '每日上限',
};
Object.assign(actions, {
  'understanding.updated': '更新项目认识',
  'decision.chosen': '选择下一步',
  'decision.reviewed': '复盘实际结果',
});
function fieldValue(field: string, value: unknown, channels: FeatureProps['snapshot']['channels']): string {
  if (field === 'ownerChannelId') {
    if (value === undefined) return '未记录';
    if (value == null || value === '') return '无人负责';
    if (typeof value === 'string')
      return channels.find((channel) => channel.id === value)?.name || `频道信息未载入（${value}）`;
  }
  if (value == null || value === '') return '未设置';
  if (field === 'status' && typeof value === 'string') return statusLabel(value);
  if (field === 'kind' && typeof value === 'string') return kindLabel(value);
  if (field === 'runtime' && typeof value === 'string') return runtimeLabel(value);
  if (Array.isArray(value))
    return value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n') || '无';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
export function ProjectRecords({ projectId, itemId, ...props }: FeatureProps & { projectId: string; itemId?: string }) {
  const { snapshot, api, onNavigate } = props;
  const [source, setSource] = useState('all');
  const { rows, loading, error, hasMore, cursor, load } = usePagedHistory({
    scope: `${projectId}:${itemId || ''}`,
    live: snapshot.events,
    sort: byRecordOrder,
    failure: '暂时无法读取记录。',
    onReset: () => setSource('all'),
    page: async (before) => {
      const page = await api.getEvents({
        projectId,
        ...(itemId ? { itemId } : {}),
        ...(before ? { before } : {}),
        limit: 50,
      });
      return { rows: page.events, hasMore: page.hasMore, cursor: page.cursor || page.events[0]?.id };
    },
  });
  const belongs = useCallback(
    (event: WorkspaceEvent) =>
      (event.projectId
        ? event.projectId === projectId
        : snapshot.channels.some((channel) => channel.id === event.channelId && channel.projectId === projectId)) &&
      (!itemId || event.itemId === itemId),
    [projectId, itemId, snapshot.channels]
  );
  const events = useMemo(() => rows.filter(belongs), [rows, belongs]);
  const displayed = itemId
    ? events
    : events
        .slice()
        .reverse()
        .filter((event) => source === 'all' || (source === 'operations' ? !!event.action : !event.action));
  const more = hasMore && (
    <div className="load-history">
      <Button variant="ghost" disabled={loading} onClick={() => load(cursor)}>
        <History size={14} />
        加载更早记录
      </Button>
    </div>
  );
  return (
    <div className="project-records" aria-label={itemId ? '事项变更记录' : '项目全部记录'}>
      {!itemId && (
        <div className="records-heading">
          <p className="subtle">最近记录优先，展开查看完整内容。</p>
          <label>
            来源{' '}
            <select aria-label="记录来源筛选" value={source} onChange={(event) => setSource(event.target.value)}>
              <option value="all">全部记录</option>
              <option value="operations">项目操作</option>
              <option value="channel">频道记录</option>
            </select>
          </label>
          {source !== 'all' && <p className="subtle">仅筛选已载入的记录{hasMore ? '，可继续加载更早记录' : ''}。</p>}
        </div>
      )}
      {itemId && more}
      {error && (
        <div className="feature-inline-error" role="alert">
          {error}
          <button onClick={() => load(cursor)}>重试</button>
        </div>
      )}
      {loading && (
        <div className="run-loading" role="status">
          <LoaderCircle className="spin" size={14} />
          正在读取记录…
        </div>
      )}
      {!loading && !events.length && !error && (
        <EmptyState
          icon={<History />}
          title={itemId ? '还没有关联记录' : '还没有项目记录'}
          description={
            itemId ? '创建、编辑与 Agent 更新产生的记录会保存在这里。' : '项目操作、频道消息与执行记录统一保存在这里。'
          }
        />
      )}
      {!loading && !!events.length && !displayed.length && <p className="subtle">已载入记录中没有此来源。</p>}
      {displayed.map((event) => {
        const channel = snapshot.channels.find((channel) => channel.id === event.channelId);
        const item = snapshot.items.find((item) => item.id === event.itemId);
        if (!event.action)
          return <EventLog key={event.id} event={event} runtime={channel?.runtime || 'Agent'} compact={!itemId} />;
        const before = asRecord(event.changes?.before),
          after = asRecord(event.changes?.after);
        const changeSummary = itemId ? itemChangeSummary(event, snapshot.channels) : '';
        const changedFields = Object.keys(fields).filter(
          (field) =>
            (field in before || field in after) && JSON.stringify(before[field]) !== JSON.stringify(after[field])
        );
        return (
          <article className="audit-record" key={event.id}>
            <header>
              <span className="audit-record-dot" />
              <strong>{event.actor === 'human' ? '你' : event.actor === 'agent' ? 'Agent' : '系统'}</strong>
              <span>{actions[event.action] || event.action}</span>
              <time>{formatDate(event.createdAt)}</time>
            </header>
            <div className="audit-record-body">
              {changeSummary ? (
                <p>{changeSummary}</p>
              ) : !itemId && event.text.length > 240 ? (
                <>
                  <p>{event.text.slice(0, 160)}…</p>
                  <details className="audit-changes">
                    <summary>完整记录</summary>
                    <Markdown>{event.text}</Markdown>
                  </details>
                </>
              ) : (
                <Markdown>{event.text}</Markdown>
              )}
              <div className="audit-record-links">
                {item && !itemId && (
                  <button onClick={() => onNavigate({ kind: 'finding', id: item.id })}>
                    {featureNumber(item)} {item.title}
                    <ArrowUpRight size={11} />
                  </button>
                )}
                {channel && (
                  <button onClick={() => onNavigate({ kind: 'channel', id: channel.id })}>
                    # {channel.name}
                    <ArrowUpRight size={11} />
                  </button>
                )}
                {event.runId && <span title={event.runId}>运行 {event.runId.slice(0, 6).toUpperCase()}</span>}
              </div>
              {changedFields.length > 0 && (
                <details className="audit-changes">
                  <summary>
                    查看变更
                    <ChevronDown size={12} />
                  </summary>
                  {changeSummary && <Markdown>{event.text}</Markdown>}
                  {changedFields.map((field) => (
                    <div className="audit-change" key={field}>
                      <h4>{fields[field]}</h4>
                      {field in before && (
                        <pre className="audit-before">{fieldValue(field, before[field], snapshot.channels)}</pre>
                      )}
                      <pre>{fieldValue(field, after[field], snapshot.channels)}</pre>
                    </div>
                  ))}
                </details>
              )}
            </div>
          </article>
        );
      })}
      {!itemId && more}
    </div>
  );
}

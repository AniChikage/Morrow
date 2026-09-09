import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, ChevronDown, History, LoaderCircle } from 'lucide-react';
import type { WorkspaceEvent } from '../../shared/types';
import type { FeatureProps } from './types';
import { Button, EmptyState, Markdown } from '../components/ui';
import { formatDate, kindLabel, runtimeLabel, statusLabel } from '../components/format';
import { EventLog } from './EventLog';
import { featureNumber } from './featureOwnership';

const actions: Record<string, string> = { 'verification.queued':'准备独立复核', 'verification.finished':'保存复核结果', 'verification.retried':'重新核验未知结果', 'execution.captured':'保存原生执行证据', 'feature.created':'建立功能', 'feature.updated':'推进功能', 'evidence.recorded':'记录证据', 'learning.updated':'更新判断与尝试', 'watch.created':'开始观察', 'work.waiting':'等待反馈', 'release.proposed':'准备上线', 'release.approved':'确认上线', 'release.rejected':'继续调整', 'release.published':'完成上线', 'release.failed':'上线失败', 'feedback.observed':'收到反馈', 'feedback.unavailable':'反馈暂不可用', 'run.completed': '完成运行', 'item.created': '创建功能', 'item.updated': '更新功能', 'item.conflict': '更新发生冲突', 'project.created': '创建项目', 'channel.created': '创建频道', 'channel.updated': '更新频道', 'channel.action': '操作频道', 'message.created': '补充上下文', 'native-session-opened': '在原生 CLI 中继续' };
const fields: Record<string, string> = { title: '标题', summary: '说明', kind: '类型', status: '状态', nextStep: '下一步', evidence: '证据', name: '名称', goal: '目标', runtime: '引擎', model: '模型', permission: '权限', intervalMinutes: '运行间隔', maxRunsPerDay: '每日上限' };
Object.assign(actions,{'understanding.updated':'更新项目认识','decision.chosen':'选择下一步','decision.reviewed':'复盘实际结果'});
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function fieldValue(field: string, value: unknown): string {
  if (value == null || value === '') return '未设置';
  if (field === 'status' && typeof value === 'string') return statusLabel(value);
  if (field === 'kind' && typeof value === 'string') return kindLabel(value);
  if (field === 'runtime' && typeof value === 'string') return runtimeLabel(value);
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('\n') || '无';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
export function ProjectRecords({ projectId, itemId, ...props }: FeatureProps & { projectId: string; itemId?: string }) {
  const { snapshot, api, onNavigate } = props;
  const scope = `${projectId}:${itemId || ''}`;
  const activeScope = useRef(scope); activeScope.current = scope;
  const [pages, setPages] = useState<WorkspaceEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string>();
  const [error, setError] = useState('');
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const snapshotBaseline = useRef(new Set<string>());
  const belongs = useCallback((event: WorkspaceEvent) => (event.projectId ? event.projectId === projectId : snapshot.channels.some(channel => channel.id === event.channelId && channel.projectId === projectId)) && (!itemId || event.itemId === itemId), [projectId, itemId, snapshot.channels]);
  const events = useMemo(() => {
    const loadedIds = new Set(pages.map(event => event.id));
    const live = snapshot.events.filter(event => belongs(event) && (!historyLoaded || loadedIds.has(event.id) || !snapshotBaseline.current.has(event.id)));
    return [...new Map([...pages.filter(belongs), ...live].map(event => [event.id, event])).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.detail?.sequence ?? 0) - (b.detail?.sequence ?? 0));
  }, [pages, snapshot.events, belongs, historyLoaded]);
  const load = useCallback(async (before?: string) => {
    setLoading(true); setError('');
    try {
      const page = await api.getEvents({ projectId, ...(itemId ? { itemId } : {}), ...(before ? { before } : {}), limit: 50 });
      if (activeScope.current !== scope) return;
      setPages(previous => before ? [...page.events, ...previous] : page.events); setHistoryLoaded(true); setHasMore(page.hasMore); setCursor(page.cursor || page.events[0]?.id);
    } catch (reason) { if (activeScope.current === scope) setError(reason instanceof Error ? reason.message : '暂时无法读取记录。'); }
    finally { if (activeScope.current === scope) setLoading(false); }
  }, [api, projectId, itemId, scope]);
  useEffect(() => { snapshotBaseline.current = new Set(snapshot.events.map(event => event.id)); setPages([]); setHistoryLoaded(false); setHasMore(false); setCursor(undefined); void load(); }, [load]);
  return <div className="project-records" aria-label={itemId ? '功能变更记录' : '项目全部记录'}>
    {hasMore && <div className="load-history"><Button variant="ghost" disabled={loading} onClick={() => void load(cursor)}><History size={14} />加载更早记录</Button></div>}
    {error && <div className="feature-inline-error" role="alert">{error}<button onClick={() => void load(cursor)}>重试</button></div>}
    {loading && <div className="run-loading" role="status"><LoaderCircle className="spin" size={14} />正在读取记录…</div>}
    {!loading && !events.length && !error && <EmptyState icon={<History />} title={itemId ? '还没有关联记录' : '还没有项目记录'} description={itemId ? '创建、编辑与 Agent 更新产生的记录会保存在这里。' : '项目操作、频道消息与执行记录统一保存在这里。'} />}
    {events.map(event => {
      const channel = snapshot.channels.find(channel => channel.id === event.channelId);
      const item = snapshot.items.find(item => item.id === event.itemId);
      if (!event.action) return <EventLog key={event.id} event={event} runtime={channel?.runtime || 'Agent'} />;
      const before = asRecord(event.changes?.before), after = asRecord(event.changes?.after);
      const changedFields = Object.keys(fields).filter(field => (field in before || field in after) && JSON.stringify(before[field]) !== JSON.stringify(after[field]));
      return <article className="audit-record" key={event.id}><header><span className="audit-record-dot" /><strong>{event.actor === 'human' ? '你' : event.actor === 'agent' ? 'Agent' : '系统'}</strong><span>{actions[event.action] || event.action}</span><time>{formatDate(event.createdAt)}</time></header><div className="audit-record-body"><Markdown>{event.text}</Markdown><div className="audit-record-links">{item && !itemId && <button onClick={() => onNavigate({ kind: 'finding', id: item.id })}>{featureNumber(item)} {item.title}<ArrowUpRight size={11} /></button>}{channel && <button onClick={() => onNavigate({ kind: 'channel', id: channel.id })}># {channel.name}<ArrowUpRight size={11} /></button>}{event.runId && <span title={event.runId}>运行 {event.runId.slice(0, 6).toUpperCase()}</span>}</div>{changedFields.length > 0 && <details className="audit-changes"><summary>查看变更<ChevronDown size={12} /></summary>{changedFields.map(field => <div className="audit-change" key={field}><h4>{fields[field]}</h4>{field in before && <pre className="audit-before">{fieldValue(field, before[field])}</pre>}<pre>{fieldValue(field, after[field])}</pre></div>)}</details>}</div></article>;
    })}
  </div>;
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, ArrowUpRight, Hash, History, LoaderCircle, MessageSquare, Pause, Play, RefreshCw, Settings2, Terminal } from 'lucide-react';
import type { NativeConversation, WorkspaceEvent } from '../../shared/types';
import type { FeatureProps } from './types';
import { Button, EmptyState, Markdown, PropertyPanel, StatusLabel } from '../components/ui';
import { formatDate, runtimeLabel } from '../components/format';
import { Property } from './ProjectView';
import { nativeContinuationBlock } from './featureOwnership';
import { EventLog } from './EventLog';
import { RunHistory } from './RunsView';
import { NativeConversationView, nativeConversationReady } from './NativeConversationView';
import './content.css';

export function ChannelView(props: FeatureProps & { id: string }) {
  const { id, snapshot, api, busy, onMutate, onNavigate, onEditChannel, showInspector } = props;
  const channel = snapshot.channels.find(c => c.id === id);
  const project = snapshot.projects.find(p => p.id === channel?.projectId);
  const nativeCodex = channel?.runtime === 'codex' && !project?.isDemo;
  const [tab, setTab] = useState<'conversation' | 'activity' | 'runs'>(nativeCodex ? 'conversation' : 'activity');
  const [nativeConversation, setNativeConversation] = useState<NativeConversation | null>(null);
  const [details, setDetails] = useState(false);
  const [message, setMessage] = useState('');
  const [older, setOlder] = useState<WorkspaceEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const snapshotBaseline = useRef(new Set<string>());
  const historyGeneration = useRef(0);
  const historyBusy = useRef(false);
  const events = useMemo(() => {
    const loadedIds = new Set(older.map(event => event.id));
    const live = snapshot.events.filter(event => event.channelId === id && (!historyLoaded || loadedIds.has(event.id) || !snapshotBaseline.current.has(event.id)));
    return [...new Map([...older.filter(event => event.channelId === id), ...live].map(event => [event.id, event])).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.detail?.sequence ?? 0) - (b.detail?.sequence ?? 0));
  }, [older, snapshot.events, id, historyLoaded]);
  const runs = snapshot.runs.filter(r => r.channelId === id).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const loadHistory = useCallback(async (before?: string) => {
    if (historyBusy.current) return;
    const generation = historyGeneration.current;
    historyBusy.current = true;
    setLoadingOlder(true); setHistoryError('');
    try { const page = await api.getEvents({ channelId: id, ...(before ? { before } : {}), limit: 60 }); if (historyGeneration.current !== generation) return; setOlder(previous => before ? [...page.events, ...previous] : page.events); setHistoryLoaded(true); setHasMore(page.hasMore); setCursor(page.cursor || page.events[0]?.id); }
    catch (error) { if (historyGeneration.current !== generation) return; setHistoryError(error instanceof Error ? error.message : '暂时无法加载记录，已保留当前内容。'); }
    finally { if (historyGeneration.current === generation) { historyBusy.current = false; setLoadingOlder(false); } }
  }, [api, id]);
  const channelExists = !!channel;
  useEffect(() => {
    historyGeneration.current++; historyBusy.current = false;
    snapshotBaseline.current = new Set(snapshot.events.map(event => event.id));
    setOlder([]); setHistoryLoaded(false); setHasMore(false); setCursor(undefined); setLoadingOlder(false); setHistoryError(''); setMessage(''); setTab(nativeCodex ? 'conversation' : 'activity'); setNativeConversation(null); setDetails(false);
    if (channelExists) void loadHistory();
    return () => { historyGeneration.current++; };
  }, [id, channelExists, loadHistory, nativeCodex]);
  async function send() {
    if (nativeCodex || !message.trim() || busy) return;
    const value = message.trim();
    if (await onMutate(() => api.sendMessage(id, value))) { setMessage(''); setTab('activity'); }
  }
  if (!channel) return <EmptyState icon={<Hash />} title="频道不存在" description="请从项目中重新选择频道。" />;
  const paused = channel.autonomyEnabled === undefined ? channel.status === 'paused' || channel.status === 'blocked' : !channel.autonomyEnabled;
  const demo = !!project?.isDemo;
  const nativeBlock = nativeContinuationBlock(snapshot, channel.projectId);
  const nativeBusy = !!nativeConversation?.thread?.activeTurnId || ['active', 'inProgress', 'running'].includes(nativeConversation?.thread?.status || '');
  const nativeRunUnavailable = nativeCodex && (!nativeConversationReady(nativeConversation) || !nativeConversation?.status.capabilities.send || nativeBusy);
  const activity = <>{historyError && <div className="feature-inline-error" role="alert">{historyError}<Button variant="ghost" onClick={() => void loadHistory(cursor)}>重试</Button></div>}{loadingOlder && <div className="run-loading" role="status"><LoaderCircle className="spin" size={14} />正在读取记录…</div>}{events.length > 0 ? <div className="event-timeline">{hasMore && !historyError && <div className="load-history"><Button variant="ghost" disabled={loadingOlder} onClick={() => void loadHistory(cursor)}><History size={14} />加载更早记录</Button></div>}{events.map(event => <EventLog key={event.id} event={event} runtime={channel.runtime} />)}</div> : !loadingOlder && !historyError && <EmptyState icon={<MessageSquare />} title="频道还没有动态" description={nativeCodex ? "这里记录频道设置、调度和操作；下方消息直接发送到 Codex CLI。" : "补充背景或约束，再运行一次。Agent 会带着这些上下文继续探索。"} />}</>;
  return <div className="feature-layout"><main className="feature-main">
    <header className="channel-heading"><div className="channel-title"><Hash size={22} /><h1>{channel.name}</h1>{nativeCodex ? <span className="channel-work-status">{nativeBusy ? paused ? '正在回应你的指导' : 'Codex 正在工作' : channel.work?.awaitingReply ? '等你指导' : paused ? '已暂停' : channel.nextRunAt ? '已安排下一步' : '等待继续'}</span> : <StatusLabel status={channel.status} />}{demo && <span className="feature-demo-label">示例数据</span>}</div><div className="channel-actions">{nativeCodex ? <><Button variant="ghost" onClick={() => {setDetails(value=>!value);setTab('conversation');}}>工作详情</Button><Button variant="primary" disabled={busy || (paused && !(nativeConversation?.status.capabilities.create || nativeConversationReady(nativeConversation)))} onClick={() => void onMutate(async () => {if(paused&&!nativeConversation?.threadId)await api.createNativeThread(id);await api.channelAction(id,paused?'resume':'pause');})}>{paused ? <Play size={13}/> : <Pause size={13}/>} {paused ? channel.lastRunAt ? '继续工作' : '开始工作' : '暂停'}</Button></> : <><Button variant="primary" disabled={busy || demo || channel.status === 'running' || nativeRunUnavailable} onClick={() => void onMutate(() => api.channelAction(id, 'run'))}><Play size={13} />运行一次</Button><Button disabled={busy || demo} onClick={() => void onMutate(() => api.channelAction(id, paused ? 'resume' : 'pause'))}>{paused ? <RefreshCw size={13} /> : <Pause size={13} />}{paused ? '开启持续运行' : '暂停频道'}</Button></>}</div></header>
    {nativeCodex && <div className="channel-direction"><div><span className="channel-direction-label">工作方向</span><p>{channel.goal}</p></div><Button variant="ghost" onClick={()=>onEditChannel(channel)}>调整方向</Button></div>}
    {nativeCodex && channel.work && <div className="channel-next-step"><span>{channel.work.awaitingReply?'需要你指导':'下一步'}</span><p>{channel.work.nextStep}</p>{!paused&&channel.nextRunAt&&<time>{formatDate(channel.nextRunAt)}</time>}</div>}
    {demo && <div className="channel-demo-note">示例频道用于浏览流程，不会执行任务。</div>}
    {(!nativeCodex || details) && <div className="feature-toolbar channel-tabbar"><div className="feature-tabs" role="tablist" aria-label="频道内容">{nativeCodex && <button role="tab" aria-selected={tab === 'conversation'} className={tab === 'conversation' ? 'active' : ''} onClick={() => setTab('conversation')}>原生对话</button>}<button role="tab" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>动态</button><button role="tab" aria-selected={tab === 'runs'} className={tab === 'runs' ? 'active' : ''} onClick={() => setTab('runs')}>运行记录 <span>{runs.length}</span></button></div><div className="feature-toolbar-spacer" />{project && <Button variant="ghost" onClick={() => onNavigate({ kind: 'project', id: project.id })}>项目功能看板<ArrowUpRight size={12} /></Button>}<span className="channel-engine">{runtimeLabel(channel.runtime)}</span></div>}
    {nativeCodex && <NativeConversationView key={id} channelId={id} api={api} autonomous compact={!details} direction={channel.goal} active={tab !== 'runs'} onState={setNativeConversation} historyContent={tab === 'activity' ? activity : undefined} onSent={() => setTab('conversation')} />}
    {(tab === 'runs' || (!nativeCodex && tab === 'activity')) && <div className="feature-scroll channel-body">
      {tab === 'activity' ? activity : <RunHistory {...props} runs={runs} query={{ channelId: id }} showChannel={false} />}
    </div>}
    {!nativeCodex && tab === 'activity' && <div className="message-composer"><div className="composer-box"><textarea aria-label="向频道补充上下文" placeholder="补充背景，或为下一次探索指明方向…" value={message} onChange={event => setMessage(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); } }} /><div className="composer-footer"><span>将在下一次运行时读取</span><Button variant="primary" aria-label="发送消息，快捷键 Command Enter" disabled={busy || !message.trim()} onClick={() => void send()}><ArrowUp size={15} /></Button></div></div><span className="composer-hint">⌘ Enter 发送 · 消息不会自动启动运行</span></div>}
  </main>{showInspector && (!nativeCodex || details) && <PropertyPanel><section className="property-section"><h3>属性 <button aria-label="编辑频道设置" className="property-icon-button" onClick={() => onEditChannel(channel)}><Settings2 size={14} /></button></h3><Property label="状态"><StatusLabel status={channel.status} /></Property><Property label="引擎">{runtimeLabel(channel.runtime)}</Property><Property label="模型">{nativeCodex ? nativeConversation?.thread?.model || '原生对话设置' : channel.model || 'CLI 默认模型'}</Property><Property label="权限">{nativeCodex ? '原生对话设置' : channel.permission === 'read-only' ? '只读工作空间' : '允许工作区写入'}</Property><Property label="运行间隔">{channel.intervalMinutes} 分钟</Property><Property label="每日上限">{channel.maxRunsPerDay} 次</Property><Button variant="ghost" onClick={() => onEditChannel(channel)}><Settings2 size={14} />编辑设置</Button>{nativeCodex ? null : <Button variant="ghost" title={nativeBlock || '继续此频道的原生会话；没有会话时打开项目目录中的 CLI。'} disabled={busy || !!nativeBlock} onClick={() => void onMutate(() => api.openNativeSession(channel.id))}><Terminal size={14} />在原生 CLI 中继续</Button>}</section><section className="property-section"><h3>持续目标</h3><div className="property-description"><Markdown>{channel.goal}</Markdown></div></section><section className="property-section"><h3>调度</h3><Property label="上次运行">{formatDate(channel.lastRunAt)}</Property><Property label="下次运行">{channel.status === 'paused' ? '已暂停' : channel.nextRunAt ? formatDate(channel.nextRunAt) : '等待调度'}</Property>{(nativeCodex ? nativeConversation?.threadId : channel.sessionId) && <><h4 className="property-small-label">原生会话</h4><code className="property-session">{nativeCodex ? nativeConversation?.threadId : channel.sessionId}</code></>}</section></PropertyPanel>}</div>;
}

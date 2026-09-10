import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, ArrowUpRight, Check, ChevronDown, CircleAlert, History, Link2, LoaderCircle, MessageSquare, Paperclip, Plus, RefreshCw, Search, Sparkles, Square, Terminal } from 'lucide-react';
import type { DesktopAPI, NativeAttachment, NativeConversation, NativeItem, NativeMessageInput, NativeMessageReceipt, NativeRequest, NativeThreadSummary } from '../../shared/types';
import { Button, EmptyState, Markdown } from '../components/ui';
import { formatDate } from '../components/format';
import { NativeImage, NativeImageDrafts } from './NativeImages';
import './native-conversation.css';

const pageSize = 80;
const readableError = (value: unknown) => value instanceof Error ? value.message : String(value);
const pretty = (value: unknown) => typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value, null, 2);
const isActive = (conversation: NativeConversation | null) => !!conversation?.thread?.activeTurnId || ['active', 'inProgress', 'running'].includes(conversation?.thread?.status || '');

function mergeItems(previous: NativeItem[], incoming: NativeItem[], direction: 'latest' | 'older', complete = false) {
  const previousById = new Map(previous.map(item => [item.id, item]));
  const reusable = incoming.map(item => {
    const old = previousById.get(item.id);
    return old && JSON.stringify(old) === JSON.stringify(item) ? old : item;
  });
  if (complete) return reusable;
  if (direction === 'older') return [...new Map([...reusable, ...previous].map(item => [item.id, item])).values()];
  const first = reusable[0];
  const boundary = first ? previous.findIndex(item => item.id === first.id) : -1;
  const retained = boundary >= 0 ? previous.slice(0, boundary) : previous;
  return [...new Map([...retained, ...reusable].map(item => [item.id, item])).values()];
}

export function nativeConversationReady(conversation: NativeConversation | null) {
  return !!(conversation?.status.connected && conversation?.threadId && conversation?.lastSyncedAt && !conversation.syncError);
}

interface Props {
  channelId: string; api: DesktopAPI; active?: boolean; autonomous?:boolean; compact?:boolean; direction?:string;
  onState?: (conversation: NativeConversation | null) => void;
  historyContent?: ReactNode;
  onSent?: () => void;
}

export function NativeConversationView({ channelId, api, active = true, onState, historyContent, onSent, autonomous=false, compact=false, direction }: Props) {
  const [conversation, setConversation] = useState<NativeConversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [actionError, setActionError] = useState('');
  const [operation, setOperation] = useState('');
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<NativeAttachment[]>([]);
  const [unconfirmed, setUnconfirmed] = useState<{ input: NativeMessageInput; receipt: NativeMessageReceipt } | null>(null);
  const [picker, setPicker] = useState(false);
  const [threads, setThreads] = useState<NativeThreadSummary[]>([]);
  const [threadSearch, setThreadSearch] = useState('');
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [threadError, setThreadError] = useState('');
  const generation = useRef(0);
  const mounted = useRef(false);
  const readRevision = useRef(0);
  const historyBusy = useRef(false);
  const actionBusy = useRef(false);
  const conversationRef = useRef<NativeConversation | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const stickToEnd = useRef(true);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;

  const publish = useCallback((next: NativeConversation) => {
    conversationRef.current = next;
    setConversation(next);
    onStateRef.current?.(next);
  }, []);

  const refresh = useCallback(async (before?: string) => {
    if (historyBusy.current || !mounted.current) return;
    const currentGeneration = generation.current;
    const currentReadRevision = readRevision.current;
    historyBusy.current = true;
    if (before) setLoadingOlder(true);
    try {
      let next = await api.getNativeConversation(channelId, { limit: pageSize, ...(before ? { before } : {}) });
      if (generation.current !== currentGeneration || readRevision.current !== currentReadRevision) return;
      const old = conversationRef.current;
      const sameThread = !!old && old.threadId === next.threadId;
      const oldIds = new Set(old?.items.map(item => item.id));
      let overlaps = next.items.some(item => oldIds.has(item.id));
      // Reconnection may bring more than one page of new native activity. Fill
      // the gap before joining the old range so no unseen interval is hidden.
      if (!before && sameThread && old.items.length && !overlaps) {
        const seenCursors = new Set<string>();
        for (let page = 0; page < 10 && !overlaps && next.hasMore && next.cursor && !seenCursors.has(next.cursor); page++) {
          seenCursors.add(next.cursor);
          const older = await api.getNativeConversation(channelId, { limit: pageSize, before: next.cursor });
          if (generation.current !== currentGeneration || readRevision.current !== currentReadRevision) return;
          if (older.threadId !== next.threadId) break;
          next = { ...next, items: mergeItems(next.items, older.items, 'older'), hasMore: older.hasMore, cursor: older.cursor };
          overlaps = older.items.some(item => oldIds.has(item.id));
        }
      }
      const canMerge = sameThread && (before || overlaps || !old.items.length);
      const items = canMerge ? mergeItems(old.items, next.items, before ? 'older' : 'latest', !before && !next.hasMore) : next.items;
      publish({ ...next, items, ...(canMerge && !before && old.items.length > 0 && items[0]?.id === old.items[0]?.id && next.hasMore ? { hasMore: old.hasMore, cursor: old.cursor } : {}) });
      setHistoryError('');
    } catch (error) {
      if (generation.current !== currentGeneration || readRevision.current !== currentReadRevision) return;
      const message = readableError(error);
      setHistoryError(message);
      const old = conversationRef.current;
      if (old && !before) publish({ ...old, status: { ...old.status, connected: false }, syncError: message });
    } finally {
      if (generation.current === currentGeneration) { historyBusy.current = false; setLoading(false); setLoadingOlder(false); }
    }
  }, [api, channelId, publish]);

  useEffect(() => {
    mounted.current = true;
    generation.current++;
    historyBusy.current = false;
    actionBusy.current = false;
    conversationRef.current = null;
    setConversation(null); setLoading(true); setHistoryError(''); setActionError(''); setDraft(''); setAttachments([]); setUnconfirmed(null); setPicker(false); setThreads([]); setOperation('');
    onStateRef.current?.(null);
    void refresh();
    return () => { mounted.current = false; generation.current++; };
  }, [refresh]);

  useEffect(() => {
    if (!active) return;
    const poll = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    poll();
    const interval = window.setInterval(poll, 700);
    window.addEventListener('focus', poll);
    return () => { window.clearInterval(interval); window.removeEventListener('focus', poll); };
  }, [active, refresh]);

  useEffect(() => {
    if (active && stickToEnd.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [active, conversation?.items, conversation?.requests]);

  async function loadThreads() {
    const currentGeneration = generation.current;
    setPicker(true); setLoadingThreads(true); setThreadError('');
    try {
      const result = await api.listNativeThreads(channelId);
      if (generation.current !== currentGeneration) return;
      setThreads(result.threads);
      if (!result.status.connected) setThreadError(result.status.detail);
    } catch (error) { if (generation.current === currentGeneration) setThreadError(readableError(error)); }
    finally { if (generation.current === currentGeneration) setLoadingThreads(false); }
  }

  async function runAction(name: string, action: () => Promise<unknown>) {
    if (actionBusy.current) return;
    const currentGeneration = generation.current;
    actionBusy.current = true; setOperation(name); setActionError('');
    try {
      await action();
      if (generation.current !== currentGeneration) return;
      await refresh();
    } catch (error) { if (generation.current === currentGeneration) setActionError(readableError(error)); }
    finally { if (generation.current === currentGeneration) { actionBusy.current = false; setOperation(''); } }
  }

  async function bind(threadId?: string) {
    await runAction('bind', async () => {
      const currentGeneration = generation.current;
      const next = threadId ? await api.bindNativeThread(channelId, threadId) : await api.createNativeThread(channelId);
      if (generation.current !== currentGeneration) return;
      readRevision.current++;
      publish(next); setPicker(false); setDraft(''); setAttachments([]); setUnconfirmed(null); stickToEnd.current = true;
    });
  }

  async function send(previous?: NativeMessageInput) {
    const current = conversationRef.current;
    if (actionBusy.current || !(nativeConversationReady(current) || (autonomous && !current?.threadId && current?.status.capabilities.create)) || !current?.status.capabilities.send || (!previous && ((!draft.trim() && !attachments.length) || unconfirmed))) return;
    const currentGeneration = generation.current;
    const input: NativeMessageInput = previous || { text: draft, requestId: crypto.randomUUID(), ...(attachments.length ? { attachments: attachments.map(({ id, name, mimeType }) => ({ id, name, mimeType })) } : {}) };
    actionBusy.current = true; setOperation('send'); setActionError('');
    try {
      const receipt = await api.sendNativeMessage(channelId, input);
      if (generation.current !== currentGeneration) return;
      if (receipt.state === 'accepted') {
        setDraft(value => value === input.text ? '' : value);
        const sentIds = new Set(input.attachments?.map(attachment => attachment.id));
        setAttachments(value => value.filter(attachment => !sentIds.has(attachment.id)));
        setUnconfirmed(null); stickToEnd.current = true; onSent?.();
      } else if (receipt.state === 'failed') {
        setUnconfirmed(null); setActionError(receipt.error || '原生任务未接收消息，请检查后重试。');
      } else setUnconfirmed({ input, receipt });
      await refresh();
    } catch (error) {
      if (generation.current !== currentGeneration) return;
      // A lost reply does not prove that the native App rejected the message.
      // Keep the exact idempotency key until the service can reconcile it.
      setUnconfirmed({ input, receipt: { requestId: input.requestId, state: 'unknown', error: readableError(error) } });
    } finally { if (generation.current === currentGeneration) { actionBusy.current = false; setOperation(''); } }
  }

  async function chooseImages() {
    await runAction('images', async () => {
      const currentGeneration = generation.current;
      const selected = await api.chooseNativeImages(channelId);
      if (generation.current !== currentGeneration) return;
      if (attachments.length + selected.length > 5) throw new Error('每条消息最多添加 5 张图片，请移除部分图片后再选择。');
      setAttachments(value => [...value, ...selected]);
    });
  }

  const ready = nativeConversationReady(conversation);
  const canCompose = ready || !!(autonomous && !conversation?.threadId && conversation?.status.capabilities.create);
  const running = isActive(conversation);
  const bound = !!conversation?.threadId;
  const caps = conversation?.status.capabilities;
  const busy = !!operation;
  const syncLabel = loading ? '连接中' : !conversation?.status.connected ? '连接已断开' : !bound ? '尚未关联对话' : ready ? '已同步' : '正在同步';
  const filteredThreads = useMemo(() => {
    const query = threadSearch.trim().toLocaleLowerCase();
    return threads.filter(thread => !query || `${thread.title}\n${thread.id}\n${thread.cwd}`.toLocaleLowerCase().includes(query));
  }, [threads, threadSearch]);
  const pendingRequests = conversation?.requests.filter(request => !['completed', 'resolved', 'cancelled', 'canceled', 'rejected'].includes(request.status)) || [];

  return <section className={`native-conversation ${compact?'native-conversation-compact':''} ${active ? '' : 'native-conversation-hidden'}`} aria-label="Codex 原生对话">
    {conversation?.previousThreadId && <div className="native-background-setup" role="status"><span>已通过 CLI 接续旧对话，后续工作在这里继续。旧任务与记录已保留。</span></div>}
    {(!compact || !ready) && <div className="native-conversation-bar"><span className={`native-sync-label ${ready ? 'is-synced' : ''}`} role="status">{loading ? <LoaderCircle className="spin" size={12} /> : ready ? <Check size={12} /> : <span className="native-sync-dot" />}{syncLabel}</span><span className="native-thread-name" title={conversation?.threadId}>{conversation?.thread?.title || (bound ? 'Codex 对话' : 'Codex CLI')}</span><div className="feature-toolbar-spacer" /><Button variant="ghost" aria-label="重新连接并同步对话" disabled={loading || loadingOlder} onClick={() => void refresh()}><RefreshCw size={13} /></Button>{!compact && <><Button variant="ghost" disabled={busy || running || !caps?.list} onClick={() => void loadThreads()}><Link2 size={13} />{bound ? '切换对话' : '关联对话'}</Button></>}</div>}
    {picker && <div className="native-thread-picker"><header><strong>关联此项目的 App 对话</strong><Button variant="ghost" onClick={() => setPicker(false)}>取消</Button></header><label className="native-thread-search"><Search size={14} /><input autoFocus aria-label="搜索原生对话" placeholder="按对话名称搜索…" value={threadSearch} onChange={event => setThreadSearch(event.target.value)} /></label>{threadError && <div className="feature-inline-error" role="alert">{threadError}<Button variant="ghost" onClick={() => void loadThreads()}>重试</Button></div>}<div className="native-thread-options">{loadingThreads ? <div className="run-loading"><LoaderCircle className="spin" size={14} />正在读取 App 对话…</div> : filteredThreads.length ? filteredThreads.map(thread => <button className="native-thread-option" key={thread.id} disabled={busy || thread.id === conversation?.threadId} onClick={() => void bind(thread.id)}><MessageSquare size={14} /><span><strong>{thread.title || '未命名对话'}</strong><small>{thread.cwd}</small></span><time>{formatDate(thread.updatedAt || '')}</time>{thread.id === conversation?.threadId && <Check size={14} />}</button>) : !threadError && <p className="native-picker-empty">{threadSearch ? '没有匹配的对话。' : '此项目还没有可关联的 App 对话。'}</p>}</div>{caps?.create && <Button variant="ghost" disabled={busy} onClick={() => void bind()}><Plus size={13} />新建原生对话</Button>}</div>}
    <div className="native-conversation-scroll" ref={scroll} onScroll={event => { const node = event.currentTarget; stickToEnd.current = node.scrollHeight - node.scrollTop - node.clientHeight < 72; }}>
      <div className="native-conversation-document">
        {(historyError || conversation?.syncError) && <div className="feature-inline-error" role="alert">{historyError || conversation?.syncError}<Button variant="ghost" onClick={() => void refresh()}>重新连接</Button>{conversation?.canRecreateEmpty && <Button variant="ghost" disabled={busy} onClick={() => void runAction('recreate-empty', async () => { publish(await api.createNativeThread(channelId)); })}>重新创建空白对话</Button>}</div>}
        {actionError && <div className="feature-inline-error" role="alert">{actionError}</div>}
        {loading && <div className="run-loading"><LoaderCircle className="spin" size={14} />正在读取原生对话…</div>}
        {!loading && !bound && autonomous && <EmptyState icon={<Sparkles/>} title="让 Codex 沿着这个方向开始" description="点击上方开始工作，它会自主判断下一步。你也可以先在下面补充背景。"/>}
        {!loading && !bound && !autonomous && <EmptyState icon={<MessageSquare />} title="接上你的 Codex CLI 对话" description={conversation?.status.detail || '关联此项目已有的原生对话，消息、回复和工具活动会在这里同步。'} action={<><Button disabled={busy || !caps?.list} onClick={() => void loadThreads()}><Link2 size={14} />关联已有对话</Button>{caps?.create && <Button variant="primary" disabled={busy || !conversation?.status.connected} onClick={() => void bind()}><Plus size={14} />新建原生对话</Button>}</>} />}
        {historyContent}
        {bound && <>{historyContent === undefined && <>{conversation.hasMore && <div className="load-history"><Button variant="ghost" disabled={loadingOlder || !conversation.cursor} onClick={() => { stickToEnd.current = false; void refresh(conversation.cursor); }}>{loadingOlder ? <LoaderCircle className="spin" size={13} /> : <History size={13} />}加载更早对话</Button></div>}{<NativeTranscript items={conversation.items} compact={compact} channelId={channelId} api={api}/>}{!loading && !conversation.items.length && !conversation.syncError && <EmptyState icon={<MessageSquare />} title={autonomous?"准备好继续了":"原生对话已关联"} description={autonomous?"告诉 Codex 你的想法，或点击开始工作，让它主动推进这个方向。":"发送消息，直接在这条 Codex CLI 对话中继续。"} />}</>}{pendingRequests.map(request => <NativeRequestView key={request.id} request={request} disabled={busy || !ready} canRespond={!!caps?.respond} onRespond={response => api.respondNativeRequest(channelId, request.id, response).then(() => refresh())} />)}{running && <div className="native-running" role="status"><LoaderCircle className="spin" size={13} />Codex 正在处理{!conversation?.thread?.activeTurnId && '，等待轮次确认'}</div>}</>}
      </div>
    </div>
    {(bound || autonomous) && <div className="message-composer native-composer">{unconfirmed && <div className="native-send-pending" role="alert"><CircleAlert size={14} /><div><strong>{unconfirmed.receipt.state === 'pending' ? '正在等待原生任务确认' : '消息的接收状态尚未确认'}</strong><p>{unconfirmed.receipt.error || '保留了原消息，核对结果后继续。'}</p></div><Button variant="ghost" disabled={busy || !ready} onClick={() => void send(unconfirmed.input)}>核对发送结果</Button></div>}<div className="composer-box"><NativeImageDrafts attachments={attachments} disabled={busy || !!unconfirmed} onRemove={id => setAttachments(value => value.filter(attachment => attachment.id !== id))} /><textarea aria-label="发送到 Codex CLI 原生对话" placeholder={autonomous?'指导 Codex，补充想法，或调整当前重点…':ready ? running ? '补充指令，继续当前轮次…' : '与 Codex 对话…' : '连接恢复后可继续发送…'} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /><div className="composer-footer"><span>{autonomous?'随时指导，继续同一份工作':<>{conversation?.thread?.model || '原生模型与权限'}{running ? ' · 当前轮次进行中' : ' · 同一条 CLI 对话'}</>}</span><div className="native-composer-actions"><Button aria-label="添加图片" title="最多 5 张图片，单张不超过 10 MB，合计不超过 20 MB" disabled={busy || !ready || !caps?.send || attachments.length >= 5 || !!unconfirmed} onClick={() => void chooseImages()}>{operation === 'images' ? <LoaderCircle size={14} className="spin" /> : <Paperclip size={14} />}</Button>{running && caps?.interrupt && <Button aria-label="停止当前原生轮次" title="停止当前原生轮次" disabled={busy || !ready || !conversation?.thread?.activeTurnId} onClick={() => void runAction('interrupt', () => api.interruptNativeTurn(channelId, conversation?.thread!.activeTurnId!))}><Square size={12} /></Button>}<Button variant="primary" aria-label={running ? '追加到当前 Codex 轮次' : '发送到 Codex CLI'} disabled={busy || !canCompose || !caps?.send || (!draft.trim() && !attachments.length) || !!unconfirmed} onClick={() => void send()}>{operation === 'send' ? <LoaderCircle size={14} className="spin" /> : <ArrowUp size={15} />}</Button></div></div></div><span className="composer-hint">⌘ Enter {running ? '追加指令' : '发送'} · {ready ? '消息直接进入原生对话' : '当前显示上次同步的记录'}{conversation?.lastSyncedAt && <time>上次同步 {formatDate(conversation?.lastSyncedAt)}</time>}</span></div>}
  </section>;
}

function NativeTranscript({items,compact,channelId,api}:{items:NativeItem[];compact:boolean;channelId:string;api:DesktopAPI}) {
  const blocks:ReactNode[]=[];let tools:NativeItem[]=[];
  const flush=()=>{if(!tools.length)return;const group=tools;tools=[];blocks.push(<NativeDetails key={`tools-${group[0].id}`} className="native-work-process" summary={<>工作过程<span>{group.length} 项活动</span></>}>{()=> <>{group.map(item=><NativeConversationItem key={item.id} item={item} channelId={channelId} api={api}/>)}</>}</NativeDetails>);};
  for(const item of items){if(compact&&!item.autonomousContext&&!['user','assistant'].includes(item.role||'')&&!['userMessage','agentMessage','steeringUserMessage'].includes(item.type))tools.push(item);else{flush();blocks.push(<NativeConversationItem key={item.id} item={item} channelId={channelId} api={api}/>);}}
  flush();return <>{blocks}</>;
}

const NativeConversationItem = memo(function NativeConversationItem({ item, channelId, api }: { item: NativeItem; channelId: string; api: DesktopAPI }) {
  const user = item.role === 'user' || item.type === 'userMessage' || item.type === 'steeringUserMessage';
  const assistant = item.role === 'assistant' || item.type === 'agentMessage';
  if(item.autonomousContext)return <NativeDetails className="native-raw-record native-work-context" summary="继续工作 · 已准备项目上下文">{()=> <pre>{item.text}</pre>}</NativeDetails>;
  if (item.type === 'steered') return <div className="native-steered"><Check size={12} />指令已追加到当前轮次</div>;
  if (user || assistant) return <article className={`message-event native-message ${user ? 'human-event' : ''}`}><div className="event-avatar">{user ? <MessageSquare size={14} /> : <Sparkles size={14} />}</div><div className="message-event-body"><header><strong>{user ? '你' : 'Codex'}</strong>{item.status === 'inProgress' && <LoaderCircle size={12} className="spin" />}{item.createdAt && <time>{formatDate(item.createdAt)}</time>}</header>{item.text && <Markdown>{assistant?item.text.replace(/```(?:morrow|nohuman)-(?:next|report)\s*\n[\s\S]*?(?:```|$)/g,'').trim():item.text}</Markdown>}{assistant&&/```(?:morrow|nohuman)-(?:next|report)/.test(item.text)&&<NativeDetails className="native-raw-record" summary="工作安排与看板记录">{()=> <pre>{item.text}</pre>}</NativeDetails>}<NativeAttachments item={item} channelId={channelId} api={api} />{!item.text && !Array.isArray(item.raw.content) && !Array.isArray(item.raw.input) && <NativeDetails className="native-raw-record" summary="原生消息内容">{() => <pre>{pretty(item.raw)}</pre>}</NativeDetails>}</div></article>;
  const names: Record<string, string> = { commandExecution: '运行命令', fileChange: '文件修改', mcpToolCall: '调用工具', dynamicToolCall: '调用工具', subAgentActivity: '子任务活动', reasoning: '思考摘要', webSearch: '搜索网页', imageView: '查看图片', imageGeneration: '生成图片', contextCompaction: '整理上下文', plan: '计划', enteredReviewMode: '开始评审', exitedReviewMode: '评审结果' };
  const name = typeof item.raw.tool === 'string' ? item.raw.tool : names[item.type] || item.type || '原生活动';
  return <NativeDetails className="tool-event native-tool" autoOpen={item.status === 'failed'} summary={<><Terminal size={13} /><span>{name}</span>{item.status && <span className="native-item-status">{({ inProgress: '进行中', completed: '完成', failed: '失败', declined: '已拒绝' } as Record<string, string>)[item.status] || item.status}</span>}{item.createdAt && <time>{formatDate(item.createdAt)}</time>}<ChevronDown size={12} /></>}>{() => <NativeToolBody item={item} />}</NativeDetails>;
});

function NativeDetails({ className, autoOpen = false, summary, children }: { className: string; autoOpen?: boolean; summary: ReactNode; children: () => ReactNode }) {
  const [open, setOpen] = useState(autoOpen);
  useEffect(() => { if (autoOpen) setOpen(true); }, [autoOpen]);
  return <details className={className} open={open} onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}><summary>{summary}</summary>{open ? children() : null}</details>;
}

function NativeToolBody({ item }: { item: NativeItem }) {
  const input = pretty(item.input ?? item.raw.command ?? item.raw.arguments);
  const output = pretty(item.output ?? item.raw.aggregatedOutput ?? item.raw.result ?? item.raw.changes ?? item.raw.error);
  return <div className="tool-event-body">{item.text && <Markdown>{item.text}</Markdown>}{input && <><h4>输入</h4><pre>{input}</pre></>}{output && <><h4>输出</h4><pre>{output}</pre></>}<NativeDetails className="native-raw-record" summary="完整原生记录">{() => <pre>{pretty(item.raw)}</pre>}</NativeDetails></div>;
}

function NativeAttachments({ item, channelId, api }: { item: NativeItem; channelId: string; api: DesktopAPI }) {
  const blocks = Array.isArray(item.raw.content) ? item.raw.content : Array.isArray(item.raw.input) ? item.raw.input : [];
  return <>{blocks.map((block, index) => {
    if (!block || typeof block !== 'object') return null;
    const value = block as Record<string, unknown>;
    if (value.type === 'text') return null;
    if (value.type === 'image' || value.type === 'localImage') return <NativeImage key={index} channelId={channelId} itemId={item.id} index={index} api={api} name={typeof value.name === 'string' ? value.name : '原生图片'} />;
    const path = typeof value.path === 'string' ? value.path : typeof value.url === 'string' ? value.url : '';
    const label = typeof value.name === 'string' ? value.name : ['image', 'localImage'].includes(String(value.type)) ? '图片附件' : String(value.type || '附件');
    return <NativeDetails className="native-attachment" key={index} summary={<>{label}{path && <span>{path}</span>}</>}>{() => <pre>{pretty(value)}</pre>}</NativeDetails>;
  })}</>;
}

function NativeRequestView({ request, disabled, canRespond, onRespond }: { request: NativeRequest; disabled: boolean; canRespond: boolean; onRespond: (response: unknown) => Promise<unknown> }) {
  const [sending, setSending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [otherAnswers, setOtherAnswers] = useState<Record<string, string>>({});
  const method = typeof request.raw.method === 'string' ? request.raw.method : request.type;
  const params = request.raw.params && typeof request.raw.params === 'object' ? request.raw.params as Record<string, unknown> : request.raw;
  const approval = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method);
  const questions = method === 'item/tool/requestUserInput' && Array.isArray(params.questions) ? params.questions.filter((question): question is Record<string, unknown> => !!question && typeof question === 'object' && typeof question.id === 'string') : [];
  const valueFor = (id: string) => answers[id] === '__other__' ? otherAnswers[id] || '' : answers[id] || '';
  const unavailable = disabled || sending || submitted;
  async function respond(value: unknown) {
    if (unavailable) return;
    setSending(true); setError('');
    try { await onRespond(value); setSubmitted(true); }
    catch (failure) { setError(readableError(failure)); }
    finally { setSending(false); }
  }
  return <div className="native-request"><div><CircleAlert size={15} /><strong>{request.title || (questions.length ? 'Codex 需要你的回答' : 'Codex 需要你的确认')}</strong></div>{typeof params.command === 'string' && <pre className="native-request-command">{params.command}</pre>}{typeof params.reason === 'string' && <p className="native-request-reason">{params.reason}</p>}{canRespond && approval && <div className="native-request-actions"><Button disabled={unavailable} onClick={() => void respond({ decision: 'accept' })}>批准本次</Button><Button disabled={unavailable} onClick={() => void respond({ decision: 'decline' })}>拒绝</Button></div>}{canRespond && questions.length > 0 && <form onSubmit={event => { event.preventDefault(); void respond({ answers: Object.fromEntries(questions.map(question => [String(question.id), { answers: [valueFor(String(question.id))] }])) }); }}>{questions.map(question => {
    const id = String(question.id);
    const options = Array.isArray(question.options) ? question.options.filter((option): option is Record<string, unknown> => !!option && typeof option === 'object' && typeof option.label === 'string') : [];
    const label = String(question.question || question.header || id);
    return <label className="native-input-question" key={id}><span>{label}</span>{options.length ? <select aria-label={label} disabled={unavailable} value={answers[id] || ''} onChange={event => setAnswers(old => ({ ...old, [id]: event.target.value }))}><option value="" disabled>选择一个回答</option>{options.map(option => <option value={String(option.label)} key={String(option.label)}>{String(option.label)}{typeof option.description === 'string' ? ` — ${option.description}` : ''}</option>)}{question.isOther === true && <option value="__other__">填写其他回答</option>}</select> : <input aria-label={label} type={question.isSecret === true ? 'password' : 'text'} disabled={unavailable} value={answers[id] || ''} onChange={event => setAnswers(old => ({ ...old, [id]: event.target.value }))} />}{answers[id] === '__other__' && <input aria-label={`${label}：其他回答`} disabled={unavailable} value={otherAnswers[id] || ''} onChange={event => setOtherAnswers(old => ({ ...old, [id]: event.target.value }))} />}</label>;
  })}<Button type="submit" disabled={unavailable || questions.some(question => !valueFor(String(question.id)).trim())}>提交回答</Button></form>}{submitted && <p className="native-request-reason" role="status">已提交，等待 Codex 更新请求状态…</p>}{error && <div className="feature-inline-error" role="alert">{error}</div>}<NativeDetails className="native-raw-record" summary="请求详情">{() => <pre>{pretty(request.raw)}</pre>}</NativeDetails></div>;
}

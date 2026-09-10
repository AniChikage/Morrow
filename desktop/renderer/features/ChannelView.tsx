import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Hash, Pause, Play } from 'lucide-react';
import { isLegacyRuntime } from '../../shared/types';
import type { NativeConversation, NativeThreadSummary, ProjectUsage, Run, RunDetails } from '../../shared/types';
import type { FeatureProps } from './types';
import { Button, EmptyState, Markdown, PropertyPanel } from '../components/ui';
import { channelStatusLabel, formatDate, runtimeLabel, usageWindowLabel } from '../components/format';
import { Property } from './ProjectView';
import { ChannelQuestion } from './ChannelQuestion';
import { ChannelAudit } from './ChannelAudit';
import { ProjectReleases } from './ProjectWork';
import './content.css';
import './channel-log.css';

const ready = (value: NativeConversation | null) =>
  !!(value?.status.connected && value.threadId && value.lastSyncedAt && !value.syncError);
const active = (value: NativeConversation | null) =>
  !!value?.thread?.activeTurnId || ['active', 'running', 'inProgress'].includes(value?.thread?.status || '');
const mergeRuns = (old: Run[], next: Run[]) =>
  [...new Map([...old, ...next].map((run) => [run.id, run])).values()].sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt)
  );
const stateLabel = (value: string) =>
  ({
    continue: '继续推进',
    wait: '等待',
    needs_input: '需要回答',
    completed: '已完成',
    failed: '失败',
    running: '工作中',
  })[value] || value;
const runUsage = (run: Run) =>
  run.usage?.delta && Object.keys(run.usage.delta).length
    ? Object.entries(run.usage.delta)
        .map(([key, value]) => `${usageWindowLabel(key as '5h' | 'weekly')} 估算 ${value}%`)
        .join(' · ')
    : '额度消耗未记录';

function LogEntry({
  run,
  api,
  currentWork,
  onNavigate,
}: Pick<FeatureProps, 'api' | 'onNavigate'> & { run: Run; currentWork?: import('../../shared/types').ChannelWork }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<RunDetails>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    api.getRun(run.id).then(
      (value) => {
        if (!cancelled) {
          setDetail(value);
          setError('');
        }
      },
      (failure) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : '详情读取失败');
      }
    );
    return () => {
      cancelled = true;
    };
  }, [expanded, api, run.id, run.status, attempt]);
  const log = detail?.run.log || run.log;
  const work = log?.work || currentWork;
  const duration = run.finishedAt
    ? Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000))
    : undefined;
  return (
    <article className="channel-log-entry" aria-label={`轮次 ${formatDate(run.startedAt)}`}>
      <header>
        <time dateTime={run.startedAt}>{formatDate(run.startedAt)}</time>
        <span>{stateLabel(run.status)}</span>
        <span>{duration === undefined ? '尚未结束' : `${duration} 秒`}</span>
        <span>{runUsage(run)}</span>
      </header>
      <h3>{work?.focus || log?.direction || '未记录本轮关注点'}</h3>
      <p className="log-reason">{work?.reason || '未记录选择理由'}</p>
      <section>
        <h4>做了什么</h4>
        {!!log?.files.length && <p className="log-files">{log.files.join(' · ')}</p>}
        {log?.commands.length ? (
          <ul className="log-commands">
            {log.commands.map((command) => (
              <li key={command.id}>
                <code>{command.command}</code>
                <span>
                  {command.exitCode === undefined ? stateLabel(command.status) : `退出 ${command.exitCode}`}
                  {!command.sealed && ' · 未封存'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="subtle">未记录命令或文件变更</p>
        )}
      </section>
      <section>
        <h4>产出</h4>
        {log?.outputs.length ? (
          <ul className="log-outputs">
            {log.outputs.map((output) => (
              <li key={`${output.kind}:${output.id}`}>
                <span>{output.kind}</span>
                {output.itemId ? (
                  <button onClick={() => onNavigate({ kind: 'finding', id: output.itemId! })}>{output.title}</button>
                ) : (
                  <span>{output.title}</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="subtle">未记录结构化产出</p>
        )}
      </section>
      <section className="log-conclusion">
        <h4>{work ? stateLabel(work.state) : '结论未记录'}</h4>
        <Markdown>{work?.nextStep || '展开查看本轮原话；缺少安排不代表执行失败。'}</Markdown>
      </section>
      {log?.truncated && <p className="subtle">当前为有界摘要，完整过程可在 Codex App 查看。</p>}
      <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>原生工具活动与 Codex 原话</summary>
        {error ? (
          <p role="alert">
            {error}
            <Button onClick={() => setAttempt((value) => value + 1)}>重试详情</Button>
          </p>
        ) : !detail ? (
          <p className="subtle">正在读取详情…</p>
        ) : (
          <>
            {detail.run.log?.activity?.map((item) => (
              <details key={item.id} className="log-native-item">
                <summary>{item.type}</summary>
                <pre>{item.input || item.text}</pre>
                {item.output && <pre>{item.output}</pre>}
              </details>
            ))}
            <Markdown>{detail.finalOutput || run.summary || '本轮没有原话记录。'}</Markdown>
          </>
        )}
      </details>
    </article>
  );
}

export function ChannelView(props: FeatureProps & { id: string }) {
  const { id, snapshot, api, busy, onMutate, onNavigate, onEditChannel, showInspector } = props;
  const channel = snapshot.channels.find((value) => value.id === id);
  const project = snapshot.projects.find((value) => value.id === channel?.projectId);
  const demo = !!project?.isDemo,
    legacy = !!channel && isLegacyRuntime(channel.runtime);
  const native = !!channel && !demo && !legacy;
  const [conversation, setConversation] = useState<NativeConversation | null>(null);
  const [usage, setUsage] = useState<ProjectUsage>();
  const [runs, setRuns] = useState<Run[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [nativeError, setNativeError] = useState('');
  const [threads, setThreads] = useState<NativeThreadSummary[]>([]);
  const [threadId, setThreadId] = useState('');
  const generation = useRef(0),
    inFlight = useRef(false),
    oldestCursor = useRef<string | undefined>(undefined);
  const entryQuestion = useRef<{ id: string; present: boolean } | undefined>(undefined);
  if (entryQuestion.current?.id !== id) entryQuestion.current = { id, present: !!channel?.work?.awaitingReply };
  const load = useCallback(
    async (before?: string) => {
      if (inFlight.current) return;
      inFlight.current = true;
      const gen = generation.current;
      setLoading(true);
      try {
        const page = await api.getRuns({ channelId: id, limit: 20, ...(before ? { before } : {}) });
        if (gen !== generation.current) return;
        setRuns((previous) =>
          mergeRuns(
            previous,
            page.runs.filter((run) => run.channelId === id)
          )
        );
        if (before || !oldestCursor.current) {
          setHasMore(page.hasMore);
          setCursor(page.cursor);
          oldestCursor.current = page.cursor;
        }
        setError('');
      } catch (failure) {
        if (gen === generation.current) setError(failure instanceof Error ? failure.message : '轮次读取失败');
      } finally {
        if (gen === generation.current) {
          inFlight.current = false;
          setLoading(false);
        }
      }
    },
    [api, id]
  );
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    generation.current++;
    inFlight.current = false;
    oldestCursor.current = undefined;
    setRuns(snapshot.runs.filter((run) => run.channelId === id));
    setCursor(undefined);
    setHasMore(false);
    setError('');
    setThreads([]);
    setThreadId('');
    void loadRef.current();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void loadRef.current();
    }, 3000);
    return () => {
      generation.current++;
      window.clearInterval(timer);
    };
  }, [id, api]);
  useEffect(() => {
    setRuns((previous) =>
      mergeRuns(
        previous,
        snapshot.runs
          .filter((run) => run.channelId === id)
          .map((run) => ({ ...run, log: previous.find((old) => old.id === run.id)?.log || run.log }))
      )
    );
  }, [snapshot.runs, id]);
  useEffect(() => {
    let cancelled = false,
      pending = false;
    setConversation(null);
    setUsage(undefined);
    setNativeError('');
    const poll = async () => {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      await Promise.allSettled([
        native
          ? api.getNativeConversation(id, { limit: 1 }).then(
              (value) => {
                if (!cancelled) {
                  setConversation(value);
                  setNativeError('');
                }
              },
              (failure) => {
                if (!cancelled) {
                  setConversation(null);
                  setNativeError(failure instanceof Error ? failure.message : '原生连接不可用');
                }
              }
            )
          : Promise.resolve(),
        project && api.getProjectUsage
          ? api.getProjectUsage(project.id).then(
              (value) => {
                if (!cancelled) setUsage(value);
              },
              () => {
                if (!cancelled) setUsage(undefined);
              }
            )
          : Promise.resolve(),
      ]);
      pending = false;
    };
    void poll();
    const timer = window.setInterval(poll, 3000);
    window.addEventListener('focus', poll);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', poll);
    };
  }, [api, id, native, project?.id]);
  if (!channel || !project)
    return <EmptyState icon={<Hash />} title="频道不存在" description="请从项目中重新选择频道。" />;
  const paused =
    channel.autonomyEnabled === undefined ? ['paused', 'blocked'].includes(channel.status) : !channel.autonomyEnabled;
  const nativeBusy = active(conversation);
  const unavailable = demo
    ? '示例频道不能回答'
    : !ready(conversation)
      ? '原生对话尚未就绪，暂时不能回答'
      : !conversation?.status.capabilities.send
        ? '当前不能发送到原生对话'
        : nativeBusy
          ? 'Codex 正在回应，请稍候'
          : '';
  const pendingReleases = (snapshot.releases || []).filter(
    (row) => row.projectId === project.id && row.channelId === id && row.status === 'awaiting_approval'
  );
  const blocked = snapshot.items.filter(
    (item) =>
      item.status === 'blocked' &&
      (!item.projectId || item.projectId === project.id) &&
      (item.channelId === id || item.sourceChannelIds?.includes(id))
  );
  const needs = !!channel.work?.awaitingReply || pendingReleases.length > 0 || blocked.length > 0;
  const openApp = () => void onMutate(() => api.openNativeApp(id));
  const status = channel.work?.awaitingReply
    ? '等你回答'
    : channel.usageWait && channel.status === 'waiting'
      ? channelStatusLabel(channel)
      : channel.status === 'running'
        ? '工作中'
        : paused
          ? '已暂停'
          : channel.nextRunAt
            ? `等待到 ${formatDate(channel.nextRunAt)}`
            : '等待继续';
  return (
    <div className="feature-layout">
      <main className="feature-main channel-log">
        <header className="channel-heading">
          <div className="channel-title">
            <Hash size={20} />
            <h1>{channel.name}</h1>
            <span className="channel-work-status">{status}</span>
            {demo && <span className="feature-demo-label">示例数据</span>}
          </div>
          <div className="channel-actions">
            <Button disabled={busy || demo || legacy} onClick={openApp}>
              <ArrowUpRight size={13} />在 Codex App 中打开对话
            </Button>
            <Button
              variant="primary"
              disabled={busy || demo || (paused && (legacy || !ready(conversation) || nativeBusy))}
              onClick={() => void onMutate(() => api.channelAction(id, paused ? 'resume' : 'pause'))}
            >
              {paused ? <Play size={13} /> : <Pause size={13} />} {paused ? '继续工作' : '暂停'}
            </Button>
          </div>
        </header>
        <div className="channel-direction">
          <div>
            <span className="channel-direction-label">工作方向</span>
            <p>{channel.goal}</p>
          </div>
          <Button variant="ghost" onClick={() => onEditChannel(channel)}>
            调整方向
          </Button>
        </div>
        <div className="channel-log-status">
          <strong>{channel.work?.focus || '尚未安排关注点'}</strong>
          <span>
            {usage?.budget
              ? `本项目 ${usageWindowLabel(usage.budget.window)} · 估算已用 ${usage.project?.usedPercent ?? '未知'}% / 上限 ${usage.budget.limitPercent}%`
              : usage
                ? '本项目未设置额度上限'
                : '项目额度信息未知'}
          </span>
          <span>
            {usage?.reading && !usage.stale
              ? usage.reading.windows.map((w) => `账户${usageWindowLabel(w.name)} 已用 ${w.usedPercent}%`).join(' · ')
              : '账户额度未知'}
          </span>
        </div>
        {!channel.work?.awaitingReply && channel.work && (
          <div className="channel-next-step">
            <span>下一步</span>
            <p>{channel.work.state === 'needs_input' ? '已回答，等待 Codex 继续' : channel.work.nextStep}</p>
          </div>
        )}
        {nativeError && (
          <p className="feature-inline-error" role="alert">
            {nativeError}
          </p>
        )}
        {native && !conversation?.threadId && (
          <details className="channel-link-task">
            <summary>关联 App 任务</summary>
            <p>在 Codex App 为同一目录创建任务并发送首条消息，再选择关联。</p>
            <Button
              onClick={() =>
                void onMutate(async () => {
                  const result = await api.listNativeThreads(id);
                  setThreads(result.threads);
                })
              }
            >
              读取已有任务
            </Button>
            <select aria-label="已有 App 任务" value={threadId} onChange={(event) => setThreadId(event.target.value)}>
              <option value="">选择任务</option>
              {threads.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.title || thread.id}
                </option>
              ))}
            </select>
            <Button
              disabled={busy || !threadId}
              onClick={() =>
                void onMutate(async () => {
                  setConversation(await api.bindNativeThread(id, threadId));
                })
              }
            >
              关联选中任务
            </Button>
          </details>
        )}
        {legacy && (
          <p role="note" className="channel-demo-note">
            {runtimeLabel(channel.runtime)}：此频道已停止支持，历史记录保持可读。
          </p>
        )}
        <div className="feature-scroll channel-log-scroll">
          {needs && (
            <section className="channel-needs" aria-label="需要你">
              <h2>需要你</h2>
              {channel.work?.awaitingReply && (
                <ChannelQuestion
                  key={`question:${id}:${channel.work.runId}`}
                  channelId={id}
                  work={channel.work}
                  api={api}
                  busy={busy}
                  readOnly={legacy}
                  unavailable={unavailable}
                  autoFocus={entryQuestion.current?.present}
                  onShowConversation={openApp}
                />
              )}
              {!!pendingReleases.length && (
                <details>
                  <summary>待批准发布 · {pendingReleases.map((row) => row.title).join('、')}</summary>
                  <ProjectReleases
                    {...props}
                    snapshot={{ ...snapshot, releases: pendingReleases }}
                    projectId={project.id}
                  />
                </details>
              )}
              {!!blocked.length && (
                <ul>
                  {blocked.map((item) => (
                    <li key={item.id}>
                      <button onClick={() => onNavigate({ kind: 'finding', id: item.id })}>
                        被阻塞 · {item.title}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          <div className="channel-log-heading">
            <h2>工作日志</h2>
            <Button variant="ghost" onClick={() => onNavigate({ kind: 'project', id: project.id })}>
              项目功能看板
              <ArrowUpRight size={12} />
            </Button>
          </div>
          {error && (
            <p role="alert" className="feature-inline-error">
              {error}
              <Button onClick={() => void load(cursor)}>重试轮次</Button>
            </p>
          )}
          {!runs.length && (
            <p className="subtle">{loading ? '正在读取轮次…' : '还没有轮次记录。后续工作会在这里按轮次保留。'}</p>
          )}
          {mergeRuns(
            [],
            runs.filter((run) => run.channelId === id)
          ).map((run) => (
            <LogEntry
              key={`${id}:${run.id}`}
              run={run}
              api={api}
              currentWork={channel.work?.runId === run.id ? channel.work : undefined}
              onNavigate={onNavigate}
            />
          ))}
          {hasMore && (
            <Button disabled={loading} onClick={() => void load(cursor)}>
              {loading ? '正在读取…' : '加载更早轮次'}
            </Button>
          )}
          <details className="channel-audit">
            <summary>频道审计记录</summary>
            <ChannelAudit id={id} api={api} snapshot={snapshot} />
          </details>
        </div>
      </main>
      {showInspector && (
        <PropertyPanel>
          <section className="property-section">
            <h3>工作安排</h3>
            <Property label="状态">{status}</Property>
            <Property label="复查间隔">{channel.intervalMinutes} 分钟</Property>
            <Property label="每日上限">{channel.maxRunsPerDay} 轮</Property>
            <Property label="下次安排">{channel.nextRunAt ? formatDate(channel.nextRunAt) : '尚未安排'}</Property>
            <p className="subtle">对话、模型与工具在 Codex App 管理；这里记录持续工作。</p>
          </section>
        </PropertyPanel>
      )}
    </div>
  );
}

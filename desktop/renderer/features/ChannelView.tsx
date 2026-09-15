import { useCallback, useEffect, useRef, useState } from 'react';
import { Hash, MoreHorizontal, Play } from 'lucide-react';
import { isLegacyRuntime } from '../../shared/types';
import type { NativeConversation, NativeThreadSummary, ProjectUsage, Run, RunDetails } from '../../shared/types';
import type { FeatureProps } from './types';
import { Button, Dropdown, DropdownItem, EmptyState, Markdown } from '../components/ui';
import {
  channelStatusLabel,
  durationSeconds,
  formatDate,
  runTime,
  runtimeLabel,
  usageWindowLabel,
} from '../components/format';
import { ChannelQuestion, questionExcerpt } from './ChannelQuestion';
import { ChannelAudit } from './ChannelAudit';
import { ProjectReleases } from './ProjectWork';
import { upgradeSwitching } from './upgradeState';
import './content.css';
import './channel-log.css';

const ready = (value: NativeConversation | null) =>
  !!(
    value?.status.connected &&
    value.threadId &&
    value.lastSyncedAt &&
    !value.syncError &&
    value.status.readyThreadCount !== 0
  );
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
  primaryAction,
  questionAbove,
}: Pick<FeatureProps, 'api' | 'onNavigate'> & {
  run: Run;
  currentWork?: import('../../shared/types').ChannelWork;
  primaryAction?: boolean;
  questionAbove?: boolean;
}) {
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
  // The polled list owns the summary; a collapsed detail cache may predate completion.
  // Older services without list projections can still supply the summary through details.
  const log = run.log || detail?.run.log;
  const work = log?.work || currentWork;
  // A round owned by the Codex App may carry no native timestamps at all: say so rather than
  // reporting 尚未运行 for a finished round, or NaN 秒 for a duration nothing can be derived from.
  const started = runTime(run, run.startedAt);
  const duration = run.finishedAt ? durationSeconds(run.startedAt, run.finishedAt) : undefined;
  return (
    <article className="channel-log-entry" aria-label={`轮次 ${started}`}>
      <header>
        <time dateTime={run.startedAt || undefined}>{started}</time>
        <span>{stateLabel(run.status)}</span>
        <span>{!run.finishedAt ? '尚未结束' : duration === undefined ? '时长未记录' : `${duration} 秒`}</span>
        <span>{runUsage(run)}</span>
      </header>
      <h3>{work?.focus || log?.direction || (log ? '未记录本轮关注点' : '本轮摘要尚未载入')}</h3>
      <p className="log-summary">
        {questionAbove
          ? '需要回答 · 问题见上方'
          : work
            ? `${stateLabel(work.state)} · ${questionExcerpt(work.nextStep, 100)}`
            : log
              ? '结论未记录'
              : '摘要尚未载入，可展开查看原话。'}
      </p>
      <details className="log-work-details">
        <summary className={primaryAction ? 'log-primary-action' : undefined}>
          {primaryAction ? '查看最新轮次' : '本轮详情'}
        </summary>
        <p className="log-reason">{work?.reason || (log ? '未记录选择理由' : '选择理由尚未载入')}</p>
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
            <p className="subtle">{log ? '未记录命令或文件变更' : '命令与文件记录尚未载入'}</p>
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
            <p className="subtle">{log ? '未记录结构化产出' : '产出记录尚未载入'}</p>
          )}
        </section>
        <section className="log-conclusion">
          <h4>{work ? stateLabel(work.state) : log ? '结论未记录' : '结论尚未载入'}</h4>
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
      </details>
    </article>
  );
}

export function ChannelView(props: FeatureProps & { id: string }) {
  const { id, snapshot, api, busy, onMutate, onNavigate, onEditChannel } = props;
  const channel = snapshot.channels.find((value) => value.id === id);
  const project = snapshot.projects.find((value) => value.id === channel?.projectId);
  const demo = !!project?.isDemo,
    legacy = !!channel && isLegacyRuntime(channel.runtime);
  // While the service steps aside for a new version, nothing may start work; pausing still can.
  const switching = upgradeSwitching(snapshot);
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [releasesOpen, setReleasesOpen] = useState(false);
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
    setSettingsOpen(false);
    setLinkOpen(false);
    setReleasesOpen(false);
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
  // Approvals and follow-up questions raised inside the App are fetched with the conversation but were
  // never shown: a round stuck on one of them looked like Codex was merely slow to answer.
  const appRequests = (conversation?.requests || []).filter(
    (request) => !['completed', 'resolved', 'cancelled', 'canceled', 'rejected'].includes(request.status)
  );
  const appRequestTitles = appRequests
    .map((request) => request.title || request.type)
    .filter(Boolean)
    .join('、');
  // The API keeps App availability even when a task sync error marks this conversation disconnected.
  const unloaded =
    native && !!conversation?.threadId && conversation.status.available && conversation.status.readyThreadCount === 0;
  const nativeProblem =
    nativeError ||
    (native && conversation
      ? !conversation.status.available
        ? conversation.status.detail
        : conversation.syncError || (!conversation.status.connected ? conversation.status.detail : '')
      : '');
  const unavailable = demo
    ? '示例频道不能回答'
    : unloaded
      ? '任务未在 Codex App 中打开，打开后才能继续或回答。'
      : !ready(conversation)
        ? '原生对话尚未就绪，暂时不能回答'
        : !conversation?.status.capabilities.send
          ? '当前不能发送到原生对话'
          : nativeBusy
            ? appRequests.length
              ? 'Codex 在 App 里等你处理（审批/追问）'
              : 'Codex 正在回应，请稍候'
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
  const reviewingRelease = releasesOpen && pendingReleases.length > 0;
  const usageGate = usage?.gate.blocked && !usage.gate.pending ? usage.gate : undefined;
  const needs =
    !!channel.work?.awaitingReply ||
    pendingReleases.length > 0 ||
    blocked.length > 0 ||
    appRequests.length > 0 ||
    !!usageGate;
  const needsLink = native && !!conversation && !conversation.threadId;
  const primary = needsLink
    ? 'link'
    : nativeError || (native && conversation && !ready(conversation))
      ? 'open'
      : channel.work?.awaitingReply
        ? 'answer'
        : pendingReleases.length
          ? 'release'
          : blocked.length
            ? 'blocked'
            : paused && !legacy
              ? 'resume'
              : runs.length
                ? 'latest'
                : 'none';
  const openApp = () => void onMutate(() => api.openNativeApp(id));
  const status = unloaded
    ? '任务未就绪'
    : channel.work?.awaitingReply
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
            {primary === 'open' && (
              <Button variant="primary" disabled={busy} onClick={openApp}>
                {unloaded ? '在 Codex App 中打开' : '在 Codex App 中打开对话'}
              </Button>
            )}
            {primary === 'resume' && (
              <Button
                variant="primary"
                disabled={busy || demo || (paused && (switching || legacy || !ready(conversation) || nativeBusy))}
                onClick={() => void onMutate(() => api.channelAction(id, paused ? 'resume' : 'pause'))}
              >
                <Play size={13} /> 继续工作
              </Button>
            )}
            <Dropdown
              trigger={
                <Button variant="ghost" aria-label="频道选项">
                  <MoreHorizontal size={16} />
                </Button>
              }
            >
              {primary !== 'open' && (
                <DropdownItem disabled={busy || demo || legacy} onSelect={openApp}>
                  在 Codex App 中打开对话
                </DropdownItem>
              )}
              <DropdownItem onSelect={() => onEditChannel(channel)}>调整方向</DropdownItem>
              <DropdownItem onSelect={() => setSettingsOpen((value) => !value)}>方向与额度</DropdownItem>
              <DropdownItem onSelect={() => onNavigate({ kind: 'project', id: project.id })}>项目功能看板</DropdownItem>
              {primary !== 'resume' && (
                <DropdownItem
                  disabled={busy || demo || (paused && (switching || legacy || !ready(conversation) || nativeBusy))}
                  onSelect={() => void onMutate(() => api.channelAction(id, paused ? 'resume' : 'pause'))}
                >
                  {paused ? '继续工作' : '暂停'}
                </DropdownItem>
              )}
            </Dropdown>
          </div>
        </header>
        {settingsOpen && (
          <section className="channel-settings-summary" aria-label="方向与额度">
            <h2>方向与额度</h2>
            <p>{channel.goal}</p>
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
            <p>
              复查间隔 {channel.intervalMinutes} 分钟 · 每日上限 {channel.maxRunsPerDay} 轮
            </p>
            <Button variant="ghost" onClick={() => setSettingsOpen(false)}>
              收起
            </Button>
          </section>
        )}
        {!channel.work?.awaitingReply && channel.work && (
          <div className="channel-next-step">
            <span>下一步</span>
            <p>
              {channel.work.state === 'needs_input'
                ? '已回答，等待 Codex 继续'
                : questionExcerpt(channel.work.nextStep, 120)}
            </p>
          </div>
        )}
        <p className="channel-stage-hint" role={nativeProblem ? 'alert' : undefined}>
          {channel.work?.focus && <strong>{channel.work.focus} · </strong>}
          {nativeProblem ||
            (unloaded
              ? '任务未在 Codex App 中打开。请先打开已关联任务，继续和回答暂不可用。'
              : needsLink
                ? '先关联在 Codex App 创建的任务。'
                : primary === 'open'
                  ? '请先在 Codex App 恢复连接。'
                  : channel.work?.awaitingReply
                    ? '请先回答下方问题。'
                    : pendingReleases.length
                      ? '有待批准版本，请先查看变更与风险。'
                      : blocked.length
                        ? '有事项受阻，请查看下一步。'
                        : paused
                          ? '准备好后继续工作。'
                          : '最新进展在下方，更多信息按需展开。')}
        </p>
        {needsLink && (
          <details
            className="channel-link-task"
            open={linkOpen}
            onToggle={(event) => setLinkOpen(event.currentTarget.open)}
          >
            <summary className={!linkOpen && !reviewingRelease ? 'log-primary-action' : undefined}>
              关联 App 任务
            </summary>
            <p>在 Codex App 为同一目录创建任务并发送首条消息，再选择关联。</p>
            <Button
              variant={linkOpen && !threadId && !reviewingRelease ? 'primary' : 'secondary'}
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
              variant={linkOpen && !!threadId && !reviewingRelease ? 'primary' : 'secondary'}
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
                  primaryAction={primary === 'answer' && !reviewingRelease}
                  onShowConversation={openApp}
                />
              )}
              {!!pendingReleases.length && (
                <details open={reviewingRelease} onToggle={(event) => setReleasesOpen(event.currentTarget.open)}>
                  <summary className={primary === 'release' && !reviewingRelease ? 'log-primary-action' : undefined}>
                    待批准发布 · {pendingReleases.map((row) => row.title).join('、')}
                  </summary>
                  {reviewingRelease && (
                    <ProjectReleases
                      {...props}
                      snapshot={{ ...snapshot, releases: pendingReleases }}
                      projectId={project.id}
                    />
                  )}
                </details>
              )}
              {!!appRequests.length && (
                <p className="channel-needs-note">
                  <span>
                    Codex 在 App 里等你处理（审批/追问）
                    {appRequestTitles ? ` · ${appRequestTitles}` : ''}
                  </span>
                  <Button variant="ghost" disabled={busy || demo || legacy} onClick={openApp}>
                    在 Codex App 中打开
                  </Button>
                </p>
              )}
              {usageGate && (
                <p className="channel-needs-note">
                  <span>{usageGate.message}</span>
                </p>
              )}
              {!!blocked.length && (
                <ul>
                  {blocked.map((item, index) => (
                    <li key={item.id}>
                      <Button
                        variant={primary === 'blocked' && index === 0 && !reviewingRelease ? 'primary' : 'ghost'}
                        onClick={() => onNavigate({ kind: 'finding', id: item.id })}
                      >
                        被阻塞 · {item.title}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          <div className="channel-log-heading">
            <h2>工作日志</h2>
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
          ).map((run, index) => (
            <LogEntry
              key={`${id}:${run.id}`}
              run={run}
              api={api}
              currentWork={channel.work?.runId === run.id ? channel.work : undefined}
              onNavigate={onNavigate}
              primaryAction={primary === 'latest' && index === 0 && !reviewingRelease}
              questionAbove={!!channel.work?.awaitingReply && channel.work.runId === run.id}
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
    </div>
  );
}

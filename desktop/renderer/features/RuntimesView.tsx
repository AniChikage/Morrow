import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowUpRight, ChevronRight, Hash, Info, Monitor, RefreshCw, Server, Terminal } from 'lucide-react';
import type { Channel, ConnectionInfo, DesktopAPI, NativeConnectionStatus, Project, Runtime } from '../../shared/types';
import type { FeatureProps } from './types';
import { Button, EmptyState } from '../components/ui';
import { replaceIfChanged } from '../components/collections';
import { connectionDetail } from '../components/connection-detail';
import { formatResetTime, usageWindowLabel } from '../components/format';
import './content.css';
import './runtimes.css';

const runtimeMarks: Record<string, string> = { codex: 'CX' };
function RuntimeMark({ runtime }: { runtime: Runtime }) {
  return (
    <span className={`runtime-settings-mark ${runtimeMarks[runtime.id] ? runtime.id : 'other'}`} aria-hidden="true">
      {runtimeMarks[runtime.id] || runtime.name.slice(0, 2).toUpperCase()}
    </span>
  );
}
function detection(runtime: Runtime) {
  if (runtime.available) return { label: '已检测到', className: 'detected' };
  return runtime.path ? { label: '需检查', className: 'attention' } : { label: '未检测到', className: '' };
}
/** The four facts needed to continue work in an associated App task. */
function connectionSteps(native: NativeConnectionStatus) {
  return [
    {
      label: native.appInstalled === undefined && !native.connected ? 'Codex App 安装状态未知' : 'Codex App 已安装',
      done: !!native.appInstalled || native.connected,
      version: native.appVersion,
    },
    { label: 'App 已连接', done: native.connected },
    { label: '任务已关联', done: (native.boundThreadCount ?? 0) > 0 },
    {
      label:
        native.connected && (native.boundThreadCount ?? 0) > 0 && native.readyThreadCount === 0
          ? '任务未在 Codex App 中打开'
          : '关联任务可用',
      done: (native.readyThreadCount ?? 0) > 0 && !native.restartRequired,
    },
  ];
}
/** The channel a page-level task action applies to: one candidate acts directly, several are chosen. */
function ChannelChoice({
  label,
  targets,
  projects,
  busy,
  onAct,
}: {
  label: string;
  targets: Channel[];
  projects: Project[];
  busy: boolean;
  onAct: (channelId: string) => void;
}) {
  const [choice, setChoice] = useState('');
  if (!targets.length) return null;
  const selected = targets.some((target) => target.id === choice) ? choice : targets[0].id;
  return (
    <>
      {targets.length > 1 && (
        <select aria-label="选择频道" value={selected} onChange={(event) => setChoice(event.target.value)}>
          {targets.map((target) => {
            const project = projects.find((value) => value.id === target.projectId);
            return (
              <option key={target.id} value={target.id}>
                {project ? `${project.name} / ` : ''}
                {target.name}
              </option>
            );
          })}
        </select>
      )}
      <Button variant="primary" disabled={busy} onClick={() => onAct(selected)}>
        {label}
      </Button>
    </>
  );
}
function AppChecklist({
  native,
  remote,
  api,
  busy,
  projects,
  linkTargets,
  openTargets,
  onMutate,
  onRefresh,
  onLink,
  onOpen,
}: {
  native: NativeConnectionStatus;
  remote: boolean;
  api: DesktopAPI;
  busy: boolean;
  projects: Project[];
  linkTargets: Channel[];
  openTargets: Channel[];
  onMutate: FeatureProps['onMutate'];
  onRefresh: () => Promise<void>;
  onLink: (channelId: string) => void;
  onOpen: (channelId: string) => void;
}) {
  const [receipt, setReceipt] = useState('');
  const detail = connectionDetail(native.detail);
  const rawDetail = native.rawDetail || (native.detail !== detail ? native.detail : '');
  const steps = connectionSteps(native);
  const pending = steps.findIndex((step) => !step.done);
  // Every step that waits on something happening outside Morrow says that coming back is enough.
  let next: ReactNode;
  if (native.restartRequired) next = <span>旧转接设置已撤销；当前任务结束后重开 Codex App，再重新检测。</span>;
  // `native.detail` is a finished sentence of its own, so it gets its own span instead of being
  // glued to the next one with a 「；」 the reader would see as 「。；」.
  else if (pending === 0)
    next = (
      <>
        <span>
          {native.appInstalled === false
            ? '安装并登录 Codex App。'
            : native.detail
              ? detail
              : '无法确认安装状态，请在 Morrow 桌面应用中重新检测。'}
        </span>
        <span>装好后回到这里，会自动重新检测。</span>
      </>
    );
  else if (pending === 1) next = <span>打开 Codex App；打开后回到这里，会自动重新检测。</span>;
  else if (pending === 2)
    next = (
      <>
        <span>在 Codex App 为同一项目目录创建任务、发送首条消息，再回到频道关联；回到这里会自动重新检测。</span>
        <ChannelChoice label="去关联任务" targets={linkTargets} projects={projects} busy={busy} onAct={onLink} />
        {!linkTargets.length && <span>还没有可关联的 Codex 频道，请先在项目里添加频道。</span>}
      </>
    );
  else if (pending === 3)
    next = (
      <>
        <span>任务未在 Codex App 中打开。请在 Codex App 打开已关联任务；打开后回到这里，会自动重新检测。</span>
        {!remote && (
          <ChannelChoice
            label="在 Codex App 中打开"
            targets={openTargets}
            projects={projects}
            busy={busy}
            onAct={onOpen}
          />
        )}
      </>
    );
  else next = <span>已就绪；保持 Codex App 运行，自动工作沿用任务权限。</span>;
  return (
    <div className="runtime-settings-checklist">
      <p className="runtime-settings-next">
        <b>下一步</b>
        {next}
      </p>
      {remote && <p className="runtime-settings-receipt">请在执行主机的 Codex App 中创建并打开任务。</p>}
      <details className="runtime-settings-diagnostics">
        <summary>连接清单与账户用量</summary>
        <ol aria-label="Codex App 连接清单">
          {steps.map((step, index) => (
            <li
              key={step.label}
              className={`runtime-settings-detection ${step.done ? 'detected' : index === pending ? 'attention' : ''}`}
            >
              <span className="runtime-settings-dot" />
              <span>{step.label}</span>
              {step.version && <code title={step.version}>{step.version}</code>}
            </li>
          ))}
        </ol>
        {rawDetail && (
          <div className="runtime-settings-receipt">
            <b>原始连接诊断</b>
            <pre className="runtime-settings-raw-detail">{rawDetail}</pre>
          </div>
        )}
        {native.backgroundConfigured && !remote && api.restoreNativeBackground && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void onMutate(async () => {
                const result = await api.restoreNativeBackground!();
                setReceipt(result.detail);
                await onRefresh();
              })
            }
          >
            清理旧转接设置
          </Button>
        )}
        {receipt && (
          <p className="runtime-settings-receipt" role="status">
            {receipt}
          </p>
        )}
        <p className="runtime-settings-account-usage" aria-label="账户用量">
          <b>账户用量</b>
          {native.usage?.reading && !native.usage.stale ? (
            <span>
              {native.usage.reading.windows.map((entry, index) => (
                <span key={entry.name}>
                  {index > 0 ? '；' : ''}
                  {usageWindowLabel(entry.name)} 已用 <span className="mono">{entry.usedPercent}%</span>，
                  {entry.resetsAt ? (
                    <>
                      重置 <span className="mono">{formatResetTime(entry.resetsAt)}</span>
                    </>
                  ) : (
                    '重置时间未知'
                  )}
                </span>
              ))}
            </span>
          ) : (
            <>
              <span className="usage-unknown">额度未知</span>
              {/* Never read ≠ read and refused. A service too old to report `attempted` keeps the old reason. */}
              <span title={native.usage?.lastError}>
                {native.usage?.lastError
                  ? `读取失败：${native.usage.lastError}`
                  : !native.connected
                    ? '后台未连接'
                    : native.usage?.reading
                      ? '读数已过期'
                      : native.usage?.attempted === false
                        ? '尚未读取账户用量'
                        : '协议未返回账户用量'}
              </span>
            </>
          )}
          {native.usage?.reading && !native.usage.stale && native.usage.lastError && (
            <span className="usage-unknown" title={native.usage.lastError}>
              刷新失败，显示最近读数
            </span>
          )}
        </p>
      </details>
    </div>
  );
}

export function RuntimesView({
  snapshot,
  api,
  busy,
  onMutate,
  onNavigate,
  connection,
  projectId,
}: FeatureProps & { connection?: ConnectionInfo | null; projectId?: string }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [native, setNative] = useState<NativeConnectionStatus>();
  const [nativeUnreachable, setNativeUnreachable] = useState(false);
  const nativeRequest = useRef(0);
  const refreshNative = useCallback(
    async (refreshUsage = true) => {
      if (typeof api.getNativeStatus !== 'function') return;
      const request = ++nativeRequest.current;
      try {
        const next = await api.getNativeStatus(refreshUsage);
        if (request !== nativeRequest.current) return;
        // The eight-second read repeats the same status most of the time; keep the page still.
        setNative((previous) => replaceIfChanged(previous, next));
        setNativeUnreachable(false);
      } catch {
        if (request !== nativeRequest.current) return;
        setNative((previous) =>
          replaceIfChanged(previous, {
            available: false,
            connected: false,
            detail: '暂时无法连接 Codex App。',
            capabilities: { list: false, read: false, send: false, create: false, interrupt: false, respond: false },
          })
        );
        setNativeUnreachable(true);
      }
    },
    [api]
  );
  useEffect(() => {
    setNative(undefined);
    setNativeUnreachable(false);
    void refreshNative();
    // Installing or opening the App happens outside Morrow; this page has to notice on its own.
    // The periodic read skips the account usage refresh, which stays on entry and manual detection.
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void refreshNative(false);
    }, 8000);
    return () => {
      window.clearInterval(timer);
      nativeRequest.current++;
    };
  }, [
    refreshNative,
    connection?.config.mode,
    connection?.config.host,
    connection?.config.port,
    connection?.config.directory,
  ]);
  const availableCount = snapshot.runtimes.filter((runtime) => runtime.available).length;
  const runningCount = snapshot.channels.filter((channel) => channel.status === 'running').length;
  const remote = connection?.config.mode === 'ssh';
  const appPending = native ? connectionSteps(native).findIndex((step) => !step.done) : -1;
  // A task action belongs to a project. Prefer the most recently opened one; otherwise let the
  // user pick, rather than silently acting on whichever Codex channel happens to come first.
  const codexChannels = snapshot.channels.filter((channel) => channel.runtime === 'codex');
  const scoped = projectId ? codexChannels.filter((channel) => channel.projectId === projectId) : [];
  const linkTargets = scoped.length ? scoped : codexChannels;
  const openTargets = linkTargets.filter((channel) => channel.sessionId);
  const taskAction =
    !!native &&
    !nativeUnreachable &&
    !native.restartRequired &&
    snapshot.runtimes.some((r) => r.id === 'codex') &&
    ((appPending === 2 && linkTargets.length > 0) || (appPending === 3 && !remote && openTargets.length > 0));
  const HostIcon = remote ? Server : Monitor;
  return (
    <main className="feature-main runtime-settings">
      <div className="feature-toolbar">
        <span className="feature-toolbar-title">
          <Terminal size={15} />
          运行时 <span>{snapshot.runtimes.length}</span>
        </span>
        <div className="feature-toolbar-spacer" />
        <Button
          variant={taskAction ? 'secondary' : 'primary'}
          disabled={busy}
          onClick={() =>
            void onMutate(async () => {
              await api.refreshRuntimes();
              await refreshNative();
            })
          }
        >
          <RefreshCw size={13} className={busy ? 'spin' : undefined} />
          {busy ? '正在检测…' : '重新检测'}
        </Button>
      </div>
      <div className="feature-scroll">
        <div className="runtime-settings-body">
          <header className="runtime-settings-heading">
            <span className="runtime-settings-host-icon">
              <HostIcon size={18} />
            </span>
            <div className="runtime-settings-host-title">
              <h1>{connection?.name || '当前执行主机'}</h1>
              <p>
                {snapshot.runtimes.length} 个运行时 · {availableCount} 个已检测到
              </p>
            </div>
            <div className="runtime-settings-host-state">
              {connection && (
                <span className={`runtime-settings-detection ${connection.connected ? 'detected' : ''}`}>
                  <span className="runtime-settings-dot" />
                  {connection.connected ? '已连接' : '未连接'}
                </span>
              )}
              <span>{runningCount > 0 ? `${runningCount} 个频道运行中` : '当前无运行'}</span>
            </div>
          </header>
          {snapshot.runtimes.length ? (
            <section className="runtime-settings-table" aria-label="运行时列表">
              <div className="runtime-settings-columns" aria-hidden="true">
                <span>运行时</span>
                <span>连接 / 安装</span>
                <span className="runtime-settings-auth">账号</span>
                <span>使用频道</span>
                <span>版本</span>
                <span />
              </div>
              {snapshot.runtimes.map((runtime) => {
                const channels = snapshot.channels.filter((channel) => channel.runtime === runtime.id);
                const running = channels.filter((channel) => channel.status === 'running').length;
                const appRuntime = runtime.id === 'codex' && native;
                const status = appRuntime
                  ? {
                      label: native.connected ? 'App 已连接' : 'App 未连接',
                      className: native.connected ? 'detected' : 'attention',
                    }
                  : detection(runtime);
                const isExpanded = expanded === runtime.id;
                const detailId = `runtime-details-${runtime.id}`;
                return (
                  <div className="runtime-settings-group" key={runtime.id}>
                    <button
                      className="runtime-settings-row"
                      aria-label={`${runtime.name}，${status.label}，查看详情`}
                      aria-expanded={isExpanded}
                      aria-controls={detailId}
                      onClick={() => setExpanded((previous) => (previous === runtime.id ? null : runtime.id))}
                    >
                      <span className="runtime-settings-name">
                        <RuntimeMark runtime={runtime} />
                        <span>{appRuntime ? 'Codex App' : runtime.name}</span>
                      </span>
                      <span className={`runtime-settings-detection ${status.className}`}>
                        <span className="runtime-settings-dot" />
                        {status.label}
                      </span>
                      <span className="runtime-settings-auth">
                        {appRuntime ? '由 App 管理' : runtime.available ? '待验证' : '—'}
                      </span>
                      <span className="runtime-settings-usage">
                        {running > 0 ? (
                          <>
                            <span className="runtime-settings-dot" />
                            {running} 运行中
                          </>
                        ) : channels.length ? (
                          `${channels.length} 个频道`
                        ) : (
                          '未使用'
                        )}
                      </span>
                      <code
                        className="runtime-settings-version"
                        title={(appRuntime ? native.appVersion : runtime.version) || undefined}
                      >
                        {(appRuntime ? native.appVersion : runtime.version) || '—'}
                      </code>
                      <ChevronRight size={13} className="runtime-settings-chevron" />
                    </button>
                    {appRuntime && !nativeUnreachable && (
                      <AppChecklist
                        native={native}
                        remote={remote}
                        api={api}
                        busy={busy}
                        projects={snapshot.projects}
                        linkTargets={linkTargets}
                        openTargets={openTargets}
                        onMutate={onMutate}
                        onRefresh={refreshNative}
                        onOpen={(channelId) => void onMutate(() => api.openNativeApp(channelId))}
                        onLink={(channelId) => onNavigate({ kind: 'channel', id: channelId })}
                      />
                    )}
                    {isExpanded && (
                      <div
                        className="runtime-settings-details"
                        id={detailId}
                        role="region"
                        aria-label={`${runtime.name} 详情`}
                      >
                        <dl>
                          {appRuntime && (
                            <>
                              <dt>App 连接</dt>
                              <dd>{connectionDetail(native.detail)}</dd>
                              {native.runtimeVersion && (
                                <>
                                  <dt>后台版本</dt>
                                  <dd>
                                    <code>{native.runtimeVersion}</code>
                                  </dd>
                                </>
                              )}
                              <dt>对话执行</dt>
                              <dd>
                                绑定 Codex App 的同一条会话，直接同步消息、回复和运行活动。账号、模型、工具和权限由 App
                                管理。
                              </dd>
                            </>
                          )}
                          <dt>CLI 路径</dt>
                          <dd>{runtime.path ? <code>{runtime.path}</code> : '执行主机的命令路径中尚未找到此 CLI。'}</dd>
                          {appRuntime && runtime.version && (
                            <>
                              <dt>CLI 版本</dt>
                              <dd>
                                <code>{runtime.version}</code>
                              </dd>
                            </>
                          )}
                          <dt>检测结果</dt>
                          <dd>{runtime.detail || '尚无详细检测结果。'}</dd>
                          {!appRuntime && (
                            <>
                              <dt>账号登录</dt>
                              <dd>
                                {runtime.available
                                  ? '沿用 CLI 已有账号。检测不会调用模型，登录状态与配额在实际执行时验证。'
                                  : '检测到可用 CLI 后，在执行主机终端完成登录。'}
                              </dd>
                              <dt>执行权限</dt>
                              <dd>
                                {runtime.available
                                  ? runtime.canWrite
                                    ? '自动轮次默认沿用 App 任务设置；每个频道可单独收紧为只读或工作区编辑。'
                                    : '只读执行'
                                  : 'CLI 可用后读取支持的权限。'}
                              </dd>
                            </>
                          )}
                          {channels.length > 0 && (
                            <>
                              <dt>使用频道</dt>
                              <dd className="runtime-settings-channel-links">
                                {channels.map((channel) => {
                                  const project = snapshot.projects.find((project) => project.id === channel.projectId);
                                  return (
                                    <button
                                      key={channel.id}
                                      className="runtime-settings-channel-link"
                                      onClick={() => onNavigate({ kind: 'channel', id: channel.id })}
                                      title={project?.name}
                                    >
                                      <Hash size={12} />
                                      <span>
                                        {project ? `${project.name} / ` : ''}
                                        {channel.name}
                                      </span>
                                      <ArrowUpRight size={11} />
                                    </button>
                                  );
                                })}
                              </dd>
                            </>
                          )}
                        </dl>
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          ) : (
            <div className="runtime-settings-empty">
              <EmptyState
                icon={<Terminal />}
                title="还没有检测结果"
                description="连接执行服务后，重新检测主机上可用的运行时。"
              />
            </div>
          )}
          <details className="runtime-settings-diagnostics">
            <summary>运行与复核说明</summary>
            <p className="runtime-settings-note">
              <Info size={13} />
              <span>
                自动工作使用 Codex App 任务；独立复核使用官方只读
                CLI。连接检测不会调用模型，账号与配额以实际读数为准。旧的 Claude Code / Trae 频道保持可读，但不再执行。
              </span>
            </p>
          </details>
        </div>
      </div>
    </main>
  );
}

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowUpRight, ChevronRight, Hash, Info, Monitor, RefreshCw, Server, Terminal } from 'lucide-react';
import type { ConnectionInfo, DesktopAPI, NativeConnectionStatus, Runtime } from '../../shared/types';
import type { FeatureProps } from './types';
import { Button, EmptyState } from '../components/ui';
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
/** The four facts that must hold, in order, before Morrow can create and resume App tasks by itself. */
function connectionSteps(native: NativeConnectionStatus) {
  return [
    { label: 'Codex App 已安装', done: !!native.appInstalled || native.connected, version: native.appVersion },
    { label: 'App 已连接', done: native.connected },
    { label: '任务已关联', done: (native.boundThreadCount ?? 0) > 0 },
    { label: '关联任务可用', done: (native.readyThreadCount ?? 0) > 0 && !native.restartRequired },
  ];
}
function AppChecklist({
  native,
  remote,
  api,
  busy,
  onMutate,
  onRefresh,
  onLink,
}: {
  native: NativeConnectionStatus;
  remote: boolean;
  api: DesktopAPI;
  busy: boolean;
  onMutate: FeatureProps['onMutate'];
  onRefresh: () => Promise<void>;
  onLink?: () => void;
}) {
  const [receipt, setReceipt] = useState('');
  const steps = connectionSteps(native);
  const pending = steps.findIndex((step) => !step.done);
  let next: ReactNode;
  if (native.restartRequired) next = <span>旧转接设置已撤销；当前任务结束后重开 Codex App，再重新检测。</span>;
  else if (pending === 0) next = <span>安装并登录 Codex App</span>;
  else if (pending === 1) next = <span>打开 Codex App</span>;
  else if (pending === 2)
    next = (
      <>
        <span>在 Codex App 为同一项目目录创建任务、发送首条消息，再回到频道关联。</span>
        {onLink && (
          <Button disabled={busy} onClick={onLink}>
            去关联任务
          </Button>
        )}
      </>
    );
  else if (pending === 3) next = <span>在 Codex App 打开已关联任务，然后重新检测。</span>;
  else next = <span>已就绪；保持 Codex App 运行，自动工作沿用任务权限。</span>;
  return (
    <div className="runtime-settings-checklist">
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
      <p className="runtime-settings-next">
        <b>下一步</b>
        {next}
      </p>
      {remote && <p className="runtime-settings-receipt">请在执行主机的 Codex App 中创建并打开任务。</p>}
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
            {native.usage.reading.windows
              .map(
                (entry) =>
                  `${usageWindowLabel(entry.name)} 已用 ${entry.usedPercent}%，${entry.resetsAt ? `重置 ${formatResetTime(entry.resetsAt)}` : '重置时间未知'}`
              )
              .join('；')}
          </span>
        ) : (
          <>
            <span className="usage-unknown">额度未知</span>
            {/* Never read ≠ read and refused. A service too old to report `attempted` keeps the old reason. */}
            <span title={native.usage?.lastError}>
              {!native.connected
                ? '后台未连接'
                : native.usage?.reading
                  ? '读数已过期'
                  : native.usage?.attempted === false
                    ? '尚未读取账户用量'
                    : '协议未返回账户用量'}
            </span>
          </>
        )}
      </p>
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
}: FeatureProps & { connection?: ConnectionInfo | null }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [native, setNative] = useState<NativeConnectionStatus>();
  const [nativeUnreachable, setNativeUnreachable] = useState(false);
  const refreshNative = useCallback(async () => {
    if (typeof api.getNativeStatus !== 'function') return;
    try {
      setNative(await api.getNativeStatus());
      setNativeUnreachable(false);
    } catch {
      setNative({
        available: false,
        connected: false,
        detail: '暂时无法连接 Codex App。',
        capabilities: { list: false, read: false, send: false, create: false, interrupt: false, respond: false },
      });
      setNativeUnreachable(true);
    }
  }, [api]);
  useEffect(() => {
    void refreshNative();
  }, [refreshNative, connection?.config.mode, connection?.config.host]);
  const availableCount = snapshot.runtimes.filter((runtime) => runtime.available).length;
  const runningCount = snapshot.channels.filter((channel) => channel.status === 'running').length;
  const remote = connection?.config.mode === 'ssh';
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
                        onMutate={onMutate}
                        onRefresh={refreshNative}
                        onLink={
                          snapshot.channels.find((channel) => channel.runtime === 'codex')
                            ? () =>
                                onNavigate({
                                  kind: 'channel',
                                  id: snapshot.channels.find((channel) => channel.runtime === 'codex')!.id,
                                })
                            : undefined
                        }
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
                              <dd>{native.detail}</dd>
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
          <p className="runtime-settings-note">
            <Info size={13} />
            <span>
              自动工作使用 Codex App 任务；独立复核使用官方只读
              CLI。连接检测不会调用模型，账号与配额以实际读数为准。旧的 Claude Code / Trae 频道保持可读，但不再执行。
            </span>
          </p>
        </div>
      </div>
    </main>
  );
}

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import {
  PanelLeft,
  ChevronLeft,
  ChevronRight,
  Plus,
  X,
  Search,
  Folder,
  Hash,
  Clock3,
  Cpu,
  Settings2,
  ChevronDown,
  ArrowUpRight,
  RefreshCw,
  CircleHelp,
  CircleDashed,
  Command,
  FolderPlus,
  AlertCircle,
} from 'lucide-react';
import {
  Button,
  Dropdown,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
  EmptyState,
  IconButton,
} from './components/ui';
import { Dialogs, type ModalState } from './components/Dialogs';
import { ProjectNavigation } from './components/ProjectNavigation';
import { formatClock } from './components/format';
import { isDesktop, useWorkspace } from './state/workspace';
import { useNavigation } from './state/navigation';
import { ProjectView } from './features/ProjectView';
import { FindingView } from './features/FindingView';
import { ChannelView } from './features/ChannelView';
import { RunsView } from './features/RunsView';
import { RuntimesView } from './features/RuntimesView';
import { UpgradeBanner } from './features/UpgradeBanner';
import { upgradeSwitching } from './features/upgradeState';
import morrowMark from '../../assets/brand/morrow-mark.png';
import { readPreference, writePreference } from './state/preferences';
import type { Route } from '../shared/types';
import type { FeatureProps } from './features/types';

const savedPreference = (key: string) => readPreference(`morrow:${key}`, `nh:${key}`);
const savePreference = (key: string, value: string) => writePreference(`morrow:${key}`, value);

export default function App() {
  const {
    api,
    snapshot,
    loading,
    connection,
    busy,
    error,
    stale,
    lastSyncedAt,
    clearError,
    dismissError,
    refresh,
    reconnect,
    mutate,
  } = useWorkspace();
  const scope = connection?.config.mode === 'ssh' ? `ssh:${connection.config.host}:${connection.config.port}` : 'local';
  const navigation = useNavigation(connection ? scope : null);
  const { route, navigate } = navigation;
  const [sidebar, setSidebar] = useState(() => savedPreference('sidebar') !== 'closed');
  const [modal, setModal] = useState<ModalState>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => Number(savedPreference('sidebar-width')) || 236);
  const [sidebarSection, setSidebarSection] = useState<Record<string, boolean>>({});
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef<Record<string, { top: number; left: number }>>({});
  const scrollKey = navigation.activeId + ':' + (route ? route.kind + ('id' in route ? route.id : '') : '');
  useLayoutEffect(() => {
    const position = scrollPositions.current[scrollKey];
    const node = viewportRef.current?.querySelector<HTMLElement>('.feature-scroll');
    if (node && position) {
      node.scrollTop = position.top;
      node.scrollLeft = position.left;
    }
  }, [scrollKey, loading]);
  useEffect(() => {
    if (connection && !loading && navigation.hydrated && navigation.needsDefault && snapshot.projects.length) {
      const project = snapshot.projects.find((p) => !p.isDemo) || snapshot.projects[0];
      navigation.openDefault({ kind: 'project', id: project.id });
    }
  }, [connection, loading, navigation.hydrated, navigation.needsDefault, snapshot.projects, navigation.openDefault]);
  const finding = route?.kind === 'finding' ? snapshot.items.find((i) => i.id === route.id) : undefined;
  const channel =
    route?.kind === 'channel'
      ? snapshot.channels.find((c) => c.id === route.id)
      : finding
        ? snapshot.channels.find((c) => c.id === finding.channelId)
        : undefined;
  const project =
    route?.kind === 'project'
      ? snapshot.projects.find((p) => p.id === route.id)
      : snapshot.projects.find((p) => p.id === (finding?.projectId || channel?.projectId));
  // The runtimes page acts on a project's channel; the most recently opened project is the only
  // honest default, so it is derived here rather than guessed from the first Codex channel there.
  function projectOf(target: Route): string | undefined {
    if (target.kind === 'project') return target.id;
    if (target.kind === 'channel') return snapshot.channels.find((c) => c.id === target.id)?.projectId;
    if (target.kind === 'finding') {
      const item = snapshot.items.find((i) => i.id === target.id);
      return item?.projectId || snapshot.channels.find((c) => c.id === item?.channelId)?.projectId;
    }
    return undefined;
  }
  const activeTab = navigation.tabs.find((tab) => tab.id === navigation.activeId);
  const recentRoutes = [
    ...navigation.tabs.filter((tab) => tab.id !== navigation.activeId).map((tab) => tab.history[tab.index]),
    ...(activeTab ? activeTab.history.slice(0, activeTab.index + 1) : []),
  ];
  const recentProjectId =
    project?.id ||
    recentRoutes.reduceRight<string | undefined>((found, target) => found || projectOf(target), undefined);
  const toggleSidebar = useCallback(
    () =>
      setSidebar((v) => {
        savePreference('sidebar', v ? 'closed' : 'open');
        return !v;
      }),
    []
  );
  function titleOf(r: Route) {
    if (r.kind === 'project') return snapshot.projects.find((p) => p.id === r.id)?.name || '项目';
    if (r.kind === 'channel') return snapshot.channels.find((c) => c.id === r.id)?.name || '频道';
    if (r.kind === 'finding') return snapshot.items.find((i) => i.id === r.id)?.title || '事项';
    return r.kind === 'runs' ? '运行记录' : '运行时';
  }
  const command = useCallback(
    (value: string) => {
      if (value === 'new-project') setModal({ kind: 'project' });
      else if (value === 'search') setModal({ kind: 'search' });
      else if (value === 'settings') setModal({ kind: 'settings' });
      else if (value === 'close-tab') navigation.close(navigation.activeId);
      else if (value === 'back') navigation.travel(-1);
      else if (value === 'forward') navigation.travel(1);
      else if (value === 'toggle-sidebar') toggleSidebar();
    },
    [navigation.close, navigation.activeId, navigation.travel, toggleSidebar]
  );
  useEffect(() => api.onCommand(command), [api, command]);
  useEffect(() => {
    if (isDesktop) return;
    function key(e: KeyboardEvent) {
      if (e.isComposing || !(e.metaKey || e.ctrlKey)) return;
      let cmd = '';
      if (e.key.toLowerCase() === 'k') cmd = 'search';
      if (e.key.toLowerCase() === 'n') cmd = 'new-project';
      if (e.key === ',') cmd = 'settings';
      if (e.key.toLowerCase() === 'b') cmd = 'toggle-sidebar';
      if (e.key === '[') cmd = 'back';
      if (e.key === ']') cmd = 'forward';
      if (e.key.toLowerCase() === 'w') cmd = 'close-tab';
      if (cmd) {
        e.preventDefault();
        command(cmd);
      }
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [command]);
  const props: FeatureProps = {
    snapshot,
    api,
    busy,
    onNavigate: navigate,
    onMutate: mutate,
    onEditChannel: (c) => setModal({ kind: 'channel', projectId: c.projectId, channel: c }),
    onNewChannel: (projectId) => setModal({ kind: 'channel', projectId }),
    onNewFeature: (projectId) => setModal({ kind: 'feature', projectId }),
    onEditFeature: (item) =>
      setModal({
        kind: 'feature',
        projectId: item.projectId || snapshot.channels.find((c) => c.id === item.channelId)?.projectId || '',
        item,
      }),
  };
  function feature() {
    if (loading && snapshot.projects.length === 0) return <LoadingWorkspace starting={!connection?.connected} />;
    if (!connection?.connected && snapshot.projects.length === 0)
      return (
        <EmptyState
          icon={<AlertCircle />}
          title="连接执行服务"
          description={error || '检查执行位置，连接后即可查看你的项目。'}
          action={
            <>
              {connection && (
                <Button variant="primary" disabled={busy} onClick={() => void reconnect()}>
                  重新连接
                </Button>
              )}
              <Button onClick={() => setModal({ kind: 'settings' })}>打开设置</Button>
            </>
          }
        />
      );
    if (!route)
      return (
        <EmptyState
          icon={<FolderPlus />}
          title={snapshot.projects.length ? '选择一个项目' : '还没有项目'}
          description={
            snapshot.projects.length
              ? '从左侧或顶部选择已有项目，也可接入另一个项目目录。'
              : '接入已有项目目录，写下项目说明，再关联 Codex App 任务。'
          }
          action={
            <>
              <Button variant="primary" onClick={() => setModal({ kind: 'project' })}>
                <Plus />
                接入项目
              </Button>
              {!snapshot.projects.some((p) => p.isDemo) && (
                <Button onClick={() => void mutate(() => api.loadDemo())}>浏览示例</Button>
              )}
            </>
          }
        />
      );
    switch (route.kind) {
      case 'project':
        return <ProjectView key={'project:' + route.id} {...props} id={route.id} />;
      case 'finding':
        return <FindingView key={'finding:' + route.id} {...props} id={route.id} />;
      case 'channel':
        return <ChannelView key={'channel:' + route.id} {...props} id={route.id} />;
      case 'runs':
        return <RunsView {...props} />;
      case 'runtimes':
        return <RuntimesView {...props} connection={connection} projectId={recentProjectId} />;
    }
  }
  const running = snapshot.channels.filter((c) => c.status === 'running').length;
  return (
    <div
      className={`desktop-shell ${sidebar ? '' : 'sidebar-hidden'}`}
      style={{ '--sidebar-width': sidebarWidth + 'px' } as CSSProperties}
    >
      <div className="titlebar">
        <div className="titlebar-tools">
          <IconButton label={sidebar ? '收起侧边栏' : '显示侧边栏'} onClick={toggleSidebar}>
            <PanelLeft />
          </IconButton>
          <IconButton label="后退" disabled={!navigation.canBack} onClick={() => navigation.travel(-1)}>
            <ChevronLeft />
          </IconButton>
          <IconButton label="前进" disabled={!navigation.canForward} onClick={() => navigation.travel(1)}>
            <ChevronRight />
          </IconButton>
        </div>
        <div className="tab-strip" role="tablist" aria-label="打开的页面">
          {navigation.tabs.map((tab) => {
            const r = tab.history[tab.index];
            return (
              <div className={`resource-tab ${tab.id === navigation.activeId ? 'active' : ''}`} key={tab.id}>
                <button
                  role="tab"
                  aria-selected={tab.id === navigation.activeId}
                  onClick={() => navigation.activate(tab.id)}
                  title={titleOf(r)}
                >
                  {r.kind === 'project' ? (
                    <Folder />
                  ) : r.kind === 'channel' ? (
                    <Hash />
                  ) : r.kind === 'finding' ? (
                    <CircleDashed />
                  ) : r.kind === 'runs' ? (
                    <Clock3 />
                  ) : (
                    <Cpu />
                  )}
                  <span>{titleOf(r)}</span>
                </button>
                <button
                  className="tab-close"
                  aria-label={'关闭 ' + titleOf(r)}
                  onClick={() => navigation.close(tab.id)}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
        <Dropdown
          trigger={
            <button className="icon-button add-tab" aria-label="选择项目">
              <Plus size={15} />
            </button>
          }
        >
          <DropdownLabel>项目</DropdownLabel>
          {snapshot.projects.map((p) => (
            <DropdownItem key={p.id} onSelect={() => navigate({ kind: 'project', id: p.id }, true)}>
              <Folder />
              {p.name}
            </DropdownItem>
          ))}
          <DropdownSeparator />
          <DropdownItem onSelect={() => setModal({ kind: 'project' })}>
            <Plus />
            接入项目
          </DropdownItem>
        </Dropdown>
        <div className="titlebar-space" />
      </div>
      <UpgradeBanner snapshot={snapshot} api={api} busy={busy} onMutate={mutate} onRefresh={() => void refresh()} />
      <div className="workspace-body">
        {sidebar && (
          <aside className="sidebar" aria-label="工作区导航">
            <div className="workspace-switch">
              <img className="brand-mark" src={morrowMark} width={24} height={24} alt="" aria-hidden="true" />
              <span>Morrow</span>
              <Dropdown
                trigger={
                  <button className="icon-button" aria-label="工作空间菜单">
                    <ChevronDown size={14} />
                  </button>
                }
              >
                <DropdownItem onSelect={() => setModal({ kind: 'project' })}>
                  <Plus />
                  接入项目
                </DropdownItem>
                <DropdownItem onSelect={() => setModal({ kind: 'settings' })}>
                  <Settings2 />
                  工作空间设置
                </DropdownItem>
              </Dropdown>
            </div>
            <button className="sidebar-search" onClick={() => setModal({ kind: 'search' })}>
              <Search />
              <span>搜索…</span>
              <kbd>⌘ K</kbd>
            </button>
            <div className="sidebar-scroll">
              <div className="nav-heading with-action">
                <button
                  onClick={() => setSidebarSection((v) => ({ ...v, projects: !v.projects }))}
                  aria-expanded={!sidebarSection.projects}
                >
                  项目
                  <ChevronDown className={sidebarSection.projects ? 'collapsed' : ''} />
                </button>
                <IconButton label="接入项目" onClick={() => setModal({ kind: 'project' })}>
                  <Plus />
                </IconButton>
              </div>
              {!sidebarSection.projects && (
                <ProjectNavigation
                  key={scope}
                  projects={snapshot.projects}
                  channels={snapshot.channels}
                  route={route}
                  activeProjectId={project?.id}
                  scope={scope}
                  onNavigate={navigate}
                  onNewChannel={(projectId) => setModal({ kind: 'channel', projectId })}
                />
              )}
              {!snapshot.projects.length && !loading && (
                <button className="nav-item muted" onClick={() => setModal({ kind: 'project' })}>
                  <Plus />
                  <span>接入项目</span>
                </button>
              )}
              <div className="nav-heading">记录与设置</div>
              <button
                className={`nav-item ${route?.kind === 'runs' ? 'selected' : ''}`}
                onClick={() => navigate({ kind: 'runs' }, true)}
              >
                <Clock3 />
                <span>运行记录</span>
                {running > 0 && <span className="count-badge">{running}</span>}
              </button>
              <button
                className={`nav-item ${route?.kind === 'runtimes' ? 'selected' : ''}`}
                onClick={() => navigate({ kind: 'runtimes' }, true)}
              >
                <Cpu />
                <span>运行时</span>
              </button>
              <button className="nav-item" onClick={() => setModal({ kind: 'settings' })}>
                <Settings2 />
                <span>设置</span>
              </button>
            </div>
            <div className="sidebar-footer">
              <button className="connection-status" onClick={() => setModal({ kind: 'settings' })}>
                <span className={`connection-dot ${connection?.connected ? 'connected' : ''}`} />
                <span>{connection?.name || '正在连接…'}</span>
              </button>
              <IconButton label="刷新工作空间" onClick={() => void refresh()}>
                <RefreshCw />
              </IconButton>
            </div>
            <div
              className="sidebar-resizer"
              role="separator"
              aria-label="调整导航栏宽度"
              aria-orientation="vertical"
              aria-valuenow={sidebarWidth}
              aria-valuemin={204}
              aria-valuemax={300}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                  e.preventDefault();
                  setSidebarWidth((v) => {
                    const next = Math.max(204, Math.min(300, v + (e.key === 'ArrowRight' ? 12 : -12)));
                    savePreference('sidebar-width', String(next));
                    return next;
                  });
                }
              }}
              onPointerDown={(e) => {
                const x = e.clientX,
                  initial = sidebarWidth,
                  node = e.currentTarget;
                node.setPointerCapture(e.pointerId);
                let latest = initial;
                const move = (event: PointerEvent) => {
                  latest = Math.max(204, Math.min(300, initial + event.clientX - x));
                  setSidebarWidth(latest);
                };
                const stop = () => {
                  node.removeEventListener('pointermove', move);
                  node.removeEventListener('pointerup', stop);
                  node.removeEventListener('pointercancel', stop);
                  savePreference('sidebar-width', String(latest));
                };
                node.addEventListener('pointermove', move);
                node.addEventListener('pointerup', stop);
                node.addEventListener('pointercancel', stop);
              }}
            />
          </aside>
        )}
        <main className="workspace-canvas">
          <header className="breadcrumb">
            <div className="breadcrumbs">
              {project ? (
                <>
                  <button onClick={() => navigate({ kind: 'project', id: project.id })}>项目</button>
                  <ChevronRight />
                  <button
                    className={route?.kind === 'project' ? 'current' : ''}
                    onClick={() => navigate({ kind: 'project', id: project.id })}
                  >
                    {project.name}
                  </button>
                  {route?.kind !== 'project' && (
                    <>
                      <ChevronRight />
                      <span className="current truncate">{route ? titleOf(route) : ''}</span>
                    </>
                  )}
                  {project.isDemo && <span className="demo-badge">示例</span>}
                </>
              ) : (
                <span className="current">{route ? titleOf(route) : '工作空间'}</span>
              )}
            </div>
            <div className="breadcrumb-actions">
              {busy && <RefreshCw size={13} className="spin muted" />}
              {project && !project.isDemo && (
                <IconButton label="打开项目目录" onClick={() => void mutate(() => api.openProjectFolder(project.id))}>
                  <FolderOpenIcon />
                </IconButton>
              )}
            </div>
          </header>
          {/* The service stopped answering: the page below is a frozen read, so say so until it is back. */}
          {stale && (
            <div className="offline-banner" role="status" aria-label="执行服务离线">
              <span className="offline-banner-text">
                执行服务未响应，显示的是 {formatClock(lastSyncedAt)} 之前的数据。
              </span>
              <Button variant="ghost" disabled={busy} onClick={() => void reconnect()}>
                重新连接
              </Button>
            </div>
          )}
          <div
            className="feature-viewport"
            ref={viewportRef}
            onScrollCapture={(event) => {
              const target = event.target;
              if (target instanceof HTMLElement && target.classList.contains('feature-scroll'))
                scrollPositions.current[scrollKey] = { top: target.scrollTop, left: target.scrollLeft };
            }}
          >
            {feature()}
          </div>
        </main>
      </div>
      {/* During the handover the old service is stepping aside on purpose; the banner explains it. */}
      {error && !modal && !upgradeSwitching(snapshot) && (
        <div role="alert" className="error-toast">
          <AlertCircle size={16} />
          <p>{error}</p>
          {/* Re-reading state cannot revive a dead daemon; while offline the retry reconnects instead. */}
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              if (stale) {
                void reconnect();
                return;
              }
              clearError();
              void refresh();
            }}
          >
            {stale ? '重新连接' : '重试'}
          </Button>
          <IconButton label="关闭提示" onClick={dismissError}>
            <X />
          </IconButton>
        </div>
      )}
      <Dialogs modal={modal} onClose={() => setModal(null)} onNavigate={navigate} />
    </div>
  );
}
function FolderOpenIcon() {
  return <ArrowUpRight />;
}
/**
 * A cold start can wait twelve seconds for the daemon's health probe and fifteen for the first read.
 * Name the phase the app is actually in, and after eight seconds say where the log is.
 */
function LoadingWorkspace({ starting }: { starting: boolean }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 8000);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className="loading-workspace" role="status">
      <div className="skeleton-line" />
      <div className="skeleton-line" />
      <div className="skeleton-line" />
      <p>{starting ? '正在启动执行服务…' : '正在读取工作空间…'}</p>
      {slow && <p className="subtle">仍在启动，日志在数据目录的 service.log。</p>}
    </div>
  );
}

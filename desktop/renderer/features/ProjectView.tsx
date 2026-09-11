import { useEffect, useState, type ReactNode } from 'react';
import {
  ArrowUpRight,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Columns3,
  Filter,
  Folder,
  Link2,
  List,
  Plus,
  Search,
  X,
} from 'lucide-react';
import { isLegacyRuntime } from '../../shared/types';
import type { Channel, WorkItem } from '../../shared/types';
import type { FeatureProps } from './types';
import { Button, EmptyState, IconButton, Markdown, PropertyPanel, StatusIcon } from '../components/ui';
import { formatDate, kindLabel, statusLabel } from '../components/format';
import {
  featureNumber,
  featureOwnerLabel,
  featureProjectId,
  featureSourceIds,
  featureSourceLabel,
} from './featureOwnership';
import { ProjectRecords } from './ProjectRecords';
import { ProjectReleases, ProjectThinking } from './ProjectWork';
import { ProjectBrief } from './ProjectBrief';
import { ProjectUsageSection } from './ProjectUsage';
import { questionExcerpt } from './ChannelQuestion';
import './content.css';

const statusOrder = ['open', 'investigating', 'blocked', 'verified', 'resolved'];
interface ProjectPreferences {
  layout: 'list' | 'board';
  status: string;
  channel: string;
}
const defaults: ProjectPreferences = { layout: 'board', status: 'all', channel: 'all' };
function readPreferences(id: string): ProjectPreferences {
  try {
    const stored = JSON.parse(
      localStorage.getItem(`morrow.project-view.${id}`) || localStorage.getItem(`nohuman.project-view.${id}`) || '{}'
    );
    return {
      layout: stored.layout === 'list' ? 'list' : 'board',
      status: typeof stored.status === 'string' ? stored.status : 'all',
      channel: typeof stored.channel === 'string' ? stored.channel : 'all',
    };
  } catch {
    return defaults;
  }
}
export function ProjectView(props: FeatureProps & { id: string }) {
  const { id, snapshot, api, onMutate, onNavigate, onNewFeature, onNewChannel, busy } = props;
  const project = snapshot.projects.find((project) => project.id === id);
  const channels = snapshot.channels.filter((channel) => channel.projectId === id);
  const allItems = snapshot.items.filter((item) => featureProjectId(item, snapshot.channels) === id);
  const [tab, setTab] = useState<'items' | 'brief' | 'thinking' | 'records' | 'releases'>('items');
  const [query, setQuery] = useState('');
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [briefState, setBriefState] = useState<{ id: string; revision?: number; present: boolean }>();
  useEffect(() => {
    if (!project || !api.getProjectBrief) return;
    let cancelled = false;
    api.getProjectBrief(id).then(
      (value) => {
        if (!cancelled) setBriefState({ id, revision: project.briefRevision, present: !!value.brief.trim() });
      },
      () => {
        if (!cancelled) setBriefState(undefined);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [api, id, project?.briefRevision]);
  const [preferences, setPreferences] = useState(() => readPreferences(id));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    setPreferences(readPreferences(id));
    setQuery('');
    setCollapsed(new Set());
    setTab('items');
    setPropertiesOpen(false);
    setFiltersOpen(false);
    setHistoryOpen(false);
  }, [id]);
  const changePreferences = (patch: Partial<ProjectPreferences>) =>
    setPreferences((previous) => {
      const next = { ...previous, ...patch };
      try {
        localStorage.setItem(`morrow.project-view.${id}`, JSON.stringify(next));
      } catch {
        /* Keep this view preference for the current session. */
      }
      return next;
    });
  const queryText = query.trim().toLocaleLowerCase();
  const items = allItems
    .filter(
      (item) =>
        (preferences.status === 'all' || item.status === preferences.status) &&
        (preferences.channel === 'all' ||
          (preferences.channel === 'manual'
            ? !item.channelId
            : featureSourceIds(item).includes(preferences.channel))) &&
        (!queryText ||
          `${featureNumber(item)} ${item.title} ${item.summary} ${item.evidence.join(' ')}`
            .toLocaleLowerCase()
            .includes(queryText))
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const filtered = preferences.channel !== 'all' || preferences.status !== 'all' || !!queryText;
  const currentItems = filtered ? items : items.filter((item) => item.status !== 'resolved');
  const resolvedItems = items.filter((item) => item.status === 'resolved');
  const clearFilters = () => {
    changePreferences({ status: 'all', channel: 'all' });
    setQuery('');
  };
  const openItem = (item: WorkItem) => onNavigate({ kind: 'finding', id: item.id });
  // Only a Codex channel can continue in the App; channels from retired runtimes stay readable but never execute.
  const codexChannel = channels.find((channel) => channel.runtime === 'codex');
  const legacyChannels = channels.filter((channel) => isLegacyRuntime(channel.runtime));
  const pendingQuestions = channels.filter((channel) => channel.work?.awaitingReply);
  if (!project) return <EmptyState title="项目不存在" description="项目可能已被移除，请在侧栏重新选择。" />;
  const pendingReleases = (snapshot.releases || []).filter(
    (release) => release.projectId === id && release.status === 'awaiting_approval'
  );
  const blocked = allItems.find((item) => item.status === 'blocked');
  const boundChannel = channels.find((channel) => channel.runtime === 'codex' && channel.sessionId);
  const missingBrief =
    briefState?.id === id && briefState.revision === project.briefRevision
      ? !briefState.present
      : project.brief !== undefined
        ? !project.brief.trim()
        : project.briefRevision === 0;
  const next = pendingQuestions.length
    ? {
        text: `${pendingQuestions.length} 个频道有问题待回答`,
        label: '回答当前问题',
        action: () => onNavigate({ kind: 'channel', id: pendingQuestions[0].id }),
      }
    : pendingReleases.length
      ? {
          text: `${pendingReleases.length} 个版本等待你审核`,
          label: '查看待审版本',
          action: () => setTab('releases'),
        }
      : blocked
        ? {
            text: blocked.title,
            label: '查看阻塞事项',
            action: () => openItem(blocked),
          }
        : missingBrief
          ? {
              text: '写下目标、约束和需要你决定的事',
              label: '完善项目说明',
              action: () => setTab('brief'),
            }
          : !codexChannel
            ? {
                text: '添加持续频道，再关联你在 Codex App 中创建的任务',
                label: '添加频道',
                action: () => onNewChannel(id),
              }
            : !boundChannel
              ? {
                  text: '在 Codex App 创建任务，再到频道关联',
                  label: '关联已有任务',
                  action: () => onNavigate({ kind: 'channel', id: codexChannel.id }),
                }
              : {
                  text: `${boundChannel.name} · 查看当前进展和下一步`,
                  label: '打开工作日志',
                  action: () => onNavigate({ kind: 'channel', id: boundChannel.id }),
                };

  const history = !filtered && resolvedItems.length > 0 && (
    <section className="project-history" aria-label="已解决历史">
      <button
        className="task-group-heading"
        aria-expanded={historyOpen}
        onClick={() => setHistoryOpen((open) => !open)}
      >
        {historyOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        已解决历史 <span className="subtle">{resolvedItems.length}</span>
      </button>
      {historyOpen &&
        resolvedItems.map((item) => (
          <FindingRow key={item.id} item={item} channels={channels} onClick={() => openItem(item)} />
        ))}
    </section>
  );
  return (
    <div className="feature-layout">
      <main className="feature-main">
        <div className="feature-toolbar project-feature-toolbar">
          <div className="feature-tabs" role="tablist" aria-label="项目内容">
            <button
              role="tab"
              aria-selected={tab === 'items'}
              className={tab === 'items' ? 'active' : ''}
              onClick={() => setTab('items')}
            >
              功能看板 <span>{allItems.length}</span>
            </button>
            <button
              role="tab"
              aria-selected={tab === 'brief'}
              className={tab === 'brief' ? 'active' : ''}
              onClick={() => setTab('brief')}
            >
              项目说明
            </button>
            <button
              role="tab"
              aria-selected={tab === 'thinking'}
              className={tab === 'thinking' ? 'active' : ''}
              onClick={() => setTab('thinking')}
            >
              当前判断
            </button>
            <button
              role="tab"
              aria-selected={tab === 'records'}
              className={tab === 'records' ? 'active' : ''}
              onClick={() => setTab('records')}
            >
              全部记录
            </button>
            <button
              role="tab"
              aria-selected={tab === 'releases'}
              className={tab === 'releases' ? 'active' : ''}
              onClick={() => setTab('releases')}
            >
              上线确认{' '}
              <span>
                {(snapshot.releases || []).filter((r) => r.projectId === id && r.status === 'awaiting_approval')
                  .length || ''}
              </span>
            </button>
          </div>
          <div className="feature-toolbar-spacer" />
          {tab === 'items' && (
            <>
              <Button variant="secondary" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((open) => !open)}>
                <Filter size={14} />
                {filtered ? '已筛选' : '筛选'}
              </Button>
              <IconButton
                label={preferences.layout === 'list' ? '切换为看板' : '切换为列表'}
                onClick={() => changePreferences({ layout: preferences.layout === 'list' ? 'board' : 'list' })}
              >
                {preferences.layout === 'list' ? <Columns3 size={16} /> : <List size={16} />}
              </IconButton>
            </>
          )}
          {tab === 'items' && (
            <Button variant="ghost" disabled={busy} onClick={() => onNewFeature(id)}>
              <Plus size={14} />
              新建功能
            </Button>
          )}
          <Button variant="ghost" aria-expanded={propertiesOpen} onClick={() => setPropertiesOpen((open) => !open)}>
            项目属性
          </Button>
        </div>
        {tab === 'items' && filtersOpen && (
          <section className="project-filters" aria-label="看板筛选">
            <label className="feature-search">
              <Search size={14} />
              <input
                aria-label="搜索功能和证据"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索…"
              />
              {query && (
                <button aria-label="清除搜索" onClick={() => setQuery('')}>
                  <X size={12} />
                </button>
              )}
            </label>
            <select
              aria-label="状态筛选"
              value={preferences.status}
              onChange={(event) => changePreferences({ status: event.target.value })}
            >
              {preferences.status !== 'all' && !statusOrder.includes(preferences.status) && (
                <option value={preferences.status}>原状态筛选已不可用</option>
              )}
              {['all', ...statusOrder].map((status) => (
                <option key={status} value={status}>
                  {status === 'all' ? '所有状态' : statusLabel(status)}
                </option>
              ))}
            </select>
            <select
              aria-label="来源频道筛选"
              value={preferences.channel}
              onChange={(event) => changePreferences({ channel: event.target.value })}
            >
              {!['all', 'manual'].includes(preferences.channel) &&
                !channels.some((channel) => channel.id === preferences.channel) && (
                  <option value={preferences.channel}>原频道筛选已不可用</option>
                )}
              <option value="all">所有来源</option>
              <option value="manual">手动创建</option>
              {channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.name}
                </option>
              ))}
            </select>
            {filtered && (
              <Button variant="ghost" onClick={clearFilters}>
                清除筛选
              </Button>
            )}
          </section>
        )}
        {tab === 'items' && (
          <section className="project-next" aria-label="项目下一步">
            <div>
              <p className="project-goal-summary" title={project.goal}>
                {project.goal}
              </p>
              <p>{next.text}</p>
            </div>
            <Button variant="primary" disabled={busy} onClick={next.action}>
              {next.label}
            </Button>
          </section>
        )}
        {tab === 'brief' ? (
          <ProjectBrief key={id} api={api} project={project} busy={busy} onMutate={onMutate} />
        ) : tab === 'thinking' ? (
          <ProjectThinking api={api} projectId={id} onNavigate={onNavigate} isDemo={project.isDemo} />
        ) : tab === 'releases' ? (
          <ProjectReleases {...props} key={id} projectId={id} />
        ) : tab === 'records' ? (
          <div className="feature-scroll">
            <ProjectRecords {...props} projectId={id} />
          </div>
        ) : !items.length ? (
          <div className="feature-empty">
            <EmptyState
              icon={<CheckCheck />}
              title={filtered ? '没有符合条件的功能' : '还没有项目功能'}
              description={
                filtered
                  ? '调整状态、来源频道或关键词，查看其他功能。'
                  : 'Codex 会根据项目目标自动建立和跟踪功能，你可以进入频道指导它。'
              }
              action={
                filtered && !filtersOpen ? (
                  <Button variant="ghost" onClick={clearFilters}>
                    清除筛选
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : preferences.layout === 'list' ? (
          <div className="feature-scroll task-list">
            {!currentItems.length && <p className="project-board-empty">当前没有未解决事项，历史记录保留在下方。</p>}
            {statusOrder
              .filter((status) => currentItems.some((item) => item.status === status))
              .map((status) => (
                <section className="task-group" key={status}>
                  <button
                    className="task-group-heading"
                    aria-expanded={!collapsed.has(status)}
                    onClick={() =>
                      setCollapsed((previous) => {
                        const next = new Set(previous);
                        if (next.has(status)) next.delete(status);
                        else next.add(status);
                        return next;
                      })
                    }
                  >
                    {collapsed.has(status) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    <StatusIcon status={status} />
                    <span>{statusLabel(status)}</span>
                    <span className="subtle">{currentItems.filter((item) => item.status === status).length}</span>
                  </button>
                  {!collapsed.has(status) &&
                    currentItems
                      .filter((item) => item.status === status)
                      .map((item) => (
                        <FindingRow key={item.id} item={item} channels={channels} onClick={() => openItem(item)} />
                      ))}
                </section>
              ))}
            {history}
          </div>
        ) : (
          <div className="feature-scroll board-scroll">
            {!currentItems.length && <p className="project-board-empty">当前没有未解决事项，历史记录保留在下方。</p>}
            <div className="finding-board current-board">
              {statusOrder
                .filter((status) => currentItems.some((item) => item.status === status))
                .map((status) => (
                  <section className="board-column" key={status}>
                    <h3>
                      <StatusIcon status={status} />
                      {statusLabel(status)} <span>{currentItems.filter((item) => item.status === status).length}</span>
                    </h3>
                    {currentItems
                      .filter((item) => item.status === status)
                      .map((item) => (
                        <button className="board-card" key={item.id} onClick={() => openItem(item)}>
                          <span className="board-card-type">
                            {kindLabel(item.kind)} <span>{featureNumber(item)}</span>
                          </span>
                          <strong>{item.title}</strong>
                          <span className="board-card-meta">
                            <span className="feature-source-tag" title={`来源：${featureSourceLabel(item, channels)}`}>
                              {item.channelId ? '# ' : ''}
                              {featureSourceLabel(item, channels)}
                            </span>
                            <FeatureOwnerTag item={item} channels={channels} />
                            <span>
                              <Link2 size={12} />
                              {item.evidence.length}
                            </span>
                          </span>
                        </button>
                      ))}
                  </section>
                ))}
            </div>
            {history}
          </div>
        )}
      </main>
      {propertiesOpen && (
        <PropertyPanel>
          <div className="property-project-icon">
            <Folder size={24} />
          </div>
          <h2 className="property-title">{project.name}</h2>
          {project.isDemo && <span className="feature-demo-label">示例数据</span>}
          <Button
            variant="ghost"
            aria-label="在 Codex App 中继续此项目"
            title={
              project.isDemo
                ? '示例项目不会打开原生对话。'
                : codexChannel
                  ? '打开此项目的原生会话；尚未关联时打开 App 新建对话。'
                  : legacyChannels.length
                    ? '旧频道使用的运行时已停止支持；新建 Codex 频道后可打开原生对话。'
                    : '创建 Codex 频道后可打开原生对话。'
            }
            disabled={busy || project.isDemo || !codexChannel}
            onClick={() => codexChannel && void onMutate(() => api.openNativeApp(codexChannel.id))}
          >
            <ArrowUpRight size={14} />
            <span className="project-native-label">Codex App</span>
          </Button>

          {pendingQuestions.length > 0 && (
            <section className="property-section" aria-label="待回答">
              <h3>待回答</h3>
              {pendingQuestions.map((channel) => (
                <div className="pending-question" key={channel.id}>
                  <span className="pending-question-channel">{channel.name}</span>
                  <span className="pending-question-excerpt" title={channel.work?.nextStep}>
                    {questionExcerpt(channel.work?.nextStep || '')}
                  </span>
                  <Button
                    variant="ghost"
                    aria-label={`回答 ${channel.name} 的问题`}
                    onClick={() => onNavigate({ kind: 'channel', id: channel.id })}
                  >
                    回答
                  </Button>
                </div>
              ))}
            </section>
          )}
          <section className="property-section">
            <h3>属性</h3>
            <Property label="项目功能">{allItems.length} 个</Property>
            <Property label="持续频道">{channels.length} 个</Property>
            {legacyChannels.length > 0 && (
              <Property label="已停止支持">{legacyChannels.length} 个旧频道，历史可读</Property>
            )}
            <Property label="正在运行">{channels.filter((channel) => channel.status === 'running').length} 个</Property>
            {channels.some((channel) => channel.usageWait && channel.status === 'waiting') && (
              <Property label="等待额度">
                {channels.filter((channel) => channel.usageWait && channel.status === 'waiting').length} 个频道
              </Property>
            )}
            <Property label="创建时间">{formatDate(project.createdAt)}</Property>
          </section>
          <section className="property-section">
            <h3>项目目标</h3>
            <button
              type="button"
              className="property-goal"
              title="打开项目说明，查看或编辑目标与要求"
              onClick={() => setTab('brief')}
            >
              <span className="property-description">
                <Markdown>{project.goal}</Markdown>
              </span>
            </button>
          </section>
          <ProjectUsageSection
            api={api}
            project={project}
            busy={busy}
            onMutate={onMutate}
            readingAt={snapshot.usage?.reading?.at}
          />
          <section className="property-section">
            <h3>资源</h3>
            {project.path ? (
              <>
                <p className="property-path">{project.path}</p>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void onMutate(() => api.openProjectFolder(project.id))}
                >
                  <Folder size={14} />
                  打开项目目录
                </Button>
              </>
            ) : (
              <p className="subtle">示例项目未关联目录</p>
            )}
          </section>
        </PropertyPanel>
      )}
    </div>
  );
}
export function FindingRow({
  item,
  channel,
  channels = channel ? [channel] : [],
  onClick,
}: {
  item: WorkItem;
  channel?: Channel;
  channels?: Channel[];
  onClick: () => void;
}) {
  const ownerLabel = featureOwnerLabel(item, channels);
  return (
    <button className="finding-row" onClick={onClick} title={item.title}>
      <StatusIcon status={item.status} />
      <span className="finding-id">{featureNumber(item)}</span>
      <span className="finding-row-title">{item.title}</span>
      <span className="finding-kind">{kindLabel(item.kind)}</span>
      <span className="finding-channel feature-source-tag" title={`来源：${featureSourceLabel(item, channels)}`}>
        {featureSourceLabel(item, channels)}
      </span>
      <span className="finding-owner feature-owner-tag" title={ownerLabel ? `负责频道：${ownerLabel}` : undefined}>
        {ownerLabel ? `负责 ${ownerLabel}` : ''}
      </span>
      <span className="finding-evidence">
        <Link2 size={12} />
        {item.evidence.length}
      </span>
    </button>
  );
}
/** Which channel is responsible for this item; nothing at all while nobody is. */
export function FeatureOwnerTag({ item, channels }: { item: WorkItem; channels: Channel[] }) {
  const owner = featureOwnerLabel(item, channels);
  if (!owner) return null;
  return (
    <span className="feature-owner-tag" title={`负责频道：${owner}`}>
      负责 {owner}
    </span>
  );
}
export function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="feature-property">
      <span>{label}</span>
      <div>{children}</div>
    </div>
  );
}

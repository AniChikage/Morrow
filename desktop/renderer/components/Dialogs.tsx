import { productName, version } from '../../../package.json';
import { useEffect, useId, useRef, useState, type ReactNode, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, FolderOpen, Plus, Search, Hash, Folder, FileText, Laptop, Server, ArrowUpRight, Check } from 'lucide-react';
import { Button, IconButton, StatusIcon } from './ui';
import { kindLabel, usageWindowLabel } from './format';
import { useWorkspace } from '../state/workspace';
import { briefPlaceholder, briefTemplate } from '../features/ProjectBrief';
import { isLegacyRuntime, usageWindows } from '../../shared/types';
import type {
  Channel,
  ChannelPatch,
  ConnectionConfig,
  Route,
  WorkItem,
  ItemPatch,
  Settings,
  SettingsPatch,
  UsageWindow,
} from '../../shared/types';

export type ModalState =
  | { kind: 'project' }
  | { kind: 'channel'; projectId: string; channel?: Channel }
  | { kind: 'feature'; projectId: string; item?: WorkItem }
  | { kind: 'search' }
  | { kind: 'settings' }
  | null;
export function Dialogs({
  modal,
  onClose,
  onNavigate,
}: {
  modal: ModalState;
  onClose: () => void;
  onNavigate: (route: Route, newTab?: boolean) => void;
}) {
  if (!modal) return null;
  if (modal.kind === 'project') return <ProjectDialog onClose={onClose} onNavigate={onNavigate} />;
  if (modal.kind === 'channel')
    return (
      <ChannelDialog key={modal.channel?.id || modal.projectId} {...modal} onClose={onClose} onNavigate={onNavigate} />
    );
  if (modal.kind === 'feature')
    return (
      <FeatureDialog key={modal.item?.id || modal.projectId} {...modal} onClose={onClose} onNavigate={onNavigate} />
    );
  if (modal.kind === 'search') return <SearchDialog onClose={onClose} onNavigate={onNavigate} />;
  return <SettingsDialog onClose={onClose} />;
}
function Modal({
  title,
  description,
  children,
  onClose,
  className = '',
}: {
  title: string;
  description: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          ref={ref}
          className={`dialog-content ${className}`}
          onOpenAutoFocus={(event) => {
            const el = ref.current?.querySelector<HTMLElement>('[data-autofocus]');
            if (el) {
              event.preventDefault();
              el.focus();
            }
          }}
        >
          <div className="dialog-heading">
            <div>
              <Dialog.Title className="dialog-title">{title}</Dialog.Title>
              <Dialog.Description className="dialog-description">{description}</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <IconButton label="关闭" className="dialog-close">
                <X />
              </IconButton>
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
function Field({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <label className="form-field">
      <span className="field-label">{title}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function ProjectDialog({
  onClose,
  onNavigate,
}: {
  onClose: () => void;
  onNavigate: (route: Route, newTab?: boolean) => void;
}) {
  const { api, connection, mutate, busy, error, clearError, snapshot } = useWorkspace();
  const [name, setName] = useState(''),
    [path, setPath] = useState(''),
    [goal, setGoal] = useState(''),
    [brief, setBrief] = useState(''),
    [localError, setLocalError] = useState('');
  const remote = connection?.config.mode === 'ssh';
  const existing = path.trim()
    ? snapshot.projects.find((project) => !project.isDemo && project.path === path.trim())
    : undefined;
  useEffect(() => clearError(), []);
  async function choose() {
    try {
      const folder = await api.chooseFolder();
      if (folder) {
        setPath(folder);
        if (!name) setName(folder.split('/').filter(Boolean).pop() || '');
        setLocalError('');
      }
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e));
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (existing) {
      onNavigate({ kind: 'project', id: existing.id }, true);
      onClose();
      return;
    }
    let projectId = '';
    const ok = await mutate(async () => {
      const project = await api.createProject({
        name: name.trim() || path.split('/').filter(Boolean).pop() || '项目',
        path: path.trim(),
        goal: goal.trim() || '持续跟踪项目进展，识别有证据支持的问题，在授权范围内推进修复并验证结果。',
        runtime: 'codex',
        ...(brief.trim() ? { brief: brief.trim() } : {}),
      });
      projectId = project.id;
    });
    if (ok) {
      onNavigate({ kind: 'project', id: projectId }, true);
      onClose();
    }
  }
  return (
    <Modal
      title="打开项目文件夹"
      description="接入已有目录，再关联 Codex App 任务开始工作。"
      onClose={onClose}
      className="project-dialog"
    >
      <form onSubmit={submit}>
        <div className="project-dialog-fields">
          <Field title={remote ? '远程项目目录' : '项目文件夹'}>
            <span className="input-action">
              <input
                data-autofocus
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder={remote ? '/home/user/projects/atlas' : '选择本机项目文件夹'}
                required
              />
              {!remote && (
                <Button onClick={() => void choose()}>
                  <FolderOpen />
                  选择文件夹
                </Button>
              )}
            </span>
          </Field>
          <Field title="项目名称">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="默认使用文件夹名称"
              maxLength={100}
            />
          </Field>
          <Field title="持续目标" hint="可以留空，稍后在频道中细化长期职责。">
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="例如：持续检查关键流程，发现问题、修复并验证。"
              maxLength={10000}
            />
          </Field>
          <details className="project-brief-options">
            <summary>项目说明（可选）{brief.trim() ? ' · 已填写' : ''}</summary>
            <Field title="项目说明" hint="Codex 按这些要求工作，不修改说明；接入后仍可在项目页编辑。">
              <textarea
                className="brief-input"
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                placeholder={briefPlaceholder}
                maxLength={65536}
              />
            </Field>
            <div className="brief-template-row">
              <Button variant="ghost" disabled={!!brief.trim()} onClick={() => setBrief(briefTemplate)}>
                插入模板
              </Button>
            </div>
          </details>
          <p className="form-note">频道初始保持暂停；关联 App 任务后再开启，沿用 App 的权限与审批设置。</p>
          {existing && <p className="form-note">这个文件夹已接入，将打开已有项目。</p>}
          {(error || localError) && (
            <p role="alert" className="form-error">
              {localError || error}
            </p>
          )}
        </div>
        <div className="form-actions">
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" type="submit" disabled={busy || !path.trim()}>
            {busy ? '正在接入…' : existing ? '打开已有项目' : '打开项目'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function FeatureDialog({
  projectId,
  item,
  onClose,
  onNavigate,
}: {
  projectId: string;
  item?: WorkItem;
  onClose: () => void;
  onNavigate: (route: Route, newTab?: boolean) => void;
}) {
  const { api, snapshot, mutate, busy, error, clearError } = useWorkspace();
  const [title, setTitle] = useState(item?.title || ''),
    [summary, setSummary] = useState(item?.summary || ''),
    [kind, setKind] = useState(item?.kind || 'feature'),
    [status, setStatus] = useState(item?.status || 'open'),
    [channelId, setChannelId] = useState(item?.channelId || '');
  const [evidence, setEvidence] = useState<string[]>(item?.evidence || []),
    [nextStep, setNextStep] = useState(item?.nextStep || ''),
    [revision, setRevision] = useState(item?.revision);
  const latest = item ? snapshot.items.find((value) => value.id === item.id) : undefined;
  const stale = !!item && latest?.revision !== undefined && revision !== latest.revision;
  const channels = snapshot.channels.filter((channel) => channel.projectId === projectId);
  useEffect(() => clearError(), []);
  function reload() {
    if (!latest) return;
    setTitle(latest.title);
    setSummary(latest.summary);
    setKind(latest.kind);
    setStatus(latest.status);
    setEvidence(latest.evidence);
    setNextStep(latest.nextStep);
    setRevision(latest.revision);
    clearError();
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    let itemId = item?.id || '';
    const fields: ItemPatch = {
      title: title.trim(),
      summary: summary.trim(),
      kind,
      status,
      evidence: evidence.map((value) => value.trim()).filter(Boolean),
      nextStep: nextStep.trim(),
    };
    const ok = await mutate(async () => {
      if (item) await api.patchItem(item.id, { ...fields, ...(revision !== undefined ? { revision } : {}) });
      else {
        const value = await api.createItem({ projectId, ...fields, title: fields.title!, channelId });
        itemId = value.id;
      }
    });
    if (ok) {
      onNavigate({ kind: 'finding', id: itemId });
      onClose();
    }
  }
  return (
    <Modal
      title={item ? '编辑功能' : '新建功能'}
      description="功能保存在项目统一看板，所有频道共享进展与证据。"
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <Field title="标题">
          <input
            data-autofocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={300}
            placeholder="描述一个需要推进的功能或问题"
            required
          />
        </Field>
        <Field title="描述">
          <textarea
            className="feature-description-input"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            maxLength={10000}
            placeholder="目标、背景与验收标准，支持 Markdown。"
          />
        </Field>
        <div className="form-row">
          <Field title="类型">
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="feature">功能</option>
              <option value="issue">问题</option>
              <option value="opportunity">机会</option>
              <option value="hypothesis">假设</option>
            </select>
          </Field>
          <Field title="状态">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="open">待处理</option>
              <option value="investigating">进行中</option>
              <option value="verified">已验证</option>
              <option value="resolved">已解决</option>
              <option value="blocked">受阻</option>
            </select>
          </Field>
        </div>
        {!item && (
          <Field title="关联频道">
            <select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
              <option value="">人工创建 · 暂不关联</option>
              {channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <details className="feature-form-details" open={!!item}>
          <summary>证据与下一步</summary>
          <div className="feature-evidence-fields">
            {evidence.map((value, index) => (
              <div className="feature-evidence-field" key={index}>
                <Field title={`证据 ${index + 1}`}>
                  <textarea
                    value={value}
                    onChange={(e) =>
                      setEvidence((previous) => previous.map((entry, i) => (i === index ? e.target.value : entry)))
                    }
                    maxLength={5000}
                    placeholder="可复查的路径、日志或验证结果"
                  />
                </Field>
                <IconButton
                  label={`移除证据 ${index + 1}`}
                  onClick={() => setEvidence((previous) => previous.filter((_, i) => i !== index))}
                >
                  <X size={14} />
                </IconButton>
              </div>
            ))}
            <Button
              variant="ghost"
              onClick={() => setEvidence((previous) => [...previous, ''])}
              disabled={evidence.length >= 50}
            >
              <Plus size={14} />
              添加证据
            </Button>
          </div>
          <Field title="下一步">
            <textarea
              value={nextStep}
              onChange={(e) => setNextStep(e.target.value)}
              maxLength={5000}
              placeholder="明确下一次要推进的工作。"
            />
          </Field>
        </details>
        {stale && (
          <p className="form-error">
            此功能已有新的修改。
            <button type="button" onClick={reload}>
              重新载入最新内容
            </button>
          </p>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="form-actions">
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" type="submit" disabled={busy || stale || !title.trim()}>
            {busy ? '正在保存…' : item ? '保存修改' : '创建功能'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function ChannelDialog({
  projectId,
  channel,
  onClose,
  onNavigate,
}: {
  projectId: string;
  channel?: Channel;
  onClose: () => void;
  onNavigate: (route: Route) => void;
}) {
  const { api, mutate, busy, error, clearError, snapshot } = useWorkspace();
  const [name, setName] = useState(channel?.name || '');
  const [goal, setGoal] = useState(channel?.goal || '');
  const [interval, setInterval] = useState(channel?.intervalMinutes || 60);
  const [budget, setBudget] = useState(channel?.maxRunsPerDay || 32);
  const demo = !!snapshot.projects.find((p) => p.id === projectId)?.isDemo;
  // Channels from retired runtimes keep their records; only their name and direction remain editable.
  const legacy = !!channel && isLegacyRuntime(channel.runtime);
  useEffect(() => clearError(), []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await mutate(async () => {
      if (channel) {
        const data: ChannelPatch = {
          name: name.trim(),
          goal: goal.trim(),
          intervalMinutes: interval,
          maxRunsPerDay: budget,
        };
        await api.updateChannel(channel.id, data);
      } else {
        const c = await api.createChannel({
          projectId,
          name: name.trim(),
          goal: goal.trim(),
          runtime: 'codex',
          model: '',
          permission: 'native',
          intervalMinutes: interval,
          maxRunsPerDay: budget,
        });
        onNavigate({ kind: 'channel', id: c.id });
      }
    });
    if (ok) onClose();
  }
  return (
    <Modal
      title={channel ? '调整工作方向' : '新建频道'}
      description="告诉 Codex 长期关注什么，它会自主选择下一步，你可以随时通过对话指导。"
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <Field title="频道名称">
          <input
            data-autofocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：性能与稳定性"
            maxLength={100}
            required
          />
        </Field>
        <Field title="工作方向">
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="例如：持续改善用户体验，主动发现值得做的改进，完成后验证效果。"
            maxLength={10000}
            required
          />
        </Field>
        {!legacy && (
          <div className="form-note">
            <p>模型、工具与任务权限在 Codex App 中管理。</p>
            {channel ? (
              <Button disabled={busy || demo} onClick={() => void mutate(() => api.openNativeApp(channel.id))}>
                <ArrowUpRight size={13} />在 Codex App 中打开对话
              </Button>
            ) : (
              <p>创建频道后，在频道页关联已有的 App 任务。</p>
            )}
            {channel && ['read-only', 'workspace-write'].includes(channel.permission) && (
              <p>
                此频道还保留此前的自动执行范围：{channel.permission === 'read-only' ? '只读工作空间' : '允许工作区写入'}
                。保存方向会保留该范围。
              </p>
            )}
          </div>
        )}
        <details className="feature-form-details">
          <summary>工作设置</summary>
          <div className="form-row">
            <Field title="复查间隔（分钟）">
              <input
                type="number"
                value={interval}
                onChange={(e) => setInterval(Number(e.target.value))}
                min={1}
                max={1440}
                required
              />
            </Field>
            <Field title="每日运行上限">
              <input
                type="number"
                value={budget}
                onChange={(e) => setBudget(Number(e.target.value))}
                min={1}
                max={100}
                required
              />
            </Field>
          </div>
        </details>
        <p className="form-note">
          {legacy
            ? '此频道使用的运行时已停止支持，只能调整名称与方向；历史记录保持可读，新工作请新建 Codex 频道。'
            : '保存后可在频道开始工作。已有对话和进展会保留。'}
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            type="submit"
            disabled={
              busy || !name.trim() || !goal.trim() || interval < 1 || interval > 1440 || budget < 1 || budget > 100
            }
          >
            {busy ? '正在保存…' : channel ? '保存方向' : '创建频道'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function SearchDialog({
  onClose,
  onNavigate,
}: {
  onClose: () => void;
  onNavigate: (route: Route, newTab?: boolean) => void;
}) {
  const { snapshot } = useWorkspace();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const listId = useId();
  const matches = (v: string) => v.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const results = [
    ...snapshot.projects
      .filter((p) => matches(p.name + ' ' + p.goal))
      .map((p) => ({
        route: { kind: 'project' as const, id: p.id },
        title: p.name,
        detail: '项目',
        icon: <Folder size={16} />,
      })),
    ...snapshot.channels
      .filter((c) => matches(c.name + ' ' + c.goal))
      .map((c) => ({
        route: { kind: 'channel' as const, id: c.id },
        title: c.name,
        detail: snapshot.projects.find((p) => p.id === c.projectId)?.name || '频道',
        icon: <Hash size={16} />,
      })),
    ...snapshot.items
      .filter((i) => matches(i.title + ' ' + i.summary + ' ' + i.evidence.join(' ')))
      .map((i) => ({
        route: { kind: 'finding' as const, id: i.id },
        title: i.title,
        detail: kindLabel(i.kind),
        icon: <StatusIcon status={i.status} />,
      })),
  ].slice(0, 40);
  function choose(index: number) {
    if (results[index]) {
      onNavigate(results[index].route, true);
      onClose();
    }
  }
  return (
    <Modal title="搜索工作空间" description="搜索项目、频道、发现与证据。" onClose={onClose} className="search-dialog">
      <div className="global-search-input">
        <Search size={18} />
        <input
          data-autofocus
          role="combobox"
          aria-label="搜索工作空间"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded="true"
          aria-activedescendant={results[selected] ? `${listId}-${selected}` : undefined}
          placeholder="搜索项目、发现或关键词…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSelected((v) => Math.min(results.length - 1, v + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSelected((v) => Math.max(0, v - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              choose(selected);
            }
          }}
        />
      </div>
      <div id={listId} className="search-results" role="listbox" aria-label="搜索结果">
        {results.map((r, i) => (
          <button
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === selected}
            className="search-result"
            key={r.route.kind + r.route.id}
            onMouseEnter={() => setSelected(i)}
            onClick={() => choose(i)}
          >
            {r.icon}
            <span>
              {r.title}
              <small>{r.detail}</small>
            </span>
            {i === selected && <span className="search-enter">↵</span>}
          </button>
        ))}
        {!results.length && <p className="search-empty">没有找到相关内容</p>}
      </div>
      <div className="search-footer">
        <span>{results.length} 个结果</span>
        <span>↑ ↓ 选择　↵ 打开　Esc 关闭</span>
      </div>
    </Modal>
  );
}
/** The global usage line kept for the user's own Codex work, plus the opt-in stop when the reading is unknown. */
function UsageReserveSettings() {
  const { api, busy, mutate } = useWorkspace();
  const [settings, setSettings] = useState<Settings>();
  const [loadError, setLoadError] = useState('');
  const [selectedWindow, setWindow] = useState<UsageWindow>('5h');
  const [percent, setPercent] = useState('');
  const [saved, setSaved] = useState('');
  const apply = (value: Settings) => {
    setSettings(value);
    setWindow(value.usageReserve?.window || '5h');
    setPercent(value.usageReserve ? String(value.usageReserve.keepPercent) : '');
  };
  useEffect(() => {
    if (!api.getSettings) return;
    let cancelled = false;
    api.getSettings().then(
      (value) => {
        if (!cancelled) apply(value);
      },
      (failure) => {
        if (!cancelled) setLoadError(failure instanceof Error ? failure.message : '额度设置加载失败');
      }
    );
    return () => {
      cancelled = true;
    };
  }, [api]);
  if (!api.getSettings || !api.updateSettings) return null;
  const update = async (patch: SettingsPatch, receipt: string) => {
    setSaved('');
    const ok = await mutate(async () => apply(await api.updateSettings!(patch)));
    if (ok) setSaved(receipt);
  };
  async function save(event: FormEvent) {
    event.preventDefault();
    const value = Number(percent);
    if (!Number.isInteger(value) || value < 1 || value > 99) {
      setLoadError('保留比例需要是 1 到 99 之间的整数。');
      return;
    }
    setLoadError('');
    await update({ usageReserve: { window: selectedWindow, keepPercent: value } }, '已保存保留额度');
  }
  return (
    <form className="settings-usage" onSubmit={save} aria-label="保留给自己的额度">
      <div className="settings-section-title">保留给自己的额度</div>
      <p className="form-note">
        账户用量达到「100% − 保留」时，Morrow 停止发起新的自动轮次和独立复核，等待窗口重置；普通对话不受影响。
      </p>
      <div className="usage-form">
        <select
          aria-label="保留额度窗口"
          value={selectedWindow}
          disabled={busy || !settings}
          onChange={(e) => setWindow(e.target.value as UsageWindow)}
        >
          {usageWindows.map((name) => (
            <option key={name} value={name}>
              {usageWindowLabel(name)}
            </option>
          ))}
        </select>
        <input
          aria-label="保留百分比"
          type="number"
          min={1}
          max={99}
          step={1}
          placeholder="保留 %"
          value={percent}
          disabled={busy || !settings}
          onChange={(e) => setPercent(e.target.value)}
        />
        <Button
          variant="primary"
          type="submit"
          aria-label="保存保留额度"
          disabled={busy || !settings || !percent.trim()}
        >
          保存
        </Button>
        <Button
          aria-label="清除保留额度"
          disabled={busy || !settings?.usageReserve}
          onClick={() => void update({ usageReserve: null }, '已清除保留额度')}
        >
          清除
        </Button>
      </div>
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={!!settings?.stopWhenUsageUnknown}
          disabled={busy || !settings}
          onChange={(e) =>
            void update(
              { stopWhenUsageUnknown: e.target.checked },
              e.target.checked ? '额度未知时将停止自动工作' : '额度未知时继续自动工作'
            )
          }
        />
        额度未知时也停止自动工作
      </label>
      {loadError && (
        <p role="alert" className="form-error">
          {loadError}
        </p>
      )}
      {saved && (
        <p role="status" className="settings-saved">
          <Check size={14} />
          {saved}
        </p>
      )}
    </form>
  );
}
function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { api, connection, busy, mutate, error, reset, setConnectionInfo, clearError } = useWorkspace();
  const [config, setConfig] = useState<ConnectionConfig>(
    connection?.config || { mode: 'local', host: '', port: 43821, directory: '~/.local/share/morrow' }
  );
  const [saved, setSaved] = useState(false);
  const remoteConfig = useRef<ConnectionConfig>(
    connection?.config.mode === 'ssh'
      ? connection.config
      : { mode: 'ssh', host: '', port: 43821, directory: '~/.local/share/morrow' }
  );
  function changeMode(mode: ConnectionConfig['mode']) {
    setSaved(false);
    setConfig((current) => {
      if (current.mode === mode) return current;
      if (current.mode === 'ssh') remoteConfig.current = current;
      return mode === 'ssh' ? remoteConfig.current : { mode: 'local', host: '', port: 43821, directory: '' };
    });
  }
  useEffect(() => clearError(), []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    reset();
    const ok = await mutate(async () => {
      const info = await api.connect(config);
      setConnectionInfo(info);
      if (!info.connected) throw new Error(info.error || '连接失败，请检查执行位置。');
    });
    if (ok) setSaved(true);
  }
  return (
    <Modal title="设置" description="管理桌面应用连接的执行位置。" onClose={onClose}>
      <form onSubmit={submit}>
        <fieldset className="settings-fields" disabled={busy}>
          <div className="settings-section-title">执行位置</div>
          <div className="segmented settings-mode">
            <button type="button" aria-pressed={config.mode === 'local'} onClick={() => changeMode('local')}>
              <Laptop size={14} />
              本机 Mac
            </button>
            <button type="button" aria-pressed={config.mode === 'ssh'} onClick={() => changeMode('ssh')}>
              <Server size={14} />
              远程 SSH
            </button>
          </div>
          {config.mode === 'ssh' ? (
            <>
              <Field title="SSH 主机" hint="使用已有 SSH 配置中的主机别名或 user@host。">
                <input
                  value={config.host}
                  onChange={(e) => {
                    setSaved(false);
                    setConfig((c) => ({ ...c, host: e.target.value }));
                  }}
                  placeholder="dev-box"
                  required
                />
              </Field>
              <div className="form-row">
                <Field title="服务端口">
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={config.port}
                    onChange={(e) => {
                      setSaved(false);
                      setConfig((c) => ({ ...c, port: Number(e.target.value) }));
                    }}
                    required
                  />
                </Field>
                <Field title="远程数据目录">
                  <input
                    value={config.directory}
                    onChange={(e) => {
                      setSaved(false);
                      setConfig((c) => ({ ...c, directory: e.target.value }));
                    }}
                    placeholder="~/.local/share/morrow"
                    required
                  />
                </Field>
              </div>
              <p className="form-note">远端需要先启动 Morrow 执行服务。通过已有 SSH 登录连接，执行和数据保留在远端。</p>
            </>
          ) : (
            <p className="form-note">项目和执行记录保存在这台 Mac。关闭界面后，独立执行服务继续运行。</p>
          )}
        </fieldset>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {saved && (
          <p role="status" className="settings-saved">
            <Check size={14} />
            已连接到{config.mode === 'local' ? '本机 Mac' : config.host}
          </p>
        )}
        <div className="form-actions">
          <Button variant="ghost" onClick={() => void mutate(() => api.openDataFolder())}>
            <FolderOpen />
            数据目录
          </Button>
          <span className="spacer" />
          <Button onClick={onClose}>完成</Button>
          <Button variant="primary" type="submit" disabled={busy || (config.mode === 'ssh' && !config.host.trim())}>
            {busy ? '正在连接…' : '连接'}
          </Button>
        </div>
      </form>
      <UsageReserveSettings />
      <div className="settings-about">
        <span>{productName}</span>
        <span>{version} · Electron / React</span>
      </div>
    </Modal>
  );
}

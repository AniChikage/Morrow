// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectView } from './ProjectView';
import { FindingView } from './FindingView';
import { ChannelView } from './ChannelView';
import { event, featureProps, item, snapshot, TestProviders, timestamp } from './testFixtures';

beforeEach(() => {
  localStorage.clear();
  if (!HTMLElement.prototype.hasPointerCapture) HTMLElement.prototype.hasPointerCapture = () => false;
  if (!HTMLElement.prototype.setPointerCapture) HTMLElement.prototype.setPointerCapture = () => {};
  if (!HTMLElement.prototype.releasePointerCapture) HTMLElement.prototype.releasePointerCapture = () => {};
  if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {};
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('one project-owned feature board', () => {
  it('combines manual features and legacy channel contributions without crossing project ownership', async () => {
    const user = userEvent.setup();
    const state = snapshot();
    state.items.push(item({ id: 'manual', projectId: 'project-atlas', number: 7, channelId: '', sourceChannelIds: [], title: '人工创建的功能', kind: 'feature' }));
    state.items.push(item({ id: 'other-owner', projectId: 'project-other', channelId: 'channel-system', title: '明确属于其他项目' }));
    const { props } = featureProps({ snapshot: state });
    render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    expect(screen.getByRole('tab', { name: '功能看板 4' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^打开.*CSV 重试会重复提交/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^打开.*缩短激活路径/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /#7.*人工创建的功能/ })).toBeTruthy();
    expect(screen.queryByText('明确属于其他项目')).toBeNull();
    expect(screen.queryByRole('tab', { name: /持续频道/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: '筛选' }));
    await user.click(screen.getByRole('menuitem', { name: '手动创建' }));
    expect(screen.getByRole('button', { name: /^打开.*人工创建的功能/ })).toBeTruthy();
    expect(screen.queryByText('CSV 重试会重复提交')).toBeNull();
    await user.click(screen.getByRole('button', { name: '新建功能' }));
    expect(props.onNewFeature).toHaveBeenCalledWith('project-atlas');
  });

  it('filters by contributing channels while retaining the original source label', async () => {
    const user = userEvent.setup();
    const state = snapshot();
    state.items = [item({ projectId: 'project-atlas', sourceChannelIds: ['channel-system', 'channel-growth'] })];
    const { props } = featureProps({ snapshot: state });
    render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    await user.click(screen.getByRole('button', { name: '筛选' }));
    await user.click(screen.getByRole('menuitem', { name: '运营洞察' }));
    expect(screen.getByRole('button', { name: /^打开.*CSV 重试会重复提交/ })).toBeTruthy();
    expect(screen.getByTitle('来源：系统完善')).toBeTruthy();
  });

  it('shows durable project-wide audit and channel activity, with a link back to the shared feature', async () => {
    const user = userEvent.setup();
    const state = snapshot();
    const { props, api } = featureProps({ snapshot: state });
    api.getEvents.mockResolvedValueOnce({ events: [event('human-create', '你创建了项目功能。', 1, { projectId: 'project-atlas', itemId: 'finding-import', channelId: '', runId: '', kind: 'system', actor: 'human', action: 'item.created' }), event('growth-note', '运营频道验证了激活路径。', 2, { projectId: 'project-atlas', channelId: 'channel-growth' })], hasMore: false });
    render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    await user.click(screen.getByRole('tab', { name: '全部记录' }));
    await screen.findByText('你创建了项目功能。');
    expect(api.getEvents).toHaveBeenCalledWith({ projectId: 'project-atlas', limit: 50 });
    expect(screen.getByText('运营频道验证了激活路径。')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /CSV 重试会重复提交/ }));
    expect(props.onNavigate).toHaveBeenCalledWith({ kind: 'finding', id: 'finding-import' });
  });
});

describe('manual feature details and audit', () => {
  it('resolves the project without a source channel, opens editing, sends revision-aware status changes and loads durable audit', async () => {
    const user = userEvent.setup();
    const state = snapshot();
    const manual = item({ id: 'manual', projectId: 'project-atlas', channelId: '', number: 8, revision: 3, title: '手工功能', kind: 'feature' });
    state.items = [manual];
    const { props, api } = featureProps({ snapshot: state });
    api.getEvents.mockResolvedValueOnce({ events: [event('manual-edit', '修改了功能标题。', 1, { projectId: 'project-atlas', itemId: 'manual', channelId: '', kind: 'system', actor: 'human', action: 'item.updated', changes: { before: { title: '旧标题' }, after: { title: '手工功能' } } })], hasMore: false });
    render(<FindingView {...props} id="manual" />, { wrapper: TestProviders });
    expect(within(screen.getByRole('main')).getByRole('heading', { level: 1, name: '手工功能' })).toBeTruthy();
    const properties = within(screen.getByRole('complementary'));
    expect(properties.getByText('手动创建')).toBeTruthy();
    expect(properties.getByRole('button', { name: /Atlas 示例项目/ })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '编辑功能' }));
    expect(props.onEditFeature).toHaveBeenCalledWith(manual);
    await user.click(properties.getByRole('button', { name: '待处理' }));
    await user.click(screen.getByRole('menuitem', { name: '已验证' }));
    await waitFor(() => expect(api.patchItem).toHaveBeenCalledWith('manual', { status: 'verified', revision: 3 }));
    expect(api.updateItem).not.toHaveBeenCalled();
    expect(api.getEvents).toHaveBeenCalledWith({ projectId: 'project-atlas', itemId: 'manual', limit: 50 });
    await screen.findByText('修改了功能标题。');
    await user.click(screen.getByText('查看变更'));
    expect(screen.getByText('旧标题')).toBeTruthy();
    expect(screen.getByText('查看变更').parentElement?.hasAttribute('open')).toBe(true);
  });

  it('keeps local audit visible and exposes retry if an older remote service cannot load audit', async () => {
    const state = snapshot();
    state.events = [event('existing-audit', '已经持久化的本地修改。', 1, { projectId: 'project-atlas', itemId: 'finding-import', action: 'item.updated', actor: 'human', kind: 'system' })];
    const { props, api } = featureProps({ snapshot: state });
    api.getEvents.mockRejectedValueOnce(new Error('审计服务暂不可用'));
    render(<FindingView {...props} id="finding-import" />, { wrapper: TestProviders });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '审计服务暂不可用重试');
    expect(screen.getByText('已经持久化的本地修改。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });
});

describe('channels are execution sources, not separate boards', () => {
  it('opens the CLI conversation inside Morrow while a turn is running', async () => {
    const state = snapshot(); state.projects[0].isDemo = false; state.projects[0].runtime = 'codex';
    state.channels[0].status = 'running';
    state.channels[0].nextRunAt = '2026-09-08T12:00:00Z';
    state.runs = [{ id: 'native-active', channelId: 'channel-system', runtime: 'codex', status: 'running', startedAt: timestamp, finishedAt: '', summary: '', sessionId: 'native-thread', executionOwner: 'codex-app' }];
    const { props, api } = featureProps({ snapshot: state });
    render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    expect(screen.queryByRole('button', { name: '在原生 CLI 中继续' })).toBeNull();
    const button = screen.getByRole('button', { name: '在 Morrow 中继续此项目' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await userEvent.setup().click(button);
    expect(props.onNavigate).toHaveBeenCalledWith({ kind: 'channel', id: 'channel-system' });
    expect(api.openNativeApp).not.toHaveBeenCalled();
    expect(api.openNativeSession).not.toHaveBeenCalled();
    expect(api.channelAction).not.toHaveBeenCalled();
  });

  it('uses the internal conversation entry for legacy Codex projects without a stored default runtime and never falls back to another CLI', async () => {
    const state = snapshot(); state.projects[0].isDemo = false;
    const { props, api } = featureProps({ snapshot: state });
    const view = render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    await userEvent.setup().click(screen.getByRole('button', { name: '在 Morrow 中继续此项目' }));
    expect(props.onNavigate).toHaveBeenCalledWith({ kind: 'channel', id: 'channel-system' });
    expect(api.openNativeApp).not.toHaveBeenCalled();
    const noCodex = { ...state, projects: state.projects.map(project => project.id === 'project-atlas' ? { ...project, runtime: 'codex' as const } : project), channels: state.channels.filter(channel => channel.id !== 'channel-system') };
    view.rerender(<ProjectView {...props} snapshot={noCodex} id="project-atlas" />);
    expect((screen.getByRole('button', { name: '在 Morrow 中继续此项目' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: '在原生 CLI 中继续' })).toBeNull();
    expect(api.openNativeSession).not.toHaveBeenCalled();
  });

  it('keeps channel activity and run history and navigates to the single project board', async () => {
    const { props } = featureProps();
    render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    expect(screen.getByRole('tab', { name: '动态' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /运行记录/ })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /发现|功能/ })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: '项目功能看板' }));
    expect(props.onNavigate).toHaveBeenCalledWith({ kind: 'project', id: 'project-atlas' });
  });

  it('opens the project runtime’s exact channel in the native CLI only when the whole project is inactive', async () => {
    const state = snapshot(); state.projects[0].isDemo = false; state.projects[0].runtime = 'claude';
    const { props, api } = featureProps({ snapshot: state });
    const view = render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    await userEvent.setup().click(screen.getByRole('button', { name: '在原生 CLI 中继续' }));
    expect(api.openNativeSession).toHaveBeenCalledWith('channel-growth');
    const scheduled = { ...state, channels: state.channels.map(channel => channel.id === 'channel-system' ? { ...channel, status: 'idle', nextRunAt: '2026-09-08T12:00:00Z' } : channel) };
    view.rerender(<ProjectView {...props} snapshot={scheduled} id="project-atlas" />);
    expect((screen.getByRole('button', { name: '在原生 CLI 中继续' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.openNativeSession).toHaveBeenCalledTimes(1);
  });

  it('does not open a native CLI while a sibling channel’s run is still active', () => {
    const state = snapshot(); state.projects[0].isDemo = false;
    state.channels[0].runtime = 'claude';
    state.runs = [{ id: 'active-run', channelId: 'channel-growth', runtime: 'claude', status: 'running', startedAt: timestamp, finishedAt: '', summary: '', sessionId: '' }];
    const { props, api } = featureProps({ snapshot: state });
    render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    expect((screen.getByRole('button', { name: '在原生 CLI 中继续' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.openNativeSession).not.toHaveBeenCalled();
  });
});

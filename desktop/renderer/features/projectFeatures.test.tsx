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
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('one project-owned feature board', () => {
  it('combines manual features and legacy channel contributions without crossing project ownership', async () => {
    const user = userEvent.setup();
    const state = snapshot();
    state.items.push(
      item({
        id: 'manual',
        projectId: 'project-atlas',
        number: 7,
        channelId: '',
        sourceChannelIds: [],
        title: '人工创建的功能',
        kind: 'feature',
      })
    );
    state.items.push(
      item({ id: 'other-owner', projectId: 'project-other', channelId: 'channel-system', title: '明确属于其他项目' })
    );
    const { props } = featureProps({ snapshot: state });
    render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    expect(screen.getByRole('tab', { name: '功能看板 4' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /CSV 重试会重复提交/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /缩短激活路径/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /#7.*人工创建的功能/ })).toBeTruthy();
    expect(screen.queryByText('明确属于其他项目')).toBeNull();
    expect(screen.queryByRole('tab', { name: /持续频道/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: '筛选' }));
    await user.click(screen.getByRole('menuitem', { name: '手动创建' }));
    expect(screen.getByRole('button', { name: /人工创建的功能/ })).toBeTruthy();
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
    expect(screen.getByRole('button', { name: /CSV 重试会重复提交/ })).toBeTruthy();
    expect(screen.getByTitle('来源：系统完善')).toBeTruthy();
  });

  it('shows durable project-wide audit and channel activity, with a link back to the shared feature', async () => {
    const user = userEvent.setup();
    const state = snapshot();
    const { props, api } = featureProps({ snapshot: state });
    api.getEvents.mockResolvedValueOnce({
      events: [
        event('human-create', '你创建了项目功能。', 1, {
          projectId: 'project-atlas',
          itemId: 'finding-import',
          channelId: '',
          runId: '',
          kind: 'system',
          actor: 'human',
          action: 'item.created',
        }),
        event('growth-note', '运营频道验证了激活路径。', 2, {
          projectId: 'project-atlas',
          channelId: 'channel-growth',
        }),
      ],
      hasMore: false,
    });
    render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    await user.click(screen.getByRole('tab', { name: '全部记录' }));
    await screen.findByText('你创建了项目功能。');
    expect(api.getEvents).toHaveBeenCalledWith({ projectId: 'project-atlas', limit: 50 });
    expect(screen.getByText('运营频道验证了激活路径。')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /CSV 重试会重复提交/ }));
    expect(props.onNavigate).toHaveBeenCalledWith({ kind: 'finding', id: 'finding-import' });
  });
});

describe('the project brief is the user-owned document between the board and Codex judgement', () => {
  it('renders the brief as Markdown after opening the tab from the inspector goal', async () => {
    const user = userEvent.setup();
    const state = snapshot();
    state.projects[0].briefRevision = 2;
    const { props, api } = featureProps({ snapshot: state });
    api.getProjectBrief.mockResolvedValue({
      goal: '改善可靠性与激活体验。',
      brief: '## 目标与成功标准\n\n- 首月留存 **提升到 40%**\n\n## 约束与红线\n\n不得改动计费。',
      briefRevision: 2,
    });
    render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      '功能看板 3',
      '项目说明',
      '当前判断',
      '全部记录',
      '上线确认 ',
    ]);
    expect(screen.getByRole('tab', { name: '项目说明' }).getAttribute('aria-selected')).toBe('false');
    await user.click(within(screen.getByRole('complementary')).getByRole('button', { name: /改善可靠性与激活体验/ }));
    expect(screen.getByRole('tab', { name: '项目说明' }).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByRole('heading', { level: 2, name: '目标与成功标准' })).toBeTruthy();
    expect(screen.getByText('提升到 40%').tagName).toBe('STRONG');
    expect(screen.getByRole('heading', { level: 2, name: '约束与红线' })).toBeTruthy();
    expect(screen.getByText(/当前为版本 2/)).toBeTruthy();
    expect(api.getProjectBrief).toHaveBeenCalledWith('project-atlas');
    // Demo projects are readable but never editable.
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
  });

  it('edits the goal and brief and saves them against the loaded version', async () => {
    const user = userEvent.setup();
    const state = snapshot();
    state.projects[0].isDemo = false;
    state.projects[0].briefRevision = 1;
    const { props, api } = featureProps({ snapshot: state });
    api.getProjectBrief.mockResolvedValue({ goal: '改善可靠性与激活体验。', brief: '旧说明', briefRevision: 1 });
    api.updateProject.mockResolvedValue({
      ...state.projects[0],
      goal: '新目标',
      brief: '## 目标与成功标准\n\n新说明',
      briefRevision: 2,
    });
    render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    await user.click(screen.getByRole('tab', { name: '项目说明' }));
    await user.click(await screen.findByRole('button', { name: '编辑' }));
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const goal = screen.getByRole('textbox', { name: '项目目标' });
    const brief = screen.getByRole('textbox', { name: /^项目说明/ });
    expect((brief as HTMLTextAreaElement).value).toBe('旧说明');
    await user.clear(goal);
    await user.type(goal, ' 新目标 ');
    await user.clear(brief);
    await user.type(brief, '新说明 ');
    expect(save.disabled).toBe(false);
    await user.click(save);
    await waitFor(() =>
      expect(api.updateProject).toHaveBeenCalledWith('project-atlas', { goal: '新目标', brief: '新说明', revision: 1 })
    );
    expect(props.onMutate).toHaveBeenCalled();
    expect(await screen.findByRole('heading', { level: 2, name: '目标与成功标准' })).toBeTruthy();
    expect(screen.getByText('新目标')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: '项目目标' })).toBeNull();
  });

  it('holds back a draft when the brief changed elsewhere and offers the latest version instead', async () => {
    const user = userEvent.setup();
    const state = snapshot();
    state.projects[0].isDemo = false;
    state.projects[0].briefRevision = 1;
    const { props, api } = featureProps({ snapshot: state });
    api.getProjectBrief
      .mockResolvedValueOnce({ goal: '改善可靠性与激活体验。', brief: '旧说明', briefRevision: 1 })
      .mockResolvedValue({ goal: '改善可靠性与激活体验。', brief: '别人写的新说明', briefRevision: 2 });
    api.updateProject.mockRejectedValue(new Error('项目说明已被更新，请刷新后再保存'));
    render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    await user.click(screen.getByRole('tab', { name: '项目说明' }));
    await user.click(await screen.findByRole('button', { name: '编辑' }));
    const brief = screen.getByRole('textbox', { name: /^项目说明/ }) as HTMLTextAreaElement;
    await user.type(brief, '，我的补充');
    await user.click(screen.getByRole('button', { name: '保存' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('项目说明已在别处更新（版本 2）');
    expect(api.updateProject).toHaveBeenCalledWith('project-atlas', {
      goal: '改善可靠性与激活体验。',
      brief: '旧说明，我的补充',
      revision: 1,
    });
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
    expect(brief.value).toBe('旧说明，我的补充');
    await user.click(screen.getByRole('button', { name: '载入最新版本' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('textbox', { name: /^项目说明/ }) as HTMLTextAreaElement).value).toBe('别人写的新说明');
    await user.type(screen.getByRole('textbox', { name: /^项目说明/ }), '。');
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false);
    expect(api.updateProject).toHaveBeenCalledTimes(1);
  });

  it('explains an empty brief and fills the suggested outline while editing', async () => {
    const user = userEvent.setup();
    const state = snapshot();
    state.projects[0].isDemo = false;
    const { props, api } = featureProps({ snapshot: state });
    render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    await user.click(screen.getByRole('tab', { name: '项目说明' }));
    expect(await screen.findByRole('heading', { level: 2, name: '还没有项目说明' })).toBeTruthy();
    expect(screen.getByText(/目标与成功标准、目标用户与场景、当前阶段与已知问题/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '编辑' }));
    await user.click(screen.getByRole('button', { name: '插入模板' }));
    const brief = screen.getByRole('textbox', { name: /^项目说明/ }) as HTMLTextAreaElement;
    expect(brief.value.startsWith('## 目标与成功标准\n')).toBe(true);
    expect(brief.value).toContain('\n## 需要我决定的事\n');
    expect(screen.queryByRole('button', { name: '插入模板' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByRole('heading', { level: 2, name: '还没有项目说明' })).toBeTruthy();
    expect(api.updateProject).not.toHaveBeenCalled();
  });

  it('keeps the goal readable when the connected service or bridge has no brief support', async () => {
    const user = userEvent.setup();
    const state = snapshot();
    state.projects[0].isDemo = false;
    const { props, api } = featureProps({ snapshot: state });
    api.getProjectBrief.mockRejectedValue(new Error('接口不存在'));
    const view = render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    await user.click(screen.getByRole('tab', { name: '项目说明' }));
    expect(await screen.findByText(/尚不支持项目说明/)).toBeTruthy();
    expect(within(screen.getByRole('main')).getByText('改善可靠性与激活体验。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
    view.unmount();
    const older = featureProps({ snapshot: state });
    delete (older.api as { getProjectBrief?: unknown }).getProjectBrief;
    render(<ProjectView {...older.props} id="project-atlas" />, { wrapper: TestProviders });
    await user.click(screen.getByRole('tab', { name: '项目说明' }));
    expect(screen.getByText(/尚不支持项目说明/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
  });
});

describe('manual feature details and audit', () => {
  it('resolves the project without a source channel, opens editing, sends revision-aware status changes and loads durable audit', async () => {
    const user = userEvent.setup();
    const state = snapshot();
    const manual = item({
      id: 'manual',
      projectId: 'project-atlas',
      channelId: '',
      number: 8,
      revision: 3,
      title: '手工功能',
      kind: 'feature',
    });
    state.items = [manual];
    const { props, api } = featureProps({ snapshot: state });
    api.getEvents.mockResolvedValueOnce({
      events: [
        event('manual-edit', '修改了功能标题。', 1, {
          projectId: 'project-atlas',
          itemId: 'manual',
          channelId: '',
          kind: 'system',
          actor: 'human',
          action: 'item.updated',
          changes: { before: { title: '旧标题' }, after: { title: '手工功能' } },
        }),
      ],
      hasMore: false,
    });
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
    state.events = [
      event('existing-audit', '已经持久化的本地修改。', 1, {
        projectId: 'project-atlas',
        itemId: 'finding-import',
        action: 'item.updated',
        actor: 'human',
        kind: 'system',
      }),
    ];
    const { props, api } = featureProps({ snapshot: state });
    api.getEvents.mockRejectedValueOnce(new Error('审计服务暂不可用'));
    render(<FindingView {...props} id="finding-import" />, { wrapper: TestProviders });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '审计服务暂不可用重试');
    expect(screen.getByText('已经持久化的本地修改。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });
});

describe('channels are execution sources, not separate boards', () => {
  it('opens real Codex projects in the native App, including while a shared native turn is running', async () => {
    const state = snapshot();
    state.projects[0].isDemo = false;
    state.projects[0].runtime = 'codex';
    state.channels[0].status = 'running';
    state.channels[0].nextRunAt = '2026-09-08T12:00:00Z';
    state.runs = [
      {
        id: 'native-active',
        channelId: 'channel-system',
        runtime: 'codex',
        status: 'running',
        startedAt: timestamp,
        finishedAt: '',
        summary: '',
        sessionId: 'native-thread',
        executionOwner: 'codex-app',
      },
    ];
    const { props, api } = featureProps({ snapshot: state });
    render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    expect(screen.queryByRole('button', { name: '在原生 CLI 中继续' })).toBeNull();
    const button = screen.getByRole('button', { name: '在 Codex App 中继续此项目' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await userEvent.setup().click(button);
    expect(api.openNativeApp).toHaveBeenCalledWith('channel-system');
    expect(api.openNativeSession).not.toHaveBeenCalled();
    expect(api.channelAction).not.toHaveBeenCalled();
  });

  it('uses the App entry for projects without a stored default runtime and never falls back to another CLI once only retired channels remain', async () => {
    const state = snapshot();
    state.projects[0].isDemo = false;
    state.channels[1].runtime = 'claude';
    const { props, api } = featureProps({ snapshot: state });
    const view = render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    await userEvent.setup().click(screen.getByRole('button', { name: '在 Codex App 中继续此项目' }));
    expect(api.openNativeApp).toHaveBeenCalledWith('channel-system');
    const noCodex = {
      ...state,
      projects: state.projects.map((project) =>
        project.id === 'project-atlas' ? { ...project, runtime: 'codex' as const } : project
      ),
      channels: state.channels.filter((channel) => channel.id !== 'channel-system'),
    };
    view.rerender(<ProjectView {...props} snapshot={noCodex} id="project-atlas" />);
    const entry = screen.getByRole('button', { name: '在 Codex App 中继续此项目' }) as HTMLButtonElement;
    expect(entry.disabled).toBe(true);
    expect(entry.title).toContain('已停止支持');
    expect(screen.queryByRole('button', { name: '在原生 CLI 中继续' })).toBeNull();
    expect(api.openNativeSession).not.toHaveBeenCalled();
  });

  it('keeps channel activity and run history and navigates to the single project board', async () => {
    const { props } = featureProps();
    render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    expect(screen.getByRole('heading', { name: '工作日志' })).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('tab', { name: /发现|功能/ })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: '频道选项' }));
    await userEvent.setup().click(screen.getByRole('menuitem', { name: '项目功能看板' }));
    expect(props.onNavigate).toHaveBeenCalledWith({ kind: 'project', id: 'project-atlas' });
  });

  it('continues a project whose stored default runtime is retired through its Codex channel and counts the old ones', async () => {
    const state = snapshot();
    state.projects[0].isDemo = false;
    state.projects[0].runtime = 'claude';
    state.channels[1].runtime = 'claude';
    const { props, api } = featureProps({ snapshot: state });
    render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    expect(screen.queryByRole('button', { name: '在原生 CLI 中继续' })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: '在 Codex App 中继续此项目' }));
    expect(api.openNativeApp).toHaveBeenCalledWith('channel-system');
    expect(api.openNativeSession).not.toHaveBeenCalled();
    expect(within(screen.getByRole('complementary')).getByText('1 个旧频道，历史可读')).toBeTruthy();
  });

  it('never opens a native CLI for a retired-runtime channel, even when the rest of the project is idle', async () => {
    const state = snapshot();
    state.projects[0].isDemo = false;
    state.channels[0].runtime = 'claude';
    state.runs = [
      {
        id: 'old-run',
        channelId: 'channel-system',
        runtime: 'claude',
        status: 'completed',
        startedAt: timestamp,
        finishedAt: timestamp,
        summary: '旧运行时的历史轮次',
        sessionId: 'old-session',
      },
    ];
    const { props, api } = featureProps({ snapshot: state });
    render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    await userEvent.setup().click(screen.getByRole('button', { name: '频道选项' }));
    const handoff = screen.getByRole('menuitem', { name: '在 Codex App 中打开对话' });
    expect(handoff.getAttribute('aria-disabled')).toBe('true');
    await userEvent.setup().keyboard('{Escape}');
    expect(screen.getByRole('note').textContent).toContain('已停止支持');
    expect(screen.getByRole('article', { name: /轮次/ })).toBeTruthy();
    expect(api.openNativeSession).not.toHaveBeenCalled();
  });
});

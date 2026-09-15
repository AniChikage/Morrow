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

describe('project next step and secondary properties', () => {
  it('prioritizes the current question and exposes properties only on request', async () => {
    const { props, api } = featureProps();
    props.snapshot.channels[0].work = {
      state: 'needs_input',
      focus: '确认范围',
      runId: 'question-run',
      reason: '',
      nextStep: '是否继续？',
      awaitingReply: true,
      updatedAt: timestamp,
    };
    render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    expect(screen.queryByRole('complementary')).toBeNull();
    // The gate has to be known for 下一步, but nothing about 额度 is on screen until asked for.
    expect(api.getProjectUsage).toHaveBeenCalledWith('project-atlas');
    expect(screen.queryByRole('region', { name: '额度' })).toBeNull();
    const next = within(screen.getByRole('region', { name: '项目下一步' }));
    expect(next.getAllByRole('button')).toHaveLength(1);
    await userEvent.setup().click(next.getByRole('button', { name: '回答当前问题' }));
    expect(props.onNavigate).toHaveBeenCalledWith({ kind: 'channel', id: 'channel-system' });
    await userEvent.setup().click(screen.getByRole('button', { name: '项目属性' }));
    expect(screen.getByRole('complementary')).toBeTruthy();
    expect(await screen.findByRole('region', { name: '额度' })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('tab', { name: '全部记录' }));
    expect(screen.queryByRole('region', { name: '项目下一步' })).toBeNull();
    expect(screen.queryByRole('button', { name: '新建事项' })).toBeNull();
  });

  it('uses actual brief content before guiding the user to an existing App task', async () => {
    const { props, api } = featureProps();
    props.snapshot.projects[0].briefRevision = 3;
    api.getProjectBrief.mockResolvedValue({ goal: '目标', brief: '', briefRevision: 3 });
    const view = render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    await screen.findByRole('button', { name: '完善项目说明' });
    api.getProjectBrief.mockResolvedValue({ goal: '目标', brief: '真实说明', briefRevision: 4 });
    props.snapshot.projects[0].briefRevision = 4;
    view.rerender(<ProjectView {...props} id="project-atlas" />);
    await userEvent.setup().click(await screen.findByRole('button', { name: '关联已有任务' }));
    expect(props.onNavigate).toHaveBeenCalledWith({ kind: 'channel', id: 'channel-system' });
    props.snapshot.channels[0].sessionId = 'bound-app-task';
    view.rerender(<ProjectView {...props} id="project-atlas" />);
    await userEvent.setup().click(screen.getByRole('button', { name: '打开工作日志' }));
    expect(api.channelAction).not.toHaveBeenCalled();
  });

  it('does not carry an opened properties panel or a late brief response across projects', async () => {
    const { props, api } = featureProps();
    let finish!: (value: { goal: string; brief: string; briefRevision: number }) => void;
    api.getProjectBrief.mockImplementation((id) =>
      id === 'project-atlas'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({ goal: '其他目标', brief: '已有说明', briefRevision: 2 })
    );
    const view = render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    await userEvent.setup().click(screen.getByRole('button', { name: '项目属性' }));
    view.rerender(<ProjectView {...props} id="project-other" />);
    await screen.findByRole('button', { name: '关联已有任务' });
    finish({ goal: '迟到', brief: '', briefRevision: 0 });
    await waitFor(() => expect(screen.queryByRole('button', { name: '完善项目说明' })).toBeNull());
    expect(screen.queryByRole('complementary')).toBeNull();
  });
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
    expect(screen.getByRole('tab', { name: '看板 4' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /CSV 重试会重复提交/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /缩短激活路径/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /#7.*人工创建的功能/ })).toBeTruthy();
    expect(screen.queryByText('明确属于其他项目')).toBeNull();
    expect(screen.queryByRole('tab', { name: /持续频道/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: '筛选' }));
    await user.selectOptions(screen.getByRole('combobox', { name: '来源频道筛选' }), 'manual');
    expect(screen.getByRole('button', { name: /人工创建的功能/ })).toBeTruthy();
    expect(screen.queryByText('CSV 重试会重复提交')).toBeNull();
    await user.click(screen.getByRole('button', { name: '新建事项' }));
    expect(props.onNewFeature).toHaveBeenCalledWith('project-atlas');
  });

  it('filters by contributing channels while retaining the original source label', async () => {
    const user = userEvent.setup();
    const state = snapshot();
    state.items = [item({ projectId: 'project-atlas', sourceChannelIds: ['channel-system', 'channel-growth'] })];
    const { props } = featureProps({ snapshot: state });
    render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    await user.click(screen.getByRole('button', { name: '筛选' }));
    await user.selectOptions(screen.getByRole('combobox', { name: '来源频道筛选' }), 'channel-growth');
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
      '看板 3',
      '项目说明',
      '当前判断',
      '全部记录',
      '上线确认 ',
    ]);
    expect(screen.getByRole('tab', { name: '项目说明' }).getAttribute('aria-selected')).toBe('false');
    await user.click(screen.getByRole('button', { name: '项目属性' }));
    await user.click(within(screen.getByRole('complementary')).getByRole('button', { name: /改善可靠性与激活体验/ }));
    expect(screen.getByRole('tab', { name: '项目说明' }).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByRole('heading', { level: 2, name: '目标与成功标准' })).toBeTruthy();
    expect(screen.getByText('提升到 40%').tagName).toBe('STRONG');
    expect(screen.getByText('不得改动计费。').closest('details')).toBeNull();
    const help = screen.getByText('编写帮助', { selector: 'summary' });
    expect(help.closest('details')?.open).toBe(false);
    await user.click(help);
    expect(help.closest('details')?.open).toBe(true);
    expect(api.updateProject).not.toHaveBeenCalled();
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
      // The project summary and the document each read the same initial version.
      .mockResolvedValueOnce({ goal: '改善可靠性与激活体验。', brief: '旧说明', briefRevision: 1 })
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
    expect(alert.closest('details')).toBeNull();
    await user.click(screen.getByRole('button', { name: '载入最新版本' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('textbox', { name: /^项目说明/ }) as HTMLTextAreaElement).value).toBe('别人写的新说明');
    await user.type(screen.getByRole('textbox', { name: /^项目说明/ }), '。');
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false);
    expect(api.updateProject).toHaveBeenCalledTimes(1);
  });

  it('keeps typing focus and draft when a polled brief revision introduces a conflict', async () => {
    const user = userEvent.setup();
    const state = snapshot();
    state.projects[0].isDemo = false;
    state.projects[0].briefRevision = 1;
    const { props, api } = featureProps({ snapshot: state });
    api.getProjectBrief.mockResolvedValue({ goal: '原目标', brief: '旧说明', briefRevision: 1 });
    const view = render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    await user.click(screen.getByRole('tab', { name: '项目说明' }));
    await user.click(await screen.findByRole('button', { name: '编辑' }));
    const brief = screen.getByRole('textbox', { name: /^项目说明/ }) as HTMLTextAreaElement;
    await user.type(brief, '，本地草稿');
    api.getProjectBrief.mockResolvedValue({ goal: '原目标', brief: '别人已保存', briefRevision: 2 });
    const updated = { ...state, projects: state.projects.map((project) => ({ ...project, briefRevision: 2 })) };
    view.rerender(<ProjectView {...props} snapshot={updated} id="project-atlas" />);
    expect((await screen.findByRole('alert')).textContent).toContain('版本 2');
    expect(document.activeElement).toBe(brief);
    await user.keyboard('，继续输入');
    expect(brief.value).toBe('旧说明，本地草稿，继续输入');
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.updateProject).not.toHaveBeenCalled();
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
    const help = screen.getByText('编写帮助', { selector: 'summary' });
    expect(help.closest('details')?.open).toBe(false);
    await user.click(help);
    await user.click(help);
    expect((screen.getByRole('textbox', { name: /^项目说明/ }) as HTMLTextAreaElement).value).toBe('');
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
    await user.click(screen.getByRole('button', { name: '事项属性' }));
    const properties = within(screen.getByRole('complementary'));
    expect(properties.getByText('手动创建')).toBeTruthy();
    expect(properties.getByRole('button', { name: /Atlas 示例项目/ })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '编辑事项' }));
    expect(props.onEditFeature).toHaveBeenCalledWith(manual);
    await user.click(properties.getByRole('button', { name: '待处理' }));
    await user.click(screen.getByRole('menuitem', { name: '已验证' }));
    await waitFor(() => expect(api.patchItem).toHaveBeenCalledWith('manual', { status: 'verified', revision: 3 }));
    expect(api.getEvents).toHaveBeenCalledWith({ projectId: 'project-atlas', itemId: 'manual', limit: 50 });
    await user.click(screen.getByText('变更记录'));
    await screen.findByText('修改了功能标题。');
    await user.click(screen.getByText('查看变更'));
    expect(screen.getByText('旧标题')).toBeTruthy();
    expect(screen.getByText('查看变更').parentElement?.hasAttribute('open')).toBe(true);
  });

  it('names the channel responsible for a feature on the board and lets a person assign or release it', async () => {
    const user = userEvent.setup();
    const state = snapshot();
    state.items = [item({ projectId: 'project-atlas', ownerChannelId: 'channel-growth' })];
    const { props, api } = featureProps({ snapshot: state });
    const board = render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    // Both board layouts show the responsible channel as one small chip.
    expect(screen.getAllByTitle('负责频道：运营洞察')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: '切换为列表' }));
    expect(screen.getAllByTitle('负责频道：运营洞察')).toHaveLength(1);
    board.unmount();
    render(<FindingView {...props} id="finding-import" />, { wrapper: TestProviders });
    expect(screen.getByTitle('负责频道：运营洞察')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: '分派给频道' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '事项属性' }));
    const select = screen.getByRole('combobox', { name: '分派给频道' }) as HTMLSelectElement;
    expect(select.value).toBe('channel-growth');
    expect([...select.options].map((option) => option.textContent)).toEqual(['无人负责', '系统完善', '运营洞察']);
    await user.selectOptions(select, 'channel-system');
    await waitFor(() =>
      expect(api.patchItem).toHaveBeenCalledWith('finding-import', { ownerChannelId: 'channel-system' })
    );
    await user.selectOptions(select, '');
    await waitFor(() => expect(api.patchItem).toHaveBeenCalledWith('finding-import', { ownerChannelId: null }));
  });

  it('leaves an unowned feature without a chip and keeps a removed owner readable', async () => {
    const state = snapshot();
    state.items = [item({ projectId: 'project-atlas' })];
    const { props } = featureProps({ snapshot: state });
    const view = render(<FindingView {...props} id="finding-import" />, { wrapper: TestProviders });
    expect(screen.queryByTitle(/负责频道/)).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: '事项属性' }));
    expect((screen.getByRole('combobox', { name: '分派给频道' }) as HTMLSelectElement).value).toBe('');
    props.snapshot.items[0].ownerChannelId = 'channel-removed';
    view.rerender(<FindingView {...props} id="finding-import" />);
    expect(screen.getByTitle('负责频道：已移除的频道')).toBeTruthy();
    const select = screen.getByRole('combobox', { name: '分派给频道' }) as HTMLSelectElement;
    expect(select.value).toBe('channel-removed');
    expect(select.selectedOptions[0].textContent).toBe('已移除的频道');
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
    await userEvent.setup().click(screen.getByText('变更记录'));
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
    await userEvent.setup().click(screen.getByRole('button', { name: '项目属性' }));
    const button = screen.getByRole('button', { name: '在 Codex App 中继续此项目' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await userEvent.setup().click(button);
    expect(api.openNativeApp).toHaveBeenCalledWith('channel-system');
    expect(api.channelAction).not.toHaveBeenCalled();
  });

  it('uses the App entry for projects without a stored default runtime and never falls back to another CLI once only retired channels remain', async () => {
    const state = snapshot();
    state.projects[0].isDemo = false;
    state.channels[1].runtime = 'claude';
    const { props, api } = featureProps({ snapshot: state });
    const view = render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    await userEvent.setup().click(screen.getByRole('button', { name: '项目属性' }));
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
  });

  it('keeps channel activity and run history and navigates to the single project board', async () => {
    const { props } = featureProps();
    render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    expect(screen.getByRole('heading', { name: '工作日志' })).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('tab', { name: /发现|功能/ })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: '频道选项' }));
    await userEvent.setup().click(screen.getByRole('menuitem', { name: '项目看板' }));
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
    await userEvent.setup().click(screen.getByRole('button', { name: '项目属性' }));
    await userEvent.setup().click(screen.getByRole('button', { name: '在 Codex App 中继续此项目' }));
    expect(api.openNativeApp).toHaveBeenCalledWith('channel-system');
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
  });
});

for (const layout of ['list', 'board']) {
  it(`keeps resolved history accessible and search results visible in ${layout} view`, async () => {
    localStorage.setItem('morrow.project-view.project-atlas', JSON.stringify({ layout }));
    const user = userEvent.setup();
    const { props } = featureProps();
    const done = item({
      id: 'done',
      projectId: 'project-atlas',
      title: '已完成的恢复任务',
      status: 'resolved',
      evidence: ['历史唯一关键词'],
    });
    props.snapshot.items.push(done);
    const original = JSON.stringify(props.snapshot.items);
    render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    expect(screen.queryByText(done.title)).toBeNull();
    expect(screen.queryByRole('textbox', { name: '搜索事项和证据' })).toBeNull();
    const history = screen.getByRole('button', { name: '已解决历史 1' });
    expect(history.getAttribute('aria-expanded')).toBe('false');
    await user.click(history);
    await user.click(screen.getByRole('button', { name: new RegExp(done.title) }));
    expect(props.onNavigate).toHaveBeenCalledWith({ kind: 'finding', id: 'done' });
    await user.click(history);
    await user.click(screen.getByRole('button', { name: '筛选' }));
    const search = screen.getByRole('textbox', { name: '搜索事项和证据' });
    await user.type(search, '历史唯一关键词');
    expect(screen.getByRole('button', { name: new RegExp(done.title) })).toBeTruthy();
    expect(screen.queryByRole('region', { name: '已解决历史' })).toBeNull();
    await user.clear(search);
    await user.type(search, '   ');
    expect(screen.queryByText(done.title)).toBeNull();
    await user.clear(search);
    await user.selectOptions(screen.getByRole('combobox', { name: '状态筛选' }), 'resolved');
    expect(screen.getByRole('button', { name: new RegExp(done.title) })).toBeTruthy();
    expect(JSON.stringify(props.snapshot.items)).toBe(original);
  });
}

it('handles all-resolved boards, live status changes and project-local disclosure', async () => {
  const { props } = featureProps();
  props.snapshot.items = props.snapshot.items.map((item) => ({ ...item, status: 'resolved' }));
  const view = render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
  expect(screen.getByText('当前没有未解决事项，历史记录保留在下方。')).toBeTruthy();
  expect(screen.queryByText('还没有项目功能')).toBeNull();
  await userEvent.setup().click(screen.getByRole('button', { name: '已解决历史 3' }));
  expect(screen.getAllByRole('button', { name: /CSV 重试会重复提交/ })).toHaveLength(1);
  props.snapshot.items[0].status = 'investigating';
  view.rerender(<ProjectView {...props} id="project-atlas" />);
  expect(screen.getAllByRole('button', { name: /CSV 重试会重复提交/ })).toHaveLength(1);
  expect(screen.getByRole('button', { name: '已解决历史 2' })).toBeTruthy();
  view.rerender(<ProjectView {...props} id="project-other" />);
  expect(screen.getByRole('button', { name: '已解决历史 1' }).getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByText('其他项目的发现')).toBeNull();
  expect(screen.queryByText('CSV 重试会重复提交')).toBeNull();
});

it('shows unavailable saved filters explicitly and offers one clear action', async () => {
  localStorage.setItem(
    'morrow.project-view.project-atlas',
    JSON.stringify({ layout: 'list', status: 'retired-state', channel: 'deleted-channel' })
  );
  const { props } = featureProps();
  render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
  expect(screen.getByText('没有符合条件的事项')).toBeTruthy();
  await userEvent.setup().click(screen.getByRole('button', { name: '已筛选' }));
  expect((screen.getByRole('combobox', { name: '状态筛选' }) as HTMLSelectElement).selectedOptions[0].textContent).toBe(
    '原状态筛选已不可用'
  );
  expect(
    (screen.getByRole('combobox', { name: '来源频道筛选' }) as HTMLSelectElement).selectedOptions[0].textContent
  ).toBe('原频道筛选已不可用');
  expect(screen.getAllByRole('button', { name: '清除筛选' })).toHaveLength(1);
  await userEvent.setup().click(screen.getByRole('button', { name: '清除筛选' }));
  expect(screen.getByRole('button', { name: /CSV 重试会重复提交/ })).toBeTruthy();
  expect(screen.queryByText('没有符合条件的事项')).toBeNull();
});

const gatedUsage = {
  stale: false,
  attempted: true,
  reading: { at: timestamp, source: 'protocol' as const, windows: [{ name: '5h' as const, usedPercent: 96 }] },
  budget: { window: '5h' as const, limitPercent: 40 },
  project: { usedPercent: 41, runs: 3, windowStart: timestamp },
  gate: {
    blocked: true as const,
    kind: 'budget' as const,
    window: '5h' as const,
    resetsAt: '2026-09-07T06:00:00.000Z',
    until: '2026-09-07T06:00:00.000Z',
    message: '本项目归因的5 小时额度估算已达上限 40%（已用 41%，估算），等待 09-07 06:00 重置',
  },
};

it('makes a usage gate the project action, with the reason, instead of hiding it in 项目属性', async () => {
  const user = userEvent.setup();
  const state = snapshot();
  state.channels[0].work = {
    state: 'needs_input',
    focus: '确认范围',
    runId: 'question-run',
    reason: '',
    nextStep: '是否继续？',
    awaitingReply: true,
    updatedAt: timestamp,
  };
  const { props, api } = featureProps({ snapshot: state });
  api.getProjectUsage.mockResolvedValue(gatedUsage);
  render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
  const next = within(screen.getByRole('region', { name: '项目下一步' }));
  // Nothing can run while the gate holds, so it outranks the waiting question.
  await waitFor(() => expect(next.getByText(gatedUsage.gate.message)).toBeTruthy());
  await user.click(next.getByRole('button', { name: '查看额度设置' }));
  expect(within(screen.getByRole('complementary')).getByRole('region', { name: '额度' })).toBeTruthy();
  cleanup();
  // A gate that only means "the reading is on its way" is not a stop worth an action.
  api.getProjectUsage.mockResolvedValue({ ...gatedUsage, gate: { ...gatedUsage.gate, pending: true } });
  render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
  expect(await screen.findByRole('button', { name: '回答当前问题' })).toBeTruthy();
  expect(screen.queryByText(gatedUsage.gate.message)).toBeNull();
});

it('counts the board tab by what the board shows, keeping resolved history in its own count', async () => {
  const user = userEvent.setup();
  const state = snapshot();
  state.items.push(item({ id: 'finding-done', title: '已完成的功能', status: 'resolved' }));
  const { props } = featureProps({ snapshot: state });
  render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
  expect(screen.getByRole('tab', { name: '看板 3' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '已解决历史 1' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '筛选' }));
  await user.selectOptions(screen.getByRole('combobox', { name: '状态筛选' }), 'resolved');
  expect(screen.getByRole('tab', { name: '看板 1' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /已解决历史/ })).toBeNull();
});

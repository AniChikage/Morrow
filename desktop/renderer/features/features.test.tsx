// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectView } from './ProjectView';
import { FindingView } from './FindingView';
import { ChannelView } from './ChannelView';
import { ChannelAudit } from './ChannelAudit';
import { ProjectRecords } from './ProjectRecords';
import { event, featureProps, item, snapshot, TestProviders } from './testFixtures';
import type { EventsPage } from '../../shared/types';

beforeEach(() => {
  localStorage.clear();
  // Radix pointer interactions use these browser APIs; jsdom does not implement them.
  if (!HTMLElement.prototype.hasPointerCapture) HTMLElement.prototype.hasPointerCapture = () => false;
  if (!HTMLElement.prototype.setPointerCapture) HTMLElement.prototype.setPointerCapture = () => {};
  if (!HTMLElement.prototype.releasePointerCapture) HTMLElement.prototype.releasePointerCapture = () => {};
  if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('project discovery workflow', () => {
  it('searches evidence within the selected project, combines status and channel filters, and opens the complete finding route', async () => {
    const user = userEvent.setup();
    const { props } = featureProps();
    render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    expect(screen.queryByText('其他项目的发现')).toBeNull();
    await user.click(screen.getByRole('button', { name: '筛选' }));
    const search = screen.getByRole('textbox', { name: '搜索功能和证据' });
    await user.type(search, '唯一证据关键词');
    expect(screen.getByRole('button', { name: /CSV 重试会重复提交/ })).toBeTruthy();
    expect(screen.queryByText('缩短激活路径')).toBeNull();
    await user.clear(search);
    await user.selectOptions(screen.getByRole('combobox', { name: '状态筛选' }), 'verified');
    expect(screen.getByRole('button', { name: /输入焦点已恢复/ })).toBeTruthy();
    expect(screen.queryByText('CSV 重试会重复提交')).toBeNull();
    await user.selectOptions(screen.getByRole('combobox', { name: '状态筛选' }), 'all');
    await user.selectOptions(screen.getByRole('combobox', { name: '来源频道筛选' }), 'channel-growth');
    expect(screen.queryByText('输入焦点已恢复')).toBeNull();
    await user.click(screen.getByRole('button', { name: /缩短激活路径/ }));
    expect(props.onNavigate).toHaveBeenCalledWith({ kind: 'finding', id: 'finding-growth' });
  });

  it('remembers list mode for one project without changing another project', async () => {
    const user = userEvent.setup();
    const { props } = featureProps();
    const first = render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    await user.click(screen.getByRole('button', { name: '切换为列表' }));
    expect(screen.getByRole('button', { name: /待处理/ })).toBeTruthy();
    first.unmount();
    const second = render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    expect(screen.getByRole('button', { name: '切换为看板' })).toBeTruthy();
    second.rerender(<ProjectView {...props} id="project-other" />);
    await waitFor(() => expect(screen.getByRole('button', { name: '切换为列表' })).toBeTruthy());
    expect(screen.getByRole('button', { name: /其他项目的发现/ })).toBeTruthy();
  });
});

describe('full finding view', () => {
  it('keeps the summary, Markdown, evidence and next step in the main document, with a real status mutation in properties', async () => {
    const user = userEvent.setup();
    const { props, api } = featureProps();
    render(<FindingView {...props} id="finding-import" />, { wrapper: TestProviders });
    const main = within(screen.getByRole('main'));
    expect(main.getByRole('heading', { level: 1, name: 'CSV 重试会重复提交' })).toBeTruthy();
    expect(main.getByRole('heading', { name: '复现观察' })).toBeTruthy();
    expect(main.getByText('两条重复记录').tagName).toBe('STRONG');
    await user.click(main.getByText('证据', { selector: 'summary' }));
    expect(main.getByText('日志包含唯一证据关键词：request-17。')).toBeTruthy();
    expect(main.getByRole('link', { name: '官方错误码' }).getAttribute('href')).toBe(
      'https://example.com/import/errors'
    );
    expect(main.getByText('验证幂等键，并补充失败后的恢复测试。')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '事项属性' }));
    const properties = within(screen.getByRole('complementary'));
    expect(properties.queryByText('日志包含唯一证据关键词：request-17。')).toBeNull();
    await user.click(properties.getByRole('button', { name: '待处理' }));
    await user.click(screen.getByRole('menuitem', { name: '已验证' }));
    await waitFor(() => expect(api.patchItem).toHaveBeenCalledWith('finding-import', { status: 'verified' }));
    expect(props.onMutate).toHaveBeenCalledTimes(1);
  });

  it('does not create remote image requests or executable HTML from finding content', async () => {
    const state = snapshot();
    state.items = [
      item({
        summary:
          '![外部图片](https://tracking.invalid/pixel.png)\n\n<script>window.compromised = true</script>\n\n正常发现正文',
      }),
    ];
    const { props } = featureProps({ snapshot: state });
    const { container } = render(<FindingView {...props} id="finding-import" />, { wrapper: TestProviders });
    expect(screen.getByText('正常发现正文')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    await screen.findByText('还没有关联记录');
  });
});

describe('channel control and history', () => {
  it('keeps demo channels read-only without a second conversation composer', async () => {
    const { props, api } = featureProps();
    render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    expect(screen.getByRole('heading', { name: '工作日志' })).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: '频道选项' }));
    expect(screen.getByRole('menuitem', { name: '在 Codex App 中打开对话' }).getAttribute('aria-disabled')).toBe(
      'true'
    );
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.channelAction).not.toHaveBeenCalled();
  });

  it('keeps a retired-runtime channel readable: notice shown, run and resume disabled, pause still dispatched', async () => {
    const user = userEvent.setup();
    const state = snapshot();
    state.projects[0].isDemo = false;
    state.channels[0].runtime = 'claude';
    state.channels[0].status = 'idle';
    state.channels[0].nextRunAt = '2026-09-08T12:00:00Z';
    const { props, api } = featureProps({ snapshot: state });
    api.getEvents.mockResolvedValueOnce({ events: [event('legacy-history', '旧运行时留下的记录')], hasMore: false });
    const view = render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    await user.click(screen.getByText('频道审计记录'));
    await screen.findByText('旧运行时留下的记录');
    expect(screen.getByRole('note').textContent).toContain('已停止支持');
    expect(screen.getAllByText('Claude Code（已停止支持）').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: '频道选项' }));
    expect(screen.getByRole('menuitem', { name: '在 Codex App 中打开对话' }).getAttribute('aria-disabled')).toBe(
      'true'
    );
    expect(screen.queryByRole('textbox', { name: '向频道补充上下文' })).toBeNull();
    await user.click(screen.getByRole('menuitem', { name: '暂停' }));
    expect(api.channelAction).toHaveBeenLastCalledWith('channel-system', 'pause');
    const pausedState = {
      ...state,
      channels: state.channels.map((channel) =>
        channel.id === 'channel-system' ? { ...channel, status: 'paused', nextRunAt: '' } : channel
      ),
    };
    view.rerender(<ChannelView {...props} snapshot={pausedState} id="channel-system" />);
    await user.click(screen.getByRole('button', { name: '频道选项' }));
    expect(screen.getByRole('menuitem', { name: '继续工作' }).getAttribute('aria-disabled')).toBe('true');
    await user.keyboard('{Escape}');
    expect(screen.getByText('旧运行时留下的记录')).toBeTruthy();
    expect(api.channelAction).toHaveBeenCalledTimes(1);
    expect(api.openNativeSession).not.toHaveBeenCalled();
  });

  it('during a version handover a paused channel cannot be resumed, while pausing a running one still works', async () => {
    const user = userEvent.setup();
    const state = snapshot();
    state.projects[0].isDemo = false;
    state.channels[0].status = 'paused';
    state.upgrade = {
      identity: {
        bootId: 'boot-1',
        commit: 'd'.repeat(40),
        version: '0.9.7',
        fingerprint: 'a'.repeat(64),
        bundlePath: '/Users/someone/Applications/Morrow.app',
        dataDirectory: '/Users/someone/Library/Application Support/Morrow',
      },
      exitCode: 75,
      reminderMs: 600000,
      idle: true,
      blockers: [],
      upgrade: {
        id: 'b'.repeat(64),
        releaseId: 'release-1',
        targetCommit: 'c'.repeat(40),
        targetFingerprint: 'b'.repeat(64),
        installedBundle: '/Users/someone/Applications/Morrow.app',
        fromBootId: 'boot-1',
        phase: 'exiting',
        requestedAt: '2026-09-11T00:00:00.000Z',
        updatedAt: '2026-09-11T00:00:00.000Z',
      },
    };
    const { props, api } = featureProps({ snapshot: state });
    const view = render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    await user.click(screen.getByRole('button', { name: '频道选项' }));
    expect(screen.getByRole('menuitem', { name: '继续工作' }).getAttribute('aria-disabled')).toBe('true');
    await user.keyboard('{Escape}');
    // A running channel can still be paused during the handover; only starting work is blocked.
    const runningState = {
      ...state,
      channels: state.channels.map((channel) =>
        channel.id === 'channel-system' ? { ...channel, status: 'running' } : channel
      ),
    };
    view.rerender(<ChannelView {...props} snapshot={runningState} id="channel-system" />);
    await user.click(screen.getByRole('button', { name: '频道选项' }));
    await user.click(screen.getByRole('menuitem', { name: '暂停' }));
    expect(api.channelAction).toHaveBeenLastCalledWith('channel-system', 'pause');
  });

  it('uses an event ID cursor, merges older pages without duplicates, and orders equal timestamps by sequence', async () => {
    const state = snapshot();
    state.events = [event('event-four', '第四条记录', 4), event('event-three', '第三条记录', 3)];
    const { props, api } = featureProps({ snapshot: state });
    vi.mocked(props.api.getEvents).mockResolvedValueOnce({
      events: state.events,
      hasMore: true,
      cursor: 'event-three',
    });
    api.getEvents.mockResolvedValueOnce({
      events: [
        event('event-two', '第二条记录', 2),
        event('event-one', '第一条记录', 1),
        event('event-three', '过期的第三条记录', 3),
      ],
      hasMore: false,
    });
    render(<ChannelAudit {...props} id="channel-system" />, { wrapper: TestProviders });
    await userEvent.setup().click(await screen.findByRole('button', { name: '加载更早记录' }));
    await screen.findByText('第一条记录');
    expect(api.getEvents).toHaveBeenNthCalledWith(1, { channelId: 'channel-system', limit: 60 });
    expect(api.getEvents).toHaveBeenCalledWith({ channelId: 'channel-system', before: 'event-three', limit: 60 });
    const renderedMessages = screen.getAllByRole('article').map((article) => article.textContent || '');
    expect(
      renderedMessages.map((text) =>
        ['第一条记录', '第二条记录', '第三条记录', '第四条记录'].find((value) => text.includes(value))
      )
    ).toEqual(['第一条记录', '第二条记录', '第三条记录', '第四条记录']);
    expect(screen.queryByText('过期的第三条记录')).toBeNull();
    expect(screen.getAllByText('第三条记录')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: '加载更早记录' })).toBeNull();
  });

  it('keeps current events visible when older-history loading fails', async () => {
    const state = snapshot();
    state.events = [event('current-event', '已经存在的运行结果')];
    const { props, api } = featureProps({ snapshot: state });
    vi.mocked(props.api.getEvents).mockResolvedValueOnce({
      events: state.events,
      hasMore: true,
      cursor: 'current-event',
    });
    api.getEvents
      .mockRejectedValueOnce(new Error('远程历史接口暂不可用'))
      .mockResolvedValueOnce({ events: [event('recovered-old', '重试恢复的历史记录')], hasMore: false });
    render(<ChannelAudit {...props} id="channel-system" />, { wrapper: TestProviders });
    await userEvent.setup().click(await screen.findByRole('button', { name: '加载更早记录' }));
    expect((await screen.findByRole('alert')).textContent).toContain('远程历史接口暂不可用');
    expect(screen.getByText('已经存在的运行结果')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('重试恢复的历史记录');
    expect(api.getEvents).toHaveBeenLastCalledWith({ channelId: 'channel-system', before: 'current-event', limit: 60 });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not leak an in-flight history page into another channel and leaves that channel usable', async () => {
    const state = snapshot();
    state.events = [
      event('system-current', '系统频道当前记录'),
      event('growth-current', '运营频道当前记录', 1, { channelId: 'channel-growth' }),
    ];
    const { props, api } = featureProps({ snapshot: state });
    let resolvePage!: (page: EventsPage) => void;
    api.getEvents.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePage = resolve;
        })
    );
    vi.mocked(props.api.getEvents).mockResolvedValueOnce({
      events: [event('growth-current', '运营频道当前记录', 1, { channelId: 'channel-growth' })],
      hasMore: true,
      cursor: 'growth-current',
    });
    const view = render(<ChannelAudit {...props} id="channel-system" />, { wrapper: TestProviders });
    view.rerender(<ChannelAudit {...props} id="channel-growth" />);
    await act(async () => resolvePage({ events: [event('old-system', '迟到的系统频道记录')], hasMore: false }));
    expect(screen.getByText('运营频道当前记录')).toBeTruthy();
    expect(screen.queryByText('迟到的系统频道记录')).toBeNull();
    expect((screen.getByRole('button', { name: '加载更早记录' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('loads persisted channel events on entry when that channel has no events in the snapshot', async () => {
    const state = snapshot();
    state.events = [event('unrelated', '其他频道的近期记录', 1, { channelId: 'channel-growth' })];
    const { props, api } = featureProps({ snapshot: state });
    api.getEvents.mockResolvedValueOnce({ events: [event('archived-event', '快照范围外的频道历史')], hasMore: false });
    render(<ChannelAudit {...props} id="channel-system" />, { wrapper: TestProviders });
    expect(await screen.findByText('快照范围外的频道历史')).toBeTruthy();
    expect(api.getEvents).toHaveBeenCalledWith({ channelId: 'channel-system', limit: 60 });
    expect(screen.queryByText('频道还没有动态')).toBeNull();
    expect(screen.queryByText('其他频道的近期记录')).toBeNull();
  });

  it('offers a retry after the first history request fails even with an empty snapshot', async () => {
    const { props, api } = featureProps();
    api.getEvents
      .mockRejectedValueOnce(new Error('持久化历史读取失败'))
      .mockResolvedValueOnce({ events: [event('recovered', '恢复读取的历史')], hasMore: false });
    render(<ChannelAudit {...props} id="channel-system" />, { wrapper: TestProviders });
    expect((await screen.findByRole('alert')).textContent).toContain('持久化历史读取失败');
    expect(screen.queryByText('频道还没有动态')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('恢复读取的历史')).toBeTruthy();
    expect(api.getEvents).toHaveBeenNthCalledWith(2, { channelId: 'channel-system', limit: 60 });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('rejects a previous generation even after switching away and back to the same channel', async () => {
    const { props, api } = featureProps();
    let resolveFirst!: (page: EventsPage) => void;
    api.getEvents
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce({ events: [], hasMore: false })
      .mockResolvedValueOnce({ events: [event('fresh-generation', '重新进入后的最新记录')], hasMore: false });
    const view = render(<ChannelAudit {...props} id="channel-system" />, { wrapper: TestProviders });
    view.rerender(<ChannelAudit {...props} id="channel-growth" />);
    view.rerender(<ChannelAudit {...props} id="channel-system" />);
    await screen.findByText('重新进入后的最新记录');
    await act(async () =>
      resolveFirst({ events: [event('stale-generation', '上一代迟到记录')], hasMore: true, cursor: 'stale-generation' })
    );
    expect(screen.queryByText('上一代迟到记录')).toBeNull();
    expect(screen.getByText('重新进入后的最新记录')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '加载更早记录' })).toBeNull();
  });
});

describe('database history controls the loaded range', () => {
  it.each(['channel', 'project'] as const)(
    '%s history only overlays loaded IDs and new live records, so older pages make visible progress',
    async (scope) => {
      const state = snapshot();
      const pageSize = scope === 'channel' ? 60 : 50;
      // All records deliberately have identical timestamps: IDs, not timestamps, define the boundary.
      state.events = Array.from({ length: 125 }, (_, index) =>
        event(`history-${index}`, `记录内容 ${index}`, 1, { projectId: 'project-atlas' })
      );
      const firstPage = state.events.slice(-pageSize);
      const nextPage = state.events.slice(-pageSize * 2, -pageSize);
      const { props } = featureProps({ snapshot: state });
      vi.mocked(props.api.getEvents)
        .mockResolvedValueOnce({ events: firstPage, hasMore: true, cursor: firstPage[0].id })
        .mockResolvedValueOnce({ events: nextPage, hasMore: true, cursor: nextPage[0].id });
      const draw = (nextSnapshot = state) =>
        scope === 'channel' ? (
          <ChannelAudit {...props} snapshot={nextSnapshot} id="channel-system" />
        ) : (
          <ProjectRecords {...props} snapshot={nextSnapshot} projectId="project-atlas" />
        );
      const view = render(draw(), { wrapper: TestProviders });
      await screen.findByRole('button', { name: '加载更早记录' });
      expect(screen.getAllByRole('article')).toHaveLength(pageSize);
      expect(screen.queryByText('记录内容 0')).toBeNull();
      expect(screen.queryByText(nextPage[0].text)).toBeNull();
      const updated = {
        ...state,
        events: state.events.map((record) =>
          record.id === firstPage[0].id ? { ...record, text: '已加载记录的实时更新' } : record
        ),
      };
      updated.events.push(event('live-new-id', '同时间戳的实时新增记录', 1, { projectId: 'project-atlas' }));
      view.rerender(draw(updated));
      expect(screen.getByText('已加载记录的实时更新')).toBeTruthy();
      expect(screen.getByText('同时间戳的实时新增记录')).toBeTruthy();
      expect(screen.getAllByRole('article')).toHaveLength(pageSize + 1);
      expect(screen.queryByText('记录内容 0')).toBeNull();
      await userEvent.setup().click(screen.getByRole('button', { name: '加载更早记录' }));
      await screen.findByText(nextPage[0].text);
      expect(screen.getAllByRole('article')).toHaveLength(pageSize * 2 + 1);
      expect(props.api.getEvents).toHaveBeenLastCalledWith({
        ...(scope === 'channel' ? { channelId: 'channel-system' } : { projectId: 'project-atlas' }),
        before: firstPage[0].id,
        limit: pageSize,
      });
      expect(screen.queryByText('记录内容 0')).toBeNull();
      expect(screen.getByText('已加载记录的实时更新')).toBeTruthy();
    }
  );

  it.each(['channel', 'project'] as const)(
    '%s history retains snapshot fallback after first-page failure, then adopts the successful page on retry',
    async (scope) => {
      const state = snapshot();
      const old = event('fallback-old', '首屏失败时保留的旧记录', 1, { projectId: 'project-atlas' });
      const recent = event('fallback-recent', '数据库首屏记录', 2, { projectId: 'project-atlas' });
      state.events = [old, recent];
      const { props, api } = featureProps({ snapshot: state });
      api.getEvents
        .mockRejectedValueOnce(new Error('数据库暂不可用'))
        .mockResolvedValueOnce({ events: [recent], hasMore: true });
      render(
        scope === 'channel' ? (
          <ChannelAudit {...props} id="channel-system" />
        ) : (
          <ProjectRecords {...props} projectId="project-atlas" />
        ),
        { wrapper: TestProviders }
      );
      await screen.findByRole('alert');
      expect(screen.getByText(old.text)).toBeTruthy();
      expect(screen.getByText(recent.text)).toBeTruthy();
      await userEvent.setup().click(screen.getByRole('button', { name: '重试' }));
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
      expect(screen.queryByText(old.text)).toBeNull();
      expect(screen.getByText(recent.text)).toBeTruthy();
      expect(screen.getByRole('button', { name: '加载更早记录' })).toBeTruthy();
    }
  );
});

it('places next steps before long detail and resets disclosures when switching items', async () => {
  const { props } = featureProps();
  props.snapshot.items[0].summary = '原始说明段落。'.repeat(50) + '\n\n## 完整内容尾部\n\n不可丢失的尾部';
  const original = JSON.stringify(props.snapshot.items);
  const view = render(<FindingView {...props} id="finding-import" />, { wrapper: TestProviders });
  expect(screen.queryByRole('complementary')).toBeNull();
  const next = screen.getByRole('heading', { name: '下一步' });
  const description = screen.getByRole('heading', { name: '功能说明' });
  expect(next.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const full = screen.getByText('完整说明').closest('details')!;
  const evidence = screen.getByText('证据', { selector: 'summary' }).closest('details')!;
  expect(full.open).toBe(false);
  expect(evidence.open).toBe(false);
  await userEvent.setup().click(screen.getByText('完整说明'));
  expect(screen.getByText('不可丢失的尾部')).toBeTruthy();
  await userEvent.setup().click(screen.getByText('证据', { selector: 'summary' }));
  await userEvent.setup().click(screen.getByRole('button', { name: '打开工作日志' }));
  expect(props.onNavigate).toHaveBeenCalledWith({ kind: 'channel', id: 'channel-system' });
  await userEvent.setup().click(screen.getByRole('button', { name: '事项属性' }));
  view.rerender(<FindingView {...props} id="finding-growth" />);
  expect(screen.queryByRole('complementary')).toBeNull();
  expect(screen.getByText('证据', { selector: 'summary' }).closest('details')!.open).toBe(false);
  expect(screen.getByText('变更记录').closest('details')!.open).toBe(false);
  expect(JSON.stringify(props.snapshot.items)).toBe(original);
});

describe('project audit density', () => {
  it('keeps full long records and failed tool output behind summaries only in the project view', async () => {
    const state = snapshot();
    const text = '审计原文'.repeat(80) + '审计尾部';
    const message = '原始回复'.repeat(80) + '回复尾部';
    const failure = '错误解释'.repeat(80) + '错误尾部';
    state.events = [
      event('action', text, 1, {
        projectId: 'project-atlas',
        action: 'item.updated',
        itemId: 'finding-import',
        changes: { before: { status: 'open' }, after: { status: 'investigating' } },
      }),
      event('reply', message, 2, { projectId: 'project-atlas' }),
      event('error', failure, 3, { projectId: 'project-atlas', kind: 'error' }),
      event('tool', 'raw tool', 4, {
        projectId: 'project-atlas',
        kind: 'tool',
        detail: { type: 'tool', tool: 'test command', status: 'failed', output: '失败输出尾部' },
      }),
    ];
    const original = structuredClone(state.events);
    const { props, api } = featureProps({ snapshot: state });
    api.getEvents.mockResolvedValue({ events: state.events, hasMore: false });
    const view = render(<ProjectRecords {...props} projectId="project-atlas" />, { wrapper: TestProviders });
    await waitFor(() => expect(screen.queryByText('正在读取记录…')).toBeNull());
    for (const value of [text, message, failure]) expect(screen.getByText(value).closest('details')?.open).toBe(false);
    const user = userEvent.setup();
    for (const summary of screen.getAllByText('完整记录', { selector: 'summary' })) await user.click(summary);
    for (const value of [text, message, failure]) expect(screen.getByText(value).closest('details')?.open).toBe(true);
    const tool = screen.getByText('test command').closest('details')!;
    expect(tool.open).toBe(false);
    expect(within(tool.querySelector('summary')!).getByText('运行失败')).toBeTruthy();
    await user.click(screen.getByText('test command'));
    expect(screen.getByText('失败输出尾部').closest('details')?.open).toBe(true);
    await user.click(screen.getByText('查看变更'));
    expect(screen.getByText('待处理')).toBeTruthy();
    expect(state.events).toEqual(original);
    view.unmount();
    render(<ChannelAudit {...props} id="channel-system" />, { wrapper: TestProviders });
    await screen.findByText('test command');
    expect(screen.getByText('test command').closest('details')?.open).toBe(true);
    expect(screen.getByText(message).closest('details')).toBeNull();
  });
  it('filters only loaded sources, preserves pagination and resets the filter across projects', async () => {
    const state = snapshot();
    const older = event('older', '更早的项目操作', 1, { projectId: 'project-atlas', action: 'item.created' });
    const recent = event('recent', '最近的频道记录', 3, { projectId: 'project-atlas' });
    state.events = [older, recent];
    const { props, api } = featureProps({ snapshot: state });
    api.getEvents
      .mockResolvedValueOnce({ events: [recent], hasMore: true, cursor: 'recent' } as EventsPage)
      .mockResolvedValueOnce({ events: [older], hasMore: false })
      .mockResolvedValue({ events: [], hasMore: false });
    const view = render(<ProjectRecords {...props} projectId="project-atlas" />, { wrapper: TestProviders });
    await screen.findByRole('button', { name: '加载更早记录' });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole('combobox', { name: '记录来源筛选' }), 'operations');
    expect(screen.getByText('已载入记录中没有此来源。')).toBeTruthy();
    expect(screen.getByText('仅筛选已载入的记录，可继续加载更早记录。')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '加载更早记录' }));
    await screen.findByText('更早的项目操作');
    expect(api.getEvents).toHaveBeenLastCalledWith({ projectId: 'project-atlas', before: 'recent', limit: 50 });
    await user.selectOptions(screen.getByRole('combobox', { name: '记录来源筛选' }), 'all');
    expect(
      screen.getByText('最近的频道记录').compareDocumentPosition(screen.getByText('更早的项目操作')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    await user.selectOptions(screen.getByRole('combobox', { name: '记录来源筛选' }), 'channel');
    expect(screen.queryByText('更早的项目操作')).toBeNull();
    view.rerender(<ProjectRecords {...props} projectId="other-project" />);
    await screen.findByText('还没有项目记录');
    expect((screen.getByRole('combobox', { name: '记录来源筛选' }) as HTMLSelectElement).value).toBe('all');
    expect(screen.queryByText('最近的频道记录')).toBeNull();
  });
});

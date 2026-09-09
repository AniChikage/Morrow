// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectView } from './ProjectView';
import { FindingView } from './FindingView';
import { ChannelView } from './ChannelView';
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
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('project discovery workflow', () => {
  it('searches evidence within the selected project, combines status and channel filters, and opens the complete finding route', async () => {
    const user = userEvent.setup();
    const { props } = featureProps();
    render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    expect(screen.queryByText('其他项目的发现')).toBeNull();
    const search = screen.getByRole('textbox', { name: '搜索功能和证据' });
    await user.type(search, '唯一证据关键词');
    expect(screen.getByRole('button', { name: /^打开.*CSV 重试会重复提交/ })).toBeTruthy();
    expect(screen.queryByText('缩短激活路径')).toBeNull();
    await user.clear(search);
    await user.click(screen.getByRole('button', { name: '筛选' }));
    await user.click(screen.getByRole('menuitem', { name: '已验证' }));
    expect(screen.getByRole('button', { name: /^打开.*输入焦点已恢复/ })).toBeTruthy();
    expect(screen.queryByText('CSV 重试会重复提交')).toBeNull();
    await user.click(screen.getByRole('button', { name: '已筛选' }));
    await user.click(screen.getByRole('menuitem', { name: '所有状态' }));
    await user.click(screen.getByRole('button', { name: '筛选' }));
    await user.click(screen.getByRole('menuitem', { name: '运营洞察' }));
    expect(screen.queryByText('输入焦点已恢复')).toBeNull();
    await user.click(screen.getByRole('button', { name: /^打开.*缩短激活路径/ }));
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
    expect(screen.getByRole('button', { name: /^打开.*其他项目的发现/ })).toBeTruthy();
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
    expect(main.getByText('日志包含唯一证据关键词：request-17。')).toBeTruthy();
    expect(main.getByRole('link', { name: '官方错误码' }).getAttribute('href')).toBe('https://example.com/import/errors');
    expect(main.getByText('验证幂等键，并补充失败后的恢复测试。')).toBeTruthy();
    const properties = within(screen.getByRole('complementary'));
    expect(properties.queryByText('日志包含唯一证据关键词：request-17。')).toBeNull();
    await user.click(properties.getByRole('button', { name: '待处理' }));
    await user.click(screen.getByRole('menuitem', { name: '已验证' }));
    await waitFor(() => expect(api.patchItem).toHaveBeenCalledWith('finding-import', { status: 'verified' }));
    expect(props.onMutate).toHaveBeenCalledTimes(1);
  });

  it('does not create remote image requests or executable HTML from finding content', async () => {
    const state = snapshot();
    state.items = [item({ summary: '![外部图片](https://tracking.invalid/pixel.png)\n\n<script>window.compromised = true</script>\n\n正常发现正文' })];
    const { props } = featureProps({ snapshot: state });
    const { container } = render(<FindingView {...props} id="finding-import" />, { wrapper: TestProviders });
    expect(screen.getByText('正常发现正文')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    await screen.findByText('还没有关联记录');
  });
});

describe('channel control and history', () => {
  it('blocks demo execution but lets the user save a note without launching an agent', async () => {
    const user = userEvent.setup();
    const { props, api } = featureProps();
    render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    expect((screen.getByRole('button', { name: '运行一次' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '开启持续运行' }) as HTMLButtonElement).disabled).toBe(true);
    const notes = screen.getByRole('textbox', { name: '向频道补充上下文' });
    await user.type(notes, '  下一轮先检查导入边界  ');
    fireEvent.keyDown(notes, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledWith('channel-system', '下一轮先检查导入边界'));
    await waitFor(() => expect((notes as HTMLTextAreaElement).value).toBe(''));
    expect(api.channelAction).not.toHaveBeenCalled();
  });

  it('dispatches run, resume and pause to the selected real channel without overlapping a running task', async () => {
    const user = userEvent.setup();
    const state = snapshot(); state.projects[0].isDemo = false;
    state.channels[0].runtime = 'claude';
    const { props, api } = featureProps({ snapshot: state });
    const view = render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    await user.click(screen.getByRole('button', { name: '运行一次' }));
    expect(api.channelAction).toHaveBeenLastCalledWith('channel-system', 'run');
    await user.click(screen.getByRole('button', { name: '开启持续运行' }));
    expect(api.channelAction).toHaveBeenLastCalledWith('channel-system', 'resume');
    const runningState = { ...state, channels: state.channels.map(channel => channel.id === 'channel-system' ? { ...channel, status: 'running' } : channel) };
    view.rerender(<ChannelView {...props} snapshot={runningState} id="channel-system" />);
    expect((screen.getByRole('button', { name: '运行一次' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: '暂停频道' }));
    expect(api.channelAction).toHaveBeenLastCalledWith('channel-system', 'pause');
    expect(api.channelAction).toHaveBeenCalledTimes(3);
  });

  it('preserves an unsent note when the mutation fails', async () => {
    const user = userEvent.setup();
    const { props, api } = featureProps();
    api.sendMessage.mockRejectedValueOnce(new Error('服务不可用'));
    render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    const notes = screen.getByRole('textbox', { name: '向频道补充上下文' });
    await user.type(notes, '保留这段上下文');
    await user.click(screen.getByRole('button', { name: /发送消息/ }));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(props.onMutate).toHaveResolvedWith(false));
    expect((notes as HTMLTextAreaElement).value).toBe('保留这段上下文');
    expect(api.channelAction).not.toHaveBeenCalled();
  });

  it('uses an event ID cursor, merges older pages without duplicates, and orders equal timestamps by sequence', async () => {
    const state = snapshot();
    state.events = [event('event-four', '第四条记录', 4), event('event-three', '第三条记录', 3)];
    const { props, api } = featureProps({ snapshot: state });
    vi.mocked(props.api.getEvents).mockResolvedValueOnce({ events: state.events, hasMore: true, cursor: 'event-three' });
    api.getEvents.mockResolvedValueOnce({ events: [event('event-two', '第二条记录', 2), event('event-one', '第一条记录', 1), event('event-three', '过期的第三条记录', 3)], hasMore: false });
    render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    await userEvent.setup().click(await screen.findByRole('button', { name: '加载更早记录' }));
    await screen.findByText('第一条记录');
    expect(api.getEvents).toHaveBeenNthCalledWith(1, { channelId: 'channel-system', limit: 60 });
    expect(api.getEvents).toHaveBeenCalledWith({ channelId: 'channel-system', before: 'event-three', limit: 60 });
    const renderedMessages = screen.getAllByRole('article').map(article => article.textContent || '');
    expect(renderedMessages.map(text => ['第一条记录', '第二条记录', '第三条记录', '第四条记录'].find(value => text.includes(value)))).toEqual(['第一条记录', '第二条记录', '第三条记录', '第四条记录']);
    expect(screen.queryByText('过期的第三条记录')).toBeNull();
    expect(screen.getAllByText('第三条记录')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: '加载更早记录' })).toBeNull();
  });

  it('keeps current events visible when older-history loading fails', async () => {
    const state = snapshot(); state.events = [event('current-event', '已经存在的运行结果')];
    const { props, api } = featureProps({ snapshot: state });
    vi.mocked(props.api.getEvents).mockResolvedValueOnce({ events: state.events, hasMore: true, cursor: 'current-event' });
    api.getEvents.mockRejectedValueOnce(new Error('远程历史接口暂不可用')).mockResolvedValueOnce({ events: [event('recovered-old', '重试恢复的历史记录')], hasMore: false });
    render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    await userEvent.setup().click(await screen.findByRole('button', { name: '加载更早记录' }));
    expect((await screen.findByRole('alert')).textContent).toContain('远程历史接口暂不可用');
    expect(screen.getByText('已经存在的运行结果')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('重试恢复的历史记录');
    expect(api.getEvents).toHaveBeenLastCalledWith({ channelId: 'channel-system', before: 'current-event', limit: 60 });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not leak an in-flight history page into another channel and leaves that channel usable', async () => {
    const state = snapshot(); state.events = [event('system-current', '系统频道当前记录'), event('growth-current', '运营频道当前记录', 1, { channelId: 'channel-growth' })];
    const { props, api } = featureProps({ snapshot: state });
    let resolvePage!: (page: EventsPage) => void;
    api.getEvents.mockImplementationOnce(() => new Promise(resolve => { resolvePage = resolve; }));
    vi.mocked(props.api.getEvents).mockResolvedValueOnce({ events: [event('growth-current', '运营频道当前记录', 1, { channelId: 'channel-growth' })], hasMore: true, cursor: 'growth-current' });
    const view = render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    view.rerender(<ChannelView {...props} id="channel-growth" />);
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
    render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    expect(await screen.findByText('快照范围外的频道历史')).toBeTruthy();
    expect(api.getEvents).toHaveBeenCalledWith({ channelId: 'channel-system', limit: 60 });
    expect(screen.queryByText('频道还没有动态')).toBeNull();
    expect(screen.queryByText('其他频道的近期记录')).toBeNull();
  });

  it('offers a retry after the first history request fails even with an empty snapshot', async () => {
    const { props, api } = featureProps();
    api.getEvents.mockRejectedValueOnce(new Error('持久化历史读取失败')).mockResolvedValueOnce({ events: [event('recovered', '恢复读取的历史')], hasMore: false });
    render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
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
    api.getEvents.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ events: [], hasMore: false })
      .mockResolvedValueOnce({ events: [event('fresh-generation', '重新进入后的最新记录')], hasMore: false });
    const view = render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    view.rerender(<ChannelView {...props} id="channel-growth" />);
    view.rerender(<ChannelView {...props} id="channel-system" />);
    await screen.findByText('重新进入后的最新记录');
    await act(async () => resolveFirst({ events: [event('stale-generation', '上一代迟到记录')], hasMore: true, cursor: 'stale-generation' }));
    expect(screen.queryByText('上一代迟到记录')).toBeNull();
    expect(screen.getByText('重新进入后的最新记录')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '加载更早记录' })).toBeNull();
  });
});

describe('database history controls the loaded range', () => {
  it.each(['channel', 'project'] as const)('%s history only overlays loaded IDs and new live records, so older pages make visible progress', async scope => {
    const state = snapshot();
    const pageSize = scope === 'channel' ? 60 : 50;
    // All records deliberately have identical timestamps: IDs, not timestamps, define the boundary.
    state.events = Array.from({ length: 125 }, (_, index) => event(`history-${index}`, `记录内容 ${index}`, 1, { projectId: 'project-atlas' }));
    const firstPage = state.events.slice(-pageSize);
    const nextPage = state.events.slice(-pageSize * 2, -pageSize);
    const { props } = featureProps({ snapshot: state });
    vi.mocked(props.api.getEvents)
      .mockResolvedValueOnce({ events: firstPage, hasMore: true, cursor: firstPage[0].id })
      .mockResolvedValueOnce({ events: nextPage, hasMore: true, cursor: nextPage[0].id });
    const draw = (nextSnapshot = state) => scope === 'channel'
      ? <ChannelView {...props} snapshot={nextSnapshot} id="channel-system" />
      : <ProjectRecords {...props} snapshot={nextSnapshot} projectId="project-atlas" />;
    const view = render(draw(), { wrapper: TestProviders });
    await screen.findByRole('button', { name: '加载更早记录' });
    expect(screen.getAllByRole('article')).toHaveLength(pageSize);
    expect(screen.queryByText('记录内容 0')).toBeNull();
    expect(screen.queryByText(nextPage[0].text)).toBeNull();
    const updated = { ...state, events: state.events.map(record => record.id === firstPage[0].id ? { ...record, text: '已加载记录的实时更新' } : record) };
    updated.events.push(event('live-new-id', '同时间戳的实时新增记录', 1, { projectId: 'project-atlas' }));
    view.rerender(draw(updated));
    expect(screen.getByText('已加载记录的实时更新')).toBeTruthy();
    expect(screen.getByText('同时间戳的实时新增记录')).toBeTruthy();
    expect(screen.getAllByRole('article')).toHaveLength(pageSize + 1);
    expect(screen.queryByText('记录内容 0')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: '加载更早记录' }));
    await screen.findByText(nextPage[0].text);
    expect(screen.getAllByRole('article')).toHaveLength(pageSize * 2 + 1);
    expect(props.api.getEvents).toHaveBeenLastCalledWith({ ...(scope === 'channel' ? { channelId: 'channel-system' } : { projectId: 'project-atlas' }), before: firstPage[0].id, limit: pageSize });
    expect(screen.queryByText('记录内容 0')).toBeNull();
    expect(screen.getByText('已加载记录的实时更新')).toBeTruthy();
  });

  it.each(['channel', 'project'] as const)('%s history retains snapshot fallback after first-page failure, then adopts the successful page on retry', async scope => {
    const state = snapshot();
    const old = event('fallback-old', '首屏失败时保留的旧记录', 1, { projectId: 'project-atlas' });
    const recent = event('fallback-recent', '数据库首屏记录', 2, { projectId: 'project-atlas' });
    state.events = [old, recent];
    const { props, api } = featureProps({ snapshot: state });
    api.getEvents.mockRejectedValueOnce(new Error('数据库暂不可用')).mockResolvedValueOnce({ events: [recent], hasMore: true });
    render(scope === 'channel' ? <ChannelView {...props} id="channel-system" /> : <ProjectRecords {...props} projectId="project-atlas" />, { wrapper: TestProviders });
    await screen.findByRole('alert');
    expect(screen.getByText(old.text)).toBeTruthy();
    expect(screen.getByText(recent.text)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.queryByText(old.text)).toBeNull();
    expect(screen.getByText(recent.text)).toBeTruthy();
    expect(screen.getByRole('button', { name: '加载更早记录' })).toBeTruthy();
  });
});

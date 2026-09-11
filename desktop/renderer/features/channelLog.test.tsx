// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChannelView } from './ChannelView';
import { featureProps, snapshot, TestProviders, timestamp } from './testFixtures';
import type { Run, RunsPage } from '../../shared/types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const round = (id: string, patch: Partial<Run> = {}): Run => ({
  id,
  channelId: 'channel-system',
  projectId: 'project-atlas',
  runtime: 'codex',
  status: 'completed',
  startedAt: timestamp,
  finishedAt: '2026-09-07T02:02:00.000Z',
  sessionId: 'thread',
  summary: '原话默认折叠',
  usage: { attribution: 'estimated', delta: { weekly: 0.2 } },
  log: {
    work: { state: 'wait', focus: `关注 ${id}`, reason: '已有证据，等待报告', nextStep: '检查下一份报告' },
    commands: [{ id: 'check', command: 'npm test', status: 'completed', exitCode: 0, sealed: true, output: 'ok' }],
    files: ['src/import.ts'],
    outputs: [{ id: 'finding-import', itemId: 'finding-import', kind: '看板事项', title: '修复导入' }],
    truncated: false,
  },
  ...patch,
});
it('renders a structured round and opens raw activity only on expansion for demo and linked channels', async () => {
  for (const demo of [true, false]) {
    const state = snapshot();
    state.projects[0].isDemo = demo;
    const run = round('one');
    const { props, api } = featureProps({ snapshot: state });
    vi.mocked(props.api.getRuns).mockResolvedValue({ runs: [run], hasMore: false });
    api.getRun.mockResolvedValue({
      run: {
        ...run,
        log: {
          ...run.log!,
          activity: [{ id: 'native', type: 'mcpToolCall', input: '工具参数', output: '工具结果', text: '' }],
        },
      },
      prompt: '',
      finalOutput: '完整的 Codex 原话',
    });
    render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    const entry = within(await screen.findByRole('article', { name: /轮次/ }));
    expect(entry.getByRole('button', { name: '修复导入' }).closest('details')!.hasAttribute('open')).toBe(false);
    await userEvent.setup().click(entry.getByText(/^(本轮详情|查看最新轮次)$/));
    for (const text of [
      '关注 one',
      '已有证据，等待报告',
      'src/import.ts',
      'npm test',
      '退出 0',
      '修复导入',
      '检查下一份报告',
      '120 秒',
      '每周 估算 0.2%',
    ])
      expect(entry.getByText(text)).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('region', { name: '需要你' })).toBeNull();
    expect(api.getRun).not.toHaveBeenCalled();
    expect(screen.queryByText('完整的 Codex 原话')).toBeNull();
    await userEvent.setup().click(entry.getByText('原生工具活动与 Codex 原话'));
    expect(await screen.findByText('完整的 Codex 原话')).toBeTruthy();
    await userEvent.setup().click(screen.getByText('mcpToolCall'));
    expect(screen.getByText('工具结果')).toBeTruthy();
    await userEvent.setup().click(entry.getByText('修复导入'));
    expect(props.onNavigate).toHaveBeenCalledWith({ kind: 'finding', id: 'finding-import' });
    cleanup();
  }
});

it('prioritizes the current question and keeps direction and duplicate question text out of the default log', async () => {
  const state = snapshot();
  const run = round('question');
  state.channels[0].work = {
    state: 'needs_input',
    focus: '等待选择',
    reason: '两种路径',
    nextStep: '先做哪一种导入？',
    runId: run.id,
    updatedAt: timestamp,
    awaitingReply: true,
  };
  run.log!.work = state.channels[0].work;
  const { props, api } = featureProps({ snapshot: state });
  vi.mocked(props.api.getRuns).mockResolvedValue({ runs: [run], hasMore: false });
  const view = render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
  await screen.findByText('需要回答 · 问题见上方');
  expect(screen.queryByText(state.channels[0].goal)).toBeNull();
  expect(screen.queryByRole('complementary')).toBeNull();
  expect(view.container.querySelectorAll('.button-primary')).toHaveLength(1);
  expect(screen.getByRole('button', { name: '回答' }).classList.contains('button-primary')).toBe(true);
  expect(screen.queryByRole('button', { name: '继续工作' })).toBeNull();
  await userEvent.setup().click(screen.getByRole('button', { name: '频道选项' }));
  await userEvent.setup().click(screen.getByRole('menuitem', { name: '方向与额度' }));
  const settings = within(screen.getByRole('region', { name: '方向与额度' }));
  expect(settings.getByText(state.channels[0].goal)).toBeTruthy();
  expect(settings.getByText(/每日上限/)).toBeTruthy();
  expect(api.channelAction).not.toHaveBeenCalled();
});

it('marks only the newest round as the primary action while work is continuing', async () => {
  const state = snapshot();
  state.channels[0].autonomyEnabled = true;
  state.channels[0].status = 'waiting';
  const { props, api } = featureProps({ snapshot: state });
  vi.mocked(props.api.getRuns).mockResolvedValue({
    runs: [round('new'), round('old', { startedAt: '2026-09-06T00:00:00Z' })],
    hasMore: false,
  });
  const view = render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
  await screen.findByText('关注 new');
  expect(view.container.querySelectorAll('.log-primary-action')).toHaveLength(1);
  expect(screen.getByText('查看最新轮次').closest('article')!.textContent).toContain('关注 new');
  expect(screen.queryByRole('button', { name: '暂停' })).toBeNull();
});
it('keeps historical work distinct from the channel current focus and renders honest missing fields', async () => {
  const state = snapshot();
  state.channels[0].work = {
    state: 'continue',
    focus: '当前关注',
    reason: '当前理由',
    nextStep: '继续',
    runId: 'current',
    updatedAt: timestamp,
    awaitingReply: false,
  };
  const { props, api } = featureProps({ snapshot: state });
  vi.mocked(props.api.getRuns).mockResolvedValue({
    runs: [
      round('old'),
      round('missing', { log: { commands: [], files: [], outputs: [], truncated: false }, usage: undefined }),
    ],
    hasMore: false,
  });
  render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
  expect(await screen.findByText('关注 old')).toBeTruthy();
  expect(screen.getByText('未记录本轮关注点')).toBeTruthy();
  expect(screen.getByText('额度消耗未记录')).toBeTruthy();
  for (const entry of screen.getAllByRole('article', { name: /轮次/ }))
    expect(entry.textContent).not.toContain('当前关注');
});
it('merges older run pages once, orders newest first, preserves content after failure and retries the same cursor', async () => {
  const { props, api } = featureProps();
  const recent = round('recent', { startedAt: '2026-09-08T00:00:00Z' }),
    old = round('old');
  vi.mocked(props.api.getRuns)
    .mockResolvedValueOnce({ runs: [recent], hasMore: true, cursor: recent.id })
    .mockRejectedValueOnce(new Error('历史读取失败'))
    .mockResolvedValueOnce({ runs: [old, recent], hasMore: false });
  render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
  await userEvent.setup().click(await screen.findByRole('button', { name: '加载更早轮次' }));
  expect((await screen.findByRole('alert')).textContent).toContain('历史读取失败');
  expect(screen.getByText('关注 recent')).toBeTruthy();
  await userEvent.setup().click(screen.getByRole('button', { name: '重试轮次' }));
  await screen.findByText('关注 old');
  expect(api.getRuns).toHaveBeenLastCalledWith({ channelId: 'channel-system', limit: 20, before: 'recent' });
  expect(screen.getAllByRole('article', { name: /轮次/ }).map((e) => e.querySelector('h3')!.textContent)).toEqual([
    '关注 recent',
    '关注 old',
  ]);
});
it('rejects late run responses across channel changes, including switching away and back', async () => {
  const { props, api } = featureProps();
  let resolve!: (value: RunsPage) => void;
  vi.mocked(props.api.getRuns)
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    )
    .mockResolvedValueOnce({ runs: [], hasMore: false })
    .mockResolvedValueOnce({ runs: [round('fresh')], hasMore: false });
  const view = render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
  view.rerender(<ChannelView {...props} id="channel-growth" />);
  view.rerender(<ChannelView {...props} id="channel-system" />);
  await screen.findByText('关注 fresh');
  await act(async () => resolve({ runs: [round('stale')], hasMore: true, cursor: 'stale' }));
  expect(screen.queryByText('关注 stale')).toBeNull();
  expect(screen.queryByRole('button', { name: '加载更早轮次' })).toBeNull();
});
it('shows only this channel pending releases and blocked items in 需要你', async () => {
  const state = snapshot();
  state.items[0].status = 'blocked';
  state.releases = [
    {
      id: 'pending',
      projectId: 'project-atlas',
      channelId: 'channel-system',
      status: 'awaiting_approval',
      itemIds: [],
      title: '候选版本',
    },
    {
      id: 'other',
      projectId: 'project-atlas',
      channelId: 'channel-growth',
      status: 'awaiting_approval',
      itemIds: [],
      title: '别的频道发布',
    },
  ] as any;
  const { props } = featureProps({ snapshot: state });
  const view = render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
  const needs = within(screen.getByRole('region', { name: '需要你' }));
  expect(needs.getByText('待批准发布 · 候选版本')).toBeTruthy();
  expect(needs.getByText('待批准发布 · 候选版本').classList.contains('log-primary-action')).toBe(true);
  expect(needs.getByRole('button', { name: /被阻塞/ })).toBeTruthy();
  expect(needs.queryByText('待批准发布 · 别的频道发布')).toBeNull();
  await userEvent.setup().click(needs.getByText('待批准发布 · 候选版本'));
  view.rerender(<ChannelView {...props} snapshot={{ ...state, releases: [] }} id="channel-system" />);
  expect(screen.getByRole('button', { name: /被阻塞/ }).classList.contains('button-primary')).toBe(true);
});

it('does not call a completed snapshot missing while its structured log is still loading', async () => {
  const state = snapshot();
  state.channels[0].autonomyEnabled = true;
  state.channels[0].status = 'waiting';
  state.runs = [round('delayed', { log: undefined })];
  const { props, api } = featureProps({ snapshot: state });
  let resolve!: (page: RunsPage) => void;
  vi.mocked(api.getRuns).mockImplementationOnce(
    () =>
      new Promise<RunsPage>((r) => {
        resolve = r;
      })
  );
  render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
  expect(screen.getByText('本轮摘要尚未载入')).toBeTruthy();
  expect(screen.queryByText('未记录本轮关注点')).toBeNull();
  expect(screen.queryByText('结论未记录')).toBeNull();
  await userEvent.setup().click(screen.getByText('查看最新轮次'));
  expect(screen.queryByText('未记录命令或文件变更')).toBeNull();
  expect(screen.queryByText('未记录结构化产出')).toBeNull();
  await act(async () => resolve({ runs: [round('delayed')], hasMore: false }));
  expect(screen.getByText('关注 delayed')).toBeTruthy();
  expect(screen.queryByText('本轮摘要尚未载入')).toBeNull();
  expect(state.runs[0].log).toBeUndefined();
});

it('shows retrieval failure without claiming that the unavailable summary is absent', async () => {
  const state = snapshot();
  state.runs = [round('unavailable', { log: undefined })];
  const { props, api } = featureProps({ snapshot: state });
  vi.mocked(api.getRuns).mockRejectedValue(new Error('轮次接口暂不可用'));
  render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
  await screen.findByText('轮次接口暂不可用');
  expect(screen.getByText('本轮摘要尚未载入')).toBeTruthy();
  expect(screen.queryByText('未记录本轮关注点')).toBeNull();
  expect(screen.queryByText('结论未记录')).toBeNull();
  expect(screen.getByRole('button', { name: '重试轮次' })).toBeTruthy();
});

it.each(['empty', 'older'] as const)(
  'does not let a cached %s detail log hide a later completed list log',
  async (cached) => {
    const callbacks: Array<() => void> = [];
    vi.spyOn(window, 'setInterval').mockImplementation((callback) => {
      if (typeof callback === 'function') callbacks.push(callback as () => void);
      return 0 as unknown as ReturnType<typeof window.setInterval>;
    });
    const state = snapshot();
    state.channels[0].work = undefined;
    const initial = round('cache', {
      status: 'running',
      finishedAt: '',
      log: cached === 'empty' ? { commands: [], files: [], outputs: [], truncated: false } : round('previous').log,
    });
    let current = initial;
    const { props, api } = featureProps({ snapshot: state });
    vi.mocked(api.getRuns).mockImplementation(async () => ({ runs: [current], hasMore: false }));
    api.getRun.mockResolvedValue({ run: initial, prompt: '', finalOutput: '缓存的原话' });
    render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    const entry = within(await screen.findByRole('article', { name: /轮次/ }));
    const user = userEvent.setup();
    await user.click(entry.getByText(/^(本轮详情|查看最新轮次)$/));
    await user.click(entry.getByText('原生工具活动与 Codex 原话'));
    await entry.findByText('缓存的原话');
    await user.click(entry.getByText('原生工具活动与 Codex 原话'));
    await waitFor(() => expect(entry.getByText('缓存的原话').closest('details')?.open).toBe(false));
    current = round('cache');
    await act(async () => {
      callbacks.forEach((callback) => callback());
    });
    expect(await entry.findByText('关注 cache')).toBeTruthy();
    expect(entry.queryByText('未记录本轮关注点')).toBeNull();
    expect(entry.queryByText('关注 previous')).toBeNull();
    expect(api.getRun).toHaveBeenCalledTimes(1);
    expect(initial.status).toBe('running');
  }
);

it('uses detailed log as a fallback when the list has no projection', async () => {
  const { props, api } = featureProps();
  vi.mocked(props.api.getRuns).mockResolvedValue({ runs: [round('fallback', { log: undefined })], hasMore: false });
  api.getRun.mockResolvedValue({ run: round('fallback'), prompt: '', finalOutput: '详情原话' });
  render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
  const entry = within(await screen.findByRole('article', { name: /轮次/ }));
  const user = userEvent.setup();
  await user.click(entry.getByText(/^(本轮详情|查看最新轮次)$/));
  await user.click(entry.getByText('原生工具活动与 Codex 原话'));
  expect(await entry.findByText('关注 fallback')).toBeTruthy();
  expect(entry.getByText('详情原话')).toBeTruthy();
});

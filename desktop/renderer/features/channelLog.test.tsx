// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChannelView } from './ChannelView';
import { featureProps, nativeStatus, snapshot, TestProviders, timestamp } from './testFixtures';
import type { NativeConversation, ProjectUsage, Run, RunsPage } from '../../shared/types';

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

it('previews command first lines and expands each full command without moving its result', async () => {
  const state = snapshot();
  const first = "python3 - <<'PY'\nprint('保留原样')\nPY";
  const second = 'echo ' + '🙂'.repeat(180);
  const run = round('commands');
  run.log!.commands = [
    { id: 'first', command: first, status: 'completed', exitCode: 0, sealed: true, output: '' },
    { id: 'second', command: second, status: 'running', sealed: false, output: '' },
    { id: 'short', command: 'npm test', status: 'completed', exitCode: 1, sealed: false, output: '' },
  ];
  const original = structuredClone(run);
  const { props, api } = featureProps({ snapshot: state });
  vi.mocked(props.api.getRuns).mockResolvedValue({ runs: [run], hasMore: false });
  render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
  const entry = within(await screen.findByRole('article', { name: /轮次/ }));
  const user = userEvent.setup();
  await user.click(entry.getByText(/^(本轮详情|查看最新轮次)$/));
  const rows = within(entry.getByRole('list', { name: '本轮命令' })).getAllByRole('listitem');
  expect(rows[0].querySelector('code')!.textContent).toBe("python3 - <<'PY'");
  expect(rows[0].querySelector('pre')).toBeNull();
  expect(Array.from(rows[1].querySelector('code')!.textContent!)).toHaveLength(160);
  expect(rows[1].querySelector('code')!.textContent?.endsWith('🙂…')).toBe(true);
  expect(within(rows[2]).queryByRole('button')).toBeNull();
  expect(rows[0].querySelector('.log-command-line')!.textContent).toContain('退出 0 · 已封存');
  expect(rows[1].querySelector('.log-command-line')!.textContent).toContain('工作中 · 未封存');
  await user.click(within(rows[0]).getByRole('button', { name: '展开' }));
  expect(rows[0].querySelector('pre')!.textContent).toBe(first);
  expect(rows[1].querySelector('pre')).toBeNull();
  await user.click(within(rows[1]).getByRole('button', { name: '展开' }));
  expect(rows[1].querySelector('pre')!.textContent).toBe(second);
  await user.click(within(rows[0]).getByRole('button', { name: '收起' }));
  expect(rows[0].querySelector('pre')).toBeNull();
  expect(rows[1].querySelector('pre')!.textContent).toBe(second);
  expect(run).toEqual(original);
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
      '退出 0 · 已封存',
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
  await userEvent.setup().click(screen.getByRole('menuitem', { name: '当前方向与额度' }));
  const settings = within(screen.getByRole('region', { name: '当前方向与额度' }));
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
it('carries each round outcome onto the time rail, so the tick can be coloured by it', async () => {
  const { props } = featureProps();
  vi.mocked(props.api.getRuns).mockResolvedValue({
    runs: [
      round('now', { status: 'running', finishedAt: '' }),
      round('done', { startedAt: '2026-09-06T03:00:00Z' }),
      round('gone', { status: 'failed', startedAt: '2026-09-06T02:00:00Z' }),
      round('left', { status: 'interrupted', startedAt: '2026-09-06T01:00:00Z' }),
    ],
    hasMore: false,
  });
  const view = render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
  await screen.findByText('关注 now');
  // The status is plain text inside the round, so only this attribute lets the rail read it.
  expect(
    Array.from(view.container.querySelectorAll('.channel-log-entry')).map((entry) => entry.getAttribute('data-status'))
  ).toEqual(['running', 'completed', 'failed', 'interrupted']);
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
  expect(needs.getByText('待确认上线 · 候选版本')).toBeTruthy();
  expect(needs.getByText('待确认上线 · 候选版本').classList.contains('log-primary-action')).toBe(true);
  expect(needs.getByRole('button', { name: /被阻塞/ })).toBeTruthy();
  expect(needs.queryByText('待确认上线 · 别的频道发布')).toBeNull();
  await userEvent.setup().click(needs.getByText('待确认上线 · 候选版本'));
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
  const placeholder = screen.getByRole('status', { name: '本轮摘要尚未载入' });
  expect(placeholder.querySelectorAll('.skeleton-line')).toHaveLength(2);
  expect(screen.queryByRole('heading', { name: '本轮摘要尚未载入' })).toBeNull();
  expect(screen.queryByText('摘要尚未载入，可展开查看原话。')).toBeNull();
  expect(screen.queryByText('未记录本轮关注点')).toBeNull();
  expect(screen.queryByText('结论未记录')).toBeNull();
  await userEvent.setup().click(screen.getByText('查看最新轮次'));
  expect(screen.queryByText('未记录命令或文件变更')).toBeNull();
  expect(screen.queryByText('未记录结构化产出')).toBeNull();
  await act(async () => resolve({ runs: [round('delayed')], hasMore: false }));
  expect(screen.getByText('关注 delayed')).toBeTruthy();
  expect(screen.queryByRole('status', { name: '本轮摘要尚未载入' })).toBeNull();
  expect(state.runs[0].log).toBeUndefined();
});

it('shows retrieval failure without claiming that the unavailable summary is absent', async () => {
  const state = snapshot();
  state.runs = [round('unavailable', { log: undefined })];
  const { props, api } = featureProps({ snapshot: state });
  vi.mocked(api.getRuns).mockRejectedValue(new Error('轮次接口暂不可用'));
  render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
  await screen.findByText('轮次接口暂不可用');
  expect(screen.getByRole('status', { name: '本轮摘要尚未载入' }).querySelectorAll('.skeleton-line')).toHaveLength(2);
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

it('reports missing native timestamps honestly instead of 尚未运行 and NaN 秒', async () => {
  const { props } = featureProps();
  vi.mocked(props.api.getRuns).mockResolvedValue({
    runs: [
      round('native-clock', { startedAt: '', executionOwner: 'codex-app' }),
      round('cli-clock', { startedAt: '' }),
    ],
    hasMore: false,
  });
  render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
  const entries = await screen.findAllByRole('article', { name: /轮次/ });
  expect(entries.map((entry) => entry.textContent).join(' ')).not.toContain('NaN');
  expect(screen.queryByText('尚未运行')).toBeNull();
  // A round the App owns may carry no native timestamp; a CLI round simply has none recorded.
  expect(within(entries[0]).getByText('原生时间未提供')).toBeTruthy();
  expect(within(entries[0]).getByText('时长未记录')).toBeTruthy();
  expect(within(entries[1]).getByText('时间未记录')).toBeTruthy();
});

const connectedConversation = (patch: Partial<NativeConversation> = {}): NativeConversation => ({
  channelId: 'channel-system',
  threadId: 'native-thread',
  thread: { id: 'native-thread', title: '已关联任务', cwd: '/tmp/atlas', status: 'active', activeTurnId: 'turn-1' },
  status: {
    ...nativeStatus,
    available: true,
    connected: true,
    detail: '已连接 Codex App',
    boundThreadCount: 1,
    readyThreadCount: 1,
    capabilities: { list: true, read: true, send: true, create: false, interrupt: true, respond: true },
  },
  items: [],
  requests: [],
  hasMore: false,
  lastSyncedAt: timestamp,
  ...patch,
});

it.each([false, true])(
  'keeps the main action neutral until App connection is known (connected=%s)',
  async (connected) => {
    const state = snapshot();
    state.projects[0].isDemo = false;
    state.channels[0].autonomyEnabled = false;
    state.channels[0].status = 'paused';
    const { props, api } = featureProps({ snapshot: state });
    let resolve!: (value: NativeConversation) => void;
    vi.mocked(props.api.getNativeConversation).mockImplementationOnce(
      () =>
        new Promise<NativeConversation>((done) => {
          resolve = done;
        })
    );
    render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    const pending = screen.getByRole('button', { name: '正在检测 App 连接…' }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    expect(pending.classList.contains('button-primary')).toBe(false);
    expect(screen.queryByRole('button', { name: '继续工作' })).toBeNull();
    expect(screen.queryByRole('button', { name: '在 Codex App 中打开对话' })).toBeNull();
    const value = connectedConversation();
    value.status.connected = connected;
    value.thread = { ...value.thread!, activeTurnId: undefined, status: 'idle' };
    await act(async () => resolve(value));
    expect(screen.queryByRole('button', { name: '正在检测 App 连接…' })).toBeNull();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: connected ? '继续工作' : '在 Codex App 中打开对话' }));
    if (connected) expect(api.channelAction).toHaveBeenCalledWith('channel-system', 'resume');
    else expect(api.openNativeApp).toHaveBeenCalledWith('channel-system');
  }
);

it.each([
  ['Codex App 没有响应，稍后会重试', 'Codex App 没有响应，稍后会重试'],
  ['connect ECONNREFUSED /Users/test/.codex/ipc/ipc.sock', 'App 连接暂时不可用，请在运行时页重新检测。'],
])('preserves human sync errors and replaces raw sync errors: %s', async (syncError, expected) => {
  const { props } = featureProps();
  props.snapshot.projects[0].isDemo = false;
  const detail = '已连接 Codex App。请在 App 创建并打开同一项目的任务。';
  vi.mocked(props.api.getNativeConversation).mockResolvedValue(
    connectedConversation({
      status: { ...nativeStatus, available: true, connected: false, detail },
      syncError,
    })
  );
  render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
  expect((await screen.findByRole('alert')).textContent).toContain(expected);
  expect(screen.queryByText(detail)).toBeNull();
  expect(screen.queryByText(/ECONNREFUSED|ipc\.sock/)).toBeNull();
});

it.each(['connect ECONNREFUSED /Users/test/.codex/ipc/ipc.sock', 'EAI_AGAIN', '读取 /tmp/task 失败'])(
  'keeps an unmapped detail out of the channel hint: %s',
  async (detail) => {
    const { props, api } = featureProps();
    props.snapshot.projects[0].isDemo = false;
    vi.mocked(props.api.getNativeConversation).mockResolvedValue(
      connectedConversation({ status: { ...nativeStatus, detail } })
    );
    render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    expect((await screen.findByRole('alert')).textContent).toContain('App 连接暂时不可用，请在运行时页重新检测。');
    expect(screen.queryByText(detail)).toBeNull();
  }
);

it.each([
  ['connect ECONNREFUSED /tmp/service.sock', 'App 连接暂时不可用，请在运行时页重新检测。'],
  ['Morrow 正在切换版本，请稍后重试。', 'Morrow 正在切换版本，请稍后重试。'],
])('preserves human request errors and replaces raw request errors: %s', async (message, expected) => {
  const { props, api } = featureProps();
  props.snapshot.projects[0].isDemo = false;
  api.getNativeConversation.mockRejectedValue(new Error(message));
  render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
  expect((await screen.findByRole('alert')).textContent).toContain(expected);
  expect(screen.queryByText(/ECONNREFUSED|service\.sock/)).toBeNull();
  expect(screen.queryByRole('button', { name: '正在检测 App 连接…' })).toBeNull();
  expect(screen.getByRole('button', { name: '在 Codex App 中打开对话' })).toBeTruthy();
});

it('surfaces an App approval waiting on the user instead of claiming Codex is still answering', async () => {
  const state = snapshot();
  state.projects[0].isDemo = false;
  const { props, api } = featureProps({ snapshot: state });
  vi.mocked(props.api.getNativeConversation).mockResolvedValue(
    connectedConversation({
      requests: [{ id: 'approval', type: 'commandApproval', status: 'pending', title: '允许运行 npm test', raw: {} }],
    })
  );
  render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
  const needs = within(await screen.findByRole('region', { name: '需要你' }));
  expect(needs.getByText(/Codex 在 App 里等你处理（审批\/追问）/).textContent).toContain('允许运行 npm test');
  expect(screen.queryByText('Codex 正在回应，请稍候')).toBeNull();
  await userEvent.setup().click(needs.getByRole('button', { name: '在 Codex App 中打开' }));
  expect(api.openNativeApp).toHaveBeenCalledWith('channel-system');
  expect(api.channelAction).not.toHaveBeenCalled();
});

it('keeps a resolved App request out of 需要你', async () => {
  const state = snapshot();
  state.projects[0].isDemo = false;
  const { props, api } = featureProps({ snapshot: state });
  vi.mocked(props.api.getNativeConversation).mockResolvedValue(
    connectedConversation({ requests: [{ id: 'done', type: 'commandApproval', status: 'resolved', raw: {} }] })
  );
  render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
  await screen.findByText('工作日志');
  await waitFor(() => expect(api.getNativeConversation).toHaveBeenCalled());
  expect(screen.queryByRole('region', { name: '需要你' })).toBeNull();
});

it('names the usage gate in 需要你, so a channel held by 额度 is not a silent wait', async () => {
  const message = '账户5 小时额度已用 92%，达到保留线（保留 10%），等待 09-07 06:00 重置';
  const gate: ProjectUsage = {
    stale: false,
    gate: { blocked: true, kind: 'reserve', window: '5h', until: '2026-09-07T06:00:00.000Z', message },
  };
  const { props, api } = featureProps();
  api.getProjectUsage.mockResolvedValue(gate);
  render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
  const needs = within(await screen.findByRole('region', { name: '需要你' }));
  expect(needs.getByText(message)).toBeTruthy();
  cleanup();
  api.getProjectUsage.mockResolvedValue({ stale: true, gate: { blocked: false } });
  render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
  await screen.findByText('工作日志');
  expect(screen.queryByRole('region', { name: '需要你' })).toBeNull();
});

/** The same reading the Codex case above is held by; the service starts a CLI turn regardless. */
const reserveMessage = '账户每周额度已用 94%，达到保留线（保留 30%），等待 09-19 12:02 重置';
const reserveGate: ProjectUsage = {
  stale: false,
  gate: {
    blocked: true,
    kind: 'reserve',
    window: 'weekly',
    until: '2026-09-19T12:02:00.000Z',
    message: reserveMessage,
  },
};
/** A CLI channel: the account gate and usage attribution are both Codex-only in `service/engine.ts`. */
function cliChannelState() {
  const state = snapshot();
  state.projects[0].isDemo = false;
  state.channels[0].runtime = 'claude';
  state.channels[0].permission = 'workspace-write';
  return state;
}

it('keeps the Codex account gate off a CLI channel, which is never held by the reserve line', async () => {
  const { props, api } = featureProps({ snapshot: cliChannelState() });
  api.getProjectUsage.mockResolvedValue(reserveGate);
  render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
  await screen.findByText('工作日志');
  await waitFor(() => expect(api.getProjectUsage).toHaveBeenCalled());
  expect(screen.queryByText(reserveMessage)).toBeNull();
  expect(screen.queryByRole('region', { name: '需要你' })).toBeNull();
});

it('leaves the 额度 line off a CLI turn rather than reporting consumption it never records', async () => {
  const { props } = featureProps({ snapshot: cliChannelState() });
  vi.mocked(props.api.getRuns).mockResolvedValue({
    runs: [round('cli', { runtime: 'claude', usage: undefined })],
    hasMore: false,
  });
  render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
  const entry = await screen.findByRole('article', { name: /轮次/ });
  expect(entry.textContent).not.toContain('额度');
  // Three facts, and no fourth empty span leaving a gap where the label used to sit.
  const header = Array.from(entry.querySelector('header')!.children).map((node) => node.textContent);
  expect(header).toHaveLength(3);
  expect(header.slice(1)).toEqual(['已完成', '120 秒']);
});

it('shows a CLI report excerpt without work while preserving Codex, empty and structured summaries', async () => {
  const summary = '**已核对导入。** 后续仍待观察。\r\n第二行保留。\r\n第三行只在全文中';
  const { props } = featureProps({ snapshot: cliChannelState() });
  const emptyLog = { commands: [], files: [], outputs: [], truncated: false };
  const runs = [
    round('claude-summary', { runtime: 'claude', summary, log: emptyLog }),
    round('trae-summary', { runtime: 'trae', summary: '🙂'.repeat(230), log: undefined }),
    round('cli-empty', { runtime: 'claude', summary: '  ', log: emptyLog }),
    round('codex-summary', { summary, log: emptyLog }),
    round('cli-work', { runtime: 'claude', summary }),
  ];
  const original = structuredClone(runs);
  vi.mocked(props.api.getRuns).mockResolvedValue({ runs, hasMore: false });
  render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
  const entries = await screen.findAllByRole('article', { name: /轮次/ });
  expect(within(entries[0]).getByRole('heading', { name: '已核对导入。' })).toBeTruthy();
  expect(entries[0].querySelector('.log-summary')!.textContent).toBe('已核对导入。 后续仍待观察。\n第二行保留。');
  expect(entries[0].querySelector('.log-summary')!.textContent).not.toContain('第三行');
  expect(Array.from(entries[1].querySelector('.log-summary')!.textContent!)).toHaveLength(201);
  expect(entries[1].querySelector('.log-summary')!.textContent).toBe('🙂'.repeat(200) + '…');
  for (const index of [2, 3]) {
    expect(within(entries[index]).getByRole('heading', { name: '未记录本轮关注点' })).toBeTruthy();
    expect(entries[index].querySelector('.log-summary')!.textContent).toBe('结论未记录');
  }
  expect(within(entries[4]).getByRole('heading', { name: '关注 cli-work' })).toBeTruthy();
  expect(entries[4].querySelector('.log-summary')!.textContent).toContain('检查下一份报告');
  expect(runs).toEqual(original);
});

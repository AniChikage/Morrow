// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Channel, ChannelWork, NativeConversation, Snapshot } from '../../shared/types';
import { ChannelView } from './ChannelView';
import { ProjectView } from './ProjectView';
import { questionExcerpt } from './ChannelQuestion';
import { ProjectNavigation } from '../components/ProjectNavigation';
import { formatDate } from '../components/format';
import { featureProps, nativeStatus, snapshot, TestProviders, timestamp } from './testFixtures';

beforeEach(() => {
  localStorage.clear();
  if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const question: ChannelWork = {
  state: 'needs_input',
  focus: '空状态的导入入口',
  reason: '两条证据指向不同的入口。',
  nextStep: '空状态的导入入口应指向 **CSV 导入** 还是集成导入？\n\n如果两者都要，先做哪个？',
  runId: 'run-one',
  updatedAt: timestamp,
  awaitingReply: true,
};
const cardName = 'Codex 需要你回答';
const boxName = '回答 Codex 的问题';
function ready(patch: Partial<NativeConversation> = {}): NativeConversation {
  return {
    channelId: 'channel-system',
    threadId: 'native-thread',
    thread: { id: 'native-thread', title: '频道对话', cwd: '/tmp/atlas', status: 'idle', model: 'native-model' },
    status: {
      ...nativeStatus,
      available: true,
      connected: true,
      detail: '连接到原生 App',
      capabilities: { list: true, read: true, send: true, create: false, interrupt: true, respond: true },
    },
    items: [],
    requests: [],
    hasMore: false,
    lastSyncedAt: timestamp,
    ...patch,
  };
}
/** A real Codex channel whose last scheduled turn ended by asking the user something. */
function waitingState(work?: ChannelWork): Snapshot {
  const state = snapshot();
  state.projects[0].isDemo = false;
  state.channels[0].status = work ? 'blocked' : 'idle';
  if (work) state.channels[0].work = work;
  return state;
}
function withChannel(state: Snapshot, patch: Partial<Channel>): Snapshot {
  return {
    ...state,
    channels: state.channels.map((channel) => (channel.id === 'channel-system' ? { ...channel, ...patch } : channel)),
  };
}
function renderChannel(state = waitingState(question), conversation = ready()) {
  const { props, api } = featureProps({ snapshot: state });
  vi.mocked(props.api.getNativeConversation).mockResolvedValue(conversation);
  const view = render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
  return { props, api, view, state };
}
const card = () => screen.getByRole('region', { name: cardName });
const box = () => screen.getByRole('textbox', { name: boxName }) as HTMLTextAreaElement;
const answerButton = () => screen.getByRole('button', { name: '回答' }) as HTMLButtonElement;
async function usableBox() {
  await waitFor(() => expect(box().disabled).toBe(false));
  return box();
}

describe('the Codex question card on the channel page', () => {
  it('shows the question as Markdown with its time instead of the next-step block, which returns once the reply is taken', () => {
    const { props, view, state } = renderChannel();
    const content = within(card());
    expect(content.getByText('CSV 导入').tagName).toBe('STRONG');
    expect(content.getByText('如果两者都要，先做哪个？')).toBeTruthy();
    expect(content.getByText(formatDate(timestamp))).toBeTruthy();
    expect(screen.getAllByText('等你回答')[0]).toBeTruthy();
    expect(screen.queryByText('需要你指导')).toBeNull();
    expect(document.querySelector('.channel-next-step')).toBeNull();
    const replied = withChannel(state, {
      status: 'idle',
      work: { ...question, state: 'continue', nextStep: '继续验证导入路径。', awaitingReply: false },
    });
    view.rerender(<ChannelView {...props} snapshot={replied} id="channel-system" />);
    expect(screen.queryByRole('region', { name: cardName })).toBeNull();
    expect(screen.getByText('继续验证导入路径。').closest('.channel-next-step')?.textContent).toContain('下一步');
    const noWork = withChannel(state, { status: 'idle' });
    noWork.channels.forEach((channel) => delete channel.work);
    view.rerender(<ChannelView {...props} snapshot={noWork} id="channel-system" />);
    expect(screen.queryByRole('region', { name: cardName })).toBeNull();
    expect(document.querySelector('.channel-next-step')).toBeNull();
  });

  it('never re-labels an answered question as the next step', async () => {
    const { props, view, state } = renderChannel();
    // The reply is taken but the turn's saved decision is still the needs_input one: its nextStep is
    // the question, not a next step, so the block says what is actually happening instead.
    const answered = withChannel(state, { status: 'idle', work: { ...question, awaitingReply: false } });
    view.rerender(<ChannelView {...props} snapshot={answered} id="channel-system" />);
    expect(screen.queryByRole('region', { name: cardName })).toBeNull();
    const block = document.querySelector('.channel-next-step')!;
    expect(block.textContent).toContain('已回答，等待 Codex 继续');
    expect(block.textContent).not.toContain('还是集成导入');
  });

  it('sends the trimmed answer with a request id, then shows 已回答 without the box and without changing tabs', async () => {
    const user = userEvent.setup();
    const { api } = renderChannel();
    const input = await usableBox();
    await user.type(input, '  先做 CSV 导入  ');
    await user.click(answerButton());
    await waitFor(() =>
      expect(api.sendNativeMessage).toHaveBeenCalledWith('channel-system', {
        text: '先做 CSV 导入',
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      })
    );
    expect(await screen.findByText('已回答，Codex 将继续')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: boxName })).toBeNull();
    expect(screen.queryByRole('button', { name: '回答' })).toBeNull();
    expect(screen.getByRole('heading', { name: '工作日志' })).toBeTruthy();
    expect(api.channelAction).not.toHaveBeenCalled();
  });

  it('submits with Command or Control Enter only, ignores an empty draft, and reports a pending receipt as sent', async () => {
    const user = userEvent.setup();
    const { api } = renderChannel();
    api.sendNativeMessage.mockResolvedValueOnce({ state: 'pending', requestId: 'queued' });
    const input = await usableBox();
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    await user.type(input, '   ');
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    expect(answerButton().disabled).toBe(true);
    await user.type(input, '先验证导入前的流程');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(api.sendNativeMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(api.sendNativeMessage).toHaveBeenCalledTimes(1));
    expect(api.sendNativeMessage.mock.calls[0][1].text).toBe('先验证导入前的流程');
    expect(await screen.findByText('已发送，正在等待原生任务确认')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: boxName })).toBeNull();
  });

  it('keeps the draft and shows the error when the receipt fails or the request throws', async () => {
    const user = userEvent.setup();
    const { api } = renderChannel();
    api.sendNativeMessage
      .mockResolvedValueOnce({ state: 'failed', requestId: 'refused', error: '原生任务已断开' })
      .mockRejectedValueOnce(new Error('网络中断'));
    const input = await usableBox();
    await user.type(input, '先做集成导入');
    await user.click(answerButton());
    expect((await screen.findByRole('alert')).textContent).toBe('原生任务已断开');
    expect(input.value).toBe('先做集成导入');
    expect(input.disabled).toBe(false);
    await user.click(answerButton());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('网络中断'));
    expect(input.value).toBe('先做集成导入');
    expect(input.disabled).toBe(false);
    expect(api.sendNativeMessage).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('已回答，Codex 将继续')).toBeNull();
  });

  it('keeps the draft with a check-first note when the receipt is unknown, and re-sends the same request', async () => {
    const user = userEvent.setup();
    const { api } = renderChannel();
    api.sendNativeMessage.mockResolvedValueOnce({ state: 'unknown', requestId: 'lost' });
    const input = await usableBox();
    await user.type(input, '两者都要，先做 CSV');
    await user.click(answerButton());
    expect(await screen.findByText('发送状态尚未确认，请到对话中核对后再决定是否重发')).toBeTruthy();
    expect(input.value).toBe('两者都要，先做 CSV');
    expect(input.disabled).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(answerButton());
    await waitFor(() => expect(api.sendNativeMessage).toHaveBeenCalledTimes(2));
    expect(api.sendNativeMessage.mock.calls[1]).toEqual(api.sendNativeMessage.mock.calls[0]);
    expect(await screen.findByText('已回答，Codex 将继续')).toBeTruthy();
  });

  it('shows a demo question without accepting an answer', () => {
    const state = snapshot();
    state.channels[0].work = question;
    const { props } = featureProps({ snapshot: state });
    render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    expect(within(card()).getByText('如果两者都要，先做哪个？')).toBeTruthy();
    expect(box().disabled).toBe(true);
    expect(answerButton().disabled).toBe(true);
    expect(screen.getByText('示例频道不能回答')).toBeTruthy();
  });

  it('answers a CLI-runtime question without waiting on an App conversation', () => {
    const state = waitingState(question);
    state.channels[0].runtime = 'claude';
    const { props } = featureProps({ snapshot: state });
    render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    expect(within(card()).getByText('如果两者都要，先做哪个？')).toBeTruthy();
    // No App task stands behind this channel, so nothing about App readiness may block the answer.
    expect(box().disabled).toBe(false);
    expect(screen.getByText('⌘ Enter 回答')).toBeTruthy();
    expect(screen.queryByText('原生对话尚未就绪，暂时不能回答')).toBeNull();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('waits for a native conversation that can send, then focuses the box because the page opened with the question', async () => {
    const offline = ready({ status: { ...ready().status, connected: false }, lastSyncedAt: undefined });
    const { props } = renderChannel(waitingState(question), offline);
    expect(box().disabled).toBe(true);
    expect(await screen.findByText('原生对话尚未就绪，暂时不能回答')).toBeTruthy();
    vi.mocked(props.api.getNativeConversation).mockResolvedValue(ready());
    fireEvent.focus(window);
    const input = await usableBox();
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(screen.getByText('⌘ Enter 回答')).toBeTruthy();
  });

  it('does not steal focus when the question arrives while the page is already open', async () => {
    const { props, view, state } = renderChannel(waitingState());
    expect(screen.queryByRole('region', { name: cardName })).toBeNull();
    await waitFor(() => expect(props.api.getNativeConversation).toHaveBeenCalled());
    view.rerender(
      <ChannelView
        {...props}
        snapshot={withChannel(state, { status: 'blocked', work: question })}
        id="channel-system"
      />
    );
    const input = await usableBox();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.activeElement).not.toBe(input);
  });

  it('opens Codex App from 查看完整回复', async () => {
    const user = userEvent.setup();
    const { api } = renderChannel();
    expect(screen.getByRole('heading', { name: '工作日志' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '查看完整回复' }));
    expect(api.openNativeApp).toHaveBeenCalledWith('channel-system');
  });
});

describe('pending questions on the project page and in the sidebar', () => {
  it('lists waiting channels first under 待回答 with a one-line excerpt, and 回答 opens the channel', async () => {
    const user = userEvent.setup();
    const state = waitingState(question);
    state.channels[1].work = { ...question, nextStep: '# 长问题\n\n' + '很长的问题正文，'.repeat(40) };
    const { props } = featureProps({ snapshot: state });
    render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    expect(screen.getByText('2 个频道有问题待回答')).toBeTruthy();
    expect(screen.queryByRole('region', { name: '待回答' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '项目属性' }));
    const section = screen.getByRole('region', { name: '待回答' });
    expect(document.querySelector('.property-section')).toBe(section);
    const rows = within(section);
    expect(rows.getByText('系统完善')).toBeTruthy();
    expect(rows.getByText('空状态的导入入口应指向 CSV 导入 还是集成导入？ 如果两者都要，先做哪个？')).toBeTruthy();
    expect(rows.getByText('运营洞察')).toBeTruthy();
    const long = rows.getByText(/^长问题 很长的问题正文，.*…$/);
    expect(Array.from(long.textContent || '')).toHaveLength(121);
    expect(rows.getAllByRole('button')).toHaveLength(2);
    await user.click(rows.getByRole('button', { name: '回答 系统完善 的问题' }));
    expect(props.onNavigate).toHaveBeenCalledWith({ kind: 'channel', id: 'channel-system' });
  });

  it('drops Markdown markers and surrounding whitespace from the excerpt and cuts long questions', () => {
    expect(questionExcerpt('  **粗体**  和 `代码`\n\n- 列表项 [链接](https://example.com) ')).toBe(
      '粗体 和 代码 列表项 链接'
    );
    expect(questionExcerpt('字'.repeat(130))).toBe('字'.repeat(120) + '…');
    expect(questionExcerpt('字'.repeat(120))).toBe('字'.repeat(120));
  });

  it('hides 待回答 and the sidebar count when nothing is waiting', () => {
    const { props } = featureProps();
    render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    expect(screen.queryByRole('region', { name: '待回答' })).toBeNull();
    expect(screen.queryByText('待回答')).toBeNull();
    cleanup();
    const state = snapshot();
    render(
      <ProjectNavigation
        projects={state.projects}
        channels={state.channels}
        scope="local"
        onNavigate={vi.fn()}
        onNewChannel={vi.fn()}
      />
    );
    expect(screen.queryByRole('img', { name: /待回答/ })).toBeNull();
  });

  it('counts waiting questions on the sidebar project row whether expanded or collapsed', async () => {
    const user = userEvent.setup();
    const state = waitingState(question);
    state.channels[1].work = question;
    render(
      <ProjectNavigation
        projects={state.projects}
        channels={state.channels}
        scope="local"
        onNavigate={vi.fn()}
        onNewChannel={vi.fn()}
      />
    );
    const atlas = within(screen.getByRole('region', { name: 'Atlas 示例项目 项目' }));
    expect(atlas.getByRole('img', { name: '2 个问题待回答' })).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'Other 项目' })).queryByRole('img', { name: /待回答/ })
    ).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Atlas 示例项目' }));
    expect(screen.queryByRole('group', { name: 'Atlas 示例项目 的频道' })).toBeNull();
    expect(atlas.getByRole('img', { name: '2 个问题待回答' })).toBeTruthy();
  });
});

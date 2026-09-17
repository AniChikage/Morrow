// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectView } from './ProjectView';
import { FindingView } from './FindingView';
import { ChannelView } from './ChannelView';
import { ChannelAudit } from './ChannelAudit';
import { ProjectRecords } from './ProjectRecords';
import { event, featureProps, item, snapshot, TestProviders, timestamp } from './testFixtures';
import type { EventsPage, Run, Snapshot } from '../../shared/types';

/** A real project running Claude Code: the only shape that offers the 留言 entry. */
function cliChannelState(): Snapshot {
  const state = snapshot();
  state.projects[0].isDemo = false;
  state.channels[0].runtime = 'claude';
  state.channels[0].permission = 'workspace-write';
  state.channels[0].status = 'paused';
  state.channels[0].nextRunAt = '';
  return state;
}
const cliRun = (patch: Partial<Run> = {}): Run => ({
  id: 'run-earlier',
  projectId: 'project-atlas',
  channelId: 'channel-system',
  runtime: 'claude',
  status: 'completed',
  startedAt: '2026-09-07T03:00:00.000Z',
  finishedAt: '2026-09-07T03:05:00.000Z',
  summary: '',
  sessionId: '',
  ...patch,
});
const note = (id: string, text: string, createdAt = timestamp) =>
  event(id, text, 1, { kind: 'message', runId: '', actor: 'human' as const, createdAt });
/** What `Engine.finishSuccess` stores when a turn reports `needsHuman`: the summary is the question. */
const waitingQuestion = {
  state: 'needs_input' as const,
  focus: '',
  reason: '本轮需要人工输入',
  nextStep: '样本数据从哪里取？',
  runId: 'run-earlier',
  updatedAt: timestamp,
  awaitingReply: true,
};

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
    const search = screen.getByRole('textbox', { name: '搜索事项和证据' });
    await user.type(search, '唯一证据关键词');
    expect(screen.getByRole('button', { name: /^打开.+CSV 重试会重复提交/ })).toBeTruthy();
    expect(screen.queryByText('缩短激活路径')).toBeNull();
    await user.clear(search);
    await user.selectOptions(screen.getByRole('combobox', { name: '状态筛选' }), 'verified');
    expect(screen.getByRole('button', { name: /^打开.+输入焦点已恢复/ })).toBeTruthy();
    expect(screen.queryByText('CSV 重试会重复提交')).toBeNull();
    await user.selectOptions(screen.getByRole('combobox', { name: '状态筛选' }), 'all');
    await user.selectOptions(screen.getByRole('combobox', { name: '来源频道筛选' }), 'channel-growth');
    expect(screen.queryByText('输入焦点已恢复')).toBeNull();
    await user.click(screen.getByRole('button', { name: /^打开.+缩短激活路径/ }));
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
    expect(screen.getByRole('button', { name: /^打开.+其他项目的发现/ })).toBeTruthy();
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
    expect(api.channelAction).not.toHaveBeenCalled();
  });

  it('runs a Claude Code channel from the page itself: no App entry, continue and pause both work', async () => {
    const user = userEvent.setup();
    const state = snapshot();
    state.projects[0].isDemo = false;
    state.channels[0].runtime = 'claude';
    state.channels[0].permission = 'workspace-write';
    state.channels[0].status = 'paused';
    state.channels[0].nextRunAt = '';
    const { props, api } = featureProps({ snapshot: state });
    api.getEvents.mockResolvedValueOnce({ events: [event('cli-history', '本机 CLI 轮次留下的记录')], hasMore: false });
    const view = render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    await user.click(screen.getByText('频道审计记录'));
    await screen.findByText('本机 CLI 轮次留下的记录');
    expect(screen.queryByRole('note')).toBeNull();
    // Nothing here belongs to an App task, so its entry is not offered at all.
    expect(screen.queryByRole('button', { name: /在 Codex App 中打开/ })).toBeNull();
    expect(screen.getByText('准备好后继续工作。')).toBeTruthy();
    const resume = screen.getByRole('button', { name: /继续工作/ }) as HTMLButtonElement;
    expect(resume.disabled).toBe(false);
    await user.click(resume);
    expect(api.channelAction).toHaveBeenLastCalledWith('channel-system', 'resume');
    const runningState = {
      ...state,
      channels: state.channels.map((channel) =>
        channel.id === 'channel-system' ? { ...channel, status: 'running', autonomyEnabled: true } : channel
      ),
    };
    view.rerender(<ChannelView {...props} snapshot={runningState} id="channel-system" />);
    await user.click(screen.getByRole('button', { name: '频道选项' }));
    expect(screen.queryByRole('menuitem', { name: '在 Codex App 中打开对话' })).toBeNull();
    await user.click(screen.getByRole('menuitem', { name: '暂停' }));
    expect(api.channelAction).toHaveBeenLastCalledWith('channel-system', 'pause');
    expect(api.channelAction).toHaveBeenCalledTimes(2);
  });

  it('pauses a manual running turn without offering to resume its disabled autonomy', async () => {
    const user = userEvent.setup();
    const state = cliChannelState();
    state.channels[0].status = 'running';
    state.channels[0].autonomyEnabled = false;
    const { props, api } = featureProps({ snapshot: state });
    const view = render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    expect(screen.getByText('本轮进行中，结束后频道保持暂停。')).toBeTruthy();
    expect(screen.queryByText('准备好后继续工作。')).toBeNull();
    expect(screen.queryByRole('button', { name: '继续工作' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '频道选项' }));
    expect(screen.queryByRole('menuitem', { name: '继续工作' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '暂停' })).toBeNull();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: '暂停' }));
    expect(api.channelAction).toHaveBeenCalledExactlyOnceWith('channel-system', 'pause');
    const finished = { ...state, channels: state.channels.map((c) => ({ ...c, status: 'paused' })) };
    view.rerender(<ChannelView {...props} snapshot={finished} id="channel-system" />);
    expect(screen.getByText('准备好后继续工作。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '继续工作' })).toBeTruthy();
  });

  it('leaves a note for the next CLI turn and says which notes a turn has already read', async () => {
    const user = userEvent.setup();
    const state = cliChannelState();
    // A loaded turn that started after the stored note, and none after the one left below.
    state.runs = [cliRun()];
    const { props, api } = featureProps({ snapshot: state });
    api.getMessages.mockResolvedValue({ messages: [note('note-old', '先看导入流程')] });
    render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    const section = within(await screen.findByRole('region', { name: '留言' }));
    expect(api.getMessages).toHaveBeenCalledWith('channel-system');
    await waitFor(() => expect(section.getByText('先看导入流程')).toBeTruthy());
    expect(section.getByText(/^已在 .+ 的轮次读取$/)).toBeTruthy();
    const box = screen.getByRole('textbox', { name: '给频道留言' }) as HTMLTextAreaElement;
    expect((screen.getByRole('button', { name: '留言' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(box, '再核对重试路径');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledWith('channel-system', '再核对重试路径'));
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    // A stored note clears the box; nothing about it starts a turn.
    await waitFor(() => expect(box.value).toBe(''));
    expect(screen.getByText('已留言，下一轮读取')).toBeTruthy();
    expect(api.channelAction).not.toHaveBeenCalled();
    const rows = section.getAllByRole('listitem');
    expect(within(rows[0]).getByText('再核对重试路径')).toBeTruthy();
    expect(within(rows[0]).getByText('等下一轮读取')).toBeTruthy();
    expect(within(rows[1]).getByText('先看导入流程')).toBeTruthy();
  });

  it('folds older notes behind one entry, expands them on request, and opens every channel folded', async () => {
    const user = userEvent.setup();
    const state = cliChannelState();
    state.channels[1].runtime = 'claude';
    // One loaded turn per channel, started after every note below, so none is still waiting.
    state.runs = [cliRun(), cliRun({ id: 'run-growth', channelId: 'channel-growth' })];
    const { props, api } = featureProps({ snapshot: state });
    const many = Array.from({ length: 6 }, (_, index) =>
      note(`note-${index}`, `第 ${index + 1} 条留言`, `2026-09-07T00:0${index}:00.000Z`)
    );
    api.getMessages
      .mockResolvedValueOnce({ messages: many })
      .mockResolvedValueOnce({ messages: many.slice(0, 4) })
      .mockResolvedValueOnce({ messages: many });
    const view = render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    const notes = () => within(screen.getByRole('region', { name: '留言' }));
    const texts = () =>
      notes()
        .getAllByRole('listitem')
        .map((row) => row.querySelector('p')?.textContent);
    await screen.findByText('第 6 条留言');
    // Only the newest three are open, and the entry says how many are still behind it.
    expect(texts()).toEqual(['第 6 条留言', '第 5 条留言', '第 4 条留言']);
    expect(screen.queryByText('第 3 条留言')).toBeNull();
    const entry = screen.getByText('更早的留言 · 还有 3 条');
    expect(entry.closest('details')!.open).toBe(false);
    await user.click(entry);
    await screen.findByText('第 1 条留言');
    expect(texts()).toEqual(['第 6 条留言', '第 5 条留言', '第 4 条留言', '第 3 条留言', '第 2 条留言', '第 1 条留言']);
    // Expanded, the same entry folds them back.
    await user.click(screen.getByText('更早的留言 · 3 条'));
    await waitFor(() => expect(screen.queryByText('第 1 条留言')).toBeNull());
    expect(texts()).toHaveLength(3);
    await user.click(screen.getByText('更早的留言 · 还有 3 条'));
    await screen.findByText('第 1 条留言');
    // A channel holding four notes keeps them all open: one note behind an entry saying 「还有 1
    // 条」 reads longer than the note it would hide, so the entry only appears from two up.
    view.rerender(<ChannelView {...props} snapshot={state} id="channel-growth" />);
    await screen.findByText('第 4 条留言');
    expect(texts()).toEqual(['第 4 条留言', '第 3 条留言', '第 2 条留言', '第 1 条留言']);
    expect(screen.queryByText(/^更早的留言/)).toBeNull();
    // Coming back opens folded again: one channel's expansion is not another's.
    view.rerender(<ChannelView {...props} snapshot={state} id="channel-system" />);
    await screen.findByText('第 6 条留言');
    expect(texts()).toEqual(['第 6 条留言', '第 5 条留言', '第 4 条留言']);
    expect(screen.getByText('更早的留言 · 还有 3 条').closest('details')!.open).toBe(false);
  });

  it('never folds a note that is still waiting to be read, wherever it sits in the list', async () => {
    const state = cliChannelState();
    // The one loaded turn started at 03:00, so only the notes left before it have been read.
    state.runs = [cliRun()];
    const { props, api } = featureProps({ snapshot: state });
    api.getMessages.mockResolvedValue({
      messages: [
        ...Array.from({ length: 3 }, (_, index) =>
          note(`read-${index}`, `已读留言 ${index + 1}`, `2026-09-07T00:0${index}:00.000Z`)
        ),
        ...Array.from({ length: 5 }, (_, index) =>
          note(`waiting-${index}`, `待读留言 ${index + 1}`, `2026-09-07T04:0${index}:00.000Z`)
        ),
      ],
    });
    render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    const notes = within(await screen.findByRole('region', { name: '留言' }));
    await screen.findByText('待读留言 5');
    // Five notes are waiting for an answer, so all five stay open even though only three would fit
    // the preview; 待读留言 2 and 1 sit past it and are still visible. The read ones fold instead.
    expect(notes.getAllByText('等下一轮读取')).toHaveLength(5);
    expect(notes.getAllByRole('listitem')).toHaveLength(5);
    expect(notes.getByText('待读留言 1')).toBeTruthy();
    expect(screen.queryByText('已读留言 3')).toBeNull();
    expect(screen.getByText('更早的留言 · 还有 3 条')).toBeTruthy();
  });

  it('「留言并运行一轮」 stores the note before asking for the turn, and a refused note keeps the draft', async () => {
    const user = userEvent.setup();
    const { props, api } = featureProps({ snapshot: cliChannelState() });
    render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    await screen.findByText('还没有留言。留言会在下一轮开始时随上下文交给 CLI。');
    expect(screen.getByText('频道已暂停，留言会在下一轮读取')).toBeTruthy();
    const box = screen.getByRole('textbox', { name: '给频道留言' }) as HTMLTextAreaElement;
    await user.type(box, '先合并那个分支');
    await user.click(screen.getByRole('button', { name: '留言并运行一轮' }));
    await waitFor(() => expect(api.channelAction).toHaveBeenCalledWith('channel-system', 'run'));
    expect(api.sendMessage).toHaveBeenCalledWith('channel-system', '先合并那个分支');
    expect(api.sendMessage.mock.invocationCallOrder[0]).toBeLessThan(api.channelAction.mock.invocationCallOrder[0]);
    expect(screen.getByText('已留言，正在开始一轮')).toBeTruthy();
    // A note the service refused is not lost: the draft stays and the failure is named.
    api.sendMessage.mockRejectedValueOnce(new Error('服务暂时不可用'));
    await user.type(box, '再核对重试路径');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('留言未保存：服务暂时不可用');
    expect(box.value).toBe('再核对重试路径');
  });

  it('offers no note entry on a Codex channel, which talks to its App task instead', async () => {
    const state = snapshot();
    state.projects[0].isDemo = false;
    const { props, api } = featureProps({ snapshot: state });
    render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    await screen.findByRole('heading', { name: '工作日志' });
    expect(screen.queryByRole('region', { name: '留言' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: '给频道留言' })).toBeNull();
    expect(api.getMessages).not.toHaveBeenCalled();
  });

  it('shows a CLI turn’s question read-only and sends the answer to the composer', async () => {
    const user = userEvent.setup();
    const state = cliChannelState();
    state.channels[0].status = 'blocked';
    state.channels[0].work = waitingQuestion;
    const { props, api } = featureProps({ snapshot: state });
    const view = render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    expect(screen.getByText('等你回答')).toBeTruthy();
    expect(screen.getByText('请先回答下方问题。')).toBeTruthy();
    // The question itself, and the one line saying how to answer it, are in 需要你.
    const needs = within(screen.getByRole('region', { name: '需要你' }));
    expect(needs.getByText('样本数据从哪里取？')).toBeTruthy();
    expect(needs.getByText('在下方留言框回答，然后点「留言并运行一轮」；只留言不会开始运行。')).toBeTruthy();
    // One box on the page, and it is the composer: 需要你 answers nothing by itself.
    expect(needs.queryByRole('textbox')).toBeNull();
    const boxes = screen.getAllByRole('textbox') as HTMLTextAreaElement[];
    expect(boxes.length).toBe(1);
    expect(boxes[0].getAttribute('aria-label')).toBe('给频道留言');
    expect(boxes[0].placeholder).toBe('回答上一轮的问题，或补充背景…');
    expect(screen.getByText('上一轮在等你回答：留言后点「留言并运行一轮」')).toBeTruthy();
    // The waiting question takes the page's primary action; every entry the channel needs stays.
    await user.type(boxes[0], '用 2026-08 的对账导出');
    expect((screen.getByRole('button', { name: '留言' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: '留言并运行一轮' }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole('button', { name: '频道选项' }));
    expect(screen.getByRole('menuitem', { name: '继续工作' })).toBeTruthy();
    await user.keyboard('{Escape}');
    // Once a turn has taken the answer, the CLI channel waits for its next turn, not for Codex.
    view.rerender(
      <ChannelView
        {...props}
        snapshot={{
          ...state,
          channels: state.channels.map((channel) =>
            channel.id === 'channel-system'
              ? { ...channel, status: 'paused' as const, work: { ...waitingQuestion, awaitingReply: false } }
              : channel
          ),
        }}
        id="channel-system"
      />
    );
    expect(screen.getByText('已回答，等待下一轮')).toBeTruthy();
    expect(screen.queryByRole('region', { name: '需要你' })).toBeNull();
    expect(screen.getByText('频道已暂停，留言会在下一轮读取')).toBeTruthy();
    expect(api.sendNativeMessage).not.toHaveBeenCalled();
  });

  it('leaves a Codex question answerable in place, with no note entry beside it', async () => {
    const state = snapshot();
    state.projects[0].isDemo = false;
    state.channels[0].status = 'blocked';
    state.channels[0].work = waitingQuestion;
    const { props } = featureProps({ snapshot: state });
    render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    const asked = within(await screen.findByRole('region', { name: 'Codex 需要你回答' }));
    expect(asked.getByText('样本数据从哪里取？')).toBeTruthy();
    expect(asked.getByRole('textbox', { name: '回答 Codex 的问题' })).toBeTruthy();
    expect(screen.queryByText('在下方留言框回答，然后点「留言并运行一轮」；只留言不会开始运行。')).toBeNull();
    expect(screen.queryByRole('textbox', { name: '给频道留言' })).toBeNull();
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
  const description = screen.getByRole('heading', { name: '事项说明' });
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

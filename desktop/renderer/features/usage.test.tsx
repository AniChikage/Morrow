// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectView } from './ProjectView';
import { ChannelView } from './ChannelView';
import { channelStatusLabel, formatResetTime } from '../components/format';
import { featureProps, TestProviders, timestamp } from './testFixtures';
import type { ProjectUsage, UsageReading } from '../../shared/types';

beforeEach(() => {
  localStorage.clear();
  if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const resetsAt = new Date(Date.now() + 3600_000).toISOString();
const reading: UsageReading = {
  at: new Date().toISOString(),
  source: 'protocol',
  windows: [
    { name: '5h', usedPercent: 42, resetsAt },
    { name: 'weekly', usedPercent: 10 },
  ],
};
const usage: ProjectUsage = {
  reading,
  stale: false,
  reserve: { window: '5h', keepPercent: 10 },
  budget: { window: 'weekly', limitPercent: 30 },
  project: { usedPercent: 12.5, runs: 3, windowStart: timestamp },
  gate: { blocked: false },
};

describe('the project inspector shows the account reading and edits the project cap', () => {
  it('lists each window with its reset, the reserve line and the estimated project share, then saves and clears a budget', async () => {
    const user = userEvent.setup();
    const { props, api } = featureProps();
    props.snapshot.projects[1].usageBudget = { window: 'weekly', limitPercent: 30 };
    api.getProjectUsage.mockResolvedValue(usage);
    render(<ProjectView {...props} id="project-other" />, { wrapper: TestProviders });
    const section = within(await screen.findByRole('region', { name: '额度' }));
    expect(await section.findByText(`5 小时 · 已用 42% · 重置 ${formatResetTime(resetsAt)}`)).toBeTruthy();
    expect(section.getByText('每周 · 已用 10% · 重置时间未知')).toBeTruthy();
    expect(section.getByText('保留线 · 5 小时窗口保留 10%')).toBeTruthy();
    expect(section.getByText('本项目 · 每周 · 估算已用 12.5%，上限 30%（3 轮）')).toBeTruthy();
    expect(section.queryByText('额度未知')).toBeNull();
    expect(api.getProjectUsage).toHaveBeenCalledWith('project-other');
    const windowSelect = section.getByRole('combobox', { name: '额度窗口' }) as HTMLSelectElement;
    const percent = section.getByRole('spinbutton', { name: '额度上限百分比' }) as HTMLInputElement;
    expect(windowSelect.value).toBe('weekly');
    expect(percent.value).toBe('30');
    await user.selectOptions(windowSelect, '5h');
    await user.clear(percent);
    await user.type(percent, '45');
    await user.click(section.getByRole('button', { name: '保存额度上限' }));
    expect(api.updateProjectUsageBudget).toHaveBeenCalledWith('project-other', { window: '5h', limitPercent: 45 });
    await user.click(section.getByRole('button', { name: '清除额度上限' }));
    expect(api.updateProjectUsageBudget).toHaveBeenLastCalledWith('project-other', null);
    // Out-of-range values never reach the service: the input's own min/max stops the submit.
    await user.clear(percent);
    await user.type(percent, '250');
    await user.click(section.getByRole('button', { name: '保存额度上限' }));
    expect(api.updateProjectUsageBudget).toHaveBeenCalledTimes(2);
  });

  it('marks a missing reading in red, disables the form for the demo project and counts channels waiting on usage', async () => {
    const { props, api } = featureProps();
    props.snapshot.channels[0].status = 'waiting';
    props.snapshot.channels[0].usageWait = { kind: 'reserve', window: '5h', resetsAt, since: timestamp };
    api.getProjectUsage.mockResolvedValue({ stale: true, attempted: false, gate: { blocked: false } });
    render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    const section = within(await screen.findByRole('region', { name: '额度' }));
    const unknown = await section.findByText('额度未知');
    expect(unknown.classList.contains('usage-unknown')).toBe(true);
    expect(section.getByText('尚未读取账户用量')).toBeTruthy();
    expect((section.getByRole('combobox', { name: '额度窗口' }) as HTMLSelectElement).disabled).toBe(true);
    expect((section.getByRole('button', { name: '保存额度上限' }) as HTMLButtonElement).disabled).toBe(true);
    expect(section.getByText('示例项目不能设置额度上限。')).toBeTruthy();
    expect(screen.getByText('等待额度').parentElement!.textContent).toContain('1 个频道');
    expect(api.updateProjectUsageBudget).not.toHaveBeenCalled();
  });

  it('separates a read never attempted from one that returned nothing and from a stale reading', async () => {
    const cases: Array<[ProjectUsage, string]> = [
      [{ stale: true, attempted: false, gate: { blocked: false } }, '尚未读取账户用量'],
      [
        { stale: true, attempted: true, lastError: '原生后台没有返回额度读数', gate: { blocked: false } },
        '协议未返回账户用量',
      ],
      [{ reading, stale: true, attempted: true, gate: { blocked: false } }, '读数已过期'],
    ];
    for (const [value, expected] of cases) {
      const { props, api } = featureProps();
      api.getProjectUsage.mockResolvedValue(value);
      const view = render(<ProjectView {...props} id="project-other" />, { wrapper: TestProviders });
      const section = within(await screen.findByRole('region', { name: '额度' }));
      expect(await section.findByText(expected)).toBeTruthy();
      expect(section.getByText('额度未知').classList.contains('usage-unknown')).toBe(true);
      if (value.lastError) expect(section.getByText(expected).getAttribute('title')).toBe(value.lastError);
      view.unmount();
      cleanup();
    }
  });

  it('keeps the goal readable when the connected service has no usage routes', async () => {
    const { props, api } = featureProps();
    delete (api as { getProjectUsage?: unknown }).getProjectUsage;
    render(<ProjectView {...props} id="project-other" />, { wrapper: TestProviders });
    const section = within(await screen.findByRole('region', { name: '额度' }));
    expect(section.getByText('当前连接的 Morrow 服务尚不支持额度读数。')).toBeTruthy();
    expect(section.queryByRole('button', { name: '保存额度上限' })).toBeNull();
  });
});

describe('a channel held by the usage gate says so wherever its status is shown', () => {
  it('labels usage waits with the reset time and leaves other statuses alone', () => {
    const since = timestamp;
    expect(
      channelStatusLabel({ status: 'waiting', nextRunAt: '', usageWait: { kind: 'reserve', resetsAt, since } })
    ).toBe(`等待额度重置 · ${formatResetTime(resetsAt)}`);
    expect(channelStatusLabel({ status: 'waiting', nextRunAt: resetsAt, usageWait: { kind: 'budget', since } })).toBe(
      `等待额度重置 · ${formatResetTime(resetsAt)}`
    );
    expect(channelStatusLabel({ status: 'waiting', nextRunAt: resetsAt, usageWait: { kind: 'unknown', since } })).toBe(
      `额度未知，等待重试 · ${formatResetTime(resetsAt)}`
    );
    expect(channelStatusLabel({ status: 'paused', nextRunAt: '', usageWait: { kind: 'reserve', since } })).toBe(
      '已暂停'
    );
    expect(channelStatusLabel({ status: 'waiting', nextRunAt: resetsAt })).toBe('等待执行');
    expect(formatResetTime(undefined)).toBe('重置时间未知');
    expect(formatResetTime('not a date')).toBe('重置时间未知');
    expect(formatResetTime(resetsAt)).toMatch(/^(今天|明天) \d{2}:\d{2}$/);
  });

  it('shows the wait in the channel heading for demo and native channels and in the inspector status', async () => {
    const { props } = featureProps();
    const label = `等待额度重置 · ${formatResetTime(resetsAt)}`;
    for (const channel of props.snapshot.channels) {
      channel.status = 'waiting';
      channel.nextRunAt = resetsAt;
      channel.autonomyEnabled = true;
      channel.usageWait = { kind: 'reserve', window: '5h', resetsAt, since: timestamp };
    }
    const demo = render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    expect(within(screen.getByRole('heading', { name: '系统完善' }).parentElement!).getByText(label)).toBeTruthy();
    expect(screen.getByText('状态').parentElement!.textContent).toContain(label);
    demo.unmount();
    render(<ChannelView {...props} id="channel-other" />, { wrapper: TestProviders });
    await waitFor(() =>
      expect(within(document.querySelector('.channel-title') as HTMLElement).getByText(label)).toBeTruthy()
    );
    expect(screen.queryByText('已安排下一步')).toBeNull();
  });
});

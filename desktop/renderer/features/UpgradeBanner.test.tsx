// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpgradeBanner } from './UpgradeBanner';
import { upgradeSwitching } from './upgradeState';
import { featureProps, TestProviders } from './testFixtures';
import type { Snapshot, UpgradeBlocker, UpgradeRecord, UpgradeState } from '../../shared/types';

const target = 'b'.repeat(64);
function upgrade(patch: Partial<UpgradeRecord> = {}): UpgradeRecord {
  return {
    id: target,
    releaseId: 'release-1',
    targetCommit: 'c'.repeat(40),
    targetFingerprint: target,
    installedBundle: '/Users/someone/Applications/Morrow.app',
    fromBootId: 'boot-1',
    phase: 'draining',
    requestedAt: '2026-09-11T00:00:00.000Z',
    updatedAt: '2026-09-11T00:00:00.000Z',
    ...patch,
  };
}
function state(blockers: UpgradeBlocker[] = [], patch: Partial<UpgradeRecord> = {}): UpgradeState {
  return {
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
    idle: !blockers.length,
    blockers,
    upgrade: upgrade(patch),
  };
}
function banner(value?: UpgradeState) {
  const { props, api } = featureProps();
  const snapshot: Snapshot = { ...props.snapshot, ...(value ? { upgrade: value } : {}) };
  const onRefresh = vi.fn();
  const onMutate = vi.fn(async (action: () => Promise<unknown>) => {
    await action();
    return true;
  });
  render(
    <TestProviders>
      <UpgradeBanner snapshot={snapshot} api={props.api} busy={false} onMutate={onMutate} onRefresh={onRefresh} />
    </TestProviders>
  );
  return { api, onRefresh, onMutate, snapshot };
}

const text = () => screen.getByRole('status').textContent || '';
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('the installed-version banner', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it('says nothing at all when no new version is installed', () => {
    banner();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('names how many pieces of work are still running, lists them on request, and cannot restart yet', async () => {
    const blockers: UpgradeBlocker[] = [
      { kind: 'run', label: '频道「系统完善」正在执行' },
      { kind: 'review', label: '独立复核正在进行' },
    ];
    const { api } = banner(state(blockers));
    expect(text()).toContain('新版本已安装，等待 2 项工作结束');
    expect(text()).toContain('工作结束后自动切换，不会中断当前工作');
    const restart = button('立即重启');
    expect(restart.disabled).toBe(true);
    expect(restart.getAttribute('title')).toBe('有工作正在进行，不会被中断');
    expect(screen.queryByLabelText('阻塞切换的工作')).toBeNull();
    await userEvent.click(button('查看阻塞工作'));
    const list = screen.getByLabelText('阻塞切换的工作');
    expect(list.textContent).toContain('频道「系统完善」正在执行');
    expect(list.textContent).toContain('独立复核正在进行');
    await userEvent.click(button('收起阻塞工作'));
    expect(screen.queryByLabelText('阻塞切换的工作')).toBeNull();
    expect(api.requestUpgradeRestart).not.toHaveBeenCalled();
  });

  it('offers an early restart once the service is idle', async () => {
    const { api, onMutate } = banner(state());
    expect(text()).toContain('新版本已安装，即将自动切换');
    expect(screen.queryByRole('button', { name: '查看阻塞工作' })).toBeNull();
    await userEvent.click(button('立即重启'));
    expect(onMutate).toHaveBeenCalledTimes(1);
    expect(api.requestUpgradeRestart).toHaveBeenCalledTimes(1);
  });

  it('reports the handover itself without any control that would start work', () => {
    banner(state([], { phase: 'exiting', acknowledgedAt: '2026-09-11T00:05:00.000Z' }));
    expect(text()).toContain('正在切换到新版本，稍后会自动回到当前页面');
    expect(screen.queryByRole('button', { name: '立即重启' })).toBeNull();
    expect(screen.queryByRole('button', { name: '重试切换' })).toBeNull();
  });

  it('shows the switched version once and remembers that it was seen', async () => {
    const applied = state([], { phase: 'applied', appliedAt: new Date().toISOString() });
    banner(applied);
    expect(text()).toContain('已切换到新版本（0.9.7 · cccccccccccc）');
    await userEvent.click(button('知道了'));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(localStorage.getItem('morrow:upgrade-seen')).toBe(target);
    // A later render of the same finished switch stays quiet.
    banner(applied);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not keep reporting a switch that finished long ago', () => {
    banner(state([], { phase: 'applied', appliedAt: '2026-09-01T00:00:00.000Z' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('states the phase and reason of a failed switch and offers a check and a retry, never pkill', async () => {
    const { api, onRefresh } = banner(
      state([], { phase: 'blocked', error: '等待旧服务退出超时，已停止切换；当前版本继续运行，可稍后重试。' })
    );
    expect(text()).toContain('切换未完成（已停止）：等待旧服务退出超时');
    expect(text()).not.toMatch(/pkill|kill|终止进程/);
    await userEvent.click(button('重新检查'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await userEvent.click(button('重试切换'));
    expect(api.requestUpgradeRestart).toHaveBeenCalledTimes(1);
  });

  it('falls back to a readable line when a blocked switch recorded no reason', () => {
    banner(state([], { phase: 'blocked' }));
    expect(text()).toContain('原因未记录');
  });

  it('treats an acknowledged drain as the handover, and a waiting one as still waiting', () => {
    const snapshot = (value: UpgradeState): Snapshot => ({ ...featureProps().props.snapshot, upgrade: value });
    expect(upgradeSwitching(snapshot(state([{ kind: 'run', label: '频道「系统完善」正在执行' }])))).toBe(false);
    expect(upgradeSwitching(snapshot(state()))).toBe(false);
    expect(upgradeSwitching(snapshot(state([], { acknowledgedAt: '2026-09-11T00:05:00.000Z' })))).toBe(true);
    expect(upgradeSwitching(snapshot(state([], { phase: 'exiting' })))).toBe(true);
    expect(upgradeSwitching(featureProps().props.snapshot)).toBe(false);
  });
});

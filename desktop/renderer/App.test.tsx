// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import { emptySnapshot, type ConnectionInfo, type DesktopAPI, type Snapshot } from '../shared/types';

const api = {
  getState: vi.fn(),
  getConnection: vi.fn(),
  connect: vi.fn(),
  onCommand: vi.fn(() => () => {}),
  openProjectFolder: vi.fn(),
  loadDemo: vi.fn(),
} as unknown as DesktopAPI;
window.morrow = api;
const { WorkspaceProvider } = await import('./state/workspace');
const { default: App } = await import('./App');

const timestamp = '2026-09-07T02:00:00.000Z';
const state = (): Snapshot => ({
  ...emptySnapshot,
  projects: [
    { id: 'project-atlas', name: 'Atlas', path: '/atlas', goal: '改善可靠性。', createdAt: timestamp, isDemo: false },
  ],
});
const local: ConnectionInfo = {
  config: { mode: 'local', host: '', port: 43821, directory: '/local' },
  name: '本机 Mac',
  connected: true,
};
const down = '无法连接执行服务，请检查服务是否运行。';
const getState = vi.mocked(api.getState);
const getConnection = vi.mocked(api.getConnection);
const connect = vi.mocked(api.connect);
const wrapper = ({ children }: { children: ReactNode }) => (
  <Tooltip.Provider delayDuration={0}>
    <WorkspaceProvider>{children}</WorkspaceProvider>
  </Tooltip.Provider>
);
const poll = () => act(async () => void window.dispatchEvent(new Event('focus')));
const banner = () => screen.queryByRole('status', { name: '执行服务离线' });

beforeEach(() => {
  localStorage.clear();
  getState.mockReset().mockResolvedValue(state());
  getConnection.mockReset().mockResolvedValue(local);
  connect.mockReset().mockResolvedValue(local);
  if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function loaded() {
  render(<App />, { wrapper });
  await waitFor(() => expect(screen.queryByText(/正在启动执行服务…|正在读取工作空间…/)).toBeNull());
}

it('marks a dead service as stale data with a standing banner instead of silently showing old state', async () => {
  await loaded();
  expect(banner()).toBeNull();
  getState.mockRejectedValue(new Error(down));
  getConnection.mockResolvedValue({ ...local, connected: false, error: down });
  await poll();
  // The project stays readable, but nothing on screen claims to be current any more.
  expect(screen.getAllByText('Atlas').length).toBeGreaterThan(0);
  expect(banner()!.textContent).toMatch(/^执行服务未响应，显示的是 \d{2}:\d{2} 之前的数据。/);
  expect(screen.getByRole('alert').textContent).toContain(down);
  getState.mockResolvedValue(state());
  getConnection.mockResolvedValue(local);
  await userEvent.setup().click(within(banner()!).getByRole('button', { name: '重新连接' }));
  // switchConnection is the only path that runs ensureLocalService again; refresh alone cannot.
  expect(connect).toHaveBeenCalledWith(local.config);
  await waitFor(() => expect(banner()).toBeNull());
  expect(screen.queryByRole('alert')).toBeNull();
});

it('reconnects from the error toast while offline and does not raise the same error again after it is closed', async () => {
  const user = userEvent.setup();
  await loaded();
  getState.mockRejectedValue(new Error(down));
  getConnection.mockResolvedValue({ ...local, connected: false, error: down });
  await poll();
  await user.click(within(screen.getByRole('alert')).getByRole('button', { name: '重新连接' }));
  expect(connect).toHaveBeenCalledWith(local.config);
  connect.mockClear();
  await poll();
  await user.click(within(screen.getByRole('alert')).getByRole('button', { name: '关闭提示' }));
  expect(screen.queryByRole('alert')).toBeNull();
  await poll();
  await poll();
  // Dismissed once is dismissed: the standing banner keeps saying the service is gone.
  expect(screen.queryByRole('alert')).toBeNull();
  expect(banner()).toBeTruthy();
  expect(connect).not.toHaveBeenCalled();
});

it('offers reconnecting on a cold start that never reached the service', async () => {
  getState.mockRejectedValue(new Error(down));
  getConnection.mockResolvedValue({ ...local, connected: false, error: down });
  render(<App />, { wrapper });
  await screen.findByRole('heading', { name: '连接执行服务' });
  expect(banner()).toBeNull();
  await userEvent.setup().click(screen.getByRole('button', { name: '重新连接' }));
  expect(connect).toHaveBeenCalledWith(local.config);
});

it('names the startup phase and says where the service log is when the first read stays slow', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  getState.mockReturnValue(new Promise(() => {}));
  getConnection.mockReturnValue(new Promise(() => {}));
  render(<App />, { wrapper });
  expect(screen.getByText('正在启动执行服务…')).toBeTruthy();
  expect(screen.queryByText(/service\.log/)).toBeNull();
  act(() => void vi.advanceTimersByTime(8000));
  expect(screen.getByText('仍在启动，日志在数据目录的 service.log。')).toBeTruthy();
});

it('separates starting the service from reading the workspace while a chosen target connects', async () => {
  const user = userEvent.setup();
  await loaded();
  let answer!: (info: ConnectionInfo) => void;
  connect.mockReturnValue(
    new Promise<ConnectionInfo>((resolve) => {
      answer = resolve;
    })
  );
  getState.mockReturnValue(new Promise(() => {}));
  await user.click(screen.getByRole('button', { name: '设置' }));
  await user.click(await screen.findByRole('button', { name: '连接' }));
  expect(screen.getByText('正在启动执行服务…')).toBeTruthy();
  await act(async () => void answer(local));
  expect(screen.getByText('正在读取工作空间…')).toBeTruthy();
});

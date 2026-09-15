// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import {
  emptySnapshot,
  type Channel,
  type ConnectionInfo,
  type DesktopAPI,
  type NativeConnectionStatus,
  type Project,
  type Runtime,
  type Snapshot,
  type WorkItem,
} from '../shared/types';

/**
 * The packaged app takes its shortcuts from the native menu, which calls the same `onCommand` these
 * tests drive; the browser preview installs the in-app key handler instead. Reporting the preview
 * here is what puts the ⌘ key mapping itself under test.
 */
vi.mock('./state/workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./state/workspace')>()),
  isDesktop: false,
}));

const nativeStatus: NativeConnectionStatus = {
  available: true,
  connected: true,
  appInstalled: true,
  boundThreadCount: 0,
  detail: 'Codex App 已连接',
  capabilities: { list: true, read: true, send: true, create: true, interrupt: true, respond: true },
};
const api = {
  getState: vi.fn(),
  getConnection: vi.fn(),
  connect: vi.fn(),
  onCommand: vi.fn(() => () => {}),
  openProjectFolder: vi.fn(),
  loadDemo: vi.fn(),
  getRuns: vi.fn(async () => ({ runs: [], hasMore: false })),
  getNativeStatus: vi.fn(async () => nativeStatus),
  getNativeConversation: vi.fn(async (channelId: string) => ({
    channelId,
    status: nativeStatus,
    items: [],
    requests: [],
    hasMore: false,
  })),
  getEvents: vi.fn(async () => ({ events: [], hasMore: false })),
} as unknown as DesktopAPI;
window.morrow = api;
const { WorkspaceProvider } = await import('./state/workspace');
const { default: App } = await import('./App');

const timestamp = '2026-09-07T02:00:00.000Z';
const project = (id: string, name: string, isDemo = false): Project => ({
  id,
  name,
  path: `/${id}`,
  goal: '改善可靠性。',
  createdAt: timestamp,
  isDemo,
});
const channel = (id: string, name: string, projectId = 'project-atlas'): Channel => ({
  id,
  projectId,
  name,
  goal: '持续验证问题并记录证据。',
  runtime: 'codex',
  model: '',
  status: 'paused',
  intervalMinutes: 60,
  maxRunsPerDay: 8,
  permission: 'read-only',
  nextRunAt: '',
  lastRunAt: '',
  sessionId: '',
});
const boardItem = (): WorkItem => ({
  id: 'finding-import',
  channelId: 'channel-system',
  title: 'CSV 重试会重复提交',
  summary: '导入超时后再次提交，产生两条重复记录。',
  status: 'open',
  kind: 'issue',
  evidence: ['日志包含 request-17。'],
  nextStep: '验证幂等键。',
  createdAt: timestamp,
  updatedAt: timestamp,
});
const codexRuntime: Runtime = {
  id: 'codex',
  name: 'Codex',
  available: true,
  path: '/usr/local/bin/codex',
  version: '1.0.0',
  detail: '',
  canWrite: true,
};
const state = (): Snapshot => ({ ...emptySnapshot, projects: [project('project-atlas', 'Atlas')] });
/** A ⌘ shortcut as the preview window receives it. */
const press = (key: string) =>
  act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, cancelable: true })));
/**
 * A pointer step as a `MouseEvent` under the pointer event's name: jsdom's own `PointerEvent`
 * support varies, while `clientX` is what the resize handler actually reads.
 */
const pointer = (node: Element, type: 'pointerdown' | 'pointermove' | 'pointerup', clientX: number) =>
  act(() => void node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX })));
/** Only the window's own tab strip: the project page has feature tabs of its own. */
const tabStrip = () => screen.getByRole('tablist', { name: '打开的页面' });
const openTabs = () =>
  within(tabStrip())
    .getAllByRole('tab')
    .map((tab) => tab.textContent);
const selectedTab = () => within(tabStrip()).getByRole('tab', { selected: true }).textContent;
const onTab = async (name: string) =>
  within(await screen.findByRole('tablist', { name: '打开的页面' })).getByRole('tab', { name });
/** The default project tab is opened by an effect, once the first read has landed. */
const started = (name: string) => waitFor(() => expect(selectedTab()).toBe(name));
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
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
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

it('runs every window shortcut: search, new project, settings, the sidebar, tab history and closing a tab', async () => {
  const user = userEvent.setup();
  getState.mockResolvedValue({ ...state(), channels: [channel('channel-system', '系统完善')] });
  await loaded();
  press('k');
  expect(await screen.findByRole('dialog', { name: '搜索工作空间' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '关闭' }));
  press('n');
  expect(await screen.findByRole('dialog', { name: '接入项目文件夹' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '关闭' }));
  press(',');
  expect(await screen.findByRole('dialog', { name: '设置' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '关闭' }));
  // ⌘B hides the navigation and remembers that it is hidden.
  expect(screen.getByRole('complementary', { name: '工作区导航' })).toBeTruthy();
  press('b');
  expect(screen.queryByRole('complementary', { name: '工作区导航' })).toBeNull();
  expect(localStorage.getItem('morrow:sidebar')).toBe('closed');
  press('b');
  expect(screen.getByRole('complementary', { name: '工作区导航' })).toBeTruthy();
  expect(localStorage.getItem('morrow:sidebar')).toBe('open');
  // ⌘[ and ⌘] walk this tab's own history rather than switching between tabs.
  await started('Atlas');
  await user.click(screen.getByRole('button', { name: '系统完善' }));
  expect(selectedTab()).toBe('系统完善');
  expect(openTabs()).toHaveLength(1);
  press('[');
  expect(selectedTab()).toBe('Atlas');
  press(']');
  expect(selectedTab()).toBe('系统完善');
  // ⌘W closes the tab in front, leaving the one behind it open and active.
  await user.click(screen.getByRole('button', { name: 'Atlas 的看板' }));
  expect(openTabs()).toEqual(['系统完善', 'Atlas']);
  press('w');
  expect(openTabs()).toEqual(['系统完善']);
  expect(selectedTab()).toBe('系统完善');
});

it('does not pop the tooltip of the button a dialog moves focus to, but still shows it on Tab', async () => {
  const user = userEvent.setup();
  await loaded();
  await started('Atlas');
  press(',');
  const dialog = await screen.findByRole('dialog', { name: '设置' });
  const close = within(dialog).getByRole('button', { name: '关闭' });
  // The dialog focuses its close button on open; nobody asked to read its label.
  await waitFor(() => expect(document.activeElement).toBe(close));
  expect(screen.queryByRole('tooltip')).toBeNull();
  // Reaching the same button from the keyboard is a different matter.
  close.blur();
  await user.keyboard('{Tab}');
  close.focus();
  expect(await screen.findByRole('tooltip')).toBeTruthy();
});

it('keeps the tab strip a list of tabs, with each close button beside its tab rather than inside it', async () => {
  const user = userEvent.setup();
  getState.mockResolvedValue({ ...state(), channels: [channel('channel-system', '系统完善')] });
  await loaded();
  await started('Atlas');
  await user.click(screen.getByRole('button', { name: '系统完善' }));
  await user.click(screen.getByRole('button', { name: 'Atlas 的看板' }));
  expect(openTabs()).toEqual(['系统完善', 'Atlas']);
  const strip = tabStrip();
  // The tablist owns tabs only: each close button is a sibling inside a wrapper that is not a tab.
  expect(within(strip).getAllByRole('tab')).toHaveLength(2);
  const tab = within(strip).getByRole('tab', { name: 'Atlas' });
  const close = within(strip).getByRole('button', { name: '关闭 Atlas' });
  expect(tab.contains(close)).toBe(false);
  expect(close.parentElement).toBe(tab.parentElement);
  expect(tab.parentElement?.getAttribute('role')).toBe('presentation');
  await user.click(close);
  expect(openTabs()).toEqual(['系统完善']);
});

it('remembers a navigation width set by dragging the divider, within its own bounds', async () => {
  await loaded();
  const divider = screen.getByRole('separator', { name: '调整导航栏宽度' });
  expect(divider.getAttribute('aria-valuenow')).toBe('236');
  pointer(divider, 'pointerdown', 100);
  pointer(divider, 'pointermove', 140);
  expect(divider.getAttribute('aria-valuenow')).toBe('276');
  // The drag stays inside the declared range whatever the pointer does.
  pointer(divider, 'pointermove', 400);
  expect(divider.getAttribute('aria-valuenow')).toBe('300');
  pointer(divider, 'pointermove', 160);
  expect(localStorage.getItem('morrow:sidebar-width')).toBeNull(); // Saved on release, not per step.
  pointer(divider, 'pointerup', 160);
  expect(divider.getAttribute('aria-valuenow')).toBe('296');
  expect(localStorage.getItem('morrow:sidebar-width')).toBe('296');
  // Moving after the release is no longer part of the drag.
  pointer(divider, 'pointermove', 300);
  expect(divider.getAttribute('aria-valuenow')).toBe('296');
  cleanup();
  await loaded();
  expect(screen.getByRole('separator', { name: '调整导航栏宽度' }).getAttribute('aria-valuenow')).toBe('296');
});

it('puts a tab back where it was scrolled to when you return to it', async () => {
  const scrolled = new WeakMap<object, number>();
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');
  // jsdom has no layout, so scrollTop is a fixed 0 there; this makes the round trip observable.
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: object) {
      return scrolled.get(this) ?? 0;
    },
    set(this: object, value: number) {
      scrolled.set(this, value);
    },
  });
  try {
    const user = userEvent.setup();
    getState.mockResolvedValue({
      ...state(),
      channels: [channel('channel-system', '系统完善')],
      items: [boardItem()],
    });
    await loaded();
    await started('Atlas');
    const board = document.querySelector<HTMLElement>('.feature-scroll')!;
    board.scrollTop = 180;
    fireEvent.scroll(board);
    await user.click(screen.getByRole('button', { name: '系统完善' }));
    expect(selectedTab()).toBe('系统完善');
    press('[');
    expect(selectedTab()).toBe('Atlas');
    // A different element, since the page was unmounted and built again — at the same place.
    const restored = document.querySelector<HTMLElement>('.feature-scroll')!;
    expect(restored).not.toBe(board);
    expect(restored.scrollTop).toBe(180);
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, 'scrollTop', original);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTop');
  }
});

it('opens a real project rather than the demo on start, and keeps the runtime page on the project last opened', async () => {
  const user = userEvent.setup();
  getState.mockResolvedValue({
    ...state(),
    projects: [
      project('project-demo', '示例项目', true),
      project('project-atlas', 'Atlas'),
      project('project-nova', 'Nova'),
    ],
    channels: [
      channel('channel-system', '系统完善'),
      channel('channel-growth', '运营洞察'),
      channel('channel-nova-one', 'Nova 甲', 'project-nova'),
      channel('channel-nova-two', 'Nova 乙', 'project-nova'),
    ],
    runtimes: [codexRuntime],
  });
  await loaded();
  // The demo project comes first in the snapshot and is still not what the app opens.
  await started('Atlas');
  const targets = async () =>
    Array.from((await screen.findByRole('combobox', { name: '选择频道' })).querySelectorAll('option')).map(
      (option) => option.textContent
    );
  await user.click(screen.getByRole('button', { name: '运行时' }));
  // The runtime page acts on the project most recently opened, not on the first Codex channel.
  expect(await targets()).toEqual(['Atlas / 系统完善', 'Atlas / 运营洞察']);
  await user.click(screen.getByRole('button', { name: 'Nova 的看板' }));
  await user.click(await onTab('运行时'));
  expect(await targets()).toEqual(['Nova / Nova 甲', 'Nova / Nova 乙']);
});

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

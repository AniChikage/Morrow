// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RuntimesView } from './RuntimesView';
import { featureProps, snapshot } from './testFixtures';
import { formatResetTime } from '../components/format';
import { previewAPI } from '../state/preview';
import type { ConnectionInfo, NativeConnectionStatus, Runtime } from '../../shared/types';

afterEach(cleanup);
const installed: Runtime = {
  id: 'codex',
  name: 'Codex',
  available: true,
  path: '/opt/homebrew/bin/codex',
  version: 'codex-cli 0.100.0',
  detail: 'CLI 已安装，尚未验证登录和配额。',
  canWrite: true,
};
function runtimeProps(runtimes: Runtime[] = [installed]) {
  const state = snapshot();
  state.runtimes = runtimes;
  return featureProps({ snapshot: state });
}
const capabilities = (on: boolean) => ({ list: on, read: on, send: on, create: false, interrupt: on, respond: on });
function status(patch: Partial<NativeConnectionStatus> = {}): NativeConnectionStatus {
  const connected = !!patch.connected;
  return {
    available: connected,
    connected,
    detail: connected ? '已连接 Codex App。' : '请启动 Codex App 后重新连接。',
    appInstalled: connected,
    capabilities: capabilities(connected),
    ...patch,
  };
}
const remote: ConnectionInfo = {
  name: '远程 · dev-box',
  connected: true,
  config: { mode: 'ssh', host: 'dev-box', port: 43821, directory: '~/.local/share/morrow' },
};
const checklist = () => screen.findByRole('list', { name: 'Codex App 连接清单' });
/** done: green dot; next: amber dot marking the first unmet step; pending: gray. */
function step(label: string) {
  const item = screen.getByText(label).closest('li')!;
  return item.classList.contains('detected') ? 'done' : item.classList.contains('attention') ? 'next' : 'pending';
}
const nextStep = () => screen.getByText('下一步').parentElement!;

test('CLI detection stays separate from authentication and details are progressively disclosed while App status is unknown', async () => {
  const { props, api } = runtimeProps();
  // Until the App status answers, the Codex row can only report what the CLI probe found.
  api.getNativeStatus.mockImplementation(() => new Promise(() => {}));
  render(<RuntimesView {...props} />);
  expect(screen.getByText('已检测到')).toBeTruthy();
  expect(screen.getByText('待验证')).toBeTruthy();
  expect(screen.queryByText('已登录')).toBeNull();
  expect(screen.queryByText(installed.path)).toBeNull();
  expect(screen.queryByRole('list', { name: 'Codex App 连接清单' })).toBeNull();
  const row = screen.getByRole('button', { name: 'Codex，已检测到，查看详情' });
  expect(row.getAttribute('aria-expanded')).toBe('false');
  await userEvent.setup().click(row);
  const details = within(screen.getByRole('region', { name: 'Codex 详情' }));
  expect(details.getByText(installed.path)).toBeTruthy();
  expect(details.getByText('自动轮次默认沿用 App 任务设置；每个频道可单独收紧为只读或工作区编辑。')).toBeTruthy();
  expect(details.getByText(/登录状态与配额在实际执行时验证/)).toBeTruthy();
  expect(row.getAttribute('aria-expanded')).toBe('true');
  expect(screen.queryByRole('button', { name: /安装|登录|配置/ })).toBeNull();
});

test('Codex reports the live App connection and bundle version separately from the installed CLI used for review', async () => {
  const { props, api } = runtimeProps();
  api.getNativeStatus.mockResolvedValue(
    status({ connected: true, detail: '原生会话连接已建立', appVersion: '1.0-test', runtimeVersion: 'app-server/7' })
  );
  render(<RuntimesView {...props} />);
  const row = await screen.findByRole('button', { name: 'Codex，App 已连接，查看详情' });
  expect(within(row).getByText('由 App 管理')).toBeTruthy();
  // The version column belongs to the App; the CLI version moves into the details.
  expect(within(row).getByText('1.0-test')).toBeTruthy();
  expect(within(row).queryByText(installed.version)).toBeNull();
  await userEvent.setup().click(row);
  const details = within(screen.getByRole('region', { name: 'Codex 详情' }));
  expect(details.getByText('原生会话连接已建立')).toBeTruthy();
  expect(details.getByText('app-server/7')).toBeTruthy();
  expect(details.getByText(installed.version)).toBeTruthy();
  expect(details.getByText(installed.path)).toBeTruthy();
  expect(screen.queryByText('已登录')).toBeNull();
});

test('the checklist marks the first unmet step and names installing, then opening the App', async () => {
  const { props, api } = runtimeProps();
  api.getNativeStatus.mockResolvedValue(status({ appInstalled: false }));
  render(<RuntimesView {...props} />);
  await checklist();
  expect(step('Codex App 已安装')).toBe('next');
  expect(step('App 已连接')).toBe('pending');
  expect(step('任务已关联')).toBe('pending');
  expect(step('关联任务可用')).toBe('pending');
  expect(nextStep().textContent).toBe('下一步安装并登录 Codex App');
  expect(screen.queryByRole('button', { name: /启用后台连接|撤销设置/ })).toBeNull();
  cleanup();
  api.getNativeStatus.mockResolvedValue(status({ appInstalled: true, appVersion: '1.2.3' }));
  render(<RuntimesView {...props} />);
  const list = within(await checklist());
  expect(step('Codex App 已安装')).toBe('done');
  expect(list.getByText('1.2.3')).toBeTruthy();
  expect(step('App 已连接')).toBe('next');
  expect(nextStep().textContent).toBe('下一步打开 Codex App');
  expect(screen.queryByRole('button', { name: /启用后台连接|撤销设置/ })).toBeNull();
});

test('preview installation status stays unknown and shows the preview explanation', async () => {
  const { props, api } = runtimeProps();
  const previewStatus = await previewAPI().getNativeStatus();
  api.getNativeStatus.mockResolvedValue(previewStatus);
  render(<RuntimesView {...props} />);
  await checklist();
  expect(step('Codex App 安装状态未知')).toBe('next');
  expect(nextStep().textContent).toContain(previewStatus.detail);
  expect(screen.queryByText('安装并登录 Codex App')).toBeNull();
});

test('missing installation metadata does not hide a confirmed App connection', async () => {
  const { props, api } = runtimeProps();
  api.getNativeStatus.mockResolvedValue(status({ connected: true, appInstalled: undefined }));
  render(<RuntimesView {...props} />);
  await checklist();
  expect(step('Codex App 已安装')).toBe('done');
  expect(step('任务已关联')).toBe('next');
  expect(screen.getByRole('button', { name: '去关联任务' })).toBeTruthy();
});

test('a connected App guides task association without enabling a launcher', async () => {
  const { props, api } = runtimeProps();
  props.api.setupNativeBackground = vi.fn();
  api.getNativeStatus.mockResolvedValue(
    status({ connected: true, connectionMode: 'app-follower', boundThreadCount: 0, readyThreadCount: 0 })
  );
  render(<RuntimesView {...props} />);
  await checklist();
  expect(step('任务已关联')).toBe('next');
  expect(screen.queryByRole('button', { name: '启用后台连接' })).toBeNull();
  await userEvent.setup().click(screen.getByRole('button', { name: '去关联任务' }));
  expect(props.onNavigate).toHaveBeenCalledWith({
    kind: 'channel',
    id: props.snapshot.channels.find((c) => c.runtime === 'codex')!.id,
  });
  expect(props.api.setupNativeBackground).not.toHaveBeenCalled();
  expect(api.openNativeApp).not.toHaveBeenCalled();
});
test('associated tasks must actually be available before the checklist says ready', async () => {
  const { props, api } = runtimeProps();
  api.getNativeStatus.mockResolvedValue(status({ connected: true, boundThreadCount: 1, readyThreadCount: 0 }));
  const view = render(<RuntimesView {...props} />);
  await checklist();
  expect(step('任务已关联')).toBe('done');
  expect(step('关联任务可用')).toBe('next');
  expect(nextStep().textContent).toContain('在 Codex App 打开已关联任务');
  view.unmount();
  api.getNativeStatus.mockResolvedValue(status({ connected: true, boundThreadCount: 1, readyThreadCount: 1 }));
  render(<RuntimesView {...props} />);
  await checklist();
  expect(step('关联任务可用')).toBe('done');
  expect(nextStep().textContent).toContain('已就绪');
});
test('legacy cleanup rereads status, while SSH only explains the host-side task setup', async () => {
  const { props, api } = runtimeProps();
  props.api.restoreNativeBackground = vi.fn(async () => ({ restartRequired: false, detail: '已清理旧转接' }));
  api.getNativeStatus
    .mockResolvedValueOnce(status({ connected: true, backgroundConfigured: true }))
    .mockResolvedValue(status({ connected: true }));
  render(<RuntimesView {...props} />);
  await checklist();
  await userEvent.setup().click(screen.getByRole('button', { name: '清理旧转接设置' }));
  await waitFor(() => expect(props.api.restoreNativeBackground).toHaveBeenCalledTimes(1));
  expect(api.getNativeStatus).toHaveBeenCalledTimes(2);
  cleanup();
  api.getNativeStatus.mockResolvedValue(status({ connected: true, backgroundConfigured: true }));
  render(<RuntimesView {...props} connection={remote} />);
  await checklist();
  expect(screen.getByText('请在执行主机的 Codex App 中创建并打开任务。')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '清理旧转接设置' })).toBeNull();
});

test('an unreachable service shows no checklist instead of a guessed next step', async () => {
  const { props, api } = runtimeProps();
  api.getNativeStatus.mockRejectedValue(new Error('service down'));
  render(<RuntimesView {...props} />);
  const row = await screen.findByRole('button', { name: 'Codex，App 未连接，查看详情' });
  expect(screen.queryByRole('list', { name: 'Codex App 连接清单' })).toBeNull();
  expect(screen.queryByText('下一步')).toBeNull();
  await userEvent.setup().click(row);
  expect(within(screen.getByRole('region', { name: 'Codex 详情' })).getByText('暂时无法连接 Codex App。')).toBeTruthy();
});

test('an installed but incompatible CLI differs from a CLI missing from PATH, and retired runtimes are never listed', () => {
  const { props, api } = runtimeProps([
    { ...installed, available: false, detail: '当前 CLI 版本缺少必要的安全或结构化输出选项，请升级。' },
  ]);
  // A channel left over from a retired runtime is not counted against the Codex row and gets no row of its own.
  props.snapshot.channels[1].runtime = 'claude';
  api.getNativeStatus.mockImplementation(() => new Promise(() => {}));
  const view = render(<RuntimesView {...props} />);
  expect(screen.getByRole('button', { name: 'Codex，需检查，查看详情' })).toBeTruthy();
  expect(screen.getByText('2 个频道')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Claude Code|Trae/ })).toBeNull();
  expect(screen.getAllByRole('button', { name: /查看详情/ })).toHaveLength(1);
  view.rerender(
    <RuntimesView
      {...props}
      snapshot={{
        ...props.snapshot,
        runtimes: [{ ...installed, available: false, path: '', version: '', canWrite: false }],
      }}
    />
  );
  expect(screen.getByRole('button', { name: 'Codex，未检测到，查看详情' })).toBeTruthy();
  expect(screen.queryByText('已检测到')).toBeNull();
});

test('usage links open an actual channel without starting execution', async () => {
  const { props, api } = runtimeProps();
  props.snapshot.channels[0].status = 'running';
  render(<RuntimesView {...props} />);
  expect(screen.getByText('1 运行中')).toBeTruthy();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Codex，已检测到，查看详情' }));
  await user.click(screen.getByRole('button', { name: 'Atlas 示例项目 / 系统完善' }));
  expect(props.onNavigate).toHaveBeenCalledWith({ kind: 'channel', id: 'channel-system' });
  expect(api.channelAction).not.toHaveBeenCalled();
});

test('refresh uses the real detection operation and is disabled while busy', async () => {
  const { props, api } = runtimeProps();
  const view = render(<RuntimesView {...props} />);
  await userEvent.setup().click(screen.getByRole('button', { name: '重新检测' }));
  expect(api.refreshRuntimes).toHaveBeenCalledTimes(1);
  expect(props.onMutate).toHaveBeenCalledTimes(1);
  view.rerender(<RuntimesView {...props} busy />);
  expect((screen.getByRole('button', { name: '正在检测…' }) as HTMLButtonElement).disabled).toBe(true);
});

test('an empty snapshot remains an empty detection state without invented runtime rows', () => {
  const { props } = runtimeProps([]);
  render(<RuntimesView {...props} />);
  expect(screen.getByRole('heading', { name: '还没有检测结果' })).toBeTruthy();
  expect(screen.queryByRole('region', { name: '运行时列表' })).toBeNull();
  expect(screen.queryByText('Codex')).toBeNull();
});

test('host overview uses the real connection label and does not infer remote availability from CLI detection', () => {
  const { props } = runtimeProps();
  render(<RuntimesView {...props} connection={{ ...remote, connected: false }} />);
  expect(screen.getByRole('heading', { name: '远程 · dev-box' })).toBeTruthy();
  expect(screen.getByText('未连接')).toBeTruthy();
  expect(screen.getByText('1 个运行时 · 1 个已检测到')).toBeTruthy();
});

test('the checklist ends with the account usage per window, or a red unknown with the reason', async () => {
  const resetsAt = new Date(Date.now() + 3600_000).toISOString();
  const reading = {
    at: new Date().toISOString(),
    source: 'protocol' as const,
    windows: [
      { name: '5h' as const, usedPercent: 42, resetsAt },
      { name: 'weekly' as const, usedPercent: 10 },
    ],
  };
  const cases: Array<[Partial<NativeConnectionStatus>, string[]]> = [
    [
      { connected: true, backgroundConfigured: true, backgroundReady: true, usage: { reading, stale: false } },
      [`5 小时 已用 42%，重置 ${formatResetTime(resetsAt)}`, '每周 已用 10%，重置时间未知'],
    ],
    [{ connected: false }, ['额度未知', '后台未连接']],
    // Never attempted, attempted and empty, and stale each read differently; a service too old to
    // report `attempted` keeps the previous reason rather than claiming nothing was tried.
    [{ connected: true, usage: { stale: true, attempted: false } }, ['额度未知', '尚未读取账户用量']],
    [
      { connected: true, usage: { stale: true, attempted: true, lastError: '原生后台不支持读取额度' } },
      ['额度未知', '读取失败：原生后台不支持读取额度'],
    ],
    [{ connected: true, usage: { stale: true } }, ['额度未知', '协议未返回账户用量']],
    [{ connected: true, usage: { reading, stale: true, attempted: true } }, ['额度未知', '读数已过期']],
  ];
  for (const [patch, expected] of cases) {
    const { props, api } = runtimeProps();
    api.getNativeStatus.mockResolvedValue(status(patch));
    const view = render(<RuntimesView {...props} />);
    await checklist();
    const line = screen.getByLabelText('账户用量');
    for (const text of expected) expect(line.textContent).toContain(text);
    expect(!!line.querySelector('.usage-unknown')).toBe(expected.includes('额度未知'));
    view.unmount();
  }
});

test('entering the page and manual detection request fresh usage and display later readings or refresh failure', async () => {
  const { props, api } = runtimeProps();
  const reading = (usedPercent: number) => ({
    at: new Date().toISOString(),
    source: 'protocol' as const,
    windows: [{ name: 'weekly' as const, usedPercent }],
  });
  api.getNativeStatus
    .mockResolvedValueOnce(status({ connected: true, usage: { reading: reading(37), stale: false, attempted: true } }))
    .mockResolvedValueOnce(status({ connected: true, usage: { reading: reading(41), stale: false, attempted: true } }))
    .mockResolvedValue(
      status({
        connected: true,
        usage: { reading: reading(41), stale: false, attempted: true, lastError: 'fixture unavailable' },
      })
    );
  render(<RuntimesView {...props} />);
  await screen.findByText('每周 已用 37%，重置时间未知');
  expect(api.getNativeStatus).toHaveBeenNthCalledWith(1, true);
  await userEvent.setup().click(screen.getByRole('button', { name: '重新检测' }));
  await screen.findByText('每周 已用 41%，重置时间未知');
  expect(api.refreshRuntimes).toHaveBeenCalledOnce();
  expect(api.getNativeStatus).toHaveBeenNthCalledWith(2, true);
  await userEvent.setup().click(screen.getByRole('button', { name: '重新检测' }));
  await screen.findByText('刷新失败，显示最近读数');
  expect(screen.getByLabelText('账户用量').textContent).toContain('41%');
  expect(api.createNativeThread).not.toHaveBeenCalled();
  expect(api.channelAction).not.toHaveBeenCalled();
});

test('a delayed usage response from a previous host cannot overwrite the current host', async () => {
  const { props, api } = runtimeProps();
  let resolveOld!: (value: NativeConnectionStatus) => void;
  api.getNativeStatus
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        })
    )
    .mockResolvedValue(
      status({
        connected: true,
        usage: {
          reading: { at: new Date().toISOString(), source: 'protocol', windows: [{ name: 'weekly', usedPercent: 22 }] },
          stale: false,
        },
      })
    );
  const view = render(<RuntimesView {...props} />);
  await waitFor(() => expect(api.getNativeStatus).toHaveBeenCalledOnce());
  view.rerender(<RuntimesView {...props} connection={remote} />);
  await screen.findByText('每周 已用 22%，重置时间未知');
  await act(async () => {
    resolveOld(
      status({
        connected: true,
        usage: {
          reading: { at: new Date().toISOString(), source: 'protocol', windows: [{ name: 'weekly', usedPercent: 99 }] },
          stale: false,
        },
      })
    );
  });
  await waitFor(() => expect(screen.getByLabelText('账户用量').textContent).toContain('22%'));
  expect(screen.queryByText('每周 已用 99%，重置时间未知')).toBeNull();
});

// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RuntimesView } from './RuntimesView';
import { featureProps, snapshot } from './testFixtures';
import { formatResetTime } from '../components/format';
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
  expect(details.getByText('默认沿用 Codex App 的权限设置；每个频道可单独收紧为只读或工作区编辑。')).toBeTruthy();
  expect(details.getByText(/登录状态与配额在实际执行时验证/)).toBeTruthy();
  expect(row.getAttribute('aria-expanded')).toBe('true');
  expect(screen.queryByRole('button', { name: /安装|登录|配置/ })).toBeNull();
});

test('Codex reports the live App connection and bundle version separately from its unused terminal executable', async () => {
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
  expect(step('App 原生后台运行中')).toBe('pending');
  expect(step('后台桥接已配置')).toBe('pending');
  expect(step('桥接已生效')).toBe('pending');
  expect(nextStep().textContent).toBe('下一步安装并登录 Codex App');
  expect(screen.queryByRole('button', { name: /启用后台连接|撤销设置/ })).toBeNull();
  cleanup();
  api.getNativeStatus.mockResolvedValue(status({ appInstalled: true, appVersion: '1.2.3' }));
  render(<RuntimesView {...props} />);
  const list = within(await checklist());
  expect(step('Codex App 已安装')).toBe('done');
  expect(list.getByText('1.2.3')).toBeTruthy();
  expect(step('App 原生后台运行中')).toBe('next');
  expect(nextStep().textContent).toBe('下一步打开 Codex App');
  expect(screen.queryByRole('button', { name: /启用后台连接|撤销设置/ })).toBeNull();
});

test('enabling the bridge calls the desktop API through the mutation pipeline, rereads the status and shows the receipt', async () => {
  const { props, api } = runtimeProps();
  api.getNativeStatus
    .mockResolvedValueOnce(status({ connected: true }))
    .mockResolvedValue(status({ connected: true, backgroundConfigured: true }));
  const configure = vi.fn(async () => ({ restartRequired: true, detail: '桥接已写入，重开 App 后生效。' }));
  props.api.setupNativeBackground = configure;
  props.api.restoreNativeBackground = vi.fn();
  render(<RuntimesView {...props} />);
  await checklist();
  expect(step('App 原生后台运行中')).toBe('done');
  expect(step('后台桥接已配置')).toBe('next');
  expect(nextStep().textContent).toBe('下一步启用后台连接');
  expect(screen.queryByRole('button', { name: '撤销设置' })).toBeNull();
  await userEvent.setup().click(screen.getByRole('button', { name: '启用后台连接' }));
  await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
  expect(props.onMutate).toHaveBeenCalledTimes(1);
  expect(await screen.findByText('后台连接已设置，请在当前任务结束后重新打开一次 Codex App')).toBeTruthy();
  expect(api.getNativeStatus).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('status').textContent).toBe('桥接已写入，重开 App 后生效。');
  expect(step('后台桥接已配置')).toBe('done');
  expect(step('桥接已生效')).toBe('next');
  expect(screen.queryByRole('button', { name: '启用后台连接' })).toBeNull();
  expect(screen.getByRole('button', { name: '撤销设置' }).className).toContain('button-ghost');
  expect(props.api.restoreNativeBackground).not.toHaveBeenCalled();
  expect(api.openNativeApp).not.toHaveBeenCalled();
});

test('a ready bridge shows the backend version and a ghost revoke action that also rereads the status', async () => {
  const { props, api } = runtimeProps();
  const ready = status({
    connected: true,
    appVersion: '1.2.3',
    backgroundConfigured: true,
    backgroundReady: true,
    runtimeVersion: 'codex-app-server/0.50.0',
  });
  api.getNativeStatus
    .mockResolvedValueOnce(ready)
    .mockResolvedValue(status({ ...ready, backgroundConfigured: false, runtimeVersion: undefined }));
  const restore = vi.fn(async () => ({ restartRequired: true, detail: '已撤销后台启动设置。' }));
  props.api.setupNativeBackground = vi.fn();
  props.api.restoreNativeBackground = restore;
  render(<RuntimesView {...props} />);
  const list = within(await checklist());
  for (const label of ['Codex App 已安装', 'App 原生后台运行中', '后台桥接已配置', '桥接已生效'])
    expect(step(label)).toBe('done');
  expect(list.getByText('codex-app-server/0.50.0')).toBeTruthy();
  expect(nextStep().textContent).toBe('下一步已就绪撤销设置');
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Codex，App 已连接，查看详情' }));
  expect(within(screen.getByRole('region', { name: 'Codex 详情' })).getByText('codex-app-server/0.50.0')).toBeTruthy();
  const revoke = screen.getByRole('button', { name: '撤销设置' });
  expect(revoke.className).toContain('button-ghost');
  await user.click(revoke);
  await waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
  expect(props.onMutate).toHaveBeenCalledTimes(1);
  expect(await screen.findByRole('button', { name: '启用后台连接' })).toBeTruthy();
  expect(api.getNativeStatus).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('status').textContent).toBe('已撤销后台启动设置。');
  expect(step('后台桥接已配置')).toBe('next');
  expect(props.api.setupNativeBackground).not.toHaveBeenCalled();
});

test('SSH mode hides both bridge buttons and points at the machine that runs the App', async () => {
  const { props, api } = runtimeProps();
  props.api.setupNativeBackground = vi.fn();
  props.api.restoreNativeBackground = vi.fn();
  api.getNativeStatus.mockResolvedValue(status({ connected: true }));
  render(<RuntimesView {...props} connection={remote} />);
  await checklist();
  expect(nextStep().textContent).toBe('下一步后台桥接在运行 Codex App 的那台 Mac 上设置或撤销。');
  expect(screen.queryByRole('button', { name: /启用后台连接|撤销设置/ })).toBeNull();
  cleanup();
  api.getNativeStatus.mockResolvedValue(status({ connected: true, backgroundConfigured: true, backgroundReady: true }));
  render(<RuntimesView {...props} connection={remote} />);
  await checklist();
  expect(nextStep().textContent).toBe('下一步已就绪后台桥接在运行 Codex App 的那台 Mac 上设置或撤销。');
  expect(screen.queryByRole('button', { name: /启用后台连接|撤销设置/ })).toBeNull();
  expect(props.api.setupNativeBackground).not.toHaveBeenCalled();
  expect(props.api.restoreNativeBackground).not.toHaveBeenCalled();
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
    [{ connected: true, usage: { stale: true } }, ['额度未知', '协议未返回账户用量']],
    [{ connected: true, usage: { reading, stale: true } }, ['额度未知', '读数已过期']],
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

// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RuntimesView } from './RuntimesView';
import { featureProps, snapshot } from './testFixtures';
import type { NativeConnectionStatus, Runtime } from '../../shared/types';

afterEach(cleanup);
const installed: Runtime = { id: 'codex', name: 'Codex', available: true, path: '/opt/homebrew/bin/codex', version: 'codex-cli 0.100.0', detail: 'CLI 已安装，尚未验证登录和配额。', canWrite: true };
function runtimeProps(runtimes: Runtime[] = [installed]) {
  const state = snapshot();
  state.runtimes = runtimes;
  return featureProps({ snapshot: state });
}

test('CLI detection stays separate from authentication and details are progressively disclosed', async () => {
  const cli = { ...installed, id: 'claude', name: 'Claude Code', path: '/opt/homebrew/bin/claude' };
  const { props } = runtimeProps([cli]);
  render(<RuntimesView {...props} />);
  expect(screen.getByText('已检测到')).toBeTruthy();
  expect(screen.getByText('待验证')).toBeTruthy();
  expect(screen.queryByText('已登录')).toBeNull();
  expect(screen.queryByText(cli.path)).toBeNull();
  const row = screen.getByRole('button', { name: 'Claude Code，已检测到，查看详情' });
  expect(row.getAttribute('aria-expanded')).toBe('false');
  await userEvent.setup().click(row);
  const details = within(screen.getByRole('region', { name: 'Claude Code 详情' }));
  expect(details.getByText(cli.path)).toBeTruthy();
  expect(details.getByText('只读 / 工作区编辑，由每个频道单独设置。')).toBeTruthy();
  expect(details.getByText(/登录状态与配额在实际执行时验证/)).toBeTruthy();
  expect(row.getAttribute('aria-expanded')).toBe('true');
  expect(screen.queryByRole('button', { name: /安装|登录|配置/ })).toBeNull();
});

test('Codex reports the live App connection separately from its unused terminal executable', async () => {
  const { props, api } = runtimeProps();
  const status: NativeConnectionStatus = { available: true, connected: true, detail: '原生会话连接已建立', appVersion: '1.0-test', capabilities: { list: true, read: true, send: true, create: false, interrupt: true, respond: true } };
  api.getNativeStatus.mockResolvedValue(status);
  render(<RuntimesView {...props} />);
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Codex，App 已连接，查看详情' }));
  expect(screen.getByText('由 App 管理')).toBeTruthy();
  expect(screen.getByText('1.0-test')).toBeTruthy();
  expect(screen.getByText('原生会话连接已建立')).toBeTruthy();
  expect(screen.queryByText('已登录')).toBeNull();
  expect(screen.getByText(installed.path)).toBeTruthy();
});

test('an installed but incompatible CLI differs from a CLI missing from PATH', () => {
  const { props } = runtimeProps([
    { ...installed, available: false, detail: '当前 CLI 版本缺少必要的安全或结构化输出选项，请升级。' },
    { ...installed, id: 'claude', name: 'Claude Code', available: false, path: '', version: '', canWrite: false },
  ]);
  render(<RuntimesView {...props} />);
  expect(screen.getByRole('button', { name: 'Codex，需检查，查看详情' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Claude Code，未检测到，查看详情' })).toBeTruthy();
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
  render(<RuntimesView {...props} connection={{ name: '远程 · dev-box', connected: false, config: { mode: 'ssh', host: 'dev-box', port: 43821, directory: '~/.local/share/morrow' } }} />);
  expect(screen.getByRole('heading', { name: '远程 · dev-box' })).toBeTruthy();
  expect(screen.getByText('未连接')).toBeTruthy();
  expect(screen.getByText('1 个运行时 · 1 个已检测到')).toBeTruthy();
});

// @vitest-environment jsdom
import { execFileSync } from 'node:child_process';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChannelView } from './ChannelView';
import { featureProps, TestProviders } from './testFixtures';
afterEach(cleanup);

test('the actual conversation API drives the unloaded-task message, recovery and App-disconnection message', async () => {
  const data = JSON.parse(
    execFileSync(process.execPath, ['tests/fixtures/native-projection.ts'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 10000,
    })
  );
  const actual = data.unloaded;
  const message = '请先在 Codex App 中打开此对话，再连接同步。';
  expect(actual.status.available).toBe(true);
  expect(actual.status.connected).toBe(false);
  expect(actual.status.readyThreadCount).toBe(0);
  expect(actual.syncError).toBe(message);
  let current = actual;
  const { props, api } = featureProps();
  props.snapshot.projects = [data.project];
  props.snapshot.channels = [data.channel];
  props.snapshot.runs = [];
  props.snapshot.items = [];
  props.api.getNativeConversation = vi.fn(async () => current);
  render(<ChannelView {...props} id={data.channel.id} />, { wrapper: TestProviders });
  await screen.findByText(message);
  await userEvent.setup().click(screen.getByRole('button', { name: /^在 Codex App 中打开$/ }));
  expect(api.ensureAppTask).toHaveBeenCalledWith(data.channel.id);
  expect(api.channelAction).not.toHaveBeenCalled();
  current = data.unloadedThenOffline;
  expect(current.status.available).toBe(false);
  expect(current.syncError).toBe(message); // Keep the historical task error; do not use it as the current connection cause.
  fireEvent.focus(window);
  await screen.findByText('Codex App 已关闭，请重新打开。');
  expect(screen.queryByText(message)).toBeNull();
  expect(screen.queryByRole('button', { name: '继续工作' })).toBeNull();
  current = data.restored;
  fireEvent.focus(window);
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '继续工作' }) as HTMLButtonElement).disabled).toBe(false)
  );
  expect(screen.queryByText(message)).toBeNull();
  current = data.offline;
  fireEvent.focus(window);
  await screen.findByText('Codex App 已关闭，请重新打开。');
  expect(screen.queryByText(/任务未在 Codex App 中打开/)).toBeNull();
  expect(screen.queryByRole('button', { name: '继续工作' })).toBeNull();
  expect(data.sentMessages).toBe(0);
}, 15000);

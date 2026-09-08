// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectNavigation } from './ProjectNavigation';
import { snapshot } from '../features/testFixtures';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

it('keeps identically named channels in their own project and scopes navigation and creation', async () => {
  const user = userEvent.setup();
  const state = snapshot();
  const onNavigate = vi.fn(), onNewChannel = vi.fn();
  render(<ProjectNavigation {...state} route={{ kind: 'runs' }} scope="local" onNavigate={onNavigate} onNewChannel={onNewChannel} />);
  const atlas = within(screen.getByRole('group', { name: 'Atlas 示例项目 的频道' }));
  const other = within(screen.getByRole('group', { name: 'Other 的频道' }));
  await user.click(atlas.getByRole('button', { name: '系统完善' }));
  expect(onNavigate).toHaveBeenLastCalledWith({ kind: 'channel', id: 'channel-system' });
  await user.click(other.getByRole('button', { name: '系统完善' }));
  expect(onNavigate).toHaveBeenLastCalledWith({ kind: 'channel', id: 'channel-other' });
  expect(other.queryByRole('button', { name: '运营洞察' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '在 Other 新建频道' }));
  expect(onNewChannel).toHaveBeenCalledWith('project-other');
  await user.click(screen.getByRole('button', { name: 'Other 的看板' }));
  expect(onNavigate).toHaveBeenLastCalledWith({ kind: 'project', id: 'project-other' }, true);
  const project = screen.getByRole('region', { name: 'Other 项目' });
  const labels = within(project).getAllByRole('button').map(button => button.getAttribute('aria-label') || button.textContent);
  expect(labels.indexOf('Other 的看板')).toBeLessThan(labels.indexOf('系统完善'));
  expect(within(project).queryByRole('button', { name: /展开|收起/ })).toBeNull();
});

it('remembers independent collapsed projects and reveals a channel reached through another tab', async () => {
  const user = userEvent.setup();
  const props = { ...snapshot(), scope: 'local', onNavigate: vi.fn(), onNewChannel: vi.fn() };
  const first = render(<ProjectNavigation {...props} />);
  await user.click(screen.getByRole('button', { name: 'Atlas 示例项目' }));
  expect(screen.queryByRole('group', { name: 'Atlas 示例项目 的频道' })).toBeNull();
  expect(screen.getByRole('group', { name: 'Other 的频道' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Atlas 示例项目 的看板' })).toBeNull();
  expect(props.onNavigate).not.toHaveBeenCalled();
  first.unmount();
  const next = render(<ProjectNavigation {...props} />);
  expect(screen.queryByRole('group', { name: 'Atlas 示例项目 的频道' })).toBeNull();
  next.rerender(<ProjectNavigation {...props} route={{ kind: 'channel', id: 'channel-growth' }} activeProjectId="project-atlas" />);
  expect(screen.getByRole('group', { name: 'Atlas 示例项目 的频道' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '运营洞察' }).getAttribute('aria-current')).toBe('page');
  await user.click(screen.getByRole('button', { name: 'Atlas 示例项目' }));
  next.rerender(<ProjectNavigation {...props} channels={[...props.channels]} route={{ kind: 'channel', id: 'channel-growth' }} activeProjectId="project-atlas" />);
  expect(screen.queryByRole('group', { name: 'Atlas 示例项目 的频道' })).toBeNull();
});

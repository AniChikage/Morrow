// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FeatureBoard } from './FeatureBoard';
import { ProjectView } from './ProjectView';
import { featureProps, item, TestProviders } from './testFixtures';

afterEach(() => { cleanup(); localStorage.clear(); });
Object.defineProperty(window, 'PointerEvent', { value: MouseEvent, configurable: true });
const hitTest = vi.fn();
Object.defineProperty(document, 'elementFromPoint', { value: hitTest, configurable: true });
function dragCard(target: HTMLElement) {
  const card = screen.getByRole('button', { name: /^打开/ });
  hitTest.mockReturnValue(target);
  fireEvent.pointerDown(card, { button: 0, clientX: 20, clientY: 20 });
  fireEvent.pointerMove(card, { clientX: 320, clientY: 30 });
  fireEvent.pointerUp(card, { clientX: 320, clientY: 30 });
}
function setup() {
  const { props, api } = featureProps();
  const card = item({ revision: 7 });
  const board = { api, onMutate: props.onMutate, busy: false, items: [card], channels: props.snapshot.channels, onOpen: vi.fn(), filtered: false };
  const view = render(<FeatureBoard {...board} />, { wrapper: TestProviders });
  return { board, api, view, card };
}
describe('shared project pipelines', () => {
  it('keeps five columns visible for empty and filtered projects', async () => {
    const { props } = featureProps(); props.snapshot.items = [];
    render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    expect(screen.getAllByRole('region', { name: /列$/ })).toHaveLength(5);
    expect(screen.getAllByText('暂无功能')).toHaveLength(5);
    await userEvent.setup().type(screen.getByRole('textbox', { name: '搜索功能和证据' }), 'not-found');
    expect(screen.getAllByRole('region', { name: /列$/ })).toHaveLength(5);
    expect(screen.getAllByText('没有匹配的功能')).toHaveLength(5);
  });
  it('opens the new board once for legacy list preferences', () => {
    localStorage.setItem('morrow.project-view.project-atlas', JSON.stringify({ layout: 'list' }));
    const { props } = featureProps();
    render(<ProjectView {...props} id="project-atlas" />, { wrapper: TestProviders });
    expect(screen.getAllByRole('region', { name: /列$/ })).toHaveLength(5);
  });
  it('persists a drop with its original revision, then follows the confirmed snapshot', async () => {
    const { board, api, view, card } = setup();
    const target = screen.getByRole('region', { name: '调查中列' });
    dragCard(target);
    await waitFor(() => expect(api.patchItem).toHaveBeenCalledWith(card.id, { status: 'investigating', revision: 7 }));
    expect(within(screen.getByRole('region', { name: '待处理列' })).getByRole('article')).toBeTruthy();
    view.rerender(<FeatureBoard {...board} items={[{ ...card, status: 'investigating', revision: 8 }]} />);
    expect(within(target).getByRole('article')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '待处理列' })).queryByRole('article')).toBeNull();
  });
  it('keeps the source card on a rejected write and ignores unrelated drops', async () => {
    const { api, card } = setup(); api.patchItem.mockRejectedValueOnce(new Error('事项已更新'));
    const target = screen.getByRole('region', { name: '已解决列' });
    fireEvent.pointerUp(screen.getByRole('button', { name: /^打开/ })); expect(api.patchItem).not.toHaveBeenCalled();
    dragCard(target);
    await screen.findByText('移动未保存，请刷新后重试。');
    expect(within(screen.getByRole('region', { name: '待处理列' })).getByLabelText(`${card.title}卡片`)).toBeTruthy();
  });
  it('ignores a cancelled gesture or a drop outside this board, and keeps clicks usable', () => {
    const { board, api } = setup();
    const card = screen.getByRole('button', { name: /^打开/ });
    hitTest.mockReturnValue(document.body);
    fireEvent.pointerDown(card, { button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(card, { clientX: 320, clientY: 30 });
    fireEvent.pointerCancel(card);
    fireEvent.pointerUp(card, { clientX: 320, clientY: 30 });
    expect(api.patchItem).not.toHaveBeenCalled();
    fireEvent.click(card, { detail: 0 });
    expect(board.onOpen).toHaveBeenCalledTimes(1);
  });
  it('offers a keyboard-accessible alternative to dragging without opening the feature', async () => {
    const { board, api, card } = setup(); const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: `移动「${card.title}」` }));
    await user.click(screen.getByRole('menuitem', { name: '需要关注' }));
    await waitFor(() => expect(api.patchItem).toHaveBeenCalledWith(card.id, { status: 'blocked', revision: 7 }));
    expect(board.onOpen).not.toHaveBeenCalled();
  });
});

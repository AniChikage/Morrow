// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { FeatureBoard } from './FeatureBoard';
import { featureProps, item, TestProviders } from './testFixtures';

beforeEach(() => {
  localStorage.clear();
  // Radix pointer interactions use these browser APIs; jsdom does not implement them.
  if (!HTMLElement.prototype.hasPointerCapture) HTMLElement.prototype.hasPointerCapture = () => false;
  if (!HTMLElement.prototype.setPointerCapture) HTMLElement.prototype.setPointerCapture = () => {};
  if (!HTMLElement.prototype.releasePointerCapture) HTMLElement.prototype.releasePointerCapture = () => {};
  if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});
// jsdom has neither of these; the drag handlers only ever read a pointer event's mouse fields.
Object.defineProperty(window, 'PointerEvent', { value: MouseEvent, configurable: true });
const hitTest = vi.fn();
Object.defineProperty(document, 'elementFromPoint', { value: hitTest, configurable: true });

type BoardProps = ComponentProps<typeof FeatureBoard>;
function setup(patch: Partial<BoardProps> = {}) {
  const { props, api } = featureProps();
  const card = item({ revision: 7 });
  const onOpen = vi.fn();
  const board: BoardProps = {
    api,
    onMutate: props.onMutate,
    busy: false,
    items: [card],
    channels: props.snapshot.channels,
    filtered: false,
    onOpen,
    ...patch,
  };
  const view = render(<FeatureBoard {...board} />, { wrapper: TestProviders });
  return { board, api, view, card, onOpen };
}
/** One complete pointer drag of the only card on the board onto `target`. */
function dragCard(target: Element) {
  const card = screen.getByRole('button', { name: /^打开/ });
  hitTest.mockReturnValue(target);
  fireEvent.pointerDown(card, { button: 0, clientX: 20, clientY: 20 });
  fireEvent.pointerMove(card, { clientX: 320, clientY: 30 });
  fireEvent.pointerUp(card, { clientX: 320, clientY: 30 });
  return card;
}
const columnNames = () =>
  screen.getAllByRole('region', { name: /列$/ }).map((column) => column.getAttribute('aria-label'));

describe('shared project board', () => {
  it('keeps its four columns, and their wording, on an empty and on a filtered board', () => {
    const { view, board } = setup({ items: [] });
    expect(columnNames()).toEqual(['待处理列', '调查中列', '需要关注列', '已验证列']);
    expect(screen.getAllByText('暂无事项')).toHaveLength(4);
    view.rerender(<FeatureBoard {...board} items={[]} filtered />);
    expect(columnNames()).toEqual(['待处理列', '调查中列', '需要关注列', '已验证列']);
    expect(screen.getAllByText('没有匹配的事项')).toHaveLength(4);
    // 已解决 is the history section's, not a column's — until a filter puts resolved items on the board.
    view.rerender(<FeatureBoard {...board} items={[item({ id: 'done', status: 'resolved' })]} filtered />);
    expect(columnNames()).toEqual(['待处理列', '调查中列', '需要关注列', '已验证列', '已解决列']);
  });

  it('shows the item number, kind, two-line next step, source and evidence on a card', () => {
    const { card } = setup();
    const open = screen.getByRole('button', { name: `打开 FINDIN「${card.title}」` });
    expect(within(open).getByText('问题')).toBeTruthy();
    expect(open.querySelector('.board-card-next')?.textContent).toBe(card.nextStep);
    expect(within(open).getByTitle('来源：系统完善')).toBeTruthy();
    expect(within(open).getByTitle('2 条证据')).toBeTruthy();
  });

  it('persists a drop with the revision it read, and moves the card only once the snapshot agrees', async () => {
    const { board, api, view, card } = setup();
    const target = screen.getByRole('region', { name: '调查中列' });
    dragCard(target);
    await waitFor(() => expect(api.patchItem).toHaveBeenCalledWith(card.id, { status: 'investigating', revision: 7 }));
    // No optimistic reordering: the card is still where the snapshot says it is.
    expect(within(screen.getByRole('region', { name: '待处理列' })).getByRole('article')).toBeTruthy();
    expect(within(target).queryByRole('article')).toBeNull();
    view.rerender(<FeatureBoard {...board} items={[{ ...card, status: 'investigating', revision: 8 }]} />);
    expect(within(target).getByRole('article')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '待处理列' })).queryByRole('article')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe(`已将「${card.title}」移至调查中`);
  });

  it('leaves a refused move where it was and says it was not saved', async () => {
    const { api, card } = setup();
    api.patchItem.mockRejectedValueOnce(new Error('事项已被更新，请刷新后再保存'));
    dragCard(screen.getByRole('region', { name: '已验证列' }));
    expect(await screen.findByText('移动未保存，请刷新后重试。')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '待处理列' })).getByLabelText(`${card.title}卡片`)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '已验证列' })).queryByRole('article')).toBeNull();
  });

  it('writes nothing for a cancelled gesture or a drop outside the board, and still opens on a click', () => {
    const { api, onOpen } = setup();
    const open = screen.getByRole('button', { name: /^打开/ });
    hitTest.mockReturnValue(screen.getByRole('region', { name: '调查中列' }));
    fireEvent.pointerDown(open, { button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(open, { clientX: 320, clientY: 30 });
    fireEvent.pointerCancel(open);
    fireEvent.pointerUp(open, { clientX: 320, clientY: 30 });
    expect(api.patchItem).not.toHaveBeenCalled();
    // Something that is neither a column of this board nor the history heading takes no drop.
    dragCard(document.body);
    expect(api.patchItem).not.toHaveBeenCalled();
    // A drag suppresses the mouse click it ends with, never the keyboard's (`detail === 0`).
    fireEvent.click(open, { detail: 1 });
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(open, { detail: 0 });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('keeps the grab offset in a non-interactive ghost and previews the target without moving the source', () => {
    const { api } = setup();
    const source = screen.getByRole('article');
    vi.spyOn(source, 'getBoundingClientRect').mockReturnValue({
      left: 10,
      top: 15,
      width: 220,
      height: 120,
    } as DOMRect);
    const open = screen.getByRole('button', { name: /^打开/ });
    const target = screen.getByRole('region', { name: '调查中列' });
    hitTest.mockReturnValue(target);
    fireEvent.pointerDown(open, { button: 0, clientX: 30, clientY: 40 });
    fireEvent.pointerMove(open, { clientX: 32, clientY: 42 });
    expect(document.querySelector('.board-drag-ghost')).toBeNull();
    fireEvent.pointerMove(open, { clientX: 330, clientY: 140 });
    const ghost = document.querySelector<HTMLElement>('.board-drag-ghost')!;
    expect(ghost.parentElement).toBe(document.body);
    expect(ghost.getAttribute('aria-hidden')).toBe('true');
    expect(ghost.querySelector('button')).toBeNull();
    expect([ghost.style.left, ghost.style.top, ghost.style.width]).toEqual(['310px', '115px', '220px']);
    expect(target.querySelector('.board-drop-placeholder')?.textContent).toBe('松开移至调查中');
    expect(source.closest('[data-status]')?.getAttribute('data-status')).toBe('open');
    expect(api.patchItem).not.toHaveBeenCalled();
    hitTest.mockReturnValue(source);
    fireEvent.pointerMove(open, { clientX: 40, clientY: 40 });
    expect(document.querySelector('.board-drop-placeholder')).toBeNull();
    hitTest.mockReturnValue(document.body);
    fireEvent.pointerMove(open, { clientX: 0, clientY: 0 });
    expect(document.querySelector('.board-column-over')).toBeNull();
    fireEvent.pointerUp(open, { clientX: 0, clientY: 0 });
    expect(document.querySelector('.board-drag-ghost')).toBeNull();
    expect(api.patchItem).not.toHaveBeenCalled();
  });

  it.each(['escape', 'cancel', 'capture', 'blur', 'busy', 'unmount'])(
    'cleans up drag feedback on %s without saving',
    (reason) => {
      const { api, view, board } = setup();
      const open = screen.getByRole('button', { name: /^打开/ });
      hitTest.mockReturnValue(screen.getByRole('region', { name: '调查中列' }));
      fireEvent.pointerDown(open, { button: 0, clientX: 20, clientY: 20 });
      fireEvent.pointerMove(open, { clientX: 320, clientY: 30 });
      expect(document.querySelector('.board-drag-ghost')).toBeTruthy();
      if (reason === 'escape') fireEvent.keyDown(window, { key: 'Escape' });
      if (reason === 'cancel') fireEvent.pointerCancel(open);
      if (reason === 'capture') fireEvent.lostPointerCapture(open);
      if (reason === 'blur') fireEvent.blur(window);
      if (reason === 'busy') view.rerender(<FeatureBoard {...board} busy />);
      if (reason === 'unmount') view.unmount();
      expect(document.querySelector('.board-drag-ghost')).toBeNull();
      expect(document.querySelector('.board-drop-placeholder')).toBeNull();
      expect(document.querySelector('.board-column-over')).toBeNull();
      fireEvent.pointerUp(open, { clientX: 320, clientY: 30 });
      expect(api.patchItem).not.toHaveBeenCalled();
    }
  );

  it('previews and saves a move to resolved history, then clears its highlight', async () => {
    const { api, card } = setup();
    const history = document.createElement('section');
    history.className = 'project-history';
    history.innerHTML = '<button data-status="resolved">已解决历史</button>';
    document.body.append(history);
    try {
      const heading = history.querySelector('button')!;
      const open = screen.getByRole('button', { name: /^打开/ });
      hitTest.mockReturnValue(heading);
      fireEvent.pointerDown(open, { button: 0, clientX: 20, clientY: 20 });
      fireEvent.pointerMove(open, { clientX: 320, clientY: 30 });
      expect(heading.classList.contains('board-drop-over')).toBe(true);
      expect(document.querySelector('.board-drag-destination')?.textContent).toBe('松开移至已解决');
      fireEvent.pointerUp(open, { clientX: 320, clientY: 30 });
      expect(heading.classList.contains('board-drop-over')).toBe(false);
      expect(document.querySelector('.board-drag-ghost')).toBeNull();
      await waitFor(() => expect(api.patchItem).toHaveBeenCalledWith(card.id, { status: 'resolved', revision: 7 }));
    } finally {
      history.remove();
    }
  });

  it('reaches the card and its 移动到 menu by keyboard, 已解决 included', async () => {
    const { api, card, onOpen } = setup();
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^打开/ }));
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onOpen).toHaveBeenCalledTimes(2);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: `移动「${card.title}」` }));
    await user.keyboard('{Enter}');
    expect(screen.getAllByRole('menuitem').map((entry) => entry.textContent)).toEqual([
      '待处理',
      '调查中',
      '需要关注',
      '已验证',
      '已解决',
    ]);
    await user.keyboard('{End}{Enter}');
    await waitFor(() => expect(api.patchItem).toHaveBeenCalledWith(card.id, { status: 'resolved', revision: 7 }));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('neither drags nor offers a move while the workspace is busy', () => {
    const { api, card } = setup({ busy: true });
    expect((screen.getByRole('button', { name: `移动「${card.title}」` }) as HTMLButtonElement).disabled).toBe(true);
    dragCard(screen.getByRole('region', { name: '调查中列' }));
    expect(api.patchItem).not.toHaveBeenCalled();
    expect(within(screen.getByRole('region', { name: '待处理列' })).getByRole('article')).toBeTruthy();
  });
});

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Link2, MoreHorizontal } from 'lucide-react';
import type { Channel, WorkItem } from '../../shared/types';
import type { FeatureProps } from './types';
import { Dropdown, DropdownItem, StatusIcon } from '../components/ui';
import { kindLabel, statusLabel } from '../components/format';
import { featureNumber, featureSourceLabel } from './featureOwnership';
// ProjectView renders this board and reads `boardStatuses` back from here. Both sides only reach for
// the other while rendering, so neither module's top level depends on the other being evaluated yet.
import { FeatureOwnerTag } from './ProjectView';

/**
 * The four columns unresolved work moves through. 已解决 is deliberately not one of them: a resolved
 * item leaves the board for the 已解决历史 section below it, and that section's heading is a drop
 * target of its own.
 */
export const boardStatuses = ['open', 'investigating', 'blocked', 'verified'];
/** Every status a card can be moved to by hand, 已解决 included. */
const moveTargets = [...boardStatuses, 'resolved'];
const descriptions: Record<string, string> = {
  open: '待选择与推进',
  investigating: '正在调查和实施',
  blocked: '等待依赖或需要指导',
  verified: '已有验证依据',
  resolved: '已结束的工作',
};
type Props = Pick<FeatureProps, 'api' | 'onMutate' | 'busy'> & {
  items: WorkItem[];
  channels: Channel[];
  /** Whether a search or a filter decided `items`; it changes what an empty column has to say. */
  filtered: boolean;
  onOpen: (item: WorkItem) => void;
};
/**
 * The project's shared board: four fixed columns whose cards can be dragged between them, with a
 * per-card 移动到 menu as the keyboard equivalent. A move is only ever what the service confirmed —
 * a card changes column when the next snapshot says so, never optimistically.
 */
export function FeatureBoard({ items, channels, filtered, api, onMutate, busy, onOpen }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ item: WorkItem; x: number; y: number; active: boolean } | null>(null);
  const suppressClick = useRef(false);
  const moving = useRef(false);
  const [draggedId, setDraggedId] = useState('');
  const [over, setOver] = useState('');
  const [pending, setPending] = useState('');
  const [notice, setNotice] = useState('');
  /**
   * 已解决历史 belongs to the page, not to this board, so the one class that marks the drop target
   * under the pointer has to be put on its heading directly; everything inside the board is React's.
   */
  useEffect(() => {
    const heading = document.querySelector('.project-history [data-status="resolved"]');
    if (!heading) return;
    heading.classList.toggle('board-drop-over', over === 'resolved');
    return () => heading.classList.remove('board-drop-over');
  }, [over]);
  /**
   * 已解决 has no column of its own, but a status filter or a search can still put resolved items in
   * `items`; nothing the filter matched may go missing, so the column is there for exactly as long as
   * it holds something.
   */
  const columns = items.some((item) => item.status === 'resolved') ? moveTargets : boardStatuses;
  const resetDrag = () => {
    drag.current = null;
    setDraggedId('');
    setOver('');
  };
  const move = async (item: WorkItem, status: string) => {
    if (busy || moving.current || item.status === status) return;
    moving.current = true;
    setPending(item.id);
    setNotice('');
    try {
      const ok = await onMutate(() =>
        api.patchItem(item.id, { status, ...(item.revision !== undefined ? { revision: item.revision } : {}) })
      );
      setNotice(ok ? `已将「${item.title}」移至${statusLabel(status)}` : '移动未保存，请刷新后重试。');
    } finally {
      moving.current = false;
      setPending('');
    }
  };
  /** The status under the pointer: a column of this board, or the 已解决历史 heading below it. */
  const targetAt = (event: PointerEvent) => {
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-status]');
    if (!target) return '';
    return root.current?.contains(target) || target.closest('.project-history') ? target.dataset.status || '' : '';
  };
  const pointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || busy || moving.current) return;
    // Below the threshold this is still a click on the card, not a drag.
    if (!current.active && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6) return;
    current.active = true;
    suppressClick.current = true;
    setDraggedId(current.item.id);
    setOver(targetAt(event));
    event.preventDefault();
  };
  const pointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    const target = current?.active ? targetAt(event) : '';
    resetDrag();
    if (current?.active && target) void move(current.item, target);
  };
  return (
    <div className="project-board-view" ref={root}>
      {/* Always in the document, so the live region can speak the result of a move that just landed. */}
      <p className="board-notice" role="status" aria-live="polite">
        {notice}
      </p>
      <div className="finding-board">
        {columns.map((status) => {
          const cards = items.filter((item) => item.status === status);
          return (
            <section
              key={status}
              className={`board-column${over === status ? ' board-column-over' : ''}`}
              aria-label={`${statusLabel(status)}列`}
              data-status={status}
            >
              <header className="board-column-header">
                <h3>
                  <StatusIcon status={status} />
                  <span>{statusLabel(status)}</span>
                  <span className="board-column-count">{cards.length}</span>
                </h3>
                <p>{descriptions[status]}</p>
              </header>
              <div className="board-column-body">
                {cards.map((item) => (
                  <article
                    key={item.id}
                    className={`board-card${draggedId === item.id ? ' board-card-dragging' : ''}${
                      pending === item.id ? ' board-card-pending' : ''
                    }`}
                    aria-label={`${item.title}卡片`}
                    aria-busy={pending === item.id}
                  >
                    <button
                      type="button"
                      className="board-card-open"
                      draggable={false}
                      aria-label={`打开 ${featureNumber(item)}「${item.title}」`}
                      onPointerDown={(event) => {
                        if (event.button !== 0 || busy || moving.current) return;
                        suppressClick.current = false;
                        drag.current = { item, x: event.clientX, y: event.clientY, active: false };
                        event.currentTarget.setPointerCapture?.(event.pointerId);
                      }}
                      onPointerMove={pointerMove}
                      onPointerUp={pointerUp}
                      onPointerCancel={resetDrag}
                      onLostPointerCapture={resetDrag}
                      onClick={(event) => {
                        // Enter and Space arrive as a click with no pointer behind them (`detail === 0`),
                        // so a finished drag suppresses the mouse click without swallowing the keyboard.
                        if (!suppressClick.current || event.detail === 0) onOpen(item);
                        suppressClick.current = false;
                      }}
                    >
                      <span className="board-card-type">
                        <span>{featureNumber(item)}</span>
                        <span>{kindLabel(item.kind)}</span>
                      </span>
                      <strong>{item.title}</strong>
                      {item.nextStep && <span className="board-card-next">{item.nextStep}</span>}
                      <span className="board-card-meta">
                        <span className="feature-source-tag" title={`来源：${featureSourceLabel(item, channels)}`}>
                          {item.channelId ? '# ' : ''}
                          {featureSourceLabel(item, channels)}
                        </span>
                        <FeatureOwnerTag item={item} channels={channels} />
                        <span title={`${item.evidence.length} 条证据`}>
                          <Link2 size={12} />
                          {item.evidence.length}
                        </span>
                      </span>
                    </button>
                    <Dropdown
                      trigger={
                        <button
                          type="button"
                          className="board-card-menu"
                          aria-label={`移动「${item.title}」`}
                          disabled={busy || !!pending}
                        >
                          <MoreHorizontal size={15} />
                        </button>
                      }
                    >
                      <div className="feature-menu-heading">移动到</div>
                      {moveTargets.map((target) => (
                        <DropdownItem
                          key={target}
                          selected={target === status}
                          onSelect={() => void move(item, target)}
                        >
                          <StatusIcon status={target} />
                          {statusLabel(target)}
                        </DropdownItem>
                      ))}
                    </Dropdown>
                  </article>
                ))}
                {!cards.length && (
                  <div className="board-column-empty">
                    {draggedId ? '放到此列' : filtered ? '没有匹配的事项' : '暂无事项'}
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

import { useRef, useState, type PointerEvent } from 'react';
import { Link2, MoreHorizontal } from 'lucide-react';
import type { Channel, WorkItem } from '../../shared/types';
import type { FeatureProps } from './types';
import { Dropdown, DropdownItem, StatusIcon } from '../components/ui';
import { kindLabel, statusLabel } from '../components/format';
import { featureNumber, featureSourceLabel } from './featureOwnership';

export const boardStatuses = ['open', 'investigating', 'blocked', 'verified', 'resolved'];
const descriptions: Record<string, string> = {
  open: '待选择与推进', investigating: '正在调查和实施', blocked: '等待依赖或需要指导',
  verified: '已有验证依据', resolved: '已结束的工作',
};
type Props = Pick<FeatureProps, 'api' | 'onMutate' | 'busy'> & {
  items: WorkItem[]; channels: Channel[]; onOpen: (item: WorkItem) => void; filtered: boolean;
};

export function FeatureBoard({ items, channels, onOpen, filtered, api, onMutate, busy }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ item: WorkItem; x: number; y: number; active: boolean } | null>(null);
  const suppressClick = useRef(false);
  const moving = useRef(false);
  const [draggedId, setDraggedId] = useState('');
  const [over, setOver] = useState('');
  const [pending, setPending] = useState('');
  const [notice, setNotice] = useState('');
  const resetDrag = () => { drag.current = null; setDraggedId(''); setOver(''); };
  const move = async (item: WorkItem, status: string) => {
    if (busy || moving.current || item.status === status) return;
    moving.current = true; setPending(item.id); setNotice('');
    try {
      const ok = await onMutate(() => api.patchItem(item.id, { status, ...(item.revision !== undefined ? { revision: item.revision } : {}) }));
      setNotice(ok ? `已将「${item.title}」移至${statusLabel(status)}` : '移动未保存，请刷新后重试。');
    } finally { moving.current = false; setPending(''); }
  };
  const targetAt = (event: PointerEvent) => {
    const column = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-status]');
    return column && root.current?.contains(column) ? column.dataset.status || '' : '';
  };
  const pointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || busy || moving.current) return;
    if (!current.active && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6) return;
    current.active = true; suppressClick.current = true;
    setDraggedId(current.item.id); setOver(targetAt(event));
    event.preventDefault();
  };
  const pointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    const target = current?.active ? targetAt(event) : '';
    resetDrag();
    if (current?.active && target) void move(current.item, target);
  };
  return <div className="project-board-view" ref={root}>
    <div className="board-guidance"><span>项目共享看板</span><span>Codex 持续更新 · 拖动卡片可调整状态</span><span role="status" aria-live="polite">{notice}</span></div>
    <div className="feature-scroll board-scroll" aria-label="项目功能看板">
      <div className="finding-board">
        {boardStatuses.map(status => {
          const cards = items.filter(item => item.status === status);
          return <section key={status} className={`board-column${over === status ? ' board-column-over' : ''}`} aria-label={`${statusLabel(status)}列`} data-status={status}>
            <header className="board-column-header"><h3><StatusIcon status={status} /><span>{statusLabel(status)}</span><span className="board-column-count">{cards.length}</span></h3><p>{descriptions[status]}</p></header>
            <div className="board-column-body">
              {cards.map(item => <article key={item.id} className={`board-card${draggedId === item.id ? ' board-card-dragging' : ''}${pending === item.id ? ' board-card-pending' : ''}`}
                aria-label={`${item.title}卡片`} aria-busy={pending === item.id}>
                <button className="board-card-open" draggable={false} aria-label={`打开 ${featureNumber(item)}「${item.title}」`}
                  onPointerDown={event => {
                    if (event.button !== 0 || busy || moving.current) return;
                    suppressClick.current = false;
                    drag.current = { item, x: event.clientX, y: event.clientY, active: false };
                    event.currentTarget.setPointerCapture?.(event.pointerId);
                  }}
                  onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={resetDrag} onLostPointerCapture={resetDrag}
                  onClick={event => { if (!suppressClick.current || event.detail === 0) onOpen(item); suppressClick.current = false; }}>
                  <span className="board-card-type"><span>{featureNumber(item)}</span><span>{kindLabel(item.kind)}</span></span>
                  <strong>{item.title}</strong>
                  {item.nextStep && <span className="board-card-next">{item.nextStep}</span>}
                  <span className="board-card-meta"><span className="feature-source-tag" title={`来源：${featureSourceLabel(item, channels)}`}>{item.channelId ? '# ' : ''}{featureSourceLabel(item, channels)}</span><span title={`${item.evidence.length} 条证据`}><Link2 size={12} />{item.evidence.length}</span></span>
                </button>
                <Dropdown trigger={<button className="board-card-menu" aria-label={`移动「${item.title}」`} disabled={busy || !!pending}><MoreHorizontal size={15} /></button>}>
                  <div className="feature-menu-heading">移动到</div>
                  {boardStatuses.map(target => <DropdownItem key={target} selected={target === status} onSelect={() => void move(item, target)}><StatusIcon status={target} />{statusLabel(target)}</DropdownItem>)}
                </Dropdown>
              </article>)}
              {!cards.length && <div className="board-column-empty">{draggedId ? '放到此列' : filtered ? '没有匹配的功能' : '暂无功能'}</div>}
            </div>
          </section>;
        })}
      </div>
    </div>
  </div>;
}

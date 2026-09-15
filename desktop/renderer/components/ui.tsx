import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type PointerEvent,
} from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  Check,
  CheckCircle2,
  CircleDashed,
  CircleDot,
  CirclePause,
  AlertCircle,
  GripVertical,
  Copy,
} from 'lucide-react';
import { readPreference, writePreference } from '../state/preferences';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { statusLabel } from './format';

export function Button({
  variant = 'secondary',
  className = '',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return <button type={type} className={`button button-${variant} ${className}`} {...props} />;
}
export function IconButton({
  label,
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button type="button" aria-label={label} className={`icon-button ${className}`} {...props}>
          {children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" sideOffset={6}>
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
const tabId = (scope: string, key: string) => `${scope}-tab-${key}`;
/**
 * The attributes of the panel a `TabRow` controls. Only the selected panel is on screen, so one
 * element is the panel for whichever tab is selected and is labelled by that tab; every tab points
 * at it, so no `aria-controls` ever names an element that is not there.
 */
export const tabPanel = (scope: string, active: string) => ({
  id: `${scope}-panel`,
  role: 'tabpanel' as const,
  'aria-labelledby': tabId(scope, active),
});
/**
 * One row of tabs with the keyboard behaviour the pattern requires: only the selected tab is in the
 * tab order, and Left/Right/Home/End move between them, wrapping around. Each tab names the panel
 * it controls; mark that panel with `tabPanel(scope, active)`.
 */
export function TabRow<T extends string>({
  label,
  scope,
  tabs,
  active,
  onSelect,
  className = '',
}: {
  label: string;
  /** Unique per row on screen, so the ids stay distinct when more than one row is open. */
  scope: string;
  tabs: readonly { key: T; content: ReactNode }[];
  active: T;
  onSelect: (key: T) => void;
  className?: string;
}) {
  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = tabs.map((tab) => tab.key);
    const at = Math.max(0, keys.indexOf(active));
    const next =
      event.key === 'ArrowLeft'
        ? keys[(at - 1 + keys.length) % keys.length]
        : event.key === 'ArrowRight'
          ? keys[(at + 1) % keys.length]
          : event.key === 'Home'
            ? keys[0]
            : event.key === 'End'
              ? keys[keys.length - 1]
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    if (next !== active) onSelect(next);
    document.getElementById(tabId(scope, next))?.focus();
  };
  return (
    <div className={`feature-tabs ${className}`.trim()} role="tablist" aria-label={label} onKeyDown={step}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          id={tabId(scope, tab.key)}
          type="button"
          role="tab"
          aria-selected={tab.key === active}
          aria-controls={`${scope}-panel`}
          tabIndex={tab.key === active ? 0 : -1}
          className={tab.key === active ? 'active' : ''}
          onClick={() => onSelect(tab.key)}
        >
          {tab.content}
        </button>
      ))}
    </div>
  );
}
export function Dropdown({ trigger, children }: { trigger: ReactNode; children: ReactNode }) {
  return (
    <Menu.Root>
      <Menu.Trigger asChild>{trigger}</Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="dropdown" align="end" sideOffset={5}>
          {children}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
export function DropdownItem({
  onSelect,
  children,
  disabled,
  selected,
}: {
  onSelect?: () => void;
  children: ReactNode;
  disabled?: boolean;
  selected?: boolean;
}) {
  return (
    <Menu.Item className="dropdown-item" onSelect={onSelect} disabled={disabled}>
      {children}
      {selected && <Check size={14} className="menu-check" />}
    </Menu.Item>
  );
}
export function DropdownSeparator() {
  return <Menu.Separator className="dropdown-separator" />;
}
export function DropdownLabel({ children }: { children: ReactNode }) {
  return <Menu.Label className="dropdown-label">{children}</Menu.Label>;
}
export function StatusIcon({ status }: { status: string }) {
  const Icon = ['verified', 'resolved', 'completed'].includes(status)
    ? CheckCircle2
    : ['blocked', 'failed', 'interrupted'].includes(status)
      ? AlertCircle
      : ['investigating', 'running'].includes(status)
        ? CircleDot
        : status === 'paused'
          ? CirclePause
          : CircleDashed;
  return <Icon aria-hidden="true" size={15} strokeWidth={1.7} className={`status-icon status-${status}`} />;
}
export function StatusLabel({ status, label }: { status: string; label?: string }) {
  return (
    <span className="status-label">
      <StatusIcon status={status} />
      {label ?? statusLabel(status)}
    </span>
  );
}
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-icon">{icon}</div>}
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {action && <div className="empty-actions">{action}</div>}
    </div>
  );
}
export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                if (href && /^https?:\/\//i.test(href)) void window.morrow?.openExternal(href).catch(() => {});
              }}
            >
              {children}
            </a>
          ),
          img: ({ alt }) => <span className="attachment-label">图片{alt ? ` · ${alt}` : ''}</span>,
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
function CodeBlock({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <button
        className="copy-code"
        aria-label="复制代码"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(ref.current?.textContent || '');
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}
export function PropertyPanel({ children }: { children: ReactNode }) {
  const [width, setWidth] = useState(() =>
    Math.max(240, Math.min(400, Number(readPreference('morrow:inspector-width', 'nh:inspector-width')) || 280))
  );
  const widthRef = useRef(width);
  widthRef.current = width;
  useEffect(() => {
    document.documentElement.style.setProperty('--inspector-width', width + 'px');
  }, [width]);
  function resize(event: PointerEvent<HTMLDivElement>) {
    const startX = event.clientX;
    const initial = width;
    event.currentTarget.setPointerCapture(event.pointerId);
    const node = event.currentTarget;
    const move = (e: globalThis.PointerEvent) => setWidth(Math.max(240, Math.min(400, initial + startX - e.clientX)));
    const end = () => {
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', end);
      node.removeEventListener('pointercancel', end);
      writePreference('morrow:inspector-width', String(widthRef.current));
    };
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', end);
    node.addEventListener('pointercancel', end);
  }
  return (
    <aside className="property-panel" style={{ width }}>
      <div
        role="separator"
        aria-label="调整属性栏宽度"
        aria-orientation="vertical"
        aria-valuenow={width}
        aria-valuemin={240}
        aria-valuemax={400}
        tabIndex={0}
        className="panel-resizer"
        onPointerDown={resize}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            const next = Math.max(240, Math.min(400, width + (e.key === 'ArrowLeft' ? 16 : -16)));
            setWidth(next);
            writePreference('morrow:inspector-width', String(next));
          }
        }}
      >
        <GripVertical size={12} />
      </div>
      <div className="property-scroll">{children}</div>
    </aside>
  );
}

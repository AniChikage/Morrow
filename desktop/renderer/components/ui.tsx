import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type PointerEvent } from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Check, CheckCircle2, CircleDashed, CircleDot, CirclePause, AlertCircle, GripVertical, Copy } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { statusLabel } from './format';

export function Button({ variant = 'secondary', className = '', type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return <button type={type} className={`button button-${variant} ${className}`} {...props}/>;
}
export function IconButton({ label, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <Tooltip.Root><Tooltip.Trigger asChild><button type="button" aria-label={label} className={`icon-button ${className}`} {...props}>{children}</button></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="tooltip" sideOffset={6}>{label}</Tooltip.Content></Tooltip.Portal></Tooltip.Root>;
}
export function Dropdown({ trigger, children }: { trigger: ReactNode; children: ReactNode }) {
  return <Menu.Root><Menu.Trigger asChild>{trigger}</Menu.Trigger><Menu.Portal><Menu.Content className="dropdown" align="end" sideOffset={5}>{children}</Menu.Content></Menu.Portal></Menu.Root>;
}
export function DropdownItem({ onSelect, children, disabled, selected }: { onSelect?: () => void; children: ReactNode; disabled?: boolean; selected?: boolean }) {
  return <Menu.Item className="dropdown-item" onSelect={onSelect} disabled={disabled}>{children}{selected && <Check size={14} className="menu-check"/>}</Menu.Item>;
}
export function DropdownSeparator() { return <Menu.Separator className="dropdown-separator"/>; }
export function DropdownLabel({children}: {children:ReactNode}) { return <Menu.Label className="dropdown-label">{children}</Menu.Label>; }
export function StatusIcon({ status }: { status: string }) {
  const Icon = ['verified','resolved','completed'].includes(status) ? CheckCircle2 : ['blocked','failed','interrupted'].includes(status) ? AlertCircle : ['investigating','running'].includes(status) ? CircleDot : status === 'paused' ? CirclePause : CircleDashed;
  return <Icon aria-hidden="true" size={15} strokeWidth={1.7} className={`status-icon status-${status}`}/>;
}
export function StatusLabel({status}: {status:string}) { return <span className="status-label"><StatusIcon status={status}/>{statusLabel(status)}</span>; }
export function EmptyState({icon, title, description, action}: {icon?:ReactNode;title:string;description?:string;action?:ReactNode}) {
  return <div className="empty-state">{icon && <div className="empty-icon">{icon}</div>}<h2>{title}</h2>{description && <p>{description}</p>}{action && <div className="empty-actions">{action}</div>}</div>;
}
export function Markdown({children}: {children:string}) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({href, children}) => <a href={href} onClick={event=>{event.preventDefault();if(href && /^https?:\/\//i.test(href)) void window.morrow?.openExternal(href).catch(()=>{});}}>{children}</a>,
    img: ({alt}) => <span className="attachment-label">图片{alt ? ` · ${alt}` : ''}</span>,
    pre: ({children}) => <CodeBlock>{children}</CodeBlock>,
  }}>{children}</ReactMarkdown></div>;
}
function CodeBlock({children}: {children:ReactNode}) {
  const ref = useRef<HTMLPreElement>(null); const [copied,setCopied] = useState(false);
  return <div className="code-block"><button className="copy-code" aria-label="复制代码" onClick={async()=>{try {await navigator.clipboard.writeText(ref.current?.textContent || '');setCopied(true);setTimeout(()=>setCopied(false),1500);}catch{setCopied(false);}}}>{copied ? <Check size={13}/> : <Copy size={13}/>}</button><pre ref={ref}>{children}</pre></div>;
}
export function PropertyPanel({children}: {children:ReactNode}) {
  const [width,setWidth] = useState(()=> {try{return Math.max(240,Math.min(400,Number(localStorage.getItem('morrow:inspector-width') ?? localStorage.getItem('nh:inspector-width')) || 280));}catch{return 280;}});
  const widthRef=useRef(width); widthRef.current=width;
  useEffect(()=>{document.documentElement.style.setProperty('--inspector-width',width+'px');},[width]);
  function resize(event:PointerEvent<HTMLDivElement>) {const startX=event.clientX; const initial=width; event.currentTarget.setPointerCapture(event.pointerId); const node=event.currentTarget; const move=(e:globalThis.PointerEvent)=>setWidth(Math.max(240,Math.min(400,initial+startX-e.clientX))); const end=()=>{node.removeEventListener('pointermove',move);node.removeEventListener('pointerup',end);node.removeEventListener('pointercancel',end);try{localStorage.setItem('morrow:inspector-width',String(widthRef.current));}catch{}};node.addEventListener('pointermove',move);node.addEventListener('pointerup',end);node.addEventListener('pointercancel',end);}
  return <aside className="property-panel" style={{width}}><div role="separator" aria-label="调整属性栏宽度" aria-orientation="vertical" aria-valuenow={width} aria-valuemin={240} aria-valuemax={400} tabIndex={0} className="panel-resizer" onPointerDown={resize} onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();const next=Math.max(240,Math.min(400,width+(e.key==='ArrowLeft'?16:-16)));setWidth(next);try{localStorage.setItem('morrow:inspector-width',String(next));}catch{}}}}><GripVertical size={12}/></div><div className="property-scroll">{children}</div></aside>;
}

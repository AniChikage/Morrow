import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ImageIcon, LoaderCircle, X } from 'lucide-react';
import type { DesktopAPI, NativeAttachment } from '../../shared/types';
import { Button } from '../components/ui';

// Renderer image sources are always bounded, validated data URLs. Native image
// paths and remote URLs go through the service's bound-item image reader.
export function nativeImageSource(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 14 * 1024 * 1024 && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/.test(value) ? value : undefined;
}

export function NativeImage({ channelId, itemId, index, api, name = '原生图片' }: { channelId: string; itemId: string; index: number; api: DesktopAPI; name?: string }) {
  const [source, setSource] = useState<string>();
  const [error, setError] = useState('');
  const [visible, setVisible] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSource(undefined); setError('');
    if (!root.current || typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    setVisible(false);
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '400px' });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, [channelId, itemId, index]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setError('');
    void api.getNativeImage(channelId, itemId, index).then(result => {
      if (cancelled) return;
      const value = nativeImageSource(result.dataUrl);
      if (!value) throw new Error('原生图片格式不可显示。');
      setSource(value);
    }).catch(failure => { if (!cancelled) setError(failure instanceof Error ? failure.message : '图片读取失败'); });
    return () => { cancelled = true; };
  }, [api, channelId, itemId, index, visible, attempt]);

  return <div className="native-image" ref={root}>{source ? <NativeImagePreview source={source} name={name} /> : error ? <div className="native-image-placeholder" role="status"><ImageIcon size={19} /><span>{error}</span><Button variant="ghost" aria-label={`重新加载${name}`} onClick={() => setAttempt(value => value + 1)}>重试</Button></div> : <div className="native-image-placeholder" role="status"><LoaderCircle size={17} className="spin" /><span>正在读取图片…</span></div>}</div>;
}

function NativeImagePreview({ source, name }: { source: string; name: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [source]);
  if (broken) return <div className="native-image-placeholder"><ImageIcon size={18} /><span>图片数据无法解码</span></div>;
  return <Dialog.Root><Dialog.Trigger asChild><button className="native-image-preview" aria-label={`放大${name}`}><img src={source} alt={name} loading="lazy" onError={() => setBroken(true)} /></button></Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="native-image-overlay" /><Dialog.Content className="native-image-dialog" aria-describedby={undefined}><Dialog.Title>{name}</Dialog.Title><Dialog.Close asChild><button className="native-image-close" aria-label="关闭图片预览"><X size={19} /></button></Dialog.Close><img src={source} alt={name} /></Dialog.Content></Dialog.Portal></Dialog.Root>;
}

export function NativeImageDrafts({ attachments, disabled, onRemove }: { attachments: NativeAttachment[]; disabled: boolean; onRemove: (id: string) => void }) {
  if (!attachments.length) return null;
  return <div className="native-image-drafts" aria-label="待发送的图片">{attachments.map(attachment => {
    const source = nativeImageSource(attachment.previewUrl);
    return <div className="native-image-draft" key={attachment.id} title={attachment.name}>{source ? <NativeImagePreview source={source} name={attachment.name} /> : <span className="native-image-draft-icon"><ImageIcon size={22} /></span>}<span>{attachment.name}</span><button aria-label={`移除图片 ${attachment.name}`} disabled={disabled} onClick={() => onRemove(attachment.id)}><X size={12} /></button></div>;
  })}</div>;
}

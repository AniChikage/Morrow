import { useEffect, useId, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import type { ChannelWork, DesktopAPI, NativeMessageInput } from '../../shared/types';
import { Button, Markdown } from '../components/ui';
import { formatDate } from '../components/format';
import './content.css';

/** One-line excerpt of a Codex question for lists: Markdown markers dropped, whitespace collapsed, cut at `limit`. */
export function questionExcerpt(text: string, limit = 120) {
  const plain = text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-+*]\s+|\d+\.\s+)/gm, '')
    .replace(/\*\*|__|~~|[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const characters = Array.from(plain);
  return characters.length > limit ? characters.slice(0, limit).join('').trimEnd() + '…' : plain;
}

interface Props {
  channelId: string;
  work: ChannelWork;
  api: DesktopAPI;
  busy?: boolean;
  /** Why the answer box is disabled right now; empty when the user can answer. */
  unavailable?: string;
  /** Retired runtimes keep the question readable but never receive an answer. */
  readOnly?: boolean;
  /** Focus the box once it is usable. Only set when the page was opened with this question already waiting. */
  autoFocus?: boolean;
  onShowConversation: () => void;
}

export function ChannelQuestion({
  channelId,
  work,
  api,
  busy = false,
  unavailable = '',
  readOnly = false,
  autoFocus = false,
  onShowConversation,
}: Props) {
  const labelId = useId();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<'accepted' | 'pending' | null>(null);
  const [error, setError] = useState('');
  // A lost reply does not prove the native App rejected the answer: keep the same
  // idempotency key so re-sending the unchanged text reconciles instead of duplicating.
  const [unconfirmed, setUnconfirmed] = useState<NativeMessageInput | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const focused = useRef(false);
  const mounted = useRef(true);
  const disabled = busy || sending || !!unavailable;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!autoFocus || focused.current || disabled || !input.current) return;
    const active = document.activeElement;
    // Never pull focus away from another field the user is typing in.
    if (
      active instanceof HTMLElement &&
      active !== input.current &&
      active.matches('input, textarea, [contenteditable]')
    )
      return;
    focused.current = true;
    input.current.focus();
  }, [autoFocus, disabled]);

  async function submit() {
    const text = draft.trim();
    if (!text || disabled) return;
    const message: NativeMessageInput =
      unconfirmed?.text === text ? unconfirmed : { text, requestId: crypto.randomUUID() };
    setSending(true);
    setError('');
    try {
      const receipt = await api.sendNativeMessage(channelId, message);
      if (!mounted.current) return;
      if (receipt.state === 'accepted' || receipt.state === 'pending') {
        setSent(receipt.state);
        setUnconfirmed(null);
        setDraft('');
      } else if (receipt.state === 'failed') {
        setUnconfirmed(null);
        setError(receipt.error || '原生任务未接收回答，请检查后重试。');
      } else setUnconfirmed(message);
    } catch (caught) {
      if (!mounted.current) return;
      setUnconfirmed(null);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (mounted.current) setSending(false);
    }
  }

  return (
    <section className="channel-question" aria-labelledby={labelId}>
      <span className="channel-question-label" id={labelId}>
        Codex 需要你回答
      </span>
      <div className="channel-question-body">
        <Markdown>{work.nextStep}</Markdown>
      </div>
      <div className="channel-question-meta">
        <time dateTime={work.updatedAt}>{formatDate(work.updatedAt)}</time>
        <Button variant="ghost" onClick={onShowConversation}>
          查看完整回复
        </Button>
      </div>
      {sent ? (
        <p className="channel-question-answered" role="status">
          <Check size={14} />
          {sent === 'accepted' ? '已回答，Codex 将继续' : '已发送，正在等待原生任务确认'}
        </p>
      ) : (
        !readOnly && (
          <div className="channel-question-answer">
            <textarea
              ref={input}
              className="channel-question-input"
              aria-label="回答 Codex 的问题"
              placeholder="回答 Codex 的问题…"
              value={draft}
              disabled={disabled}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            {error && (
              <p className="feature-inline-error" role="alert">
                {error}
              </p>
            )}
            {unconfirmed && (
              <p className="channel-question-note" role="status">
                发送状态尚未确认，请到对话中核对后再决定是否重发
              </p>
            )}
            <div className="channel-question-actions">
              <span className="channel-question-hint">{sending ? '正在发送…' : unavailable || '⌘ Enter 回答'}</span>
              <Button variant="primary" disabled={disabled || !draft.trim()} onClick={() => void submit()}>
                回答
              </Button>
            </div>
          </div>
        )
      )}
    </section>
  );
}

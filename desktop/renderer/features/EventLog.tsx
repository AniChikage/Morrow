import { ChevronDown, CircleAlert, Code2, MessageSquare, Sparkles, Terminal } from 'lucide-react';
import type { WorkspaceEvent } from '../../shared/types';
import { Markdown } from '../components/ui';
import { formatDate, runtimeLabel, statusLabel } from '../components/format';
import { readableEventText, toolPresentation } from './eventPresentation';
/** Oldest first, and within one timestamp the order the service recorded the events in. */
export const byRecordOrder = (a: WorkspaceEvent, b: WorkspaceEvent) =>
  a.createdAt.localeCompare(b.createdAt) || (a.detail?.sequence ?? 0) - (b.detail?.sequence ?? 0);
export function EventLog({
  event,
  runtime,
  compact = false,
}: {
  event: WorkspaceEvent;
  runtime: string;
  compact?: boolean;
}) {
  const tool = toolPresentation(event);
  if (tool)
    return (
      <details className="tool-event" open={!compact && tool.status === 'failed'}>
        <summary>
          <Terminal size={14} />
          <span>{tool.name}</span>
          {tool.status && <span className="subtle">{statusLabel(tool.status)}</span>}
          <time>{formatDate(event.createdAt)}</time>
          <ChevronDown size={13} />
        </summary>
        <div className="tool-event-body">
          {tool.input && (
            <div>
              <h4>输入</h4>
              <pre>{tool.input}</pre>
            </div>
          )}
          {tool.output && (
            <div>
              <h4>输出</h4>
              <pre>{tool.output}</pre>
            </div>
          )}
          {!tool.input && !tool.output && <pre>{event.text}</pre>}
        </div>
      </details>
    );
  const value = readableEventText(event);
  const content =
    compact && value.length > 240 ? (
      <>
        <p>{value.slice(0, 160)}…</p>
        <details className="audit-changes">
          <summary>完整记录</summary>
          <Markdown>{value}</Markdown>
        </details>
      </>
    ) : (
      <Markdown>{value}</Markdown>
    );
  if (event.kind === 'system' || event.kind === 'error')
    return (
      <div className={`system-event ${event.kind === 'error' ? 'event-error' : ''}`}>
        {event.kind === 'error' ? <CircleAlert size={14} /> : <Code2 size={14} />}
        <div>
          {compact && value.length > 240 ? content : <span>{value}</span>}
          <time>{formatDate(event.createdAt)}</time>
        </div>
      </div>
    );
  return (
    <article className={`message-event ${event.kind === 'message' ? 'human-event' : ''}`}>
      <div className="event-avatar">
        {event.kind === 'message' ? <MessageSquare size={15} /> : <Sparkles size={15} />}
      </div>
      <div className="message-event-body">
        <header>
          <strong>{event.kind === 'message' ? '你' : runtimeLabel(runtime)}</strong>
          {event.kind === 'result' && <span className="event-result-label">运行结果</span>}
          <time>{formatDate(event.createdAt)}</time>
        </header>
        {content}
      </div>
    </article>
  );
}

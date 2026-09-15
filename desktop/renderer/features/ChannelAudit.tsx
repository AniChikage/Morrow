import { useMemo } from 'react';
import { History, LoaderCircle, MessageSquare } from 'lucide-react';
import type { FeatureProps } from './types';
import { Button, EmptyState } from '../components/ui';
import { usePagedHistory } from '../components/history';
import { byRecordOrder, EventLog } from './EventLog';
export function ChannelAudit({ id, api, snapshot }: Pick<FeatureProps, 'api' | 'snapshot'> & { id: string }) {
  const channel = snapshot.channels.find((c) => c.id === id);
  const channelExists = !!channel;
  const {
    rows,
    loading: loadingOlder,
    error: historyError,
    hasMore,
    cursor,
    load: loadHistory,
  } = usePagedHistory({
    scope: id,
    live: snapshot.events,
    enabled: channelExists,
    sort: byRecordOrder,
    failure: '暂时无法加载记录，已保留当前内容。',
    page: async (before) => {
      const page = await api.getEvents({ channelId: id, ...(before ? { before } : {}), limit: 60 });
      return { rows: page.events, hasMore: page.hasMore, cursor: page.cursor || page.events[0]?.id };
    },
  });
  const events = useMemo(() => rows.filter((event) => event.channelId === id), [rows, id]);
  return (
    <>
      {historyError && (
        <div className="feature-inline-error" role="alert">
          {historyError}
          <Button variant="ghost" onClick={() => loadHistory(cursor)}>
            重试
          </Button>
        </div>
      )}
      {loadingOlder && (
        <div className="run-loading" role="status">
          <LoaderCircle className="spin" size={14} />
          正在读取记录…
        </div>
      )}
      {events.length > 0 ? (
        <div className="event-timeline">
          {hasMore && !historyError && (
            <div className="load-history">
              <Button variant="ghost" disabled={loadingOlder} onClick={() => loadHistory(cursor)}>
                <History size={14} />
                加载更早记录
              </Button>
            </div>
          )}
          {events.map((event) => (
            <EventLog key={event.id} event={event} runtime={channel?.runtime || 'codex'} />
          ))}
        </div>
      ) : (
        !loadingOlder &&
        !historyError && (
          <EmptyState icon={<MessageSquare />} title="频道还没有动态" description="本频道暂无审计记录。" />
        )
      )}
    </>
  );
}

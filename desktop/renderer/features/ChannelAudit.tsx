import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { History, LoaderCircle, MessageSquare } from 'lucide-react';
import type { WorkspaceEvent } from '../../shared/types';
import type { FeatureProps } from './types';
import { Button, EmptyState } from '../components/ui';
import { EventLog } from './EventLog';
export function ChannelAudit({ id, api, snapshot }: Pick<FeatureProps, 'api' | 'snapshot'> & { id: string }) {
  const channel = snapshot.channels.find((c) => c.id === id);
  const [older, setOlder] = useState<WorkspaceEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const snapshotBaseline = useRef(new Set<string>());
  const historyGeneration = useRef(0);
  const historyBusy = useRef(false);
  const events = useMemo(() => {
    const loadedIds = new Set(older.map((event) => event.id));
    const live = snapshot.events.filter(
      (event) =>
        event.channelId === id && (!historyLoaded || loadedIds.has(event.id) || !snapshotBaseline.current.has(event.id))
    );
    return [
      ...new Map(
        [...older.filter((event) => event.channelId === id), ...live].map((event) => [event.id, event])
      ).values(),
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.detail?.sequence ?? 0) - (b.detail?.sequence ?? 0));
  }, [older, snapshot.events, id, historyLoaded]);
  const loadHistory = useCallback(
    async (before?: string) => {
      if (historyBusy.current) return;
      const generation = historyGeneration.current;
      historyBusy.current = true;
      setLoadingOlder(true);
      setHistoryError('');
      try {
        const page = await api.getEvents({ channelId: id, ...(before ? { before } : {}), limit: 60 });
        if (historyGeneration.current !== generation) return;
        setOlder((previous) => (before ? [...page.events, ...previous] : page.events));
        setHistoryLoaded(true);
        setHasMore(page.hasMore);
        setCursor(page.cursor || page.events[0]?.id);
      } catch (error) {
        if (historyGeneration.current !== generation) return;
        setHistoryError(error instanceof Error ? error.message : '暂时无法加载记录，已保留当前内容。');
      } finally {
        if (historyGeneration.current === generation) {
          historyBusy.current = false;
          setLoadingOlder(false);
        }
      }
    },
    [api, id]
  );
  const channelExists = !!channel;
  useEffect(() => {
    historyGeneration.current++;
    historyBusy.current = false;
    snapshotBaseline.current = new Set(snapshot.events.map((event) => event.id));
    setOlder([]);
    setHistoryLoaded(false);
    setHasMore(false);
    setCursor(undefined);
    setLoadingOlder(false);
    setHistoryError('');
    if (channelExists) void loadHistory();
    return () => {
      historyGeneration.current++;
    };
  }, [id, channelExists, loadHistory]);
  return (
    <>
      {historyError && (
        <div className="feature-inline-error" role="alert">
          {historyError}
          <Button variant="ghost" onClick={() => void loadHistory(cursor)}>
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
              <Button variant="ghost" disabled={loadingOlder} onClick={() => void loadHistory(cursor)}>
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mergeById } from './collections';

export type HistoryPage<T> = { rows: T[]; hasMore: boolean; cursor?: string };
export type PagedHistory<T> = {
  /** The loaded pages with the live rows outside them merged on top, in the caller's order. */
  rows: T[];
  loading: boolean;
  error: string;
  hasMore: boolean;
  /** The cursor the next 「加载更早」 reads before; undefined once the oldest page is loaded. */
  cursor?: string;
  /** Without a cursor, reads the newest page again; with one, the page before it. */
  load: (before?: string) => void;
};
/**
 * The paged history the record lists share: the newest page on entry, older pages before a cursor,
 * live snapshot rows merged over the loaded range, and one error a retry clears. A new `scope`
 * starts over, dropping the loaded pages and reading the newest one again.
 *
 * `rows` comes back unfiltered so each page keeps its own filters, and so the baseline that decides
 * which live rows fall outside the loaded range stays the whole snapshot's, as every caller had it:
 * a row the snapshot already held when the scope was entered belongs to history, not to the live
 * tail, and only reappears once a page has actually loaded it.
 */
export function usePagedHistory<T extends { id: string }>(options: {
  /** Identifies the history; changing it starts a new one. */
  scope: string;
  live: T[];
  page: (before?: string) => Promise<HistoryPage<T>>;
  sort: (a: T, b: T) => number;
  /** Shown when the failure carries no message of its own. */
  failure: string;
  /** False keeps the history empty without reading anything, for a scope that does not exist. */
  enabled?: boolean;
  /** Page state that belongs to one scope, cleared with it. */
  onReset?: () => void;
}): PagedHistory<T> {
  const { scope, live, enabled = true } = options;
  const latest = useRef(options);
  latest.current = options;
  const [loaded, setLoaded] = useState<T[]>([]);
  const [loadedHistory, setLoadedHistory] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string>();
  const generation = useRef(0);
  const busy = useRef(false);
  const baseline = useRef(new Set<string>());
  const load = useCallback((before?: string) => {
    if (busy.current) return;
    const current = generation.current;
    busy.current = true;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const page = await latest.current.page(before);
        if (current !== generation.current) return;
        setLoaded((previous) => (before ? [...page.rows, ...previous] : page.rows));
        setLoadedHistory(true);
        setHasMore(page.hasMore);
        setCursor(page.cursor);
      } catch (failure) {
        if (current === generation.current)
          setError(failure instanceof Error ? failure.message : latest.current.failure);
      } finally {
        if (current === generation.current) {
          busy.current = false;
          setLoading(false);
        }
      }
    })();
  }, []);
  useEffect(() => {
    generation.current++;
    busy.current = false;
    baseline.current = new Set(latest.current.live.map((row) => row.id));
    setLoaded([]);
    setLoadedHistory(false);
    setLoading(false);
    setError('');
    setHasMore(false);
    setCursor(undefined);
    latest.current.onReset?.();
    if (enabled) load();
    return () => {
      generation.current++;
    };
  }, [scope, enabled, load]);
  const rows = useMemo(() => {
    const ids = new Set(loaded.map((row) => row.id));
    const outside = loadedHistory ? live.filter((row) => ids.has(row.id) || !baseline.current.has(row.id)) : live;
    return mergeById(loaded, outside, latest.current.sort);
  }, [loaded, live, loadedHistory]);
  return { rows, loading, error, hasMore, cursor, load };
}

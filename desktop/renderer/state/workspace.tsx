import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { emptySnapshot, type ConnectionInfo, type DesktopAPI, type Snapshot } from '../../shared/types';
const unavailable = async (): Promise<never> => { throw new Error('桌面连接不可用，请重新打开 Morrow。'); };
export const isDesktop = !!(window.morrow || window.nohuman);
let desktopAPI: DesktopAPI = window.morrow || window.nohuman || new Proxy({} as DesktopAPI, { get: () => unavailable });
export async function prepareAPI() {
  if (!window.morrow && !window.nohuman && import.meta.env.DEV) {
    desktopAPI = (await import('./preview')).previewAPI();
  }
}
interface Workspace {
  api: DesktopAPI; snapshot: Snapshot; connection: ConnectionInfo | null;
  loading: boolean; busy: boolean; error: string;
  clearError: () => void; refresh: () => Promise<void>;
  mutate: (action: () => Promise<unknown>) => Promise<boolean>;
  reset: () => void; setConnectionInfo: (info: ConnectionInfo) => void;
}
const Context = createContext<Workspace | null>(null);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const connectionKey = (info: ConnectionInfo) => JSON.stringify(info.config);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [count, setCount] = useState(0);
  const [error, setError] = useState('');
  const connectionRef = useRef<ConnectionInfo | null>(null);
  const refreshPromise = useRef<Promise<void> | null>(null);
  const fingerprint = useRef('');
  const generation = useRef(0);
  const requestNumber = useRef(0);
  const pendingConnection = useRef(false);
  const operationError = useRef(false);
  const mounted = useRef(true);

  const clearError = useCallback(() => { operationError.current = false; setError(''); }, []);
  const publishConnection = useCallback((info: ConnectionInfo) => {
    if (connectionRef.current && connectionKey(connectionRef.current) !== connectionKey(info)) {
      fingerprint.current = '';
      setSnapshot(emptySnapshot);
    }
    connectionRef.current = info;
    setConnection(previous => JSON.stringify(previous) === JSON.stringify(info) ? previous : info);
  }, []);
  const setConnectionInfo = useCallback((info: ConnectionInfo) => {
    pendingConnection.current = false;
    publishConnection(info);
    if (!info.connected) {
      setLoading(false);
      if (info.error) setError(info.error);
    }
  }, [publishConnection]);

  const fetchSnapshot = useCallback((force = false): Promise<void> => {
    if (pendingConnection.current || !mounted.current) return Promise.resolve();
    if (!force && refreshPromise.current) return refreshPromise.current;
    const currentGeneration = generation.current;
    const number = ++requestNumber.current;
    const isCurrent = () => mounted.current && currentGeneration === generation.current && number === requestNumber.current;
    const task = (async () => {
      let data: Snapshot | undefined;
      let stateFailure: unknown;
      let info: ConnectionInfo | undefined;
      let infoFailure: unknown;
      try { data = await desktopAPI.getState(); } catch (failure) { stateFailure = failure; }
      // Read this after getState, which can update the main process's liveness.
      // A failed state request must not prevent the actual target/config from updating.
      if (!isCurrent()) return;
      try { info = await desktopAPI.getConnection(); } catch (failure) { infoFailure = failure; }
      if (!isCurrent()) return;
      if (info) publishConnection(data ? info : { ...info, connected: false });
      else if (!data && connectionRef.current) publishConnection({ ...connectionRef.current, connected: false });
      if (data) {
        const next = JSON.stringify(data);
        if (fingerprint.current !== next) { fingerprint.current = next; setSnapshot(data); }
      }
      if (!operationError.current) {
        if (stateFailure || infoFailure) setError(info?.error || errorText(stateFailure || infoFailure));
        else setError('');
      }
    })().catch(failure => {
      // Also handle unexpected parsing/state errors without rejecting a polling call.
      if (isCurrent() && !operationError.current) setError(errorText(failure));
    }).finally(() => {
      if (isCurrent()) setLoading(false);
      // An obsolete request must not clear a newer request's deduplication slot.
      if (refreshPromise.current === task) refreshPromise.current = null;
    });
    refreshPromise.current = task;
    return task;
  }, [publishConnection]);
  const refresh = useCallback(() => fetchSnapshot(), [fetchSnapshot]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const interval = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, 2000);
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus);
    return () => {
      mounted.current = false;
      generation.current++;
      refreshPromise.current = null;
      clearInterval(interval);
      window.removeEventListener('focus', focus);
    };
  }, [refresh]);

  const mutate = useCallback(async (action: () => Promise<unknown>) => {
    const currentGeneration = generation.current;
    const isCurrent = () => mounted.current && currentGeneration === generation.current;
    setCount(value => value + 1);
    clearError();
    try {
      await action();
      if (!isCurrent()) return false;
      // Start a new read after the write. An earlier poll cannot satisfy this
      // refresh or subsequently overwrite its result, even if it completes last.
      await fetchSnapshot(true);
      return isCurrent();
    } catch (failure) {
      if (!isCurrent()) return false;
      if (pendingConnection.current) {
        try {
          const info = await desktopAPI.getConnection();
          if (!isCurrent()) return false;
          setConnectionInfo(info);
        } catch {
          if (!isCurrent()) return false;
          pendingConnection.current = false;
          if (connectionRef.current) publishConnection({ ...connectionRef.current, connected: false });
        }
        setLoading(false);
      }
      operationError.current = true;
      setError(errorText(failure));
      return false;
    } finally {
      if (mounted.current) setCount(value => Math.max(0, value - 1));
    }
  }, [clearError, fetchSnapshot, publishConnection, setConnectionInfo]);

  const reset = useCallback(() => {
    generation.current++;
    requestNumber.current++;
    refreshPromise.current = null;
    pendingConnection.current = true;
    fingerprint.current = '';
    setSnapshot(emptySnapshot);
    if (connectionRef.current) publishConnection({ ...connectionRef.current, connected: false });
    setLoading(true);
    clearError();
  }, [clearError, publishConnection]);

  return <Context.Provider value={{ api: desktopAPI, snapshot, connection, loading, busy: count > 0, error, clearError, refresh, mutate, reset, setConnectionInfo }}>{children}</Context.Provider>;
}
export function useWorkspace() {
  const context = useContext(Context);
  if (!context) throw new Error('WorkspaceProvider missing');
  return context;
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Route } from '../../shared/types';

interface TabSession { id: string; history: Route[]; index: number }
interface Navigation { tabs: TabSession[]; active: string }
interface Session { navigation: Navigation; initialized: boolean }
interface ScopedSession extends Session { scope: string | null; hydrated: boolean }
const emptyNavigation = (): Navigation => ({ tabs: [], active: '' });
const routeKey = (route: Route) => route.kind + ('id' in route ? ':' + route.id : '');
function validRoute(value: unknown): value is Route {
  if (!value || typeof value !== 'object') return false;
  const route = value as Route;
  return ['runs', 'runtimes'].includes(route.kind) || (['project', 'finding', 'channel'].includes(route.kind) && 'id' in route && typeof route.id === 'string' && !!route.id);
}
function readSession(scope: string): Session {
  try {
    const value = JSON.parse(localStorage.getItem('nh:tabs:' + scope) || 'null');
    const validTabs = Array.isArray(value?.tabs) && value.tabs.every((tab: TabSession) => tab && typeof tab.id === 'string' && !!tab.id && Array.isArray(tab.history) && tab.history.length > 0 && tab.history.every(validRoute) && Number.isInteger(tab.index) && tab.index >= 0 && tab.index < tab.history.length);
    if (validTabs && typeof value.active === 'string' && new Set(value.tabs.map((tab: TabSession) => tab.id)).size === value.tabs.length && (value.tabs.length ? value.tabs.some((tab: TabSession) => tab.id === value.active) : value.active === '')) {
      // An explicitly saved empty session means the user closed their last tab.
      return { navigation: value, initialized: true };
    }
  } catch { /* Invalid or unavailable storage starts a fresh in-memory session. */ }
  return { navigation: emptyNavigation(), initialized: false };
}
function newTab(route: Route): TabSession { return { id: crypto.randomUUID(), history: [route], index: 0 }; }

export function useNavigation(scope: string | null) {
  const [session, setSession] = useState<ScopedSession>({ scope: null, hydrated: false, initialized: false, navigation: emptyNavigation() });
  const sessionRef = useRef(session);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  useEffect(() => {
    const next: ScopedSession = scope === null
      ? { scope: null, hydrated: false, initialized: false, navigation: emptyNavigation() }
      : { scope, hydrated: true, ...readSession(scope) };
    sessionRef.current = next;
    setSession(next);
  }, [scope]);

  const commit = useCallback((update: (previous: Session) => Session) => {
    const previous = sessionRef.current;
    // A scope can change before effects run. Never apply an old callback to a new workspace.
    if (scope === null || scopeRef.current !== scope || previous.scope !== scope || !previous.hydrated) return;
    const changed = update(previous);
    if (changed === previous) return;
    const next: ScopedSession = { ...changed, scope, hydrated: true };
    sessionRef.current = next;
    try { localStorage.setItem('nh:tabs:' + scope, JSON.stringify(next.navigation)); } catch { /* Navigation still works when storage is unavailable. */ }
    setSession(next);
  }, [scope]);

  const save = useCallback((update: (previous: Navigation) => Navigation) => commit(previous => {
    const navigation = update(previous.navigation);
    return navigation === previous.navigation ? previous : { navigation, initialized: true };
  }), [commit]);

  const openDefault = useCallback((route: Route) => commit(previous => {
    if (previous.initialized || previous.navigation.tabs.length) return previous;
    const tab = newTab(route);
    return { initialized: true, navigation: { tabs: [tab], active: tab.id } };
  }), [commit]);

  const navigate = useCallback((route: Route, openInNewTab = false) => save(previous => {
    const existing = previous.tabs.find(tab => routeKey(tab.history[tab.index]) === routeKey(route));
    if (existing) return existing.id === previous.active ? previous : { ...previous, active: existing.id };
    const active = previous.tabs.find(tab => tab.id === previous.active);
    if (openInNewTab || !active) {
      const tab = newTab(route);
      return { tabs: [...previous.tabs, tab], active: tab.id };
    }
    return { ...previous, tabs: previous.tabs.map(tab => tab.id === active.id ? { ...tab, history: [...tab.history.slice(0, tab.index + 1), route].slice(-40), index: Math.min(tab.index + 1, 39) } : tab) };
  }), [save]);

  const close = useCallback((id: string) => save(previous => {
    const index = previous.tabs.findIndex(tab => tab.id === id);
    if (index === -1) return previous;
    const tabs = previous.tabs.filter(tab => tab.id !== id);
    return { tabs, active: previous.active === id ? tabs[Math.min(index, tabs.length - 1)]?.id || '' : previous.active };
  }), [save]);

  const activate = useCallback((id: string) => save(previous => id === previous.active || !previous.tabs.some(tab => tab.id === id) ? previous : { ...previous, active: id }), [save]);
  const travel = useCallback((delta: number) => save(previous => {
    const active = previous.tabs.find(tab => tab.id === previous.active);
    if (!active) return previous;
    const index = Math.max(0, Math.min(active.history.length - 1, active.index + delta));
    if (index === active.index) return previous;
    return { ...previous, tabs: previous.tabs.map(tab => tab.id === active.id ? { ...tab, index } : tab) };
  }), [save]);

  const hydrated = scope !== null && session.scope === scope && session.hydrated;
  const navigation = hydrated ? session.navigation : emptyNavigation();
  const active = navigation.tabs.find(tab => tab.id === navigation.active);
  return {
    hydrated, needsDefault: hydrated && !session.initialized,
    tabs: navigation.tabs, activeId: navigation.active, route: active?.history[active.index],
    canBack: !!active && active.index > 0, canForward: !!active && active.index < active.history.length - 1,
    navigate, openDefault, close, activate, travel,
  };
}

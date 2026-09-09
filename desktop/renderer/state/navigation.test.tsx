// @vitest-environment jsdom
import { StrictMode, useEffect } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Route } from '../../shared/types';
import { useNavigation } from './navigation';

const project = (id: string): Route => ({ kind: 'project', id });
const channel = (id: string): Route => ({ kind: 'channel', id });
function saveSession(scope: string, route: Route, id = 'restored-tab') {
  const value = JSON.stringify({ tabs: [{ id, history: [route], index: 0 }], active: id });
  localStorage.setItem('morrow:tabs:' + scope, value);
  return value;
}
function useDefaultWorkspace(scope: string | null, defaultRoute: Route) {
  const navigation = useNavigation(scope);
  useEffect(() => {
    if (navigation.hydrated && navigation.needsDefault) navigation.openDefault(defaultRoute);
  }, [navigation.hydrated, navigation.needsDefault, navigation.openDefault, defaultRoute]);
  return navigation;
}
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('workspace navigation sessions', () => {
  it('restores a legacy NoHuman tab session and writes future changes under Morrow', () => {
    const value = JSON.stringify({ tabs: [{ id: 'legacy-tab', history: [channel('legacy-channel')], index: 0 }], active: 'legacy-tab' });
    localStorage.setItem('nh:tabs:local', value);
    const view = renderHook(() => useNavigation('local'));
    expect(view.result.current.route).toEqual(channel('legacy-channel'));
    act(() => view.result.current.navigate(project('morrow-project'), true));
    expect(JSON.parse(localStorage.getItem('morrow:tabs:local')!).tabs).toHaveLength(2);
  });

  it('restores a saved tab before considering the default and keeps closing the final tab intentional after restart', () => {
    saveSession('local', channel('saved-channel'));
    const defaultRoute = project('default-project');
    const first = renderHook(() => useDefaultWorkspace('local', defaultRoute));
    expect(first.result.current.hydrated).toBe(true);
    expect(first.result.current.route).toEqual(channel('saved-channel'));
    expect(first.result.current.needsDefault).toBe(false);
    act(() => first.result.current.close(first.result.current.activeId));
    expect(first.result.current.tabs).toHaveLength(0);
    expect(first.result.current.route).toBeUndefined();
    expect(first.result.current.needsDefault).toBe(false);
    expect(JSON.parse(localStorage.getItem('morrow:tabs:local')!)).toEqual({ tabs: [], active: '' });
    first.unmount();
    const restarted = renderHook(() => useDefaultWorkspace('local', defaultRoute));
    expect(restarted.result.current.hydrated).toBe(true);
    expect(restarted.result.current.tabs).toHaveLength(0);
    expect(restarted.result.current.needsDefault).toBe(false);
    // Even a stale default-open effect must respect the restored empty session.
    act(() => restarted.result.current.openDefault(defaultRoute));
    expect(restarted.result.current.tabs).toHaveLength(0);
  });

  it('does not hydrate or write a local session while the actual connection scope is still unknown', () => {
    const local = saveSession('local', project('local-project'));
    const remote = saveSession('ssh:work:43821', channel('remote-channel'));
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    const observed: { scope: string | null; hydrated: boolean; route?: Route }[] = [];
    const defaultRoute = project('remote-default');
    const view = renderHook(({ scope }: { scope: string | null }) => {
      const navigation = useDefaultWorkspace(scope, defaultRoute);
      observed.push({ scope, hydrated: navigation.hydrated, route: navigation.route });
      return navigation;
    }, { initialProps: { scope: null as string | null } });
    expect(view.result.current.hydrated).toBe(false);
    expect(view.result.current.route).toBeUndefined();
    act(() => view.result.current.navigate(project('too-early')));
    expect(writes).not.toHaveBeenCalled();
    view.rerender({ scope: 'ssh:work:43821' });
    expect(view.result.current.route).toEqual(channel('remote-channel'));
    expect(observed.some(state => state.route?.kind === 'project' && state.route.id === 'local-project')).toBe(false);
    expect(observed.find(state => state.scope === 'ssh:work:43821')?.hydrated).toBe(false);
    expect(localStorage.getItem('morrow:tabs:local')).toBe(local);
    expect(localStorage.getItem('morrow:tabs:ssh:work:43821')).toBe(remote);
    expect(writes).not.toHaveBeenCalled();
  });

  it('opens the default once for a genuinely new workspace, including React Strict Mode', () => {
    const defaultRoute = project('first-project');
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    const view = renderHook(() => useDefaultWorkspace('local', defaultRoute), { wrapper: StrictMode });
    expect(view.result.current.tabs).toHaveLength(1);
    expect(view.result.current.route).toEqual(defaultRoute);
    expect(writes).toHaveBeenCalledTimes(1);
    act(() => { view.result.current.openDefault(project('another-project')); view.result.current.openDefault(defaultRoute); });
    expect(view.result.current.tabs).toHaveLength(1);
    expect(view.result.current.route).toEqual(defaultRoute);
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('keeps each tab’s history independent and discards only the active forward branch after new navigation', () => {
    const view = renderHook(() => useNavigation('local'));
    act(() => view.result.current.navigate(project('atlas')));
    const atlasTab = view.result.current.activeId;
    act(() => view.result.current.navigate(channel('reliability')));
    act(() => view.result.current.navigate({ kind: 'finding', id: 'import-bug' }));
    act(() => view.result.current.navigate({ kind: 'runtimes' }, true));
    const engineTab = view.result.current.activeId;
    expect(view.result.current.canBack).toBe(false);
    act(() => view.result.current.activate(atlasTab));
    expect(view.result.current.route).toEqual({ kind: 'finding', id: 'import-bug' });
    act(() => view.result.current.travel(-1));
    expect(view.result.current.route).toEqual(channel('reliability'));
    expect(view.result.current.canForward).toBe(true);
    act(() => view.result.current.navigate({ kind: 'runs' }));
    expect(view.result.current.canForward).toBe(false);
    act(() => view.result.current.travel(-1));
    expect(view.result.current.route).toEqual(channel('reliability'));
    act(() => view.result.current.travel(1));
    expect(view.result.current.route).toEqual({ kind: 'runs' });
    act(() => view.result.current.activate(engineTab));
    expect(view.result.current.route).toEqual({ kind: 'runtimes' });
    expect(view.result.current.canBack).toBe(false);
    expect(view.result.current.canForward).toBe(false);
    act(() => view.result.current.close(engineTab));
    expect(view.result.current.activeId).toBe(atlasTab);
    expect(view.result.current.route).toEqual({ kind: 'runs' });
  });

  it('isolates workspace switches and rejects callbacks captured from the previous workspace', () => {
    const originalLocal = saveSession('local', project('local-project'), 'local-tab');
    saveSession('ssh:work:43821', project('remote-project'), 'remote-tab');
    const view = renderHook(({ scope }) => useNavigation(scope), { initialProps: { scope: 'local' } });
    const oldNavigate = view.result.current.navigate;
    const oldClose = view.result.current.close;
    view.rerender({ scope: 'ssh:work:43821' });
    act(() => { oldNavigate(channel('local-late-response')); oldClose('local-tab'); });
    expect(view.result.current.route).toEqual(project('remote-project'));
    act(() => view.result.current.navigate(channel('remote-work'), true));
    expect(view.result.current.tabs).toHaveLength(2);
    const remote = JSON.parse(localStorage.getItem('morrow:tabs:ssh:work:43821')!);
    expect(remote.tabs.flatMap((tab: { history: Route[] }) => tab.history)).toEqual([project('remote-project'), channel('remote-work')]);
    expect(localStorage.getItem('morrow:tabs:local')).toBe(originalLocal);
    view.rerender({ scope: 'local' });
    expect(view.result.current.route).toEqual(project('local-project'));
    expect(view.result.current.tabs).toHaveLength(1);
    view.rerender({ scope: 'ssh:work:43821' });
    expect(view.result.current.route).toEqual(channel('remote-work'));
    expect(view.result.current.tabs).toHaveLength(2);
  });

  it('recovers corrupt saved navigation without crashing or exposing an invalid route', () => {
    localStorage.setItem('morrow:tabs:local', JSON.stringify({ tabs: [{ id: 'broken', history: [{ kind: 'finding' }], index: 9 }], active: 'broken' }));
    const view = renderHook(() => useDefaultWorkspace('local', project('recovered')));
    expect(view.result.current.route).toEqual(project('recovered'));
    expect(view.result.current.tabs).toHaveLength(1);
    act(() => { view.result.current.activate('missing-tab'); view.result.current.close('missing-tab'); });
    expect(view.result.current.route).toEqual(project('recovered'));
  });
});

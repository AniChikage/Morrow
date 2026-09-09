// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { emptySnapshot, type ConnectionInfo, type DesktopAPI, type Snapshot } from '../../shared/types';

const api = { getState: vi.fn(), getConnection: vi.fn() } as unknown as DesktopAPI;
window.morrow = api;
const { WorkspaceProvider, useWorkspace } = await import('./workspace');
const state = (id: string): Snapshot => ({ ...emptySnapshot, projects: [{ id, name: id, path: '/project', goal: 'goal', createdAt: '', isDemo: false }] });
const local: ConnectionInfo = { config: { mode: 'local', host: '', port: 43821, directory: '/local' }, name: 'local', connected: true };
const remote: ConnectionInfo = { config: { mode: 'ssh', host: 'host-b', port: 43821, directory: '/remote' }, name: 'remote', connected: true };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const getState = vi.mocked(api.getState);
const getConnection = vi.mocked(api.getConnection);
async function setup() {
  const hook = renderHook(useWorkspace, { wrapper: ({ children }: { children: ReactNode }) => <WorkspaceProvider>{children}</WorkspaceProvider> });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}
beforeEach(() => { getState.mockReset().mockResolvedValue(state('initial')); getConnection.mockReset().mockResolvedValue(local); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('workspace asynchronous state', () => {
  it('a completed mutation reads a genuinely fresh snapshot and ignores the older poll finishing last', async () => {
    const { result } = await setup();
    const old = deferred<Snapshot>();
    getState.mockReturnValueOnce(old.promise);
    let oldRefresh!: Promise<void>;
    act(() => { oldRefresh = result.current.refresh(); });
    expect(getState).toHaveBeenCalledTimes(2);
    getState.mockResolvedValue(state('created'));
    await act(async () => { expect(await result.current.mutate(async () => undefined)).toBe(true); });
    expect(getState).toHaveBeenCalledTimes(3);
    expect(result.current.snapshot.projects[0].id).toBe('created');
    await act(async () => { old.resolve(state('obsolete')); await oldRefresh; });
    expect(result.current.snapshot.projects[0].id).toBe('created');
  });

  it('reset immediately clears data, suspends reads and prevents an old generation from disturbing a new read', async () => {
    const { result } = await setup();
    const old = deferred<Snapshot>(); const current = deferred<Snapshot>();
    getState.mockReturnValueOnce(old.promise);
    let oldRefresh!: Promise<void>;
    act(() => { oldRefresh = result.current.refresh(); result.current.reset(); });
    expect(result.current.snapshot.projects).toEqual([]);
    expect(result.current.loading).toBe(true);
    await act(async () => { await result.current.refresh(); });
    expect(getState).toHaveBeenCalledTimes(2);
    getConnection.mockResolvedValue(remote);
    getState.mockReturnValueOnce(current.promise);
    let nextRefresh!: Promise<void>;
    act(() => { result.current.setConnectionInfo(remote); nextRefresh = result.current.refresh(); });
    await act(async () => { old.resolve(state('local-stale')); await oldRefresh; });
    expect(result.current.snapshot.projects).toEqual([]);
    expect(result.current.loading).toBe(true);
    act(() => { void result.current.refresh(); });
    expect(getState).toHaveBeenCalledTimes(3);
    await act(async () => { current.resolve(state('remote-project')); await nextRefresh; });
    expect(result.current.snapshot.projects[0].id).toBe('remote-project');
    expect(result.current.connection?.config.host).toBe('host-b');
  });

  it('a failed polling request still reads actual connection info and clears data belonging to a different target', async () => {
    const { result } = await setup();
    getState.mockRejectedValue(new Error('generic transport failure'));
    getConnection.mockResolvedValue({ ...remote, connected: false, error: 'remote SSH disconnected' });
    await act(async () => { await expect(result.current.refresh()).resolves.toBeUndefined(); });
    expect(result.current.connection?.config).toEqual(remote.config);
    expect(result.current.snapshot.projects).toEqual([]);
    expect(result.current.connection?.connected).toBe(false);
    expect(result.current.error).toBe('remote SSH disconnected');
    expect(result.current.loading).toBe(false);
  });

  it('direct connect rejection completes a pending reset and preserves its actionable error across failed polling', async () => {
    const { result } = await setup();
    getConnection.mockResolvedValue({ ...remote, connected: false, error: 'SSH host unavailable' });
    act(() => result.current.reset());
    await act(async () => { expect(await result.current.mutate(async () => { throw new Error('Check SSH host keys first'); })).toBe(false); });
    expect(result.current.connection?.config.host).toBe('host-b');
    expect(result.current.loading).toBe(false);
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBe('Check SSH host keys first');
    getState.mockRejectedValue(new Error('generic state transport error'));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.error).toBe('Check SSH host keys first');
  });

  it('failed connect info can be applied explicitly and does not leave an empty workspace loading', async () => {
    const { result } = await setup();
    act(() => result.current.reset());
    await act(async () => {
      expect(await result.current.mutate(async () => {
        result.current.setConnectionInfo({ ...remote, connected: false, error: 'Token unavailable' });
        throw new Error('Token unavailable');
      })).toBe(false);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.snapshot.projects).toEqual([]);
    expect(result.current.connection?.connected).toBe(false);
    expect(result.current.error).toBe('Token unavailable');
  });

  it('a mutation failure from the previous connection cannot overwrite the new workspace', async () => {
    const { result } = await setup();
    const operation = deferred<unknown>();
    let mutation!: Promise<boolean>;
    act(() => { mutation = result.current.mutate(() => operation.promise); });
    act(() => { result.current.reset(); result.current.setConnectionInfo(remote); });
    getState.mockResolvedValue(state('remote-project')); getConnection.mockResolvedValue(remote);
    await act(async () => { await result.current.refresh(); });
    await act(async () => { operation.reject(new Error('old operation failed')); expect(await mutation).toBe(false); });
    expect(result.current.snapshot.projects[0].id).toBe('remote-project');
    expect(result.current.error).toBe(''); expect(result.current.busy).toBe(false);
  });

  it('both polling failures resolve without unhandled rejection and report disconnected status', async () => {
    const { result } = await setup();
    getState.mockRejectedValue(new Error('state failed')); getConnection.mockRejectedValue(new Error('connection failed'));
    await act(async () => { await expect(result.current.refresh()).resolves.toBeUndefined(); });
    expect(result.current.connection?.connected).toBe(false); expect(result.current.error).toBe('state failed');
    expect(result.current.loading).toBe(false);
  });
});

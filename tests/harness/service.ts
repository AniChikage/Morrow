import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startServer } from '../../service/server.ts';
import type { BridgeRestore, NativeTransport, OpenAppLink } from '../../service/native-conversations.ts';
import type { BuildIdentity } from '../../service/build-identity.ts';
import type { Channel, Project } from '../../service/protocol.ts';

export type Service = Awaited<ReturnType<typeof startServer>>;
export type IsolatedPaths = { root: string; home: string; path: string };
/** Desktop-style request that asserts the status and returns the JSON body. `auth` defaults to the desktop token. */
export type Api = (method: string, url: string, body?: unknown, status?: number, auth?: string) => Promise<any>;
export type IsolatedOptions = {
  /** A native protocol double, or a factory that receives the temp paths before the server starts. */
  nativeTransport?: NativeTransport | ((paths: IsolatedPaths) => NativeTransport);
  /** The first project, created through the API with `files` seeded into its directory first; `false` starts empty. */
  project?: { name?: string; goal?: string; brief?: string; files?: Record<string, string> } | false;
  /** Reuse an existing data directory instead of a fresh one under `root`; `cleanup()` leaves it in place. */
  home?: string;
  /** The build this service should report as the one it runs; a dev identity is derived otherwise. */
  identity?: BuildIdentity;
  /**
   * Stands in for undoing the retired `CODEX_CLI_PATH` bridge, which the real one does with
   * `launchctl`. Supply it to exercise the restore route without touching this Mac's login session.
   */
  restoreBridge?: BridgeRestore;
  /** Opens `codex://` deep links for `ensureAppTask`. Tests inject a fake. */
  openAppLink?: OpenAppLink;
  /**
   * `false` stops the daemon's own one-second loop, here and after every `restart()`, for a test that
   * drives each step itself. Nothing else changes: every gate still runs when the test calls it.
   */
  scheduler?: boolean;
};
export type IsolatedService = Service & {
  /** Temporary directory holding `home` (unless supplied) and the project directory `path`. */
  root: string;
  path: string;
  base: string;
  token: string;
  api: Api;
  /** The first project as the API returned it, and its default channel row; both undefined with `project: false`. */
  project: Project;
  channel: Channel;
  /** Closes the service (idempotent) and starts it again on the same home and transport, refreshing this handle. */
  restart(options?: { nativeTransport?: NativeTransport; identity?: BuildIdentity }): Promise<IsolatedService>;
  /** Closes the current service and removes `root`. */
  cleanup(): Promise<void>;
};

const origin = (port: number) => `http://127.0.0.1:${port}`;

/**
 * Stops the daemon's own one-second loop, the way the acceptance fixture does. A test that drives the
 * engine itself (`engine.tick()`, `loop.tick()`, `loop.poll()`, `verification.start()`) then sees no
 * turn, review or poll start at a moment it did not ask for, which a busy machine would otherwise
 * make a coin flip. It removes no gate: the tick only decides when the same code runs.
 */
export function stopScheduler(service: Pick<Service, 'engine'>) {
  if (service.engine.timer) clearInterval(service.engine.timer);
  service.engine.timer = undefined;
}

/**
 * One Morrow service on a temporary data directory with a temporary project directory. Nothing here
 * touches the user's data directory, runs a user project or calls a model; the transport is a double.
 * Spread copies of the handle keep the fields they copied, so read `port`, `store` and `engine` from
 * the value `restart()` returns (the handle itself) after a restart.
 */
export async function startIsolated(options: IsolatedOptions = {}): Promise<IsolatedService> {
  const root = mkdtempSync(join(tmpdir(), 'morrow-test-'));
  const home = options.home || join(root, 'home');
  const path = join(root, 'project');
  mkdirSync(path);
  const files = options.project ? options.project.files || {} : {};
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(path, name)), { recursive: true });
    writeFileSync(join(path, name), text);
  }
  let transport =
    typeof options.nativeTransport === 'function'
      ? options.nativeTransport({ root, home, path })
      : options.nativeTransport;
  const start = async () => {
    const service = await startServer({
      home,
      port: 0,
      nativeTransport: transport,
      reviewTransport: transport,
      ...(options.restoreBridge ? { restoreBridge: options.restoreBridge } : {}),
      ...(options.openAppLink ? { openAppLink: options.openAppLink } : {}),
      ...(options.identity ? { identity: options.identity } : {}),
    });
    if (options.scheduler === false) stopScheduler(service);
    return service;
  };
  let current = await start();
  const token = readFileSync(join(home, 'token'), 'utf8');
  const api: Api = async (method, url, body, status = 200, auth = token) => {
    const response = await fetch(origin(current.port) + url, {
      method,
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  };
  let project: Project | undefined, channel: Channel | undefined;
  if (options.project !== false) {
    const { name = '隔离项目', goal = '在隔离环境中验证服务行为', brief } = options.project || {};
    project = await api('POST', '/api/projects', { name, path, goal, ...(brief === undefined ? {} : { brief }) }, 201);
    channel = current.store.all<Channel>('channels').find((row) => row.projectId === project!.id);
  }
  const handle: IsolatedService = {
    ...current,
    root,
    home,
    path,
    base: origin(current.port),
    token,
    api,
    project: project!,
    channel: channel!,
    async restart(next = {}) {
      await current.close();
      if (next.nativeTransport) transport = next.nativeTransport;
      if (next.identity) options.identity = next.identity;
      current = await start();
      Object.assign(handle, current, { base: origin(current.port) });
      return handle;
    },
    async cleanup() {
      await current.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return handle;
}

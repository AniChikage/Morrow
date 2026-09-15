import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { ServiceConnection } from './connection';
import {
  emptySnapshot,
  type Channel,
  type ConnectionConfig,
  type Snapshot,
  type WorkspaceEvent,
} from '../shared/types';

let appPath = '/unused-morrow-test-app';
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => appPath } }));
const noDaemonExpected = (): ChildProcess => {
  throw new Error('no daemon start was expected in this test');
};
/** Only `spawn` is replaced, so the Node version check still runs the real binary through execFile. */
let spawnDaemon: () => ChildProcess = noDaemonExpected;
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: () => spawnDaemon(),
}));

let directory = '';
let service: ServiceConnection;
let snapshot: Snapshot;
let reply: (url: string, init?: RequestInit) => Response | Promise<Response>;
const token = 'a'.repeat(64);
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const event = (id: string, channelId = 'channel-1', runId = 'run-1'): WorkspaceEvent => ({
  id,
  channelId,
  runId,
  kind: 'output',
  text: id,
  createdAt: '2026-09-07T12:00:00.000Z',
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'morrow-desktop-test-'));
  vi.stubEnv('MORROW_HOME', directory);
  vi.stubEnv('MORROW_PORT', '43821');
  await writeFile(join(directory, 'token'), token, { mode: 0o600 });
  await writeFile(
    join(directory, 'desktop-connection.json'),
    JSON.stringify({ mode: 'local', host: '', port: 43821, directory })
  );
  snapshot = structuredClone(emptySnapshot);
  reply = (url) => (url.endsWith('/health') ? json({ ok: true, service: 'morrow' }) : json(snapshot));
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) => reply(String(input), init))
  );
  service = new ServiceConnection();
  await service.initialize(); // A live health response prevents any process start.
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  appPath = '/unused-morrow-test-app';
  spawnDaemon = noDaemonExpected;
  await rm(directory, { recursive: true, force: true });
});

/** A child that behaves like the detached daemon: it announces its start and can be made to leave. */
class FakeDaemon extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  unref(): void {}
  /** `spawn` returns before the caller attaches its listener, so the event has to be deferred. */
  starting(): ChildProcess {
    queueMicrotask(() => this.emit('spawn'));
    return this as unknown as ChildProcess;
  }
  leave(code = 1): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}
/** Only the clock the wait itself uses, so the real Node version check and file reads keep working. */
const fakeClock: Parameters<typeof vi.useFakeTimers>[0] = { toFake: ['setTimeout', 'clearTimeout', 'Date'] };
/** Moves the fake clock in probe-sized steps so every probe and its file reads settle in between. */
const advance = async (ms: number) => {
  for (let moved = 0; moved < ms; moved += 250) await vi.advanceTimersByTimeAsync(250);
};
const localConfig = (): ConnectionConfig => ({ mode: 'local', host: '', port: 43821, directory });
const refused = (): never => {
  throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
};
/** Counts `/health` probes and answers them only once `online` is flipped. */
const healthProbes = (state: { online: boolean }) => {
  const counter = { probes: 0 };
  reply = (url) => {
    if (!url.endsWith('/health')) return json(snapshot);
    counter.probes += 1;
    return state.online ? json({ ok: true, service: 'morrow' }) : refused();
  };
  return counter;
};
/**
 * Prepares a daemon start and reports when the child has been spawned. The fake clock takes over
 * from the spawn on, so the service entry check and the real Node version check run untouched.
 */
const startWithDaemon = async (daemon: FakeDaemon): Promise<{ spawned: Promise<void> }> => {
  const root = join(directory, 'app');
  await mkdir(join(root, 'service'), { recursive: true });
  await writeFile(join(root, 'service/server.ts'), '');
  appPath = root;
  vi.stubEnv('MORROW_NODE', process.execPath);
  let announce = () => {};
  const spawned = new Promise<void>((resolve) => (announce = resolve));
  spawnDaemon = () => {
    vi.useFakeTimers(fakeClock);
    announce();
    return daemon.starting();
  };
  return { spawned };
};

test('a daemon this app started is waited for as long as it lives, well past the old 12 s', async () => {
  const state = { online: false };
  const counter = healthProbes(state);
  const daemon = new FakeDaemon();
  const { spawned } = await startWithDaemon(daemon);
  const connecting = service.connect(localConfig());
  await spawned;
  await advance(20000);
  // The fixed 48 × 250 ms cap would already have given up; a live child keeps the wait going.
  expect(counter.probes).toBeGreaterThan(48);
  state.online = true;
  await advance(500);
  vi.useRealTimers();
  const info = await connecting;
  expect(info).toMatchObject({ connected: true });
  expect(info.error).toBeUndefined();
});

test('a daemon that exits before answering health fails the connection at once', async () => {
  const counter = healthProbes({ online: false });
  const daemon = new FakeDaemon();
  const { spawned } = await startWithDaemon(daemon);
  const connecting = service.connect(localConfig());
  await spawned;
  await advance(1000);
  const before = counter.probes;
  daemon.leave(1);
  await advance(500);
  vi.useRealTimers();
  expect(await connecting).toMatchObject({ connected: false, error: expect.stringContaining('执行服务未能启动') });
  // One last probe covers a child that only left because another daemon holds the lock; no more.
  expect(counter.probes).toBe(before + 1);
});

test('a daemon this app did not start keeps the original 12 s wait', async () => {
  const counter = healthProbes({ online: false });
  vi.useFakeTimers(fakeClock);
  const started = Date.now();
  // `ensureLocalService` always spawns, so nothing else reaches the adopted cap to exercise it.
  const outcome = (service as unknown as { waitForHealth(port: number, child?: ChildProcess): Promise<void> })
    .waitForHealth(43821)
    .then(
      () => ({ at: Date.now() - started, message: '' }),
      (error: Error) => ({ at: Date.now() - started, message: error.message })
    );
  await advance(13000);
  const failure = await outcome;
  vi.useRealTimers();
  expect(failure.message).toContain('执行服务未能启动');
  expect(failure.at).toBeGreaterThanOrEqual(12000);
  expect(failure.at).toBeLessThan(12500);
  expect(counter.probes).toBeGreaterThan(40);
  expect(counter.probes).toBeLessThan(60);
});

test('the lifecycle routes use the local daemon and the desktop credential', async () => {
  const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
  reply = (url, init) => {
    seen.push({ url, method: init?.method, body: init?.body });
    if (url.endsWith('/health')) return json({ ok: true, service: 'morrow' });
    return json({ identity: { bootId: 'boot-1' }, idle: true, blockers: [], exitCode: 75, reminderMs: 600000 });
  };
  expect((await service.upgradeState()).identity.bootId).toBe('boot-1');
  await service.acknowledgeUpgrade({ fromBootId: 'boot-1', targetFingerprint: 'b'.repeat(64) });
  await service.restartUpgrade({ fromBootId: 'boot-1', targetFingerprint: 'b'.repeat(64) });
  await service.reportUpgradeBlocked({ fromBootId: 'boot-1', targetFingerprint: 'b'.repeat(64), reason: '超时' });
  expect(seen.map((entry) => `${entry.method || 'GET'} ${entry.url.split('/api/')[1]}`)).toEqual([
    'GET upgrade',
    'POST upgrade/acknowledge',
    'POST upgrade/restart',
    'POST upgrade/blocked',
  ]);
  expect(service.currentMode()).toBe('local');
});

test('an adopted daemon counts as gone only once health is offline and its lock is free', async () => {
  // Answering health means the daemon is still there, whatever the lock file says.
  expect(await service.daemonAbsent()).toBe(false);
  reply = () => {
    throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
  };
  expect(await service.daemonAbsent()).toBe(true);
  await writeFile(join(directory, 'daemon.lock'), JSON.stringify({ pid: process.pid, nonce: 'n' }));
  expect(await service.daemonAbsent()).toBe(false);
  // A stale lock from a crashed daemon still counts as gone; nothing is ever signalled to check.
  await writeFile(join(directory, 'daemon.lock'), JSON.stringify({ pid: 0x7ffffff, nonce: 'n' }));
  expect(await service.daemonAbsent()).toBe(true);
  await writeFile(join(directory, 'daemon.lock'), 'not json');
  expect(await service.daemonAbsent()).toBe(true);
  // This app adopted a running daemon, so it has no child exit to watch.
  expect(service.daemonExit()).toBeUndefined();
});

test('a running legacy NoHuman service remains usable after the Morrow rename', async () => {
  reply = (url) => (url.endsWith('/health') ? json({ ok: true, service: 'nohuman' }) : json(snapshot));
  const legacyService = new ServiceConnection();
  await expect(legacyService.initialize()).resolves.toBeUndefined();
  expect(await legacyService.getInfo()).toMatchObject({ connected: true });
});

test('old daemon pagination preserves insertion order and does not skip equal timestamps', async () => {
  snapshot.events = [
    event('z'),
    event('foreign', 'channel-2'),
    event('a'),
    event('different-run', 'channel-1', 'run-2'),
    event('b'),
  ];
  reply = (url) => (url.includes('/api/events?') ? json({ error: '接口不存在' }, 404) : json(snapshot));
  const newest = await service.events({ channelId: 'channel-1', runId: 'run-1', limit: 2 });
  expect(newest.events.map((item) => item.id)).toEqual(['a', 'b']);
  expect(newest).toMatchObject({ hasMore: true, cursor: 'a' });
  const older = await service.events({ channelId: 'channel-1', runId: 'run-1', before: newest.cursor, limit: 2 });
  expect(older.events.map((item) => item.id)).toEqual(['z']);
  expect(older.hasMore).toBe(false);
  const newer = await service.events({ channelId: 'channel-1', runId: 'run-1', after: 'z', limit: 1 });
  expect(newer.events.map((item) => item.id)).toEqual(['a']);
  expect(newer).toMatchObject({ hasMore: true, cursor: 'a' });
  expect(await service.events({ channelId: 'channel-1', before: 'evicted-event' })).toEqual({
    events: [],
    hasMore: false,
  });
});

test('old daemon fallback uses the service default of 50 events', async () => {
  snapshot.events = Array.from({ length: 51 }, (_, index) => event(`event-${index}`));
  reply = (url) => (url.includes('/api/events?') ? json({ error: '接口不存在' }, 404) : json(snapshot));
  const page = await service.events({ channelId: 'channel-1' });
  expect(page.events).toHaveLength(50);
  expect(page.events[0].id).toBe('event-1');
  expect(page.events.at(-1)?.id).toBe('event-50');
  expect(page).toMatchObject({ hasMore: true, cursor: 'event-1' });
});

test.each(['频道不存在', '运行记录不属于该频道或不存在', '事件游标不属于查询范围或不存在'])(
  'new daemon 404 "%s" propagates without snapshot fallback',
  async (message) => {
    const seen: string[] = [];
    reply = (url) => {
      seen.push(url);
      return json({ error: message }, 404);
    };
    await expect(service.events({ channelId: 'channel-1', runId: 'run-1', before: 'event-1' })).rejects.toThrow(
      message
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('/api/events?');
    expect((await service.getInfo()).connected).toBe(true);
  }
);

test('new daemon event endpoint is returned directly and bearer stays out of responses', async () => {
  reply = (url, init) => {
    expect(url).toContain('/api/events?channelId=channel-1&limit=2');
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
    return json({
      events: [{ ...event('event-1'), text: `accidental echo ${token}` }],
      hasMore: false,
      cursor: 'event-1',
    });
  };
  const page = await service.events({ channelId: 'channel-1', limit: 2 });
  expect(page.events[0].text).toBe('accidental echo [REDACTED]');
  expect(page.cursor).toBe('event-1');
});

test('authentication errors are actionable and never trigger old-daemon fallback', async () => {
  const seen: string[] = [];
  reply = (url) => {
    seen.push(url);
    return json({ error: `Unauthorized ${token}` }, 401);
  };
  await expect(service.events({ channelId: 'channel-1' })).rejects.toThrow('执行服务拒绝认证');
  expect(seen).toHaveLength(1);
  expect(seen[0]).toContain('/api/events?');
  expect((await service.getInfo()).connected).toBe(false);
});

test('request connection failures and timeouts update connection status without replacing the daemon', async () => {
  reply = () => {
    throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
  };
  await expect(service.state()).rejects.toThrow('无法连接执行服务');
  expect(await service.getInfo()).toMatchObject({
    connected: false,
    error: expect.stringContaining('无法连接执行服务'),
  });
  reply = () => {
    throw new DOMException('timeout', 'TimeoutError');
  };
  await expect(service.state()).rejects.toThrow('执行服务响应超时');
  reply = () => json(snapshot);
  await service.state();
  expect(await service.getInfo()).toMatchObject({ connected: true });
  expect((await service.getInfo()).error).toBeUndefined();
});

test('backend business errors do not mark a reachable connection offline and redact echoed bearer', async () => {
  reply = () => json({ error: `项目不存在 ${token}` }, 400);
  await expect(service.request('projects', 'POST', {})).rejects.toThrow('项目不存在 [REDACTED]');
  expect((await service.getInfo()).connected).toBe(true);
});

test('fallback project history includes old channel events and project-wide human events without mixing projects', async () => {
  const channel = (id: string, projectId: string): Channel => ({
    id,
    projectId,
    name: id,
    goal: '',
    runtime: 'codex',
    model: '',
    status: 'paused',
    intervalMinutes: 60,
    maxRunsPerDay: 8,
    permission: 'read-only',
    nextRunAt: '',
    lastRunAt: '',
    sessionId: '',
  });
  snapshot.channels = [
    channel('channel-1', 'project-1'),
    channel('channel-2', 'project-1'),
    channel('channel-3', 'project-2'),
  ];
  snapshot.events = [
    event('legacy-first', 'channel-1', 'run-1'),
    event('legacy-second', 'channel-2', 'run-2'),
    event('foreign-legacy', 'channel-3', 'run-3'),
    { ...event('human-project-item', '', ''), projectId: 'project-1', itemId: 'item-1', actor: 'human' },
    { ...event('channel-item', 'channel-1', 'run-1'), projectId: 'project-1', itemId: 'item-1' },
    { ...event('other-item', 'channel-2', 'run-2'), projectId: 'project-1', itemId: 'item-2' },
    { ...event('foreign-human', '', ''), projectId: 'project-2', itemId: 'item-foreign' },
  ];
  reply = (url) => (url.includes('/api/events?') ? json({ error: '接口不存在' }, 404) : json(snapshot));
  expect((await service.events({ projectId: 'project-1' })).events.map((row) => row.id)).toEqual([
    'legacy-first',
    'legacy-second',
    'human-project-item',
    'channel-item',
    'other-item',
  ]);
  expect(
    (await service.events({ projectId: 'project-1', channelId: 'channel-1' })).events.map((row) => row.id)
  ).toEqual(['legacy-first', 'channel-item']);
  expect((await service.events({ projectId: 'project-1', itemId: 'item-1' })).events.map((row) => row.id)).toEqual([
    'human-project-item',
    'channel-item',
  ]);
  expect(
    (
      await service.events({ projectId: 'project-1', itemId: 'item-1', channelId: 'channel-1', runId: 'run-1' })
    ).events.map((row) => row.id)
  ).toEqual(['channel-item']);
  expect((await service.events({ projectId: 'project-1', channelId: 'channel-3' })).events).toEqual([]);
  expect((await service.events({ projectId: 'project-1', itemId: 'item-foreign' })).events).toEqual([]);
  expect((await service.events({ projectId: 'project-1', before: 'foreign-legacy' })).events).toEqual([]);
  const page = await service.events({ projectId: 'project-1', itemId: 'item-1', limit: 1 });
  expect(page).toMatchObject({ hasMore: true, cursor: 'channel-item' });
  expect(
    (await service.events({ projectId: 'project-1', itemId: 'item-1', before: page.cursor, limit: 1 })).events.map(
      (row) => row.id
    )
  ).toEqual(['human-project-item']);
});

test('new event endpoint receives all scope fields and preserves the service cursor', async () => {
  reply = (url) => {
    const query = new URL(url).searchParams;
    expect(Object.fromEntries(query)).toEqual({
      projectId: 'project-1',
      channelId: 'channel-1',
      itemId: 'item-1',
      runId: 'run-1',
      after: 'event-1',
      limit: '100',
    });
    return json({
      events: [{ ...event('event-2'), projectId: 'project-1', itemId: 'item-1' }],
      hasMore: true,
      cursor: 'event-2',
    });
  };
  const page = await service.events({
    projectId: 'project-1',
    channelId: 'channel-1',
    itemId: 'item-1',
    runId: 'run-1',
    after: 'event-1',
    limit: 100,
  });
  expect(page.cursor).toBe('event-2');
  expect(page.hasMore).toBe(true);
});

test.each(['项目不存在', '频道不属于该项目或不存在', '事项不属于查询范围或不存在', '运行记录不属于查询范围或不存在'])(
  'scoped history error "%s" cannot fall back to another snapshot scope',
  async (message) => {
    const seen: string[] = [];
    reply = (url) => {
      seen.push(url);
      return json({ error: message }, 404);
    };
    await expect(service.events({ projectId: 'project-1', itemId: 'item-1', channelId: 'channel-2' })).rejects.toThrow(
      message
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('/api/events?');
  }
);

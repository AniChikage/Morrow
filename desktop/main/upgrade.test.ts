import { expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleFromResources, readInstalledFingerprint, UpgradeHandover, type UpgradeDeps } from './upgrade';
import type { UpgradeHandshake, UpgradeRecord, UpgradeState } from '../shared/types';

const target = 'b'.repeat(64);
const bundlePath = '/Users/someone/Applications/Morrow.app';
const dataDirectory = '/Users/someone/Library/Application Support/Morrow';

function record(patch: Partial<UpgradeRecord> = {}): UpgradeRecord {
  return {
    id: target,
    releaseId: 'release-1',
    targetCommit: 'c'.repeat(40),
    targetFingerprint: target,
    installedBundle: bundlePath,
    fromBootId: 'boot-1',
    phase: 'draining',
    requestedAt: '2026-09-11T00:00:00.000Z',
    updatedAt: '2026-09-11T00:00:00.000Z',
    ...patch,
  };
}
function state(patch: Partial<UpgradeState> = {}, upgrade: Partial<UpgradeRecord> = {}): UpgradeState {
  return {
    identity: {
      bootId: 'boot-1',
      commit: 'd'.repeat(40),
      version: '0.9.6',
      fingerprint: 'a'.repeat(64),
      bundlePath,
      dataDirectory,
    },
    exitCode: 75,
    reminderMs: 600000,
    idle: true,
    blockers: [],
    upgrade: record(upgrade),
    ...patch,
  };
}
/**
 * The Electron main's handover against doubles for the daemon, the child process and the app: no
 * Electron, no real service, nothing spawned. `gone` decides when the old daemon has left.
 */
function handover(overrides: Partial<UpgradeDeps> = {}, current: UpgradeState | undefined = state()) {
  let gone = true;
  const calls = {
    acknowledge: vi.fn(async () => current!),
    restart: vi.fn(async () => ({ ...current!, upgrade: record({ ...current!.upgrade, phase: 'exiting' }) })),
    blocked: vi.fn(async (_body: UpgradeHandshake & { reason: string }) => ({})),
    relaunch: vi.fn(async () => {}),
    fingerprint: vi.fn(async () => target),
    daemonGone: vi.fn(async () => gone),
    log: vi.fn(),
  };
  const deps: UpgradeDeps = {
    state: async () => current,
    acknowledge: calls.acknowledge,
    restart: calls.restart as unknown as UpgradeDeps['restart'],
    blocked: calls.blocked as unknown as UpgradeDeps['blocked'],
    bundlePath,
    dataDirectory,
    mode: () => 'local',
    installedFingerprint: calls.fingerprint,
    daemonGone: calls.daemonGone,
    relaunch: calls.relaunch,
    log: calls.log,
    exitTimeoutMs: 60,
    pollMs: 10,
    ...overrides,
  };
  return {
    instance: new UpgradeHandover(deps),
    calls,
    setState: (next: UpgradeState | undefined) => {
      current = next;
    },
    setGone: (value: boolean) => {
      gone = value;
    },
    reasons: () => calls.blocked.mock.calls.map(([body]) => body.reason),
  };
}

test('an idle daemon with the target on disk is handed over and the app relaunches once', async () => {
  const { instance, calls } = handover();
  await instance.check();
  expect(calls.acknowledge).toHaveBeenCalledWith({ fromBootId: 'boot-1', targetFingerprint: target });
  expect(calls.restart).toHaveBeenCalledTimes(1);
  expect(calls.relaunch).toHaveBeenCalledTimes(1);
  expect(calls.blocked).not.toHaveBeenCalled();
  // At most one relaunch per target, even if the poll runs again before the process goes away.
  await instance.check();
  await instance.check();
  expect(calls.relaunch).toHaveBeenCalledTimes(1);
  expect(calls.restart).toHaveBeenCalledTimes(1);
});

test('the exit of this app own daemon child is awaited before relaunching', async () => {
  let exited = () => {};
  const childExit = new Promise<void>((resolve) => (exited = resolve));
  const watch = vi.fn(() => childExit);
  const scenario = handover({ childExit: watch, exitTimeoutMs: 2000 });
  scenario.setGone(false);
  const running = scenario.instance.check();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(scenario.calls.relaunch).not.toHaveBeenCalled();
  scenario.setGone(true);
  exited();
  await running;
  expect(watch).toHaveBeenCalledTimes(1);
  expect(scenario.calls.relaunch).toHaveBeenCalledTimes(1);
});

test('an adopted daemon is waited for by its lock and health, and a timeout is reported as blocked', async () => {
  const scenario = handover({ childExit: () => undefined });
  scenario.setGone(false);
  await scenario.instance.check();
  expect(scenario.calls.daemonGone.mock.calls.length).toBeGreaterThan(1);
  expect(scenario.calls.relaunch).not.toHaveBeenCalled();
  expect(scenario.reasons()).toEqual(['等待旧服务退出超时，已停止切换；当前版本继续运行，可稍后重试。']);
  // One attempt per target: a timed-out switch is not retried in a loop.
  await scenario.instance.check();
  expect(scenario.calls.restart).toHaveBeenCalledTimes(1);
});

test('a busy daemon keeps waiting: the switch is not attempted and nothing is reported as failed', async () => {
  const scenario = handover({}, state({ idle: false, blockers: [{ kind: 'run', label: '频道「系统完善」正在执行' }] }));
  await scenario.instance.check();
  expect(scenario.calls.acknowledge).not.toHaveBeenCalled();
  expect(scenario.calls.relaunch).not.toHaveBeenCalled();
  expect(scenario.calls.blocked).not.toHaveBeenCalled();
  // A refusal from the daemon because work is still running is a wait, not a failure either.
  const refused = handover({
    restart: vi.fn(async () => {
      throw new Error('仍有工作在进行，不会中断：频道「系统完善」正在执行。工作结束后会自动切换。');
    }) as unknown as UpgradeDeps['restart'],
  });
  await refused.instance.check();
  expect(refused.calls.relaunch).not.toHaveBeenCalled();
  expect(refused.calls.blocked).not.toHaveBeenCalled();
});

test('a person asking for the switch runs the same handover even while the daemon reports busy', async () => {
  const scenario = handover({}, state({ idle: false, blockers: [{ kind: 'review', label: '独立复核正在进行' }] }));
  await scenario.instance.request();
  // The daemon itself decides: the request is made, and it refuses if the work is real.
  expect(scenario.calls.acknowledge).toHaveBeenCalledTimes(1);
  expect(scenario.calls.restart).toHaveBeenCalledTimes(1);
});

test('identity and target mismatches stop the switch instead of relaunching', async () => {
  const other = handover({}, state({ identity: { ...state().identity, bundlePath: '/Applications/Other.app' } }));
  await other.instance.check();
  expect(other.calls.acknowledge).not.toHaveBeenCalled();
  expect(other.calls.log).toHaveBeenCalledWith('待切换的服务不是本应用所在的安装包，已停止自动切换。');
  const elsewhere = handover({}, state({ identity: { ...state().identity, dataDirectory: '/tmp/other' } }));
  await elsewhere.instance.check();
  expect(elsewhere.calls.acknowledge).not.toHaveBeenCalled();
  // A development run has no bundle of its own and never takes over.
  const development = handover({ bundlePath: '' });
  await development.instance.check();
  expect(development.calls.acknowledge).not.toHaveBeenCalled();
  // The bundle on disk is not the target: report it and stop, without relaunching into it.
  const wrong = handover({ installedFingerprint: vi.fn(async () => 'f'.repeat(64)) });
  await wrong.instance.check();
  expect(wrong.calls.relaunch).not.toHaveBeenCalled();
  expect(wrong.reasons()).toEqual(['磁盘上的安装版本与待切换目标不一致，已停止切换；请核对安装结果。']);
  const missing = handover({ installedFingerprint: vi.fn(async () => '') });
  await missing.instance.check();
  expect(missing.reasons()).toEqual(['读不到已安装版本的构建标识，已停止切换；请核对安装结果。']);
});

test('a daemon that changed boot id mid-handover is re-verified rather than handed over', async () => {
  const scenario = handover();
  scenario.setState(state({ identity: { ...state().identity, bootId: 'boot-1' } }));
  await scenario.instance.check();
  expect(scenario.calls.relaunch).toHaveBeenCalledTimes(1);
  scenario.setState(state({ identity: { ...state().identity, bootId: 'boot-2' } }, { targetFingerprint: target }));
  await scenario.instance.check();
  expect(scenario.calls.log).toHaveBeenCalledWith('本机服务已更换启动实例，重新核对后再切换。');
  expect(scenario.calls.relaunch).toHaveBeenCalledTimes(1);
});

test('an SSH session never switches this Mac, and an unreachable daemon is simply not switched', async () => {
  const remote = handover({ mode: () => 'ssh' });
  await remote.instance.check();
  expect(remote.calls.acknowledge).not.toHaveBeenCalled();
  const offline = handover({ state: async () => undefined });
  await offline.instance.check();
  expect(offline.calls.acknowledge).not.toHaveBeenCalled();
  // Phases that need nothing from this app are left alone.
  for (const phase of ['applied', 'blocked'] as const) {
    const finished = handover({}, state({}, { phase }));
    await finished.instance.check();
    expect(finished.calls.acknowledge).not.toHaveBeenCalled();
  }
});

test('a blocked switch can be retried by the person, which relaunches after a successful handover', async () => {
  const scenario = handover({}, state({}, { phase: 'blocked', error: '等待旧服务退出超时' }));
  await scenario.instance.check();
  expect(scenario.calls.acknowledge).not.toHaveBeenCalled();
  await scenario.instance.request();
  expect(scenario.calls.acknowledge).toHaveBeenCalledTimes(1);
  expect(scenario.calls.relaunch).toHaveBeenCalledTimes(1);
});

test('a failure while relaunching is reported and the old version keeps running', async () => {
  const scenario = handover({
    relaunch: vi.fn(async () => {
      throw new Error('无法重新启动应用');
    }),
  });
  await scenario.instance.check();
  expect(scenario.reasons()).toEqual(['切换未完成：无法重新启动应用']);
  // A daemon that is already gone cannot record the reason; the app still logs it and stops.
  const unreachable = handover({
    relaunch: vi.fn(async () => {
      throw new Error('无法重新启动应用');
    }),
    blocked: vi.fn(async () => {
      throw new Error('服务已退出');
    }) as unknown as UpgradeDeps['blocked'],
  });
  await unreachable.instance.check();
  expect(unreachable.calls.log).toHaveBeenCalledWith('切换未完成：无法重新启动应用');
});

test('a daemon that has not started leaving yet is left to the next poll', async () => {
  const scenario = handover({
    restart: vi.fn(async () => state({}, { phase: 'draining' })) as unknown as UpgradeDeps['restart'],
  });
  await scenario.instance.check();
  expect(scenario.calls.relaunch).not.toHaveBeenCalled();
  expect(scenario.calls.log).toHaveBeenCalledWith('本机服务尚未开始退出，稍后重试切换。');
  expect(scenario.calls.blocked).not.toHaveBeenCalled();
});

test('the bundle identity read here accepts exactly what a build writes into its bundle', async () => {
  expect(bundleFromResources(`${bundlePath}/Contents/Resources`)).toBe(bundlePath);
  expect(bundleFromResources('/Users/someone/Morrow/out/main')).toBe('');
  const root = await mkdtemp(join(tmpdir(), 'morrow-bundle-'));
  try {
    const resources = join(root, 'Morrow.app', 'Contents', 'Resources');
    await mkdir(resources, { recursive: true });
    expect(await readInstalledFingerprint(join(root, 'Morrow.app'))).toBe('');
    await writeFile(join(resources, 'build-info.json'), JSON.stringify({ scheme: 'morrow-bundle-v1' }));
    expect(await readInstalledFingerprint(join(root, 'Morrow.app'))).toBe('');
    await writeFile(join(resources, 'build-info.json'), 'not json');
    expect(await readInstalledFingerprint(join(root, 'Morrow.app'))).toBe('');
    await writeFile(
      join(resources, 'build-info.json'),
      JSON.stringify({ scheme: 'morrow-bundle-v1', commit: 'c'.repeat(40), version: '0.9.6', fingerprint: target })
    );
    expect(await readInstalledFingerprint(join(root, 'Morrow.app'))).toBe(target);
    expect(await readInstalledFingerprint('')).toBe('');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

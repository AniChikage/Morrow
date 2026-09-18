import { readFile, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { UpgradeHandshake, UpgradeState } from '../shared/types';

/** The bundle path and fingerprint checks below are the daemon's own rules, kept independent here so
 * the Electron main never loads the service it is about to replace. `service/build-identity.ts` holds
 * the authoritative copy and `desktop/main/upgrade.test.ts` checks both accept the same shapes. */
export const buildInfoName = 'build-info.json';
const fingerprintPattern = /^[a-f0-9]{16,128}$/;
/** `<bundle>.app` for a `<bundle>.app/Contents/Resources` path, or '' outside a packaged bundle. */
export function bundleFromResources(resources: string): string {
  const parts = resources.split(sep);
  if (parts.length < 3 || parts.at(-1) !== 'Resources' || parts.at(-2) !== 'Contents') return '';
  const bundle = parts.slice(0, -2).join(sep);
  return bundle.endsWith('.app') ? bundle : '';
}
/** The fingerprint of the bundle on disk right now, which after an install is the new build. */
export async function readInstalledFingerprint(bundlePath: string): Promise<string> {
  if (!bundlePath) return '';
  try {
    const path = join(bundlePath, 'Contents', 'Resources', buildInfoName);
    if ((await stat(path)).size > 8 * 1024) return '';
    const value = JSON.parse(await readFile(path, 'utf8')) as { fingerprint?: unknown };
    return typeof value.fingerprint === 'string' && fingerprintPattern.test(value.fingerprint) ? value.fingerprint : '';
  } catch {
    return '';
  }
}

export type UpgradeDeps = {
  /** The daemon's lifecycle state, or undefined when it cannot be read at all. */
  state: () => Promise<UpgradeState | undefined>;
  acknowledge: (body: UpgradeHandshake) => Promise<UpgradeState>;
  restart: (body: UpgradeHandshake) => Promise<UpgradeState>;
  blocked: (body: UpgradeHandshake & { reason: string }) => Promise<unknown>;
  /** This Electron main's own bundle; '' in a development run, which never takes over. */
  bundlePath: string;
  dataDirectory: string;
  mode: () => 'local' | 'ssh';
  installedFingerprint: (bundlePath: string) => Promise<string>;
  /** Resolves when the daemon this app started exits; undefined when the daemon is not our child. */
  childExit?: () => Promise<void> | undefined;
  /** Whether an adopted daemon has really gone: health offline and its lock no longer held. */
  daemonGone: () => Promise<boolean>;
  /** Closes this app's own resources, then relaunches and leaves; it does not return on success. */
  relaunch: () => Promise<void>;
  log?: (message: string) => void;
  /** How long to wait for the old daemon to exit before reporting the handover as blocked. */
  exitTimeoutMs?: number;
  pollMs?: number;
};

/**
 * The Electron main's half of the automatic version switch. It polls the local daemon's lifecycle
 * state — independent of any window, so a closed window or a hidden app still takes over — verifies
 * that the daemon is really this app's own (same data directory, same bundle, one stable boot id) and
 * that the bundle now on disk is the target, hands over, waits for the daemon to leave, and only then
 * relaunches this app so a new instance starts the new daemon.
 *
 * It never kills a process, never signals by port or PID, and never relaunches more than once per
 * target on its own. A person asking for the switch (`request()`) goes through the same verification.
 */
export class UpgradeHandover {
  private readonly deps: UpgradeDeps;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private bootId = '';
  /** Targets this app already relaunched for, so a failing switch is not attempted in a loop. */
  private attempted = new Set<string>();
  private reported = new Set<string>();
  constructor(deps: UpgradeDeps) {
    this.deps = deps;
  }
  start(intervalMs = 5000) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check().catch(() => undefined), intervalMs);
    this.timer.unref?.();
    void this.check().catch(() => undefined);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  /** The person pressed 立即重启: the same handover, including every check, attempted right now. */
  request(): Promise<void> {
    return this.check(true);
  }
  private note(message: string) {
    this.deps.log?.(message);
  }
  private async report(body: UpgradeHandshake, reason: string) {
    this.note(reason);
    try {
      await this.deps.blocked({ ...body, reason });
    } catch {
      /* The daemon may already be gone; the reason is still logged locally. */
    }
  }
  async check(manual = false): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.attempt(manual);
    } finally {
      this.running = false;
    }
  }
  private async attempt(manual: boolean): Promise<void> {
    // An SSH connection only shows a remote service. Restarting this Mac's app would switch nothing.
    if (this.deps.mode() !== 'local') return;
    const state = await this.deps.state();
    const record = state?.upgrade;
    if (!state || !record) return;
    if (record.phase === 'applied') return;
    if (record.phase === 'blocked' && !manual) return;
    const body: UpgradeHandshake = { fromBootId: state.identity.bootId, targetFingerprint: record.targetFingerprint };
    // Identity: the same data directory, this app's own bundle, and one stable boot of one daemon.
    if (!this.deps.bundlePath) {
      // A development run has no bundle of its own. It never takes over — and it must not block the
      // record either: the installed app is the one that should finish this switch.
      this.note('本应用不是安装包运行，不参与自动切换。');
      return;
    }
    if (state.identity.bundlePath !== this.deps.bundlePath) {
      await this.reportOnce(`${record.id}:bundle`, body, '待切换的服务不是本应用所在的安装包，已停止自动切换。');
      return;
    }
    if (state.identity.dataDirectory !== this.deps.dataDirectory) {
      await this.reportOnce(`${record.id}:data`, body, '待切换的服务使用了其他数据目录，已停止自动切换。');
      return;
    }
    if (this.bootId && this.bootId !== state.identity.bootId) {
      // A different daemon answers now: start over rather than hand over to an unknown process.
      this.bootId = state.identity.bootId;
      await this.reportOnce(`${record.id}:boot`, body, '本机服务已更换启动实例，重新核对后再切换。');
      return;
    }
    this.bootId = state.identity.bootId;
    // The target has to be the build that is on disk now, not just the one the receipt named.
    const onDisk = await this.deps.installedFingerprint(this.deps.bundlePath);
    if (onDisk !== record.targetFingerprint) {
      await this.report(
        body,
        onDisk
          ? '磁盘上的安装版本与待切换目标不一致，已停止切换；请核对安装结果。'
          : '读不到已安装版本的构建标识，已停止切换；请核对安装结果。'
      );
      return;
    }
    if (!state.idle && !manual) return;
    if (this.attempted.has(record.targetFingerprint) && !manual) return;
    try {
      await this.deps.acknowledge(body);
      // Capture the exit watch before asking the daemon to leave, so its exit cannot be missed.
      const childExit = this.deps.childExit?.();
      const asked = await this.deps.restart(body);
      if (asked.upgrade?.phase !== 'exiting') {
        this.note('本机服务尚未开始退出，稍后重试切换。');
        return;
      }
      this.attempted.add(record.targetFingerprint);
      if (!(await this.waitForExit(childExit))) {
        await this.report(body, '等待旧服务退出超时，已停止切换；当前版本继续运行，可稍后重试。');
        return;
      }
      // The daemon is gone and the new build is on disk: relaunching starts a new instance, which
      // starts the new daemon and reopens the same project and view.
      await this.deps.relaunch();
    } catch (error) {
      const message = error instanceof Error ? error.message : '切换失败';
      // A refusal because work is still running is not a failure; the switch keeps waiting.
      if (/仍有工作在进行/.test(message)) {
        this.note(message);
        return;
      }
      await this.report(body, `切换未完成：${message}`);
    }
  }
  /**
   * A reason this app can never complete the switch, written onto the daemon's own record and not
   * only into this app's log. A record left in `draining` refuses every entry point that starts
   * work with a 409 and makes the scheduler park each channel on every tick, with nothing left to
   * move it along; `blocked` releases those and lets the interface show why and offer a retry.
   * Reported once per reason, so a five-second poll does not repeat it.
   */
  private async reportOnce(key: string, body: UpgradeHandshake, reason: string) {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    await this.report(body, reason);
  }
  /** The daemon's own child exit, or, for an adopted daemon, its lock release and health going offline. */
  private async waitForExit(childExit?: Promise<void>): Promise<boolean> {
    const deadline = Date.now() + (this.deps.exitTimeoutMs ?? 30000);
    const poll = this.deps.pollMs ?? 500;
    if (childExit)
      await Promise.race([
        childExit,
        new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())).unref?.()),
      ]);
    for (;;) {
      if (await this.deps.daemonGone()) return true;
      if (Date.now() >= deadline) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, poll).unref?.());
    }
  }
}

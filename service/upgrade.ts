import { realpathSync } from 'node:fs';
import { APIError, keys, string } from './protocol.ts';
import { now } from './store.ts';
import { log } from './log.ts';
import type { Store } from './store.ts';
import { buildIdentity, isCommit, isFingerprint, readBuildInfo, unknownFingerprint } from './build-identity.ts';
import type { BuildIdentity } from './build-identity.ts';
import type { Release } from './autonomy-types.ts';

/** The exit code a daemon uses when it steps aside for a build already installed over its own bundle. */
export const upgradeExitCode = 75;
/** A reminder deadline, never a kill deadline: after this the record carries its blockers and waits on. */
export const upgradeReminderMs = 10 * 60 * 1000;
/** How often the blockers kept on the record are refreshed once the reminder deadline has passed. */
const reminderRefreshMs = 30 * 1000;
/** How often the bundle on disk is re-read, so a manual install is noticed without a receipt. */
const installedCheckMs = 60 * 1000;
/** The `releaseId` of a request nobody published: a build copied over this daemon's own bundle. */
export const manualInstallSource = 'manual-install';

export type UpgradePhase = 'pending' | 'draining' | 'exiting' | 'blocked' | 'applied';
/** One piece of real work that keeps the switch waiting. Nothing here is ever interrupted. */
export type UpgradeBlocker = { kind: 'run' | 'native' | 'send' | 'review' | 'publication'; label: string };
export type UpgradeRecord = {
  /** The target fingerprint: one record per installed build, so one target is requested once. */
  id: string;
  releaseId: string;
  targetCommit: string;
  targetFingerprint: string;
  /** The bundle the receipt named, which had to be this daemon's own. */
  installedBundle: string;
  /** The boot the request was made in; a handshake from another boot is refused. */
  fromBootId: string;
  phase: UpgradePhase;
  requestedAt: string;
  updatedAt: string;
  /** Set once the local Electron main verified identity and target and took over the handover. */
  acknowledgedAt?: string;
  /** Set when the reminder deadline passed while work was still running. */
  remindedAt?: string;
  blockers?: UpgradeBlocker[];
  error?: string;
  appliedAt?: string;
};
export type UpgradeIdentity = BuildIdentity & { dataDirectory: string };
export type UpgradeState = {
  identity: UpgradeIdentity;
  exitCode: number;
  reminderMs: number;
  /** No CLI run, native turn, queued/running review or publication in flight right now. */
  idle: boolean;
  blockers: UpgradeBlocker[];
  /** The request that governs work now, or the last finished one for the UI. */
  upgrade?: UpgradeRecord;
};

/** Two absolute paths naming the same bundle; a just-replaced bundle is compared by its real path. */
function samePath(left: string, right: string): boolean {
  const resolve = (value: string) => {
    const trimmed = value.replace(/\/+$/, '');
    try {
      return realpathSync(trimmed);
    } catch {
      return trimmed;
    }
  };
  return !!left && !!right && resolve(left) === resolve(right);
}

/**
 * The service side of the automatic version switch. It owns one persisted record per installed
 * target and the phase it is in; it never runs a release script, never signals a process and never
 * decides on its own that work may be interrupted. Whether work is running is answered by the
 * engine through `blockersOf`, and the actual exit is performed by `beginExit`, which the server
 * installs, so this module stays free of process control.
 */
export class UpgradeManager {
  store: Store;
  identity: UpgradeIdentity;
  /** Real work in progress right now, as the engine sees it. Empty means idle. */
  blockersOf: () => UpgradeBlocker[] = () => [];
  /**
   * Installed by the server: stop accepting requests, drain through the normal close path, release
   * the lock and leave with `upgradeExitCode`. Absent (a service embedded in a test) keeps the
   * record at `exiting` and changes nothing else.
   */
  beginExit?: (record: UpgradeRecord) => void;
  /** Set the moment this daemon decided to leave, before the phase is written. */
  exiting = false;
  /** When the bundle on disk was last re-read; the tick runs once a second and this once a minute. */
  installedCheckedAt = 0;
  constructor(store: Store, dataDirectory: string, identity?: BuildIdentity) {
    this.store = store;
    this.identity = { ...(identity ?? buildIdentity()), dataDirectory };
  }
  rows(): UpgradeRecord[] {
    return this.store.all<UpgradeRecord>('upgrades');
  }
  save(row: UpgradeRecord): UpgradeRecord {
    // The switch is the one thing that makes a daemon refuse new work, and it was invisible from
    // outside. Every phase change is one log line; the repeated blocker refreshes are not.
    const previous = this.store.get<UpgradeRecord>('upgrades', row.id)?.phase;
    if (previous !== row.phase)
      log('upgrade.phase', {
        phase: row.phase,
        from: previous,
        target: row.targetFingerprint.slice(0, 12),
        running: this.identity.fingerprint.slice(0, 12),
        blockers: row.blockers?.length ?? 0,
        error: row.error,
      });
    return this.store.put('upgrades', { ...row, updatedAt: now() });
  }
  /**
   * The request that governs work now: one target at a time, still on its way to a new daemon.
   * Selected by phase rather than by reading the table, because `tick()` asks once a second and
   * every entry point asks again through `draining()`.
   */
  record(): UpgradeRecord | undefined {
    return this.store.byStatus<UpgradeRecord>('upgrades', ['pending', 'draining', 'exiting'], 'phase').at(-1);
  }
  /** The newest record of any phase, so the UI can also report a finished or blocked switch. */
  latest(): UpgradeRecord | undefined {
    return this.store.recent<UpgradeRecord>('upgrades', 1).at(-1);
  }
  blockers(): UpgradeBlocker[] {
    return this.blockersOf();
  }
  /**
   * True from the moment a switch is requested until a new daemon runs the new build: new work is
   * refused, work already running is left alone. Every entry point checks this synchronously, so
   * nothing can start between the last idle check and the exit.
   */
  draining(): boolean {
    return !!this.record();
  }
  /** The sentence a refused entry point carries, so a 409 names the switch instead of failing blankly. */
  refusal(action: string): string {
    const row = this.record();
    return `${row?.phase === 'exiting' ? '正在切换到新版本' : '新版本已安装，正在等待当前工作结束后切换'}；${action}`;
  }
  /** Refuses one entry point while a switch is on its way. Reads, answers and pause are never refused. */
  require(action: string) {
    if (this.draining()) throw new APIError(409, this.refusal(action));
  }
  /**
   * One step of the switch, driven by the engine's scheduler. It moves a fresh request into
   * draining, records the blockers once the reminder deadline has passed, and — only when the work
   * is really finished and the local Electron main has taken over — asks the server to step aside.
   * It never interrupts, signals or kills anything.
   */
  tick() {
    if (this.exiting) return;
    if (Date.now() - this.installedCheckedAt >= installedCheckMs) {
      this.installedCheckedAt = Date.now();
      this.considerInstalled();
    }
    let row = this.record();
    if (!row) return;
    if (row.phase === 'pending') row = this.save({ ...row, phase: 'draining' });
    if (row.phase === 'exiting') return;
    const blockers = this.blockers();
    if (blockers.length) {
      const due = Date.parse(row.requestedAt) + upgradeReminderMs <= Date.now();
      const changed = JSON.stringify(row.blockers ?? []) !== JSON.stringify(blockers);
      const stale = !row.remindedAt || Date.parse(row.remindedAt) + reminderRefreshMs <= Date.now();
      // The deadline only makes the waiting visible; the switch keeps waiting for real idleness.
      if (due && (changed || stale)) this.save({ ...row, blockers, remindedAt: now() });
      return;
    }
    if (row.blockers?.length) row = this.save({ ...row, blockers: [] });
    // Without a local app that took over, the daemon stays pending rather than leaving nobody to
    // start its replacement. The next time a person opens Morrow, the handover continues.
    if (!row.acknowledgedAt) return;
    this.beginExitNow(row);
  }
  /**
   * The final idle check and the decision to leave, with no await between them: `exiting` is set
   * before the phase is written and before the server is asked to close, so a publication or turn
   * cannot slip in after the check.
   */
  beginExitNow(row: UpgradeRecord): UpgradeRecord | undefined {
    if (this.exiting || this.blockers().length) return undefined;
    this.exiting = true;
    const updated = this.store.transaction(() => this.save({ ...row, phase: 'exiting', blockers: [] }));
    try {
      this.beginExit?.(updated);
    } catch (error) {
      this.exiting = false;
      return this.save({
        ...updated,
        phase: 'blocked',
        error: `准备退出失败：${error instanceof Error ? error.message : '未知原因'}`,
      });
    }
    return updated;
  }
  /**
   * The request one handshake call is about. Both routes carry the boot they were issued for and the
   * target they mean; a call from another boot, or about another version, changes nothing.
   */
  private handshake(input: Record<string, any>, row: UpgradeRecord | undefined): UpgradeRecord {
    keys(input, ['fromBootId', 'targetFingerprint']);
    const fromBootId = string(input.fromBootId, 'fromBootId', 200);
    const targetFingerprint = string(input.targetFingerprint, 'targetFingerprint', 200);
    if (!row) throw new APIError(409, '当前没有待切换的新版本');
    if (fromBootId !== this.identity.bootId || fromBootId !== row.fromBootId)
      throw new APIError(409, '切换握手来自其他启动实例，已拒绝；请重新读取当前状态');
    if (targetFingerprint !== row.targetFingerprint)
      throw new APIError(409, '切换握手的目标版本与已安装版本不一致，已拒绝');
    return row;
  }
  /** The local Electron main verified identity and target and will restart itself: it may now leave. */
  acknowledge(input: Record<string, any>): UpgradeState {
    const row = this.handshake(input, this.record());
    if (!row.acknowledgedAt) this.save({ ...row, acknowledgedAt: now() });
    return this.state();
  }
  /**
   * The same handshake, requested early from the interface. Idempotent: while the daemon is already
   * leaving it just reports that, and while real work is running it refuses and names it, so the
   * button never becomes a way to interrupt a turn.
   */
  restart(input: Record<string, any>): UpgradeState {
    const active = this.record();
    // A retry of a switch this same boot failed at: identity and target are checked again first, so
    // a mismatched request cannot revive a request nobody is driving.
    const failed = !active ? this.latest() : undefined;
    const retry =
      failed?.phase === 'blocked' && failed.fromBootId === this.identity.bootId
        ? this.handshake(input, failed)
        : undefined;
    if (retry && retry.targetFingerprint === this.identity.fingerprint)
      throw new APIError(409, '已在运行该版本，无需再次切换');
    const row = retry
      ? this.save({ ...retry, phase: 'draining', error: undefined, blockers: [] })
      : this.handshake(input, active);
    if (this.exiting || row.phase === 'exiting') return this.state();
    const blockers = this.blockers();
    if (blockers.length)
      throw new APIError(
        409,
        `仍有工作在进行，不会中断：${blockers.map((blocker) => blocker.label).join('、')}。工作结束后会自动切换。`
      );
    this.beginExitNow(row.acknowledgedAt ? row : this.save({ ...row, acknowledgedAt: now() }));
    return this.state();
  }
  /** The local Electron main could not complete the handover; the reason is kept for the interface. */
  blocked(input: Record<string, any>): UpgradeState {
    keys(input, ['fromBootId', 'targetFingerprint', 'reason']);
    const reason = string(input.reason, 'reason', 500);
    const row = this.handshake(
      { fromBootId: input.fromBootId, targetFingerprint: input.targetFingerprint },
      this.record()
    );
    this.save({ ...row, phase: 'blocked', error: reason });
    return this.state();
  }
  state(): UpgradeState {
    const blockers = this.blockers();
    return {
      identity: { ...this.identity },
      exitCode: upgradeExitCode,
      reminderMs: upgradeReminderMs,
      idle: !blockers.length,
      blockers,
      ...(this.latest() ? { upgrade: this.latest() } : {}),
    };
  }
  /**
   * Whether a published receipt describes a new build installed over this daemon's own bundle, and
   * the persisted request it creates. Called inside the transaction that stores the `published`
   * release, so a crash cannot keep the publication and lose the intent to switch. Anything else —
   * an HTTP target, another project's script of the same name, a receipt without a build identity,
   * a bundle path that is not ours, a dev checkout, or a target already requested — returns
   * undefined and changes nothing.
   */
  consider(release: Release, receipt: Record<string, unknown>): UpgradeRecord | undefined {
    if (release.target.kind !== 'local-script') return undefined;
    const installedBundle = typeof receipt.installedBundle === 'string' ? receipt.installedBundle : '';
    const targetFingerprint = isFingerprint(receipt.buildFingerprint) ? receipt.buildFingerprint : '';
    if (!installedBundle || !targetFingerprint) return undefined;
    // A dev run has no bundle and no known fingerprint, so it can never be the installed target.
    if (!this.identity.bundlePath || this.identity.fingerprint === unknownFingerprint) return undefined;
    if (!samePath(installedBundle, this.identity.bundlePath)) return undefined;
    return this.request({
      releaseId: release.id,
      installedBundle,
      targetFingerprint,
      targetCommit: isCommit(receipt.commit) ? receipt.commit : unknownFingerprint,
    });
  }
  /**
   * A build installed without a Morrow release leaves no receipt, so nothing recorded the intent to
   * switch: `npm run build:app && bash scripts/install-app.sh` replaced this daemon's own bundle and
   * the daemon kept running the old code until somebody killed the process. Re-reading the bundle's
   * own `build-info.json` once a minute notices it, and from there it is the same request, draining,
   * exit code 75 and relaunch a published install goes through.
   *
   * It stays silent in the two cases where there is nothing to do: a development run, which has no
   * bundle and an unknown fingerprint, and the ordinary case where the bundle on disk is the build
   * already running. A target that already has a record — including one `recover()` marked
   * `blocked` — is not requested again, so nothing loops.
   */
  considerInstalled(): UpgradeRecord | undefined {
    if (!this.identity.bundlePath || this.identity.fingerprint === unknownFingerprint) return undefined;
    const info = readBuildInfo(this.identity.bundlePath);
    if (!info || info.fingerprint === this.identity.fingerprint) return undefined;
    return this.request({
      releaseId: manualInstallSource,
      installedBundle: this.identity.bundlePath,
      targetFingerprint: info.fingerprint,
      targetCommit: info.commit,
    });
  }
  /** The persisted request one newly installed build creates, shared by both ways of noticing it. */
  private request(target: {
    releaseId: string;
    installedBundle: string;
    targetFingerprint: string;
    targetCommit: string;
  }): UpgradeRecord | undefined {
    if (this.store.get<UpgradeRecord>('upgrades', target.targetFingerprint)) return undefined;
    const base = {
      id: target.targetFingerprint,
      releaseId: target.releaseId,
      targetCommit: target.targetCommit,
      targetFingerprint: target.targetFingerprint,
      installedBundle: target.installedBundle,
      fromBootId: this.identity.bootId,
      requestedAt: now(),
      updatedAt: now(),
    };
    // The same build reinstalled over itself is already satisfied; nothing restarts.
    if (target.targetFingerprint === this.identity.fingerprint) {
      this.save({ ...base, phase: 'applied', appliedAt: now() });
      return undefined;
    }
    return this.save({ ...base, phase: 'pending' });
  }
  /**
   * Start-up reconciliation, before any new work is scheduled. A request whose target is the build
   * now running is satisfied; one that survived into a daemon still running the old build keeps its
   * reason and stops, so nothing relaunches in a loop.
   */
  recover() {
    for (const row of this.rows()) {
      if (!['pending', 'draining', 'exiting'].includes(row.phase)) continue;
      if (row.targetFingerprint === this.identity.fingerprint) {
        this.save({ ...row, phase: 'applied', appliedAt: now(), blockers: undefined, error: undefined });
        continue;
      }
      this.save({
        ...row,
        phase: 'blocked',
        error: `切换后运行的仍是旧版本（指纹 ${this.identity.fingerprint.slice(0, 12)}），请核对安装后重试切换`,
      });
    }
  }
}

import { realpathSync } from 'node:fs';
import { now } from './store.ts';
import type { Store } from './store.ts';
import { buildIdentity, isCommit, isFingerprint, unknownFingerprint } from './build-identity.ts';
import type { BuildIdentity } from './build-identity.ts';
import type { Release } from './autonomy-types.ts';

/** The exit code a daemon uses when it steps aside for a build already installed over its own bundle. */
export const upgradeExitCode = 75;
/** A reminder deadline, never a kill deadline: after this the record carries its blockers and waits on. */
export const upgradeReminderMs = 10 * 60 * 1000;
/** How often the blockers kept on the record are refreshed once the reminder deadline has passed. */
const reminderRefreshMs = 30 * 1000;

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
  constructor(store: Store, dataDirectory: string, identity?: BuildIdentity) {
    this.store = store;
    this.identity = { ...(identity ?? buildIdentity()), dataDirectory };
  }
  rows(): UpgradeRecord[] {
    return this.store.all<UpgradeRecord>('upgrades');
  }
  save(row: UpgradeRecord): UpgradeRecord {
    return this.store.put('upgrades', { ...row, updatedAt: now() });
  }
  /** The request that governs work now: one target at a time, still on its way to a new daemon. */
  record(): UpgradeRecord | undefined {
    return this.rows().findLast((row) => ['pending', 'draining', 'exiting'].includes(row.phase));
  }
  /** The newest record of any phase, so the UI can also report a finished or blocked switch. */
  latest(): UpgradeRecord | undefined {
    return this.rows().at(-1);
  }
  blockers(): UpgradeBlocker[] {
    return this.blockersOf();
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
    const existing = this.store.get<UpgradeRecord>('upgrades', targetFingerprint);
    if (existing) return undefined;
    const base = {
      id: targetFingerprint,
      releaseId: release.id,
      targetCommit: isCommit(receipt.commit) ? receipt.commit : unknownFingerprint,
      targetFingerprint,
      installedBundle,
      fromBootId: this.identity.bootId,
      requestedAt: now(),
      updatedAt: now(),
    };
    // The same build reinstalled over itself is already satisfied; nothing restarts.
    if (targetFingerprint === this.identity.fingerprint) {
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

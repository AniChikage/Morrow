import type { Snapshot, UpgradeRecord, UpgradeState } from '../../shared/types';

/**
 * What the interface has to say about the automatic version switch, in one reading of the polled
 * snapshot. `waiting` still has work to finish, `ready` will switch by itself in a moment,
 * `switching` is the handover itself (so a brief unavailability is expected, not a server failure),
 * and `applied`/`blocked` report the outcome.
 */
export type UpgradeView = {
  kind: 'waiting' | 'ready' | 'switching' | 'applied' | 'blocked';
  record: UpgradeRecord;
  state: UpgradeState;
};
/** How long a finished switch keeps reporting itself when nobody acknowledged the banner. */
const appliedWindowMs = 6 * 60 * 60 * 1000;

export function upgradeView(snapshot: Snapshot): UpgradeView | undefined {
  const state = snapshot.upgrade;
  const record = state?.upgrade;
  if (!state || !record) return undefined;
  if (record.phase === 'applied')
    return record.appliedAt && Date.now() - Date.parse(record.appliedAt) < appliedWindowMs
      ? { kind: 'applied', record, state }
      : undefined;
  if (record.phase === 'blocked') return { kind: 'blocked', record, state };
  if (record.phase === 'exiting' || record.acknowledgedAt) return { kind: 'switching', record, state };
  return { kind: state.blockers.length ? 'waiting' : 'ready', record, state };
}
/** During the handover the daemon is stepping aside, so controls that would start work are disabled. */
export const upgradeSwitching = (snapshot: Snapshot) => upgradeView(snapshot)?.kind === 'switching';

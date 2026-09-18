import type { WorkspaceEvent } from '../../shared/types.ts';
import { statusLabel } from '../components/format.ts';
import type { FeatureProps } from './types.ts';

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
/**
 * One line naming the fields an item write moved, read from the audit row's own `before`/`after`.
 * Kept free of React, the DOM and every renderer-only dependency so a service test can load it and
 * check the summary against what the real work interface writes (`tests/item-history-summary.test.ts`);
 * that is the only guarantee the two layers agree on the shape of `changes`.
 */
export function itemChangeSummary(event: WorkspaceEvent, channels: FeatureProps['snapshot']['channels']): string {
  if (
    !event.itemId ||
    ![
      'item.updated',
      'feature.updated',
      'feature.completed',
      'item.assigned',
      'item.claimed',
      'item.released',
    ].includes(event.action || '')
  )
    return '';
  const before = asRecord(event.changes?.before),
    after = asRecord(event.changes?.after);
  // Missing old values are not proof of a change. In particular, older Agent
  // records only stored after; leave their original description intact.
  const changed = (key: string) => key in before && key in after && before[key] !== after[key];
  const parts: string[] = [];
  if (changed('status') && typeof before.status === 'string' && typeof after.status === 'string')
    parts.push(`状态 ${statusLabel(before.status)} → ${statusLabel(after.status)}`);
  for (const [key, label] of [
    ['nextStep', '下一步已更新'],
    ['summary', '说明已修改'],
  ])
    if (changed(key) && typeof before[key] === 'string' && typeof after[key] === 'string') parts.push(label);
  const validOwner = (value: unknown) => value === null || typeof value === 'string';
  if (
    changed('ownerChannelId') &&
    validOwner(before.ownerChannelId) &&
    validOwner(after.ownerChannelId) &&
    (before.ownerChannelId || null) !== (after.ownerChannelId || null)
  ) {
    const name = after.ownerChannelId
      ? channels.find((channel) => channel.id === after.ownerChannelId)?.name || '频道信息未载入'
      : '无人负责';
    parts.push(`负责频道 → ${name}`);
  }
  return parts.join('、');
}

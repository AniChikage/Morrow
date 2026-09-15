// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { WorkspaceEvent } from '../../shared/types';
import { ProjectRecords } from './ProjectRecords';
import { event, featureProps, TestProviders } from './testFixtures';

afterEach(cleanup);

function records(actions: string[]): WorkspaceEvent[] {
  return actions.map((action, index) =>
    event(`audit-${index}`, `原始记录 ${index}`, index, {
      projectId: 'project-atlas',
      itemId: 'finding-import',
      actor: 'system',
      action,
    })
  );
}
function show(events: WorkspaceEvent[], itemId?: string) {
  const { props } = featureProps();
  props.snapshot.events = events;
  vi.mocked(props.api.getEvents).mockResolvedValue({ events, hasMore: false });
  render(<ProjectRecords {...props} projectId="project-atlas" itemId={itemId} />, { wrapper: TestProviders });
}

it('labels action literals and both conditional literal branches in service sources', async () => {
  const service = resolve('service');
  const actions = new Set<string>();
  for (const file of readdirSync(service, { recursive: true, encoding: 'utf8' })) {
    if (!file.endsWith('.ts')) continue;
    const source = readFileSync(join(service, file), 'utf8');
    for (const match of source.matchAll(/\baction\s*:\s*(['"`])([^'"`\r\n$]+)\1/g)) actions.add(match[2]);
    // Also collect both literal branches, such as previous ? 'native.empty-recreated' : 'native.created'.
    for (const match of source.matchAll(
      /\baction\s*:\s*[^,;?]+\?\s*(['"`])([^'"`\r\n$]+)\1\s*:\s*(['"`])([^'"`\r\n$]+)\3/g
    )) {
      actions.add(match[2]);
      actions.add(match[4]);
    }
  }
  // These known entries ensure a broken scan cannot pass with an empty result.
  expect(actions.has('channel.next-step')).toBe(true);
  expect(actions.has('native.message-submitted')).toBe(true);
  expect(actions.has('native.created')).toBe(true);
  expect(actions.has('native.empty-recreated')).toBe(true);
  show(records([...actions]));
  await waitFor(() => expect(document.querySelectorAll('.audit-record')).toHaveLength(actions.size));
  const labels = [...document.querySelectorAll('.audit-record header span:not(.audit-record-dot)')].map(
    (node) => node.textContent || ''
  );
  expect(labels).toHaveLength(actions.size);
  expect(labels.filter((label) => actions.has(label))).toEqual([]);
  expect(labels.every((label) => /[\u4e00-\u9fff]/.test(label))).toBe(true);
});

it.each([undefined, 'finding-import'])(
  'labels helper-generated and historical actions without changing text (%s)',
  async (itemId) => {
    const labels = {
      'finalization.applied': '采纳复核结论',
      'finalization.rejected': '未采纳复核结论',
      'finalization.stale': '复核结论未应用：内容已变化',
      'release.publishing': '正在上线',
      'feature.completed': '完成事项',
      'item.claimed': '接手事项',
      'item.released': '交回事项',
      'native.background-configured': '配置旧转接设置',
      'native.created': '创建 App 任务',
      'native.empty-recreated': '重建未保留的空白 App 任务',
      'verification.requeued': '额度恢复，重新复核',
      'verification.usage-wait': '复核等待额度',
      'upgrade.requested': '等待切换新版本',
      'future.unknown': 'future.unknown',
    };
    const events = records(Object.keys(labels));
    show(events, itemId);
    for (const label of Object.values(labels)) expect(await screen.findByText(label)).toBeTruthy();
    for (const row of events) expect(screen.getByText(row.text)).toBeTruthy();
  }
);

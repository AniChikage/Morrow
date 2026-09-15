// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

// Every action the service records with both sides: the two agent item writes, the completion a
// passing review applies, and the three ways responsibility moves.
it.each(['item.updated', 'feature.updated', 'feature.completed', 'item.claimed', 'item.released'])(
  'summarizes applied item changes while preserving the original description and full differences (%s)',
  async (action) => {
    const row = records([action])[0];
    row.changes = {
      before: { status: 'investigating', nextStep: '旧的下一步', summary: '旧说明', ownerChannelId: null },
      after: { status: 'verified', nextStep: '新的下一步', summary: '新说明', ownerChannelId: 'channel-system' },
    };
    const original = structuredClone(row);
    show([row], 'finding-import');
    expect(await screen.findByText('状态 调查中 → 已验证、下一步已更新、说明已修改、负责频道 → 系统完善')).toBeTruthy();
    const description = screen.getByText(row.text);
    const details = description.closest('details')!;
    expect(details.open).toBe(false);
    await userEvent.setup().click(screen.getByText('查看变更'));
    expect(details.open).toBe(true);
    for (const value of ['旧的下一步', '新的下一步', '旧说明', '新说明', '无人负责', '系统完善'])
      expect(within(details).getByText(value)).toBeTruthy();
    expect(row).toEqual(original);
  }
);

it.each([
  ['only after', 'feature.updated', { after: { status: 'verified', nextStep: '当前下一步', summary: '当前说明' } }],
  ['conflict', 'item.conflict', { before: { status: 'investigating' }, after: { status: 'verified' } }],
  [
    'unchanged',
    'item.updated',
    { before: { status: 'verified', summary: '相同' }, after: { status: 'verified', summary: '相同' } },
  ],
  ['invalid values', 'item.updated', { before: { status: {} }, after: { status: [] } }],
  ['no snapshots', 'item.updated', undefined],
  ['other fields', 'item.updated', { before: { title: '原标题' }, after: { title: '新标题' } }],
] as const)('keeps the original item description when a change cannot be inferred (%s)', async (_, action, changes) => {
  const row = { ...records([action])[0], changes };
  show([row], 'finding-import');
  expect((await screen.findByText(row.text)).closest('details')).toBeNull();
  expect(screen.queryByText(/^状态 .* → /)).toBeNull();
  expect(screen.queryByText('下一步已更新')).toBeNull();
});

it.each([
  ['channel-system', null, '无人负责'],
  [null, 'missing-channel', '频道信息未载入'],
] as const)(
  'names assignment changes without mistaking an unloaded channel for deletion',
  async (before, after, name) => {
    const row = records(['item.assigned'])[0];
    row.changes = { before: { ownerChannelId: before }, after: { ownerChannelId: after } };
    show([row], 'finding-import');
    expect(await screen.findByText(`负责频道 → ${name}`)).toBeTruthy();
    await userEvent.setup().click(screen.getByText('查看变更'));
    if (after) expect(screen.getByText(`频道信息未载入（${after}）`)).toBeTruthy();
  }
);

it('retains the identifying original description in the project-wide audit view', async () => {
  const row = records(['item.updated'])[0];
  row.changes = { before: { status: 'open' }, after: { status: 'verified' } };
  show([row]);
  expect((await screen.findByText(row.text)).closest('details')).toBeNull();
  expect(screen.queryByText('状态 待处理 → 已验证')).toBeNull();
});

it('does not describe a missing owner field in conflict details as unassigned', async () => {
  const row = records(['item.conflict'])[0];
  row.changes = { before: { ownerChannelId: 'channel-system' }, after: {} };
  show([row], 'finding-import');
  await screen.findByText(row.text);
  await userEvent.setup().click(screen.getByText('查看变更'));
  expect(screen.getByText('未记录')).toBeTruthy();
  expect(screen.queryByText('无人负责')).toBeNull();
});

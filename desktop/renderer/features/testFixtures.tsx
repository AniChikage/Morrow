import type { ReactNode } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { vi } from 'vitest';
import type { Channel, CreateItem, DesktopAPI, ItemPatch, Snapshot, WorkItem, WorkspaceEvent } from '../../shared/types';
import type { FeatureProps } from './types';

export const timestamp = '2026-09-07T02:00:00.000Z';
export function channel(id = 'channel-system', projectId = 'project-atlas'): Channel {
  return { id, projectId, name: id === 'channel-growth' ? '运营洞察' : '系统完善', goal: '持续验证问题并记录证据。', runtime: id === 'channel-growth' ? 'claude' : 'codex', model: '', status: 'paused', intervalMinutes: 60, maxRunsPerDay: 8, permission: 'read-only', nextRunAt: '', lastRunAt: '', sessionId: '' };
}
export function item(patch: Partial<WorkItem> = {}): WorkItem {
  return { id: 'finding-import', channelId: 'channel-system', title: 'CSV 重试会重复提交', summary: '导入超时后再次提交，产生 **两条重复记录**。\n\n### 复现观察\n\n- 首次请求返回超时\n- 重试后重复写入', status: 'open', kind: 'issue', evidence: ['日志包含唯一证据关键词：request-17。', '[官方错误码](https://example.com/import/errors)'], nextStep: '验证幂等键，并补充失败后的恢复测试。', createdAt: timestamp, updatedAt: timestamp, ...patch };
}
export function event(id: string, value: string, sequence = 1, patch: Partial<WorkspaceEvent> = {}): WorkspaceEvent {
  return { id, channelId: 'channel-system', runId: 'run-one', kind: 'assistant', text: value, createdAt: timestamp, detail: { type: 'message', sequence }, ...patch };
}
export function snapshot(): Snapshot {
  return {
    projects: [{ id: 'project-atlas', name: 'Atlas 示例项目', path: '', goal: '改善可靠性与激活体验。', createdAt: timestamp, isDemo: true }, { id: 'project-other', name: 'Other', path: '', goal: '独立项目', createdAt: timestamp, isDemo: false }],
    channels: [channel(), channel('channel-growth'), channel('channel-other', 'project-other')],
    items: [item(), item({ id: 'finding-focus', title: '输入焦点已恢复', summary: '修复键盘焦点。', evidence: ['焦点测试通过'], status: 'verified' }), item({ id: 'finding-growth', channelId: 'channel-growth', title: '缩短激活路径', summary: '研究首次导入步骤。', evidence: ['用户访谈'], kind: 'opportunity' }), item({ id: 'finding-private', channelId: 'channel-other', title: '其他项目的发现', evidence: ['不应出现在 Atlas 列表'] })],
    events: [], runs: [], runtimes: [],
  };
}
export function featureProps(patch: Partial<FeatureProps> = {}) {
  const state = snapshot();
  const api = {
    getState: vi.fn(async () => state), getConnection: vi.fn(), connect: vi.fn(),
    createProject: vi.fn(), createChannel: vi.fn(), updateChannel: vi.fn(),
    channelAction: vi.fn(async () => ({ ok: true })),
    sendMessage: vi.fn(async (id: string, text: string) => event('human-note', text, 9, { channelId: id, kind: 'message' })),
    getNativeStatus: vi.fn(async () => nativeStatus),
    listNativeThreads: vi.fn(async () => ({ status: nativeStatus, threads: [] })),
    getNativeConversation: vi.fn(async (channelId: string) => ({ channelId, status: nativeStatus, items: [], requests: [], hasMore: false })),
    bindNativeThread: vi.fn(), createNativeThread: vi.fn(), sendNativeMessage: vi.fn(),
    interruptNativeTurn: vi.fn(), respondNativeRequest: vi.fn(), openNativeApp: vi.fn(async () => {}),
    chooseNativeImages: vi.fn(async () => []), getNativeImage: vi.fn(),
    updateItem: vi.fn(async (id: string, status: string) => item({ id, status })),
    createItem: vi.fn(async (data: CreateItem) => item({ ...data, channelId: data.channelId || '' })),
    patchItem: vi.fn(async (id: string, patch: ItemPatch) => item({ id, ...patch })),
    getRuns: vi.fn(async () => ({ runs: [], hasMore: false })), getRun: vi.fn(),
    getRunOutput: vi.fn(async () => ({ chunks: [], hasMore: false })),
    openNativeSession: vi.fn(async () => {}),
    loadDemo: vi.fn(), refreshRuntimes: vi.fn(),
    getEvents: vi.fn(async () => ({ events: [] as WorkspaceEvent[], hasMore: false })),
    chooseFolder: vi.fn(), openProjectFolder: vi.fn(), openDataFolder: vi.fn(), openExternal: vi.fn(), onCommand: vi.fn(() => () => {}),
  } satisfies Partial<DesktopAPI>;
  const props: FeatureProps = {
    snapshot: state, api: api as DesktopAPI, busy: false, showInspector: true,
    onNavigate: vi.fn(), onEditChannel: vi.fn(), onNewChannel: vi.fn(), onNewFeature: vi.fn(), onEditFeature: vi.fn(),
    onMutate: vi.fn(async (action: () => Promise<unknown>) => { try { await action(); return true; } catch { return false; } }),
    ...patch,
  };
  return { props, api };
}
export const nativeStatus = { available: false, connected: false, detail: 'Codex CLI 未连接', capabilities: { list: false, read: false, send: false, create: false, interrupt: false, respond: false } };
export function TestProviders({ children }: { children: ReactNode }) {
  return <Tooltip.Provider delayDuration={0}>{children}</Tooltip.Provider>;
}

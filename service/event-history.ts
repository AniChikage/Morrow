import { APIError } from './protocol.ts';
import type { Event, Run, RunIO, WorkItem } from './protocol.ts';
import type { Store } from './store.ts';

export function queryFields(params: URLSearchParams, allowed: string[]) {
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) throw new APIError(400, '查询参数无效');
}
export function queryID(params: URLSearchParams, name: string) {
  const value = params.get(name);
  if (value === null) return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new APIError(400, `${name} 必须是有效 ID`);
  return value;
}
export function queryLimit(params: URLSearchParams, max = 200) {
  const raw = params.get('limit');
  if (raw !== null && (!/^[1-9][0-9]{0,2}$/.test(raw) || Number(raw) > max)) throw new APIError(400, `limit 必须在 1–${max} 之间`);
  return raw === null ? 50 : Number(raw);
}
function scope(store: Store, params: URLSearchParams) {
  const projectId = queryID(params, 'projectId'); const channelId = queryID(params, 'channelId');
  if (projectId && !store.get('projects', projectId)) throw new APIError(404, '项目不存在');
  const channel = channelId ? store.get('channels', channelId) : undefined;
  if (channelId && (!channel || (projectId && channel.projectId !== projectId))) throw new APIError(404, '频道不属于该项目或不存在');
  return {projectId, channelId};
}
/** Cursor IDs stay opaque; durable insertion order is resolved in SQLite. */
export function eventHistory(store: Store, params: URLSearchParams) {
  queryFields(params, ['projectId', 'channelId', 'itemId', 'runId', 'before', 'after', 'limit']);
  const {projectId, channelId} = scope(store, params);
  if (!projectId && !channelId) throw new APIError(400, '需要 projectId 或 channelId');
  const itemId = queryID(params, 'itemId'); const runId = queryID(params, 'runId');
  const before = queryID(params, 'before'); const after = queryID(params, 'after');
  if (before && after) throw new APIError(400, 'before 与 after 不能同时使用');
  const matches = (row: {projectId?: string; channelId?: string; itemId?: string; runId?: string}) => (!projectId || row.projectId === projectId) && (!channelId || row.channelId === channelId);
  if (runId) { const run = store.get<Run>('runs', runId); if (!run || !matches(run)) throw new APIError(404, '运行记录不属于查询范围或不存在'); }
  if (itemId) { const item = store.get<WorkItem>('items', itemId); const project = projectId || store.get('channels', channelId!)?.projectId; if (!item || item.projectId !== project) throw new APIError(404, '事项不属于查询范围或不存在'); }
  if (before || after) {
    const cursor = store.get<Event>('events', (before || after)!);
    if (!cursor || !matches(cursor) || (runId && cursor.runId !== runId) || (itemId && cursor.itemId !== itemId)) throw new APIError(404, '事件游标不属于查询范围或不存在');
  }
  return store.eventPage({projectId, channelId, itemId, runId, before, after, limit: queryLimit(params)});
}
export function runHistory(store: Store, params: URLSearchParams) {
  queryFields(params, ['projectId', 'channelId', 'before', 'after', 'limit']);
  const {projectId, channelId} = scope(store, params);
  const before = queryID(params, 'before'); const after = queryID(params, 'after');
  if (before && after) throw new APIError(400, 'before 与 after 不能同时使用');
  if (before || after) { const run = store.get<Run>('runs', (before || after)!); if (!run || (projectId && run.projectId !== projectId) || (channelId && run.channelId !== channelId)) throw new APIError(404, '运行游标不属于查询范围或不存在'); }
  return store.runPage({projectId, channelId, before, after, limit: queryLimit(params)});
}
export function runOutput(store: Store, runId: string, params: URLSearchParams) {
  if (!store.get('runs', runId)) throw new APIError(404, '运行记录不存在');
  queryFields(params, ['after', 'limit']); const after = queryID(params, 'after');
  if (after && store.get<RunIO>('run_io', after)?.runId !== runId) throw new APIError(404, '输出游标不属于本轮运行或不存在');
  return store.ioPage(runId, after, queryLimit(params, 100));
}

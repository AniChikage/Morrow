import type { ChannelPatch, ConnectionConfig, CreateChannel, CreateProject, EventsQuery, CreateItem, ItemPatch, RunsQuery, RunOutputQuery, NativeMessageInput, NativeHistoryQuery } from '../shared/types';

const runtimes = ['codex', 'claude', 'trae'];
export const itemStatuses = ['open', 'investigating', 'verified', 'resolved', 'blocked'];
export function record(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求必须是对象。');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !allowed.includes(key))) throw new Error('请求包含不支持的字段。');
  return data;
}
export function text(value: unknown, name: string, max = 10000, empty = false): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!empty && !value.trim())) throw new Error(`${name}格式无效。`);
  return value.trim();
}
export function id(value: unknown): string {
  const result = text(value, '标识', 100);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) throw new Error('标识格式无效。');
  return result;
}
export function choice<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error('选项无效。');
  return value as T;
}
export function integer(value: unknown, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`数值必须在 ${min}–${max} 之间。`);
  return Number(value);
}
export function connectionConfig(value: unknown): ConnectionConfig {
  const data = record(value, ['mode', 'host', 'port', 'directory']);
  const mode = choice(data.mode, ['local', 'ssh'] as const);
  const host = text(data.host, 'SSH 主机', 255, mode === 'local');
  const directory = text(data.directory, '数据目录', 4096, mode === 'local');
  const port = integer(data.port, 1, 65535);
  if (mode === 'ssh' && (!/^[A-Za-z0-9][A-Za-z0-9_.@:-]*$/.test(host) || !/^(\/|~\/)/.test(directory) || /[\r\n]/.test(directory))) {
    throw new Error('请输入 SSH 主机别名或 user@host；数据目录必须是绝对路径或以 ~/ 开头。');
  }
  return { mode, host, port, directory };
}
export function projectInput(value: unknown): CreateProject {
  const data = record(value, ['name', 'path', 'goal', 'runtime']);
  return { name: text(data.name, '项目名称', 100), path: text(data.path, '项目目录', 4096), goal: text(data.goal, '项目目标', 20000), ...(data.runtime!==undefined?{runtime:choice(data.runtime,['codex','claude','trae'] as const)}:{}) };
}
const channelKeys = ['name', 'goal', 'runtime', 'model', 'intervalMinutes', 'maxRunsPerDay', 'permission'];
export function channelPatch(value: unknown): ChannelPatch {
  const data = record(value, channelKeys);
  const result: Record<string, unknown> = {};
  if (data.name !== undefined) result.name = text(data.name, '频道名称', 100);
  if (data.goal !== undefined) result.goal = text(data.goal, '频道目标', 20000);
  if (data.runtime !== undefined) result.runtime = choice(data.runtime, runtimes);
  if (data.model !== undefined) {
    const model = text(data.model, '模型', 120, true);
    if (model && !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)) throw new Error('模型格式无效。');
    result.model = model;
  }
  if (data.permission !== undefined) result.permission = choice(data.permission, ['read-only', 'workspace-write', 'native']);
  if (data.intervalMinutes !== undefined) result.intervalMinutes = integer(data.intervalMinutes, 1, 1440);
  if (data.maxRunsPerDay !== undefined) result.maxRunsPerDay = integer(data.maxRunsPerDay, 1, 100);
  return result as ChannelPatch;
}
export function channelInput(value: unknown): CreateChannel {
  const data = record(value, ['projectId', ...channelKeys]);
  const { projectId, ...fields } = data;
  const result = channelPatch(fields);
  if (!result.name || !result.goal || !result.runtime) throw new Error('请填写频道名称、目标和运行引擎。');
  return { ...result, projectId: id(projectId) } as CreateChannel;
}
const itemKeys=['title','summary','kind','status','evidence','nextStep','revision'];
export function itemPatch(value:unknown):ItemPatch {
  const data=record(value,itemKeys),result:ItemPatch={};
  if(data.title!==undefined)result.title=text(data.title,'功能标题',300);
  if(data.summary!==undefined)result.summary=text(data.summary,'功能描述',10000,true);
  if(data.nextStep!==undefined)result.nextStep=text(data.nextStep,'下一步',5000,true);
  if(data.kind!==undefined)result.kind=choice(data.kind,['feature','issue','opportunity','hypothesis']);
  if(data.status!==undefined)result.status=choice(data.status,itemStatuses);
  if(data.evidence!==undefined){
    if(!Array.isArray(data.evidence)||data.evidence.length>50)throw new Error('证据应是最多50条文本。');
    result.evidence=data.evidence.map(value=>text(value,'证据',5000));
  }
  if(data.revision!==undefined)result.revision=integer(data.revision,1,Number.MAX_SAFE_INTEGER);
  if(!Object.keys(result).some(key=>key!=='revision'))throw new Error('请至少修改一个功能字段。');
  return result;
}
export function itemInput(value:unknown):CreateItem {
  const data=record(value,['projectId','channelId',...itemKeys.filter(key=>key!=='revision')]);
  const {projectId,channelId,...fields}=data;
  const result=itemPatch(fields);
  if(!result.title)throw new Error('请填写功能标题。');
  return {...result,projectId:id(projectId),title:result.title,...(channelId!==undefined?{channelId:channelId===''?'':id(channelId)}:{})};
}
function pageFields(data:Record<string,unknown>):RunsQuery {
  const result:RunsQuery={};
  for(const key of ['projectId','channelId','before','after'] as const)if(data[key]!==undefined)result[key]=id(data[key]);
  if(result.before&&result.after)throw new Error('一次只能指定一个分页方向。');
  if(data.limit!==undefined)result.limit=integer(data.limit,1,200);
  return result;
}
export function eventsInput(value: unknown): EventsQuery {
  const data = record(value, ['projectId','channelId','itemId','runId','before','after','limit']);
  const result:EventsQuery=pageFields(data);
  if(!result.projectId&&!result.channelId)throw new Error('请选择项目或频道。');
  if(data.runId!==undefined)result.runId=id(data.runId);
  if(data.itemId!==undefined)result.itemId=id(data.itemId);
  return result;
}
export function runsInput(value:unknown):RunsQuery {
  return pageFields(record(value,['projectId','channelId','before','after','limit']));
}
export function runOutputInput(value:unknown):RunOutputQuery {
  const data=record(value,['after','limit']);
  return {...(data.after!==undefined?{after:id(data.after)}:{}),...(data.limit!==undefined?{limit:integer(data.limit,1,100)}:{})};
}
export function nativeMessageInput(value: unknown): NativeMessageInput {
  const data = record(value, ['text', 'requestId', 'attachments']);
  if (data.attachments !== undefined && (!Array.isArray(data.attachments) || data.attachments.length > 5)) throw new Error('一次最多发送 5 张图片。');
  const attachments = (data.attachments as unknown[] | undefined)?.map(value => { const entry = record(value, ['id', 'name', 'mimeType']); return { id: id(entry.id), name: text(entry.name, '图片名称', 255), mimeType: choice(entry.mimeType, ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) }; });
  text(data.text, '消息', 100000, !!attachments?.length);
  // Direct native chat must preserve whitespace and must never receive a scheduler wrapper.
  return { text: data.text as string, requestId: id(data.requestId), ...(attachments?.length ? { attachments } : {}) };
}
export function nativeHistoryInput(value: unknown): NativeHistoryQuery {
  const data = record(value ?? {}, ['before', 'limit']);
  return { ...(data.before !== undefined ? { before: text(data.before, '历史游标', 2048) } : {}), ...(data.limit !== undefined ? { limit: integer(data.limit, 1, 200) } : {}) };
}
export function nativeResponseInput(value: unknown): unknown {
  if (!value || typeof value !== 'object') throw new Error('原生请求回复格式无效。');
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { throw new Error('原生请求回复格式无效。'); }
  if (serialized.length > 65536) throw new Error('原生请求回复过长。');
  return JSON.parse(serialized);
}
export function externalURL(value: unknown): string {
  const raw = text(value, '链接', 8192);
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('只能打开 HTTP 或 HTTPS 网页链接。');
  return url.href;
}

import { createHash } from 'node:crypto';
import { APIError, integer, keys, string } from './protocol.ts';
import type { ProjectWorkLoop, Scope } from './project-loop.ts';

const toolTypes = ['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'fileChange'];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const cut = (value: unknown, limit: number) => String(value ?? '').slice(0, limit);

function task(loop: ProjectWorkLoop, scope: Scope) {
  const { run } = loop.scope(scope);
  const binding = loop.store.get<any>('native_bindings', scope.channelId);
  if (!run.sessionId || binding?.threadId !== run.sessionId) throw new APIError(404, '本轮没有可引用的原生任务');
  return run.sessionId;
}
function owned(loop: ProjectWorkLoop, scope: Scope, threadId: string, row: any) {
  if (
    !row ||
    row.threadId !== threadId ||
    row.present === false ||
    !(row.role === 'tool' || toolTypes.includes(row.type))
  )
    return false;
  return !!loop.store.db
    .prepare(
      "SELECT 1 FROM runs WHERE json_extract(data,'$.projectId')=? AND json_extract(data,'$.channelId')=? AND json_extract(data,'$.sessionId')=? AND json_extract(data,'$.nativeTurnId')=? LIMIT 1"
    )
    .get(scope.projectId, scope.channelId, threadId, row.turnId);
}
function name(row: any) {
  return cut([row.raw?.server, row.raw?.tool || row.raw?.name || row.type].filter(Boolean).join('/'), 200);
}

/** Bounded discovery, filtered before pagination so unrelated native turns cannot consume its slots. */
export function nativeEvidenceItems(loop: ProjectWorkLoop, scope: Scope, input: Record<string, unknown>) {
  keys(input, ['before', 'limit']);
  const threadId = task(loop, scope);
  const limit = input.limit === undefined ? 20 : integer(input.limit, 'limit', 1, 20);
  const before = input.before === undefined ? undefined : string(input.before, 'before', 200);
  if (before && !owned(loop, scope, threadId, loop.store.get('native_items', before)))
    throw new APIError(404, '原生条目不属于当前频道任务');
  const rows = loop.store.db
    .prepare(
      `SELECT n.data FROM native_items n WHERE json_extract(n.data,'$.threadId')=?
    AND COALESCE(json_extract(n.data,'$.present'),1)=1
    AND (json_extract(n.data,'$.role')='tool' OR json_extract(n.data,'$.type') IN (${toolTypes.map(() => '?').join(',')}))
    AND EXISTS (SELECT 1 FROM runs r WHERE json_extract(r.data,'$.projectId')=? AND json_extract(r.data,'$.channelId')=? AND json_extract(r.data,'$.sessionId')=? AND json_extract(r.data,'$.nativeTurnId')=json_extract(n.data,'$.turnId'))
    ${before ? 'AND n.rowid < (SELECT rowid FROM native_items WHERE id=?)' : ''}
    ORDER BY n.rowid DESC LIMIT ?`
    )
    .all(
      threadId,
      ...toolTypes,
      scope.projectId,
      scope.channelId,
      threadId,
      ...(before ? [before] : []),
      limit + 1
    ) as { data: string }[];
  const items = rows.slice(0, limit).map(({ data }) => {
    const row = JSON.parse(data);
    return { id: row.id, turnId: row.turnId, type: row.type, status: row.status, tool: loop.redact(name(row)) };
  });
  return { items, hasMore: rows.length > limit, ...(items.length ? { cursor: items.at(-1)!.id } : {}) };
}

/** Copy the observed receipt. It is provenance, not a successful execution or layout verdict. */
export function nativeEvidenceSnapshot(loop: ProjectWorkLoop, scope: Scope, input: Record<string, unknown>) {
  keys(input, ['itemId', 'summary', 'nativeItemIds']);
  const threadId = task(loop, scope);
  if (!Array.isArray(input.nativeItemIds) || input.nativeItemIds.length < 1 || input.nativeItemIds.length > 20)
    throw new APIError(400, 'nativeItemIds 必须包含1到20个条目ID');
  const ids = input.nativeItemIds.map((id) => string(id, 'nativeItemId', 200));
  if (new Set(ids).size !== ids.length) throw new APIError(400, 'nativeItemIds 不得重复');
  const images: Array<Record<string, unknown>> = [];
  let imageBytes = 0;
  function sanitize(value: any, path: string, depth = 0): any {
    if (depth > 12) return '[depth limit]';
    if (typeof value === 'string') return loop.redact(value);
    if (!value || typeof value !== 'object') return value;
    if (value.type === 'image' || value.type === 'localImage') {
      const image: Record<string, unknown> = { ref: path };
      if (typeof value.data === 'string' && /^image\/(png|jpeg|gif|webp)$/.test(value.mimeType || '')) {
        imageBytes += value.data.length;
        if (imageBytes > 384 * 1024) throw new APIError(413, '内联图片合计超过384 KiB，请减少条目');
        image.mimeType = value.mimeType;
        image.dataUrl = `data:${value.mimeType};base64,${value.data}`;
        image.sha256 = hash(value.data);
        image.retained = 'inline';
      } else {
        image.source = loop.redact(cut(value.path ?? value.image_url ?? value.url, 4096));
        image.retained = 'reference_only';
      }
      if (images.length >= 20) throw new APIError(413, '图片引用超过20条');
      images.push(image);
      return { imageRef: path, retained: image.retained };
    }
    if (Array.isArray(value)) {
      if (value.length > 2000) throw new APIError(413, '原生内容过大，请减少条目');
      return value.map((v, i) => sanitize(v, `${path}/${i}`, depth + 1));
    }
    const entries = Object.entries(value);
    if (entries.length > 2000) throw new APIError(413, '原生内容过大');
    return Object.fromEntries(
      entries.map(([k, v]) => [
        k,
        /token|password|authorization|secret/i.test(k) ? '[REDACTED]' : sanitize(v, `${path}/${k}`, depth + 1),
      ])
    );
  }
  function summary(value: any, path: string) {
    const text = JSON.stringify(sanitize(value ?? null, path));
    return { text: text.slice(0, 6000), truncated: text.length > 6000, sha256: hash(text) };
  }
  const items = ids.map((id) => {
    const row = loop.store.get<any>('native_items', id);
    if (!owned(loop, scope, threadId, row)) throw new APIError(404, '原生条目不属于当前频道任务');
    const raw = row.raw || {};
    return {
      id,
      turnId: row.turnId,
      type: row.type,
      status: row.status,
      tool: loop.redact(name(row)),
      target: loop.redact(cut(raw.arguments?.target ?? raw.arguments?.url ?? raw.arguments?.path ?? raw.command, 500)),
      input: summary(row.input ?? raw.arguments ?? raw.command, `${id}/input`),
      output: summary(row.output ?? raw.result ?? row.text, `${id}/output`),
    };
  });
  const data = {
    threadId,
    items,
    images,
    limitation: '原生记录快照不等于执行成功或验收通过；reference_only图片不含文件副本。',
  };
  const serialized = JSON.stringify(data);
  if (Buffer.byteLength(serialized) > 512 * 1024) throw new APIError(413, '原生证据超过512 KiB');
  return {
    source: items
      .map((i) => `${i.tool}${i.target ? ` · ${i.target}` : ''}`)
      .join('\n')
      .slice(0, 4096),
    data,
    digest: hash(serialized),
  };
}

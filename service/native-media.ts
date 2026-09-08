import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { APIError } from './protocol.ts';
import type { Store } from './store.ts';

const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_BATCH = 20 * 1024 * 1024;
type Attachment = { id: string; channelId: string; name: string; mimeType: string; path: string; dataUrl: string; sha256: string; createdAt: string; source: 'upload' | 'native' };
function imageType(bytes: Buffer): { mime: string; extension: string } {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { mime: 'image/png', extension: 'png' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { mime: 'image/jpeg', extension: 'jpg' };
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return { mime: 'image/gif', extension: 'gif' };
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp', extension: 'webp' };
  throw new APIError(400, '请选择 PNG、JPEG、WebP 或 GIF 图片');
}
function readImage(path: string): Buffer {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new APIError(400, '图片路径无效');
  const resolved = realpathSync(path), info = statSync(resolved);
  if (!info.isFile() || info.size > MAX_IMAGE) throw new APIError(413, '每张图片最多 10 MB');
  const bytes = readFileSync(resolved);
  if (bytes.length > MAX_IMAGE) throw new APIError(413, '每张图片最多 10 MB');
  imageType(bytes);
  return bytes;
}
function ensureChannel(store: Store, channelId: string): void {
  const channel = store.get('channels', channelId);
  if (!channel || channel.runtime !== 'codex' || store.get('projects', channel.projectId)?.isDemo) throw new APIError(404, '原生频道不存在');
}
export function importNativeImages(store: Store, home: string, channelId: string, paths: string[]) {
  ensureChannel(store, channelId);
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 5) throw new APIError(400, '一次请选择 1 至 5 张图片');
  const images = paths.map(path => ({ name: basename(path), bytes: readImage(path) }));
  if (images.reduce((sum, image) => sum + image.bytes.length, 0) > MAX_BATCH) throw new APIError(413, '一批图片总大小最多 20 MB');
  const directory = join(home, 'native-images');
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  return images.map(({ name, bytes }) => {
    const id = randomUUID(), type = imageType(bytes), path = join(directory, `${id}.${type.extension}`);
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
    const row: Attachment = { id, channelId, name, mimeType: type.mime, path, dataUrl: `data:${type.mime};base64,${bytes.toString('base64')}`, sha256: createHash('sha256').update(bytes).digest('hex'), createdAt: new Date().toISOString(), source: 'upload' };
    store.put('native_attachments', row);
    return { id, name, mimeType: type.mime, previewUrl: row.dataUrl };
  });
}
export function resolveNativeAttachments(store: Store, channelId: string, attachments: Array<{ id: string }> = []): Array<{ path: string }> {
  ensureChannel(store, channelId);
  if (!Array.isArray(attachments) || attachments.length > 5 || new Set(attachments.map(value => value?.id)).size !== attachments.length) throw new APIError(400, '图片附件列表无效');
  return attachments.map(value => {
    const row = typeof value?.id === 'string' ? store.get<Attachment>('native_attachments', value.id) : undefined;
    if (!row || row.channelId !== channelId || row.source !== 'upload') throw new APIError(404, '图片附件不属于此频道');
    const bytes = readImage(row.path);
    if (createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw new APIError(409, '图片附件已改变，请重新添加');
    return { path: row.path };
  });
}
export function readNativeImage(store: Store, channelId: string, itemId: string, index: number): { dataUrl: string } {
  ensureChannel(store, channelId);
  const binding = store.get('native_bindings', channelId), item = store.get('native_items', itemId);
  if (!binding || !item || item.threadId !== binding.threadId || !item.present || !Number.isInteger(index) || index < 0 || index > 100) throw new APIError(404, '图片不属于当前原生对话');
  const part = (item.raw?.type === 'steeringUserMessage' ? item.raw.input : item.raw?.content)?.[index];
  if (!part || !['image', 'localImage'].includes(part.type)) throw new APIError(404, '此消息内容不是图片');
  const key = createHash('sha256').update(`${channelId}:${itemId}:${index}:${JSON.stringify(part)}`).digest('hex');
  const cached = store.get<Attachment>('native_attachments', key);
  if (cached) return { dataUrl: cached.dataUrl };
  const source = part.path ?? part.image_url ?? part.url;
  let bytes: Buffer;
  if (typeof source === 'string' && source.startsWith('data:')) {
    const match = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(source);
    if (!match || match[1].length > Math.ceil(MAX_IMAGE / 3) * 4) throw new APIError(413, '图片内容格式无效或超过 10 MB');
    bytes = Buffer.from(match[1], 'base64');
  } else if (part.type === 'localImage' && typeof source === 'string') {
    try { bytes = readImage(source); } catch (error) { if (error instanceof APIError) throw error; throw new APIError(404, '原生图片文件暂时不可用，请在 Codex App 中查看'); }
  } else throw new APIError(409, '此图片由 Codex App 托管，请在 App 中查看');
  const type = imageType(bytes), dataUrl = `data:${type.mime};base64,${bytes.toString('base64')}`;
  store.put('native_attachments', { id: key, channelId, name: '原生图片', mimeType: type.mime, path: '', dataUrl, sha256: createHash('sha256').update(bytes).digest('hex'), createdAt: new Date().toISOString(), source: 'native' });
  return { dataUrl };
}

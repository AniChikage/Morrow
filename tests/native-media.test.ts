import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../service/store.ts';
import { importNativeImages, readNativeImage, resolveNativeAttachments } from '../service/native-media.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jTfoAAAAASUVORK5CYII=', 'base64');
function fixture(t: any) {
  const home = mkdtempSync(join(tmpdir(), 'morrow-media-')), store = new Store(join(home, 'workspace.sqlite'));
  t.after(() => { store.db.close(); rmSync(home, { recursive: true, force: true }); });
  store.put('projects', { id: 'project', isDemo: false });
  for (const id of ['channel', 'other']) store.put('channels', { id, projectId: 'project', runtime: 'codex' });
  const path = join(home, 'chosen.png'); writeFileSync(path, png);
  return { home, store, path };
}
test('selected native images persist immutable private copies and full database content', t => {
  const { home, store, path } = fixture(t), [image] = importNativeImages(store, home, 'channel', [path]);
  rmSync(path);
  const [native] = resolveNativeAttachments(store, 'channel', [image]);
  assert.deepEqual(readFileSync(native.path), png);
  assert.equal(image.previewUrl, store.get('native_attachments', image.id).dataUrl);
  assert.throws(() => resolveNativeAttachments(store, 'other', [image]), /不属于/);
  assert.throws(() => resolveNativeAttachments(store, 'channel', [image, image]), /无效/);
  writeFileSync(native.path, Buffer.concat([png, Buffer.from('changed')]));
  assert.throws(() => resolveNativeAttachments(store, 'channel', [image]), /已改变/);
});
test('native images are scoped to the current bound item and cached for offline history', t => {
  const { store, path } = fixture(t);
  store.put('native_bindings', { id: 'channel', threadId: 'thread' });
  store.put('native_items', { id: 'item', threadId: 'thread', present: true, raw: { content: [{ type: 'text', text: 'image' }, { type: 'localImage', path }] } });
  const first = readNativeImage(store, 'channel', 'item', 1);
  assert.equal(first.dataUrl, `data:image/png;base64,${png.toString('base64')}`);
  rmSync(path);
  assert.deepEqual(readNativeImage(store, 'channel', 'item', 1), first);
  assert.throws(() => readNativeImage(store, 'other', 'item', 1), /不属于/);
  assert.throws(() => readNativeImage(store, 'channel', 'item', 0), /不是图片/);
  store.put('native_items', { id: 'steered-image', threadId: 'thread', present: true, raw: { type: 'steeringUserMessage', input: [{ type: 'image', image_url: first.dataUrl }] } });
  assert.deepEqual(readNativeImage(store, 'channel', 'steered-image', 0), first);
  store.put('native_bindings', { id: 'channel', threadId: 'different' });
  assert.throws(() => readNativeImage(store, 'channel', 'item', 1), /不属于/);
});
test('image imports reject non-images, excessive batches and do not accept arbitrary renderer paths', t => {
  const { home, store, path } = fixture(t);
  assert.throws(() => importNativeImages(store, home, 'channel', Array(6).fill(path)), /1 至 5/);
  writeFileSync(path, 'not an image');
  assert.throws(() => importNativeImages(store, home, 'channel', [path]), /PNG/);
  assert.throws(() => resolveNativeAttachments(store, 'channel', [{ id: path }]), /不属于/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { exportHandoff } from './export.js';

const records = [
  { id: 'h1', title: '交接一', body: 'x'.repeat(150) },
  { id: 'h2', title: '交接二', body: 'y'.repeat(20) },
];

test('导出的记录条数与输入一致', () => {
  assert.equal(exportHandoff(records).count, 2);
});

test('正文完整保留，顺序和 ID 不变', () => {
  const items = exportHandoff(records).items;
  assert.deepEqual(
    items.map((item) => item.id),
    ['h1', 'h2']
  );
  assert.equal(items[0].body.length, 150);
});

test('导出不修改输入', () => {
  const copy = structuredClone(records);
  exportHandoff(records);
  assert.deepEqual(records, copy);
});

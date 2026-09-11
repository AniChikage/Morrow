import test from 'node:test';
import assert from 'node:assert/strict';
import { exportHandoff } from './export.js';

test('导出的记录条数与输入一致', () => {
  const records = [
    { id: 'h1', title: '交接一', body: 'x'.repeat(150) },
    { id: 'h2', title: '交接二', body: 'y'.repeat(20) },
  ];
  assert.equal(exportHandoff(records).count, 2);
});

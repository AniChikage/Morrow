import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBrief } from './brief.js';

test('材料齐全时每条材料生成一节', () => {
  const brief = buildBrief([
    { id: 'n1', kind: '背景', text: '现场记录一' },
    { id: 'n2', kind: '结论', text: '现场记录二' },
  ]);
  assert.equal(brief.ready, true);
  assert.equal(brief.count, 2);
});

test('材料不足时说明缺什么，不生成简报', () => {
  const brief = buildBrief([{ id: 'n1', kind: '背景', text: '现场记录一' }]);
  assert.deepEqual(brief, { ready: false, missing: ['结论'], sections: [], count: 0 });
});

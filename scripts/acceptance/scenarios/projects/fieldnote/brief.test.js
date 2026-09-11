import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBrief } from './brief.js';

test('每条材料生成一节', () => {
  const brief = buildBrief([{ id: 'n1', text: '现场记录一' }, { id: 'n2', text: '现场记录二' }]);
  assert.equal(brief.count, 2);
});

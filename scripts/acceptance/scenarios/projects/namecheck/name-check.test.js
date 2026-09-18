import test from 'node:test';
import assert from 'node:assert/strict';
import { checkName } from './name-check.js';

test('ASCII 名称可用', () => {
  assert.deepEqual(checkName('Ops Team'), { ok: true, name: 'Ops Team' });
});

test('超过长度上限的名称被拒绝', () => {
  assert.equal(checkName('x'.repeat(33)).reason, 'too_long');
});

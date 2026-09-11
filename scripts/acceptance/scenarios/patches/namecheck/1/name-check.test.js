import test from 'node:test';
import assert from 'node:assert/strict';
import { checkName } from './name-check.js';

test('ASCII 名称可用', () => {
  assert.deepEqual(checkName('Ops Team'), { ok: true, name: 'Ops Team' });
});

test('超过长度上限的名称被拒绝', () => {
  assert.equal(checkName('x'.repeat(33)).reason, 'too_long');
});

test('国际化名称不再被整段拒绝', () => {
  assert.equal(checkName('运维小组').ok, true);
  assert.equal(checkName('Équipe').ok, true);
});

test('只有空白的名字被拒绝', () => {
  assert.equal(checkName('   ').reason, 'blank');
});

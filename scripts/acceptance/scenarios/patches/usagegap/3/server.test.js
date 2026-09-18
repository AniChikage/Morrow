import test from 'node:test';
import assert from 'node:assert/strict';
import { pages, route } from './app.js';
import { usage } from './usage.js';

// 种子版本只断言在每个补丁上同样成立的行为；每个补丁自己再加一条对应那次修复的回归断言。

test('首页、五个功能页和使用数据都能路由到', () => {
  assert.equal(route('/').status, 200);
  assert.equal(route('/usage').status, 200);
  for (const id of Object.keys(pages)) assert.equal(route(`/f/${id}`).status, 200, id);
  assert.equal(route('/f/nothing').status, 404);
});

test('使用数据的五个功能都带齐口径字段', () => {
  assert.deepEqual(Object.keys(usage.features).sort(), Object.keys(pages).sort());
  for (const [id, row] of Object.entries(usage.features)) {
    assert.equal(typeof row.visits, 'number', id);
    assert.equal(typeof row.completionRate, 'number', id);
    assert.equal(typeof row.abandonStep, 'number', id);
    assert.equal(typeof row.askedFor, 'boolean', id);
    assert.equal(typeof row.emptyStateNextAction, 'boolean', id);
    assert.equal(typeof row.copyMatchesBehaviour, 'boolean', id);
  }
});

test('使用数据里的 /usage 就是端点返回的内容', () => {
  assert.deepEqual(JSON.parse(route('/usage').body), usage);
});

test('补丁 1：首页直接给出批量导出的入口', () => {
  assert.match(route('/').body, /href="\/f\/bulkexport"/);
});

test('补丁 2：归档看板的空状态带下一步', () => {
  const body = route('/f/archive').body;
  assert.match(body, /还没有归档内容/);
  assert.match(body, /href="\/f\/handover"/);
});

test('补丁 3：合法的 CSV 能走过第二步', () => {
  const file = pages.handover.pickFile('交接单.csv');
  assert.deepEqual(pages.handover.mapFields(file), { ok: true, fields: ['交接人', '事项', '截止时间'] });
  assert.equal(pages.handover.mapFields({ name: '交接单.TXT' }).ok, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { auditBrief, buildBrief } from './brief.js';

const notes = [
  { id: 'n1', kind: '背景', text: '现场记录一' },
  { id: 'n2', kind: '结论', text: '现场记录二' },
];

test('材料齐全时每条材料生成一节', () => {
  const brief = buildBrief(notes);
  assert.equal(brief.ready, true);
  assert.equal(brief.count, 2);
});

test('材料不足时说明缺什么，不生成简报', () => {
  const brief = buildBrief([{ id: 'n1', kind: '背景', text: '现场记录一' }]);
  assert.deepEqual(brief, { ready: false, missing: ['结论'], sections: [], count: 0 });
});

test('每一节都带上原始材料 ID', () => {
  assert.deepEqual(
    buildBrief(notes).sections.map((section) => section.source),
    ['n1', 'n2']
  );
});

test('证据审计只认能回到原文的结论', () => {
  const brief = buildBrief(notes);
  assert.deepEqual(auditBrief(brief, notes), { deliverable: true, unsourced: [] });
  assert.equal(auditBrief(brief, [notes[0]]).deliverable, false);
});

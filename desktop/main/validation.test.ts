import { test } from 'vitest';
import assert from 'node:assert/strict';
import { channelInput, channelPatch, connectionConfig, eventsInput, externalURL, id, itemInput, itemPatch, projectInput, runOutputInput, runsInput } from './validation.ts';

test('IPC IDs cannot inject routes or query parameters', () => {
  for (const value of ['../state', 'id?action=resume', 'id/events', '', {}, 'id\0']) assert.throws(() => id(value));
  assert.equal(id('a0b1-2c3d'), 'a0b1-2c3d');
});
test('only HTTP(S) web links without credentials leave the app', () => {
  for (const value of ['file:///etc/passwd', 'javascript:alert(1)', 'nohuman://app/index.html', 'https://user:secret@example.com']) assert.throws(() => externalURL(value));
  assert.equal(externalURL('https://example.com/a?x=1'), 'https://example.com/a?x=1');
});
test('SSH destinations and directories reject argument and command injection', () => {
  const config = { mode: 'ssh', host: 'dev-box', port: 43821, directory: '~/.local/share/nohuman' };
  assert.deepEqual(connectionConfig(config), config);
  for (const host of ['-oProxyCommand=anything', 'dev box', 'dev;touch /tmp/x', 'dev\nbox']) assert.throws(() => connectionConfig({ ...config, host }));
  for (const directory of ['relative/path', '~/test\nwhoami']) assert.throws(() => connectionConfig({ ...config, directory }));
  assert.throws(() => connectionConfig({ ...config, port: 70000 }));
  assert.throws(() => connectionConfig({ ...config, token: 'must-not-be-accepted' }));
});
test('channel inputs preserve supported settings and reject arbitrary fields', () => {
  assert.deepEqual(channelInput({ projectId: 'project-1', name: '检查', goal: '验证项目', runtime: 'codex' }), { projectId: 'project-1', name: '检查', goal: '验证项目', runtime: 'codex' });
  for (const value of [{ runtime: 'shell' }, { permission: 'danger-full-access' }, { maxRunsPerDay: 0 }, { intervalMinutes: 0 }, { model: '--dangerous' }, { sessionId: 'foreign-session' }]) assert.throws(() => channelPatch(value));
  assert.throws(() => projectInput({ name: '项目', path: '/tmp', goal: '目标', isDemo: true }));
});
test('event pagination is bounded and accepts only a single direction', () => {
  assert.deepEqual(eventsInput({ channelId: 'channel-1', before: 'event-2', limit: 100 }), { channelId: 'channel-1', before: 'event-2', limit: 100 });
  assert.throws(() => eventsInput({ channelId: 'channel-1', before: 'event-1', after: 'event-2' }));
  assert.equal(eventsInput({ channelId: 'channel-1', limit: 200 }).limit, 200);
  assert.throws(() => eventsInput({ channelId: 'channel-1', limit: 201 }));
  assert.throws(() => eventsInput({ channelId: 'channel-1', endpoint: 'anything' }));
});

test('human item creation accepts explicit project scope but cannot forge identity or audit origin', () => {
  assert.deepEqual(itemInput({ projectId: 'project-1', title: '  统一项目看板  ', kind: 'feature', channelId: '', summary: '' }), { projectId: 'project-1', title: '统一项目看板', kind: 'feature', channelId: '', summary: '' });
  assert.equal(itemInput({ projectId: 'project-1', channelId: 'channel-1', title: '来源频道' }).channelId, 'channel-1');
  for (const field of ['id', 'number', 'revision', 'sourceChannelIds', 'lastRunId', 'createdAt', 'updatedAt', 'actor', 'action', 'changes']) {
    assert.throws(() => itemInput({ projectId: 'project-1', title: '合法标题', [field]: 'forged' }), field);
  }
  for (const value of [{ title: '缺少项目' }, { projectId: 'project-1', summary: '缺少标题' }, { projectId: '../project', title: '非法项目' }, { projectId: 'project-1', channelId: '../channel', title: '非法频道' }]) assert.throws(() => itemInput(value));
});

test('item patches cannot move project/channel ownership or replace persisted provenance', () => {
  assert.deepEqual(itemPatch({ title: '新标题', status: 'verified', revision: 2, evidence: [] }), { title: '新标题', status: 'verified', revision: 2, evidence: [] });
  for (const field of ['projectId', 'channelId', 'sourceChannelIds', 'lastRunId', 'number', 'id', 'createdAt', 'updatedAt', 'actor', 'action', 'changes']) {
    assert.throws(() => itemPatch({ title: '合法标题', [field]: 'forged' }), field);
  }
  for (const value of [{}, { revision: 2 }, { title: '' }, { status: 'published' }, { kind: 'shell' }, { title: '新标题', revision: 0 }, { title: '新标题', revision: 1.5 }, { title: '新标题', revision: Number.MAX_SAFE_INTEGER + 1 }]) assert.throws(() => itemPatch(value));
});

test('item text and evidence bounds match daemon acceptance limits', () => {
  const boundaries = { title: 'x'.repeat(300), summary: 'x'.repeat(10000), nextStep: 'x'.repeat(5000), evidence: Array.from({ length: 50 }, () => 'x'.repeat(5000)) };
  assert.deepEqual(itemPatch(boundaries), boundaries);
  assert.deepEqual(itemPatch({ summary: '', nextStep: '', evidence: [] }), { summary: '', nextStep: '', evidence: [] });
  for (const value of [{ title: 'x'.repeat(301) }, { summary: 'x'.repeat(10001) }, { nextStep: 'x'.repeat(5001) }, { evidence: Array(51).fill('evidence') }, { evidence: ['x'.repeat(5001)] }, { evidence: [''] }, { evidence: [null] }, { evidence: [{ text: 'object' }] }, { evidence: 'not an array' }]) assert.throws(() => itemPatch(value));
});

test('project runtime selection remains an enum and cannot add native launch parameters', () => {
  assert.equal(projectInput({ name: '项目', path: '/tmp/project', goal: '目标', runtime: 'claude' }).runtime, 'claude');
  assert.throws(() => projectInput({ name: '项目', path: '/tmp/project', goal: '目标', runtime: 'bash' }));
  assert.throws(() => projectInput({ name: '项目', path: '/tmp/project', goal: '目标', executable: '/bin/bash' }));
});

test('event scopes accept project/channel/item/run intersections but never arbitrary searches', () => {
  const query = { projectId: 'project-1', channelId: 'channel-1', itemId: 'item-1', runId: 'run-1', after: 'event-1', limit: 200 };
  assert.deepEqual(eventsInput(query), query);
  assert.deepEqual(eventsInput({ projectId: 'project-1', itemId: 'item-1' }), { projectId: 'project-1', itemId: 'item-1' });
  for (const value of [{}, { itemId: 'item-1' }, { runId: 'run-1' }, { projectId: 'project-1', query: 'full text' }, { projectId: 'project-1', itemId: '../other' }, { projectId: 'project-1', after: 'event&limit=999' }, { projectId: 'project-1', limit: 0 }, { projectId: 'project-1', limit: '50' }]) assert.throws(() => eventsInput(value));
});

test('run history and output queries are bounded and cannot read arbitrary files or streams', () => {
  assert.deepEqual(runsInput({}), {});
  assert.deepEqual(runsInput({ projectId: 'project-1', channelId: 'channel-1', before: 'run-2', limit: 200 }), { projectId: 'project-1', channelId: 'channel-1', before: 'run-2', limit: 200 });
  assert.deepEqual(runOutputInput({ after: 'chunk-1', limit: 100 }), { after: 'chunk-1', limit: 100 });
  assert.deepEqual(runOutputInput({}), {});
  for (const value of [{ limit: 201 }, { limit: -1 }, { limit: 1.5 }, { before: 'run-1', after: 'run-2' }, { projectId: 'project/other' }, { itemId: 'item-1' }, { search: 'all text' }, { path: '/etc/passwd' }]) assert.throws(() => runsInput(value));
  for (const value of [{ limit: 101 }, { limit: 0 }, { limit: '50' }, { before: 'chunk-1' }, { after: '../../file' }, { path: '/etc/passwd' }, { stream: 'token' }, { fullText: true }, { offset: 9999999 }]) assert.throws(() => runOutputInput(value));
});

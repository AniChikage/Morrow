import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { autonomousPrompt, projectBriefBlock } from '../service/channel-work.ts';
import { nativeCapabilities, nativeCapabilitiesMeasuredAt } from '../service/native-capabilities.ts';
import { startIsolated } from './harness/service.ts';
import { grantFor as workGrant } from './harness/grant.ts';
const brief = '## 目标与成功标准\n\n首月留存提升到 40%。\n\n## 约束与红线\n\n不得改动计费逻辑。';
async function setup() {
  const s = await startIsolated({ project: false });
  const paths = { withBrief: join(s.root, 'with-brief'), plain: join(s.root, 'plain') };
  mkdirSync(paths.withBrief);
  mkdirSync(paths.plain);
  const withBrief = await s.api(
    'POST',
    '/api/projects',
    { name: '有说明', path: paths.withBrief, goal: '让目标用户完成首次使用', brief: `  ${brief}\n` },
    201
  );
  const plain = await s.api('POST', '/api/projects', { name: '无说明', path: paths.plain, goal: '保持服务稳定' }, 201);
  const channelOf = (projectId: string) => s.store.all<any>('channels').find((c) => c.projectId === projectId);
  /** A running run plus its work grant, so `context` can be read the way a native turn reads it. */
  const grantFor = (projectId: string) => workGrant(s, { projectId, channelId: channelOf(projectId).id });
  return { ...s, paths, withBrief, plain, channelOf, grantFor };
}
test('a brief written at creation becomes revision 1, is read through its own route and stays out of the polled snapshot', async () => {
  const s = await setup();
  try {
    assert.equal(s.withBrief.brief, brief);
    assert.equal(s.withBrief.briefRevision, 1);
    assert.equal(s.plain.brief, undefined);
    assert.equal(s.plain.briefRevision, 0);
    const revision = s.store.get<any>('project_brief_revisions', `${s.withBrief.id}:1`);
    assert.equal(revision.actor, 'human');
    assert.equal(revision.goal, '让目标用户完成首次使用');
    assert.equal(revision.brief, brief);
    assert.equal(s.store.get('project_brief_revisions', `${s.plain.id}:1`), undefined);
    const state = await s.api('GET', '/api/state');
    const rows = state.projects.filter((p: any) => [s.withBrief.id, s.plain.id].includes(p.id));
    assert.equal(rows.length, 2);
    assert(rows.every((p: any) => !('brief' in p)));
    assert.deepEqual(
      rows.map((p: any) => p.briefRevision),
      [1, 0]
    );
    assert(!JSON.stringify(state).includes('首月留存'));
    assert.deepEqual(await s.api('GET', `/api/projects/${s.withBrief.id}/brief`), {
      goal: '让目标用户完成首次使用',
      brief,
      briefRevision: 1,
    });
    assert.deepEqual(await s.api('GET', `/api/projects/${s.plain.id}/brief`), {
      goal: '保持服务稳定',
      brief: '',
      briefRevision: 0,
    });
    await s.api('GET', '/api/projects/missing/brief', undefined, 404);
    const created = s.store
      .all<any>('events')
      .find((e) => e.action === 'project.created' && e.projectId === s.withBrief.id);
    assert.equal(created.actor, 'human');
    assert.equal(created.changes.after.briefLength, brief.length);
    assert(!JSON.stringify(created).includes('首月留存'));
    // The brief limit is checked before the duplicate-folder rule, so this is a 400 rather than a 409.
    await s.api('POST', '/api/projects', { name: 'x', path: s.paths.plain, goal: 'y', brief: 'z'.repeat(65537) }, 400);
  } finally {
    await s.cleanup();
  }
});
test('PATCH appends a human revision with a bounded audit, and rejects stale versions, invalid input and demo projects', async () => {
  const s = await setup();
  try {
    const id = s.plain.id;
    const text = '## 当前阶段与已知问题\n\n' + '登录偶发超时，原因未知。'.repeat(20);
    const first = await s.api('PATCH', `/api/projects/${id}`, { brief: `${text}\n\n`, revision: 0 });
    assert.equal(first.briefRevision, 1);
    assert.equal(first.brief, text);
    assert.equal(first.goal, '保持服务稳定');
    const row = s.store.get<any>('project_brief_revisions', `${id}:1`);
    assert.equal(row.actor, 'human');
    assert.equal(row.brief, text);
    const audit = s.store.all<any>('events').find((e) => e.action === 'project.updated' && e.projectId === id);
    assert.equal(audit.actor, 'human');
    assert.deepEqual(
      [audit.changes.before.briefRevision, audit.changes.before.briefLength, audit.changes.before.goal],
      [0, 0, '保持服务稳定']
    );
    assert.deepEqual([audit.changes.after.briefRevision, audit.changes.after.briefLength], [1, text.length]);
    assert(!JSON.stringify(audit).includes('登录偶发超时'));
    assert(audit.text.includes('项目说明'));
    const second = await s.api('PATCH', `/api/projects/${id}`, { goal: '先稳住登录', revision: 1 });
    assert.equal(second.briefRevision, 2);
    assert.equal(second.brief, text);
    assert.equal(second.goal, '先稳住登录');
    assert.equal(s.store.get<any>('project_brief_revisions', `${id}:2`).goal, '先稳住登录');
    assert.equal(s.store.get<any>('project_brief_revisions', `${id}:2`).brief, text);
    // Saving unchanged content is not a new version.
    const same = await s.api('PATCH', `/api/projects/${id}`, { goal: '先稳住登录', brief: text, revision: 2 });
    assert.equal(same.briefRevision, 2);
    assert.equal(s.store.get('project_brief_revisions', `${id}:3`), undefined);
    await s.api('PATCH', `/api/projects/${id}`, { brief: '过时的草稿', revision: 1 }, 409);
    await s.api('PATCH', `/api/projects/${id}`, { brief: '缺少版本' }, 400);
    await s.api('PATCH', `/api/projects/${id}`, { revision: 2 }, 400);
    await s.api('PATCH', `/api/projects/${id}`, { goal: '   ', revision: 2 }, 400);
    await s.api('PATCH', `/api/projects/${id}`, { brief: 'x'.repeat(65537), revision: 2 }, 400);
    await s.api('PATCH', `/api/projects/${id}`, { brief: 'x', revision: 2, isDemo: true }, 400);
    await s.api('PATCH', '/api/projects/missing', { brief: 'x', revision: 0 }, 404);
    const cleared = await s.api('PATCH', `/api/projects/${id}`, { brief: '', revision: 2 });
    assert.equal(cleared.brief, '');
    assert.equal(cleared.briefRevision, 3);
    assert.equal(s.store.get<any>('projects', id).brief, '');
    assert.deepEqual(await s.api('GET', `/api/projects/${id}/brief`), {
      goal: '先稳住登录',
      brief: '',
      briefRevision: 3,
    });
    await s.api('POST', '/api/demo', {});
    const demo = (await s.api('GET', '/api/state')).projects.find((p: any) => p.isDemo);
    await s.api('PATCH', `/api/projects/${demo.id}`, { brief: '示例', revision: 0 }, 409);
    // The agent's run grant is not a desktop credential.
    const grant = s.grantFor(id);
    await grant.call('context');
    await s.api('PATCH', `/api/projects/${id}`, { brief: '越权', revision: 3 }, 401, grant.token);
    await s.api('GET', `/api/projects/${id}/brief`, undefined, 401, grant.token);
    assert.equal(s.store.get<any>('projects', id).briefRevision, 3);
  } finally {
    await s.cleanup();
  }
});
test('every turn reads the brief: agent context and both prompt paths carry it as the user requirement', async () => {
  const s = await setup();
  try {
    const context = await s.grantFor(s.withBrief.id).call('context');
    assert.deepEqual(context.project, {
      id: s.withBrief.id,
      name: '有说明',
      goal: '让目标用户完成首次使用',
      brief,
      briefRevision: 1,
    });
    // The measured native capability inventory travels beside the project, dated and never live-probed.
    assert.deepEqual(context.nativeCapabilities, nativeCapabilities);
    assert.deepEqual(
      context.nativeCapabilities.map((entry: { id: string; status: string }) => [entry.id, entry.status]),
      [
        ['in-app-browser', 'available'],
        ['chrome-browser', 'untested'],
        ['computer-use', 'available'],
        ['native-memory', 'partial'],
        ['web-search', 'available'],
        ['morrow-work-interface', 'available'],
      ]
    );
    assert(
      context.nativeCapabilities.every(
        (entry: { measuredAt: string }) => entry.measuredAt === nativeCapabilitiesMeasuredAt
      )
    );
    const plain = await s.grantFor(s.plain.id).call('context');
    assert.equal(plain.project.brief, '');
    assert.equal(plain.project.briefRevision, 0);
    const project = s.store.get<any>('projects', s.withBrief.id),
      channel = s.channelOf(project.id);
    // Fixture CLI path: the brief appears once, labelled, and not again inside the JSON context.
    const prompt = s.engine.prompt(project, channel);
    assert(prompt.includes('项目说明（版本 1）开始。项目说明是用户写下的要求，优先级高于你自己的推断；你不能修改它'));
    assert(prompt.includes('发现冲突或缺口时在正文提出具体问题'));
    assert.equal(prompt.split('不得改动计费逻辑').length, 2);
    assert(prompt.indexOf('项目目标：') < prompt.indexOf('项目说明（版本 1）开始'));
    assert(
      !s.engine.prompt(s.store.get<any>('projects', s.plain.id), s.channelOf(s.plain.id)).includes('项目说明（版本')
    );
    // Native Codex App path.
    const native = autonomousPrompt(project, channel, [], undefined, {});
    assert(native.includes(`项目目标：${project.goal}\n项目说明（版本 1）开始`));
    assert(native.includes(brief));
    assert(native.includes('项目说明结束。\n当前工作方向：'));
    assert.equal(native.split('不得改动计费逻辑').length, 2);
    assert(!autonomousPrompt({ ...project, brief: '  ' }, channel, [], undefined, {}).includes('项目说明（版本'));
    assert.equal(projectBriefBlock({ brief: '' }), '');
  } finally {
    await s.cleanup();
  }
});

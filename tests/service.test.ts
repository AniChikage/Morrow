import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Store } from '../service/store.ts';
import { eventHistory } from '../service/event-history.ts';
import { startServer } from '../service/server.ts';
import { invocation, diagnoseFailure } from '../service/runtimes.ts';
import { validateResult } from '../service/protocol.ts';
import { startIsolated } from './harness/service.ts';
import { until } from './harness/wait.ts';
const fixture = resolve('tests/fixtures/runtime.mjs');
async function setup() {
  const s = await startIsolated({ project: { name: 'Test Project', goal: '验证完整项目循环' } });
  const state = await s.api('GET', '/api/state');
  const channels = state.channels;
  assert.equal(channels.length, 1);
  assert.equal(channels[0].name, '自主推进');
  channels.push(
    await s.api(
      'POST',
      '/api/channels',
      {
        projectId: s.project.id,
        name: '独立验收职责',
        goal: '验证共享项目上下文',
        runtime: 'codex',
        permission: 'workspace-write',
      },
      201
    )
  );
  const config = (value: any) => writeFileSync(join(s.path, '.fixture.json'), JSON.stringify(value));
  return { ...s, projectPath: s.path, channels, config };
}
test('local auth, schema validation, paused defaults and idempotent explicit demo', async () => {
  const s = await setup();
  try {
    assert.deepEqual(await (await fetch(s.base + '/health')).json(), {
      ok: true,
      service: 'morrow',
    });
    assert.equal((await fetch(s.base + '/api/state')).status, 401);
    assert.equal(statSync(join(s.home, 'token')).mode & 0o777, 0o600);
    assert.equal(
      (
        await fetch(s.base + '/api/state', {
          headers: {
            Authorization: `Bearer ${s.token}`,
            Origin: 'https://example.com',
          },
        })
      ).status,
      403
    );
    assert(s.channels.every((c: any) => c.status === 'paused' && c.sessionId === ''));
    assert.equal(s.channels[0].permission, 'native');
    assert.equal(s.channels[1].permission, 'workspace-write');
    await s.api('POST', '/api/projects', { name: 'Again', path: s.projectPath, goal: 'Duplicate' }, 409);
    await s.api('PATCH', `/api/channels/${s.channels[0].id}`, { model: '--dangerous' }, 400);
    await s.api('PATCH', `/api/channels/${s.channels[0].id}`, { maxRunsPerDay: 0 }, 400);
    await s.api('POST', '/api/channels', { projectId: s.project.id, name: 'A', goal: 'B', runtime: 'unknown' }, 400);
    await s.api('POST', '/api/channels', { projectId: s.project.id, name: 'A', goal: 'B', runtime: 'claude' }, 400);
    await s.api('POST', '/api/demo', {});
    await s.api('POST', '/api/demo', {});
    const state = await s.api('GET', '/api/state');
    assert.equal(state.projects.filter((p: any) => p.isDemo).length, 1);
    assert(state.items.every((i: any) => i.evidence.length));
    const demo = state.channels.find((c: any) => c.projectId !== s.project.id);
    await s.api('POST', `/api/channels/${demo.id}/action`, { action: 'run' }, 409);
    assert(!JSON.stringify(state).includes(s.token));
  } finally {
    await s.cleanup();
  }
});
test('one-shot persists valid results, shared sourced knowledge, messages, native resume and engine handoff', async () => {
  const s = await setup();
  try {
    const c = s.channels[0];
    await s.api('PATCH', `/api/channels/${c.id}`, { permission: 'read-only' });
    await s.api('POST', `/api/channels/${c.id}/messages`, { text: '请重点检查导入流程' }, 201);
    await s.api('POST', `/api/channels/${c.id}/action`, { action: 'run' });
    await until(() => s.store.all<any>('runs').find((r) => r.status === 'completed'));
    let state = await s.api('GET', '/api/state');
    assert.equal(state.channels[0].status, 'paused');
    assert.equal(state.channels[0].sessionId, 'fixture-session-1');
    assert.equal(state.items.length, 1);
    assert.equal(s.store.all('results').length, 1);
    const capture = JSON.parse(readFileSync(join(s.projectPath, '.fixture-capture.json'), 'utf8'));
    assert(capture.input.includes('请重点检查导入流程'));
    assert(capture.args.includes('sandbox_mode="read-only"'));
    assert(s.engine.prompt(s.project, s.channels[1]).includes('共享确认事实'));
    assert(!s.engine.prompt(s.project, s.channels[1]).includes('未验证的猜想'));
    assert(s.store.all<any>('knowledge').every((k) => k.source && k.createdAt));
    await s.api('POST', `/api/channels/${c.id}/action`, { action: 'run' });
    await until(() => s.store.all<any>('runs').filter((r) => r.status === 'completed').length === 2);
    assert(JSON.parse(readFileSync(join(s.projectPath, '.fixture-capture.json'), 'utf8')).args.includes('resume'));
    await s.api('PATCH', `/api/channels/${c.id}`, { runtime: 'claude' }, 400);
    const updated = await s.api('PATCH', `/api/channels/${c.id}`, { model: 'gpt-5-codex' });
    assert.equal(updated.sessionId, '');
    await s.api('POST', `/api/channels/${c.id}/action`, { action: 'run' });
    await until(() => s.store.all<any>('runs').filter((r) => r.status === 'completed').length === 3);
    const nextCapture = JSON.parse(readFileSync(join(s.projectPath, '.fixture-capture.json'), 'utf8'));
    assert(!nextCapture.args.includes('resume'));
    assert(nextCapture.input.includes('Fixture 发现'));
    assert.equal(nextCapture.args[nextCapture.args.indexOf('--model') + 1], 'gpt-5-codex');
    state = await s.api('GET', '/api/state');
    assert.equal(state.runs.at(-1).runtime, 'codex');
    assert.equal(state.runs.at(-1).model, 'gpt-5-codex');
  } finally {
    await s.cleanup();
  }
});
test('successful native output without a report does not invent findings or fail execution', async () => {
  const s = await setup();
  try {
    s.config({ malformed: true });
    const c = s.channels[0];
    await s.api('POST', `/api/channels/${c.id}/action`, { action: 'run' });
    await until(() => s.store.all<any>('runs').some((r) => r.status === 'completed'));
    const state = await s.api('GET', '/api/state');
    assert.equal(state.items.length, 0);
    assert.equal(state.channels[0].status, 'paused');
    assert.equal(state.runs[0].reportStatus, 'missing');
    assert(state.runs[0].summary.includes('No structured output'));
    assert.equal(s.store.all('results').length, 0);
  } finally {
    await s.cleanup();
  }
});
test('daily budget applies to manual runs and scheduled continuation', async () => {
  const s = await setup();
  try {
    const c = s.channels[0];
    await s.api('PATCH', `/api/channels/${c.id}`, { maxRunsPerDay: 1 });
    await s.api('POST', `/api/channels/${c.id}/action`, { action: 'run' });
    await until(() => s.store.all<any>('runs').some((r) => r.status === 'completed'));
    await s.api('POST', `/api/channels/${c.id}/action`, { action: 'run' }, 429);
    await s.api('POST', `/api/channels/${c.id}/action`, { action: 'resume' });
    const current = s.store.get<any>('channels', c.id);
    assert.equal(current.status, 'waiting');
    assert(current.nextRunAt > new Date().toISOString());
    assert.equal(s.store.all('runs').length, 1);
    await s.api('POST', `/api/channels/${c.id}/action`, { action: 'pause' });
  } finally {
    await s.cleanup();
  }
});
test('project execution lock, settings guard, pause cancels complete process group', async () => {
  const s = await setup();
  try {
    s.config({ sleep: true, ignoreTerm: true });
    const [a, b] = s.channels;
    await s.api('POST', `/api/channels/${a.id}/action`, { action: 'run' });
    await until(() => existsSync(join(s.projectPath, '.fixture-child-ready')));
    const child = Number(readFileSync(join(s.projectPath, '.fixture-child.pid'), 'utf8'));
    await s.api('POST', `/api/channels/${b.id}/action`, { action: 'run' }, 409);
    await s.api('PATCH', `/api/channels/${a.id}`, { permission: 'read-only' }, 409);
    await s.api('POST', `/api/channels/${a.id}/action`, { action: 'pause' });
    await until(() => s.store.all<any>('runs').some((r) => r.status === 'interrupted'));
    await until(() => {
      try {
        process.kill(child, 0);
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(s.store.get<any>('channels', a.id).status, 'paused');
    assert.equal(s.engine.active.size, 0);
  } finally {
    await s.cleanup();
  }
});
test('channels from retired runtimes stay readable but never execute again', async () => {
  const s = await setup();
  try {
    // An old database row: a Claude channel that was still scheduled when support ended.
    const legacy = {
      id: randomUUID(),
      projectId: s.project.id,
      name: '旧 Claude 频道',
      goal: '历史职责',
      runtime: 'claude',
      model: '',
      status: 'idle',
      intervalMinutes: 60,
      maxRunsPerDay: 8,
      permission: 'workspace-write',
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      lastRunAt: '',
      sessionId: 'legacy-claude-session',
    };
    s.store.put('channels', legacy);
    s.engine.setControl(legacy.id, { enabled: true });
    const listed = (await s.api('GET', '/api/state')).channels.find((c: any) => c.id === legacy.id);
    assert.equal(listed.runtime, 'claude');
    assert.equal(listed.sessionId, 'legacy-claude-session');
    for (const action of ['run', 'resume']) {
      const rejected = await s.api('POST', `/api/channels/${legacy.id}/action`, { action }, 409);
      assert.match(rejected.error, /停止支持/);
    }
    const notices = () =>
      s.store.all<any>('events').filter((e) => e.channelId === legacy.id && e.text.includes('停止支持'));
    s.engine.tick();
    s.engine.tick();
    assert.equal(s.store.all('runs').length, 0);
    assert.equal(s.engine.control(legacy.id).enabled, false);
    const current = s.store.get<any>('channels', legacy.id);
    assert.equal(current.status, 'paused');
    assert.equal(current.nextRunAt, '');
    assert.equal(current.sessionId, 'legacy-claude-session');
    assert.equal(notices().length, 1);
    assert.equal(notices()[0].kind, 'system');
    const handoff = await s.api('POST', `/api/channels/${legacy.id}/native-handoff`, {}, 409);
    assert.match(handoff.error, /停止支持/);
    await s.api('POST', `/api/channels/${legacy.id}/action`, { action: 'pause' });
    assert.equal(s.store.get<any>('channels', legacy.id).status, 'paused');
    assert.equal(s.store.all('runs').length, 0);
    assert.equal(notices().length, 1);
    // The API keeps a deliberate migration path the desktop never sends: converting
    // the retired channel into a Codex channel in place. History must survive it.
    const preserved = s.store.all<any>('events').filter((e) => e.channelId === legacy.id);
    assert.ok(preserved.length >= 1);
    const converted = await s.api('PATCH', `/api/channels/${legacy.id}`, { runtime: 'codex' });
    assert.equal(converted.runtime, 'codex');
    assert.equal(converted.sessionId, '');
    const stored = s.store.get<any>('channels', legacy.id);
    assert.equal(stored.runtime, 'codex');
    assert.equal(stored.sessionId, '');
    assert.equal(stored.goal, '历史职责');
    const remaining = s.store.all<any>('events').filter((e) => e.channelId === legacy.id);
    for (const event of preserved) assert.ok(remaining.some((e) => e.id === event.id && e.text === event.text));
    assert.ok(remaining.some((e) => e.kind === 'system' && e.text.includes('运行时已切换为 codex')));
    // The converted channel executes again: the run request is accepted instead of the 停止支持 409.
    // Under MORROW_TEST_MODE the fixture CLI really runs, so let that run settle before pausing.
    await s.api('POST', `/api/channels/${legacy.id}/action`, { action: 'run' });
    const run = await until(() =>
      s.store.all<any>('runs').find((r) => r.channelId === legacy.id && r.status !== 'running')
    );
    assert.equal(run.runtime, 'codex');
    await s.api('POST', `/api/channels/${legacy.id}/action`, { action: 'pause' });
    assert.equal(s.store.get<any>('channels', legacy.id).status, 'paused');
  } finally {
    await s.cleanup();
  }
});
test('resume scheduling, per-project queued work, and human-needed results stop continuation', async () => {
  const s = await setup();
  try {
    const c = s.channels[0];
    await s.api('POST', `/api/channels/${c.id}/action`, { action: 'resume' });
    await until(() => s.store.all<any>('runs').some((r) => r.status === 'completed'));
    assert.equal(s.store.get<any>('channels', c.id).status, 'waiting');
    assert(s.engine.control(c.id).enabled);
    s.config({
      result: {
        summary: '需要人类提供样本数据。',
        items: [],
        nextCheckMinutes: 60,
        knowledge: [],
        needsHuman: true,
      },
    });
    s.store.put('channels', {
      ...s.store.get<any>('channels', c.id),
      nextRunAt: '2000-01-01T00:00:00.000Z',
    });
    s.engine.tick();
    await until(() => s.store.all<any>('runs').filter((r) => r.status === 'completed').length === 2);
    assert.equal(s.store.get<any>('channels', c.id).status, 'blocked');
    assert(!s.engine.control(c.id).enabled);
  } finally {
    await s.cleanup();
  }
});
test('safe adapters and evidence validation', () => {
  const channel: any = {
    runtime: 'codex',
    permission: 'read-only',
    sessionId: 'previous-session',
    model: '',
  };
  const args = invocation(channel, 'output');
  assert(args.includes('resume'));
  assert(args.includes('sandbox_mode="read-only"'));
  assert(args.includes('approval_policy="never"'));
  assert(args.includes('sandbox_workspace_write.network_access=false'));
  assert(!args.some((a) => a.includes('dangerously')));
  const native = invocation({ ...channel, permission: 'native', sessionId: '' }, 'output');
  assert(native.includes('sandbox_mode="danger-full-access"'));
  assert(!native.includes('sandbox_workspace_write.network_access=false'));
  assert.equal(native[native.indexOf('--sandbox') + 1], 'danger-full-access');
  assert.throws(() =>
    validateResult({
      summary: 'Claim',
      items: [
        {
          id: '',
          title: 'Claim',
          summary: '',
          status: 'verified',
          kind: 'issue',
          evidence: [],
          nextStep: '',
        },
      ],
      nextCheckMinutes: 1,
      knowledge: [],
      needsHuman: false,
    })
  );
});
test('restart recovers unfinished run, kills verified orphan and pauses channel', async () => {
  const root = mkdtempSync(join(tmpdir(), 'morrow-restart-'));
  const home = join(root, 'home');
  const projectPath = join(root, 'project');
  mkdirSync(projectPath);
  writeFileSync(join(projectPath, '.fixture.json'), JSON.stringify({ sleep: true }));
  let daemon: any;
  let recovered: any;
  try {
    daemon = spawn(process.execPath, ['service/server.ts'], {
      cwd: resolve('.'),
      env: { ...process.env, MORROW_HOME: home, MORROW_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    daemon.stdout.on('data', (c: any) => (output += c));
    await until(() => output.includes('listening'));
    const port = output.match(/127\.0\.0\.1:(\d+)/)![1];
    const token = readFileSync(join(home, 'token'), 'utf8');
    const api = async (path: string, data?: any) => {
      const r = await fetch(`http://127.0.0.1:${port}` + path, {
        method: data ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
      return r.json();
    };
    await api('/api/projects', {
      name: 'Recovery',
      path: projectPath,
      goal: 'Recover safely',
    });
    const state: any = await api('/api/state');
    const id = state.channels[0].id;
    await api(`/api/channels/${id}/action`, { action: 'resume' });
    await until(() => existsSync(join(projectPath, '.fixture-capture.json')));
    const pid = JSON.parse(readFileSync(join(projectPath, '.fixture-capture.json'), 'utf8')).pid;
    daemon.kill('SIGKILL');
    await new Promise((resolve) => daemon.once('close', resolve));
    daemon = undefined;
    recovered = await startServer({ home, port: 0 });
    assert.equal(recovered.store.all('runs')[0].status, 'interrupted');
    assert.equal(recovered.store.get('channels', id).status, 'paused');
    assert(!recovered.engine.control(id).enabled);
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  } finally {
    if (daemon) {
      daemon.kill('SIGKILL');
      await new Promise((resolve) => daemon.once('close', resolve));
    }
    if (recovered) await recovered.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('split UTF-8 stream preserves Chinese structured output', async () => {
  const s = await setup();
  try {
    s.config({ splitUTF8: true });
    await s.api('POST', `/api/channels/${s.channels[0].id}/action`, {
      action: 'run',
    });
    await until(() => s.store.all<any>('runs').some((r) => r.status === 'completed'));
    assert.equal(s.store.all<any>('runs')[0].summary, '中文证据完整');
  } finally {
    await s.cleanup();
  }
});

test('execution timeout interrupts and disables scheduling', async () => {
  process.env.MORROW_TEST_TIMEOUT_MS = '150';
  const s = await setup();
  try {
    s.config({ sleep: true });
    await s.api('POST', `/api/channels/${s.channels[0].id}/action`, {
      action: 'resume',
    });
    await until(() => s.store.all<any>('runs').some((r) => r.status === 'interrupted'));
    assert.equal(s.store.get<any>('channels', s.channels[0].id).status, 'paused');
    assert(!s.engine.control(s.channels[0].id).enabled);
    assert(s.store.all<any>('runs')[0].summary.includes('超时'));
  } finally {
    await s.cleanup();
    delete process.env.MORROW_TEST_TIMEOUT_MS;
  }
});

test('authentication failures are actionable and never reported as valid results', async () => {
  const s = await setup();
  try {
    s.config({ fail: true, authFailure: true });
    const c = s.channels[0];
    await s.api('POST', `/api/channels/${c.id}/action`, { action: 'run' });
    await until(() => s.store.all<any>('runs').some((r) => r.status === 'failed'));
    assert(s.store.all<any>('runs')[0].summary.includes('codex login'));
    assert.equal(s.store.all('results').length, 0);
    assert.equal(s.store.all('items').length, 0);
    assert(diagnoseFailure('codex', '429 rate_limit')?.summary.includes('配额'));
  } finally {
    await s.cleanup();
  }
});

test('event history uses scoped stable cursors and includes legacy events', async () => {
  const s = await setup();
  try {
    const channelId = s.channels[0].id;
    const runId = randomUUID();
    s.store.put('runs', { id: runId, channelId, status: 'completed' });
    const otherRunId = randomUUID();
    s.store.put('runs', { id: otherRunId, channelId, status: 'completed' });
    const first = s.store.event(channelId, runId, 'system', 'legacy plain log');
    const second = s.engine.event(channelId, runId, 'tool', 'tool input', {
      type: 'tool_use',
      tool: 'Read',
      input: { path: 'a.txt' },
      toolCallId: 'read-1',
    });
    s.store.event(s.channels[1].id, '', 'system', 'another channel');
    const third = s.engine.event(channelId, runId, 'tool', 'tool result', {
      type: 'tool_result',
      toolCallId: 'read-1',
      output: 'result',
    });
    s.store.event(channelId, otherRunId, 'system', 'another run');
    const fourth = s.store.event(channelId, runId, 'result', 'finished');
    for (const event of [first, second, third, fourth])
      s.store.put('events', { ...event, createdAt: '2026-01-01T00:00:00.000Z' });
    const query = `/api/events?channelId=${channelId}&runId=${runId}&limit=2`;
    const latest = await s.api('GET', query);
    assert.deepEqual(
      latest.events.map((e: any) => e.id),
      [third.id, fourth.id]
    );
    assert.equal(latest.hasMore, true);
    assert.equal(latest.cursor, third.id);
    const previous = await s.api('GET', `${query}&before=${latest.cursor}`);
    assert.deepEqual(
      previous.events.map((e: any) => e.id),
      [first.id, second.id]
    );
    assert.equal(previous.hasMore, false);
    assert.equal(previous.events[0].detail, undefined);
    assert.equal(previous.events[1].detail.sequence, 2);
    const incremental = await s.api('GET', `${query}&after=${first.id}`);
    assert.deepEqual(
      incremental.events.map((e: any) => e.id),
      [second.id, third.id]
    );
    assert.equal(incremental.cursor, third.id);
    assert.equal(incremental.hasMore, true);
    const remainder = await s.api('GET', `${query}&after=${incremental.cursor}`);
    assert.deepEqual(
      remainder.events.map((e: any) => e.id),
      [fourth.id]
    );
    assert.equal(remainder.hasMore, false);
    const empty = await s.api('GET', `${query}&after=${fourth.id}`);
    assert.deepEqual(empty, { events: [], hasMore: false });
    const snapshot = await s.api('GET', '/api/state');
    assert.equal(snapshot.events.find((e: any) => e.id === third.id).detail.sequence, 3);
    assert.equal((await fetch(s.base + query)).status, 401);
    assert.equal(
      (await fetch(s.base + query, { headers: { Authorization: `Bearer ${s.token}`, Origin: 'http://example.com' } }))
        .status,
      403
    );
    for (const suffix of [
      '&limit=201',
      '&limit=0',
      '&limit=1.5',
      '&limit=abc',
      '&unknown=yes',
      `&before=${first.id}&after=${third.id}`,
      '&after=invalid',
    ])
      await s.api('GET', `/api/events?channelId=${channelId}&runId=${runId}${suffix}`, undefined, 400);
    await s.api('GET', `${query}&limit=3`, undefined, 400);
    for (let index = 0; index < 205; index++) s.store.event(s.channels[1].id, '', 'system', `history ${index}`);
    const bounded = await s.api('GET', `/api/events?channelId=${s.channels[1].id}&limit=200`);
    assert.equal(bounded.events.length, 200);
    assert.equal(bounded.hasMore, true);
    const defaultPage = await s.api('GET', `/api/events?channelId=${s.channels[1].id}`);
    assert.equal(defaultPage.events.length, 50);
    await s.api('GET', '/api/events', undefined, 400);
    await s.api('GET', `/api/events?channelId=${randomUUID()}`, undefined, 404);
    await s.api('GET', `${query}&before=${randomUUID()}`, undefined, 404);
    await s.api('GET', `/api/events?channelId=${s.channels[1].id}&runId=${runId}`, undefined, 404);
    await s.api('GET', `/api/events?channelId=${s.channels[1].id}&before=${first.id}`, undefined, 404);
    await s.api('GET', `/api/events?channelId=${channelId}&runId=${otherRunId}&before=${first.id}`, undefined, 404);
    // Reopen only this test's temporary database; production daemons are untouched.
    await s.close();
    const reopened = new Store(join(s.home, 'workspace.sqlite'));
    try {
      const persisted = eventHistory(reopened, new URLSearchParams({ channelId, runId, after: second.id }));
      assert.deepEqual(
        persisted.events.map((event) => event.id),
        [third.id, fourth.id]
      );
      assert.equal(persisted.events[0].detail?.sequence, 3);
      const next = reopened.event(channelId, runId, 'tool', 'continued', { type: 'tool_use', tool: 'Read' });
      assert.equal(next.detail?.sequence, 5);
    } finally {
      reopened.close();
    }
  } finally {
    await s.cleanup();
  }
});

test('streamed Codex tool items persist details, matched names and sanitized output', async () => {
  const s = await setup();
  try {
    const channelId = s.channels[0].id;
    s.config({
      events: [
        {
          type: 'item.started',
          item: { id: 'cmd-a', type: 'command_execution', command: 'cat a.txt', status: 'in_progress' },
        },
        {
          type: 'item.started',
          item: {
            id: 'mcp-b',
            type: 'mcp_tool_call',
            server: 'local',
            tool: 'grep',
            arguments: { pattern: 'TODO' },
            status: 'in_progress',
          },
        },
        {
          type: 'item.completed',
          item: {
            id: 'cmd-a',
            type: 'command_execution',
            command: 'cat a.txt',
            aggregated_output: `visible ${s.token}`,
            exit_code: 0,
            status: 'completed',
          },
        },
        {
          type: 'item.completed',
          item: {
            id: 'mcp-b',
            type: 'mcp_tool_call',
            server: 'local',
            tool: 'grep',
            arguments: { pattern: 'TODO' },
            result: 'no matches',
            status: 'completed',
          },
        },
      ],
    });
    await s.api('POST', `/api/channels/${channelId}/action`, { action: 'run' });
    await until(() => s.store.all<any>('runs').some((r) => r.status === 'completed'));
    const runId = s.store.all<any>('runs')[0].id;
    const page = await s.api('GET', `/api/events?channelId=${channelId}&runId=${runId}`);
    const details = page.events.filter((e: any) => e.detail).map((e: any) => e.detail);
    assert.equal(details.length, 4);
    assert.deepEqual(
      details.map((d: any) => d.tool),
      ['shell', 'local.grep', 'shell', 'local.grep']
    );
    assert.deepEqual(
      details.map((d: any) => d.toolCallId),
      ['cmd-a', 'mcp-b', 'cmd-a', 'mcp-b']
    );
    assert(details.every((d: any, i: number) => i === 0 || d.sequence > details[i - 1].sequence));
    assert(!JSON.stringify(page).includes(s.token));
    assert(!JSON.stringify(s.store.all('events')).includes(s.token));
    assert(details[2].output.includes('[REDACTED]'));
  } finally {
    await s.cleanup();
  }
});

test('project board creation, provenance, optimistic edits and project audit are durable', async () => {
  const s = await setup();
  try {
    const item = await s.api('POST', `/api/projects/${s.project.id}/items`, { title: '统一导入流程' }, 201);
    assert.equal(item.projectId, s.project.id);
    assert.equal(item.channelId, '');
    assert.equal(item.number, 1);
    assert.equal(item.kind, 'feature');
    assert.equal(item.revision, 1);
    const updated = await s.api('PATCH', `/api/items/${item.id}`, {
      summary: '手工描述',
      nextStep: '验证导入',
      revision: 1,
    });
    assert.equal(updated.revision, 2);
    await s.api('PATCH', `/api/items/${item.id}`, { title: '旧版本覆盖', revision: 1 }, 409);
    const legacy = await s.api('PATCH', `/api/items/${item.id}`, { status: 'investigating' });
    assert.equal(legacy.revision, 3);
    await s.api('PATCH', `/api/items/${item.id}`, { projectId: 'elsewhere' }, 400);
    const history = await s.api('GET', `/api/events?projectId=${s.project.id}&itemId=${item.id}&limit=2`);
    assert.equal(history.events.length, 2);
    assert.equal(history.hasMore, true);
    assert.equal(history.events.at(-1).changes.before.status, 'open');
    assert.equal(history.events.at(-1).changes.after.status, 'investigating');
    assert(history.events.every((event: any) => event.actor === 'human' && event.itemId === item.id));
    const first = await s.api(
      'GET',
      `/api/events?projectId=${s.project.id}&itemId=${item.id}&before=${history.cursor}`
    );
    assert.equal(first.events[0].action, 'item.created');
    assert.equal(first.hasMore, false);
    await s.api('GET', `/api/events?projectId=${s.project.id}&itemId=${randomUUID()}`, undefined, 404);
    await s.api('GET', `/api/events?projectId=${s.project.id}&before=${randomUUID()}`, undefined, 404);
    assert.equal((await fetch(s.base + `/api/events?projectId=${s.project.id}`)).status, 401);
    const rootPath = join(s.root, 'second');
    mkdirSync(rootPath);
    await s.api('POST', '/api/projects', { name: 'Other', path: rootPath, goal: 'other', runtime: 'claude' }, 400);
    const project = await s.api(
      'POST',
      '/api/projects',
      { name: 'Other', path: rootPath, goal: 'other', runtime: 'codex' },
      201
    );
    const state = await s.api('GET', '/api/state');
    assert.equal(project.runtime, 'codex');
    assert(state.channels.filter((c: any) => c.projectId === project.id).every((c: any) => c.runtime === 'codex'));
    await s.api(
      'POST',
      `/api/projects/${project.id}/items`,
      { title: 'Wrong provenance', channelId: s.channels[0].id },
      404
    );
    await s.api('GET', `/api/events?projectId=${project.id}&channelId=${s.channels[0].id}`, undefined, 404);
  } finally {
    await s.cleanup();
  }
});

test('sibling channels advance one project item, preserve origin, reject other projects and protect human edits', async () => {
  const s = await setup();
  const report = (item: any, title: string) => ({
    summary: '更新功能',
    items: [
      {
        id: item.id,
        title,
        summary: '验证后的内容',
        status: 'investigating',
        kind: 'feature',
        evidence: ['fixture.txt:1'],
        nextStep: '下一步',
      },
    ],
    nextCheckMinutes: 60,
    knowledge: [],
    needsHuman: false,
  });
  const waitRuns = (count: number) =>
    until(() => s.store.all<any>('runs').filter((r) => r.status === 'completed').length === count);
  try {
    const [a, b] = s.channels;
    const item = await s.api(
      'POST',
      `/api/projects/${s.project.id}/items`,
      { title: 'Shared feature', channelId: a.id },
      201
    );
    s.config({ markdown: true, result: report(item, 'Shared feature updated') });
    await s.api('POST', `/api/channels/${b.id}/action`, { action: 'run' });
    await waitRuns(1);
    let updated = s.store.get<any>('items', item.id);
    assert.equal(s.store.all('items').length, 1);
    assert.equal(updated.channelId, a.id);
    assert.deepEqual(updated.sourceChannelIds, [a.id, b.id]);
    assert.equal(updated.revision, 2);
    assert(s.engine.prompt(s.project, a).includes('Shared feature updated'));
    const run = s.store.all<any>('runs')[0];
    assert.equal(updated.lastRunId, run.id);
    assert.equal(run.reportStatus, 'valid');
    const history = await s.api('GET', `/api/events?projectId=${s.project.id}&itemId=${item.id}`);
    assert.equal(history.events.at(-1).actor, 'agent');
    assert.equal(history.events.at(-1).channelId, b.id);
    // Reporting an item nobody was responsible for claimed it, so the channel that may still write
    // it — and whose stale report the human edit must survive — is that same channel.
    assert.equal(updated.ownerChannelId, b.id);
    s.config({ delay: 300, result: report(updated, 'Agent stale overwrite') });
    await s.api('POST', `/api/channels/${b.id}/action`, { action: 'run' });
    await s.api('PATCH', `/api/items/${item.id}`, { title: 'Human latest', revision: updated.revision });
    await waitRuns(2);
    updated = s.store.get<any>('items', item.id);
    assert.equal(updated.title, 'Human latest');
    assert.equal(s.store.all<any>('runs').at(-1).reportStatus, 'conflict');
    assert(s.store.all<any>('events').some((e) => e.action === 'item.conflict' && e.itemId === item.id));
    const otherPath = join(s.root, 'other');
    mkdirSync(otherPath);
    const other = await s.api('POST', '/api/projects', { name: 'Other', path: otherPath, goal: 'Other' }, 201);
    const foreign = await s.api('POST', `/api/projects/${other.id}/items`, { title: 'Foreign item' }, 201);
    s.config({ result: report(foreign, 'Should never apply') });
    await s.api('POST', `/api/channels/${a.id}/action`, { action: 'run' });
    await waitRuns(3);
    assert.equal(s.store.get<any>('items', foreign.id).title, 'Foreign item');
    assert.equal(s.store.all<any>('runs').at(-1).reportStatus, 'invalid');
  } finally {
    await s.cleanup();
  }
});

test('optional invalid reports do not fail native work and terminal success overrides transient diagnostics', async () => {
  const s = await setup();
  try {
    const c = s.channels[0];
    s.config({
      finalText: 'Native work finished.\n```morrow-report\n{broken}\n```',
      events: [{ type: 'error', message: 'Transient retry' }],
      recovered: true,
    });
    await s.api('POST', `/api/channels/${c.id}/action`, { action: 'resume' });
    await until(() => s.store.all<any>('runs').some((r) => r.status === 'completed'));
    const run = s.store.all<any>('runs')[0];
    assert.equal(run.reportStatus, 'invalid');
    assert.equal(run.exitCode, 0);
    assert.equal(run.trigger, 'schedule');
    assert.equal(s.store.get<any>('channels', c.id).status, 'waiting');
    assert(s.engine.control(c.id).enabled);
    assert.equal(s.store.all('items').length, 0);
    const detail = await s.api('GET', `/api/runs/${run.id}`);
    assert(detail.finalOutput.includes('Native work finished.'));
    assert(detail.prompt.includes('可选'));
    assert.equal(detail.report, undefined);
    await s.api('POST', `/api/channels/${c.id}/action`, { action: 'pause' });
    const args = invocation({ ...c, permission: 'workspace-write', sessionId: 'exact-session' }, 'output');
    for (const flag of ['--ignore-user-config', '--ignore-rules', '--output-schema', '--last', '--json-schema'])
      assert(!args.includes(flag));
    assert(args.includes('exact-session'));
    assert(args.includes('approval_policy="never"'));
    assert(args.includes('sandbox_workspace_write.network_access=false'));
  } finally {
    await s.cleanup();
  }
});

test('full run records and raw I/O page beyond snapshots with auth and scoped cursors', async () => {
  const s = await setup();
  try {
    const c = s.channels[0];
    await s.api('POST', `/api/channels/${c.id}/action`, { action: 'run' });
    await until(() => s.store.all<any>('runs').some((r) => r.status === 'completed'));
    const run = s.store.all<any>('runs')[0];
    const detail = await s.api('GET', `/api/runs/${run.id}`);
    assert.equal(detail.run.permission, 'native');
    assert.equal(detail.run.projectId, s.project.id);
    assert(detail.prompt.includes('验证完整项目循环'));
    assert.equal(detail.report.summary, run.summary);
    for (let index = 0; index < 112; index++) s.store.io(run.id, 'stdout', `chunk${index}\n`);
    let page = await s.api('GET', `/api/runs/${run.id}/output?limit=100`);
    assert.equal(page.hasMore, true);
    const chunks = [...page.chunks];
    while (page.hasMore) {
      page = await s.api('GET', `/api/runs/${run.id}/output?after=${page.cursor}&limit=100`);
      chunks.push(...page.chunks);
    }
    assert(chunks.some((chunk: any) => chunk.stream === 'prompt'));
    assert(chunks.some((chunk: any) => chunk.stream === 'report'));
    assert(chunks.some((chunk: any) => chunk.stream === 'final'));
    assert(
      chunks
        .map((chunk: any) => chunk.text)
        .join('')
        .includes('chunk111')
    );
    assert.deepEqual(
      chunks.map((chunk: any) => chunk.sequence),
      chunks.map((_: any, index: number) => index + 1)
    );
    await s.api('GET', `/api/runs/${run.id}/output?limit=101`, undefined, 400);
    await s.api('GET', `/api/runs/${run.id}/output?after=${randomUUID()}`, undefined, 404);
    assert.equal((await fetch(s.base + `/api/runs/${run.id}/output`)).status, 401);
    for (let index = 0; index < 505; index++)
      s.store.put('runs', { ...run, id: randomUUID(), summary: `historic-${index}` });
    assert(!(await s.api('GET', '/api/state')).runs.some((r: any) => r.id === run.id));
    assert.equal((await s.api('GET', `/api/runs/${run.id}`)).run.id, run.id);
    const recent = await s.api('GET', `/api/runs?projectId=${s.project.id}&limit=200`);
    assert.equal(recent.runs.length, 200);
    assert(recent.hasMore);
    const older = await s.api('GET', `/api/runs?projectId=${s.project.id}&before=${recent.cursor}&limit=200`);
    assert(!older.runs.some((r: any) => recent.runs.some((n: any) => n.id === r.id)));
    await s.api('GET', `/api/runs?projectId=${s.project.id}&before=${randomUUID()}`, undefined, 404);
  } finally {
    await s.cleanup();
  }
});

test('unfinished native stdout and stderr persist before exit and split tokens remain redacted', async () => {
  const s = await setup();
  try {
    const c = s.channels[0];
    s.config({ partial: true });
    await s.api('POST', `/api/channels/${c.id}/action`, { action: 'run' });
    await until(() => s.store.all<any>('run_io').some((chunk) => chunk.stream === 'stderr'));
    const run = s.store.all<any>('runs')[0];
    assert.equal(run.status, 'running');
    const page = await s.api('GET', `/api/runs/${run.id}/output`);
    for (const [stream, expected] of [
      ['stdout', 'partial native output without newline'],
      ['stderr', 'partial diagnostic without newline'],
    ]) {
      const publicText = page.chunks
        .filter((chunk: any) => chunk.stream === stream)
        .map((chunk: any) => chunk.text)
        .join('');
      const pending = s.store.get<any>('run_io_pending', `${run.id}:${stream}`)?.text || '';
      assert.equal(publicText + pending, expected);
    }
    for (const text of ['prefix ', s.token.slice(0, 20), s.token.slice(20, 40), s.token.slice(40), ' suffix'])
      s.store.ioStream(run.id, 'stdout', text, s.token);
    const text = s.store.runText(run.id, 'stdout');
    assert(!text.includes(s.token));
    assert(text.includes('prefix [REDACTED] suffix'));
    await s.api('POST', `/api/channels/${c.id}/action`, { action: 'pause' });
    await until(() => s.store.get<any>('runs', run.id).status === 'interrupted');
  } finally {
    await s.cleanup();
  }
});

test('native handoff requires every project channel paused and records intent with exact native session', async () => {
  const s = await setup();
  try {
    const [a, b] = s.channels;
    s.store.put('channels', { ...a, sessionId: 'native-exact' });
    const result = await s.api('POST', `/api/channels/${a.id}/native-handoff`, {});
    assert.equal(result.sessionId, 'native-exact');
    assert.equal(result.projectPath, s.project.path);
    assert.equal(result.executable, fixture);
    assert(s.store.all<any>('events').some((e) => e.action === 'native-session-opened' && e.actor === 'human'));
    s.engine.setControl(b.id, { enabled: true });
    await s.api('POST', `/api/channels/${a.id}/native-handoff`, {}, 409);
    s.engine.setControl(b.id, { enabled: false });
    s.config({ sleep: true });
    await s.api('POST', `/api/channels/${a.id}/action`, { action: 'run' });
    await until(() => s.store.get<any>('channels', a.id).sessionId === 'fixture-session-1');
    await s.api('POST', `/api/channels/${a.id}/native-handoff`, {}, 409);
    await s.api('POST', `/api/channels/${a.id}/action`, { action: 'pause' });
    await until(() => s.store.all<any>('runs').some((run) => run.status === 'interrupted'));
    assert.equal(s.store.get<any>('channels', a.id).sessionId, 'fixture-session-1');
  } finally {
    await s.cleanup();
  }
});

test('legacy project board migration is idempotent and mirrors existing artifacts', () => {
  const home = mkdtempSync(join(tmpdir(), 'morrow-migration-'));
  const path = join(home, 'workspace.sqlite');
  let store = new Store(path);
  try {
    const projectId = randomUUID(),
      channelId = randomUUID(),
      itemId = randomUUID(),
      runId = randomUUID(),
      eventId = randomUUID();
    store.put('projects', { id: projectId, name: 'legacy' });
    store.put('channels', { id: channelId, projectId, runtime: 'trae', sessionId: 'provider-native' });
    store.put('items', { id: itemId, channelId, title: 'legacy item' });
    store.put('runs', { id: runId, channelId, status: 'completed', sessionId: 'provider-native' });
    store.put('events', { id: eventId, channelId, runId, kind: 'assistant', text: 'Legacy' });
    store.db.exec('DELETE FROM migrations');
    const dir = join(home, 'runs', runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'prompt.txt'), 'legacy prompt');
    writeFileSync(join(dir, 'stdout.jsonl'), 'legacy stdout\n');
    store.close();
    store = new Store(path);
    const first = store.get<any>('items', itemId);
    assert.equal(first.projectId, projectId);
    assert.equal(first.number, 1);
    assert.equal(first.revision, 1);
    assert.deepEqual(first.sourceChannelIds, [channelId]);
    assert.equal(store.get<any>('projects', projectId).runtime, 'trae');
    assert.equal(store.get<any>('events', eventId).projectId, projectId);
    assert.equal(store.get<any>('channels', channelId).sessionId, 'provider-native');
    assert.equal(store.runText(runId, 'prompt'), 'legacy prompt');
    const count = store.all('run_io').length;
    store.close();
    store = new Store(path);
    assert.deepEqual(store.get('items', itemId), first);
    assert.equal(store.all('run_io').length, count);
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a scheduler tick selects only the rows that need work, through indexes rather than table scans', () => {
  const home = mkdtempSync(join(tmpdir(), 'morrow-tick-scan-'));
  const store = new Store(join(home, 'workspace.sqlite'));
  try {
    for (const id of ['on', 'off', 'no-control']) store.put('channels', { id, projectId: 'p', name: id });
    store.put('controls', { id: 'on', enabled: true, pid: 0, runId: '' });
    store.put('controls', { id: 'off', enabled: false, pid: 0, runId: '' });
    // Both branches of the engine tick require an enabled control, so nothing else has to be read.
    assert.deepEqual(
      store.enabledChannels().map((channel) => channel.id),
      ['on']
    );
    for (const status of ['awaiting_approval', 'approved', 'published', 'unknown', 'failed'])
      store.put('loop_releases', { id: status, projectId: 'p', status });
    assert.deepEqual(
      store.byStatus<any>('loop_releases', ['approved', 'unknown']).map((row) => row.id),
      ['approved', 'unknown']
    );
    for (const phase of ['applied', 'draining', 'blocked']) store.put('upgrades', { id: phase, phase });
    assert.deepEqual(
      store.byStatus<any>('upgrades', ['pending', 'draining', 'exiting'], 'phase').map((row) => row.id),
      ['draining']
    );
    // `latest()` reads the newest row of any phase; `record()` the newest one still on its way.
    assert.equal(store.recent<any>('upgrades', 1).at(-1)?.id, 'blocked');
    const plan = (sql: string, ...values: string[]) =>
      JSON.stringify(
        store.db
          .prepare('EXPLAIN QUERY PLAN ' + sql)
          .all(...values)
          .map((row: any) => row.detail)
      );
    assert.match(
      plan("SELECT data FROM loop_releases WHERE json_extract(data,'$.status') IN ('approved','unknown')"),
      /INDEX loop_releases_status/
    );
    assert.match(
      plan("SELECT data FROM loop_finalizations WHERE json_extract(data,'$.status') IN ('pending')"),
      /INDEX loop_finalizations_status/
    );
    // The merged verification tick reads one row set; both of its conditions must be indexed.
    const verifications = plan(
      "SELECT data FROM loop_verifications WHERE json_extract(data,'$.interruptPending')=1 OR json_extract(data,'$.status')='queued'"
    );
    assert.match(verifications, /INDEX loop_verifications_interruptpending/);
    assert.match(verifications, /INDEX loop_verifications_status/);
    assert.match(
      plan(
        "SELECT channels.data AS data FROM controls JOIN channels ON channels.id=controls.id WHERE json_extract(controls.data,'$.enabled')=1"
      ),
      /INDEX controls_enabled/
    );
    // Checkpoint recovery's own read of the native journal, the reason for its index.
    assert.match(
      plan(
        "SELECT data FROM native_events WHERE json_extract(data,'$.kind')='native.patch' AND json_extract(data,'$.threadId')='t' AND json_extract(data,'$.ownerClientId')='o' AND json_extract(data,'$.revision')>1"
      ),
      /INDEX native_events_thread_revision/
    );
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('start-up backfills run once and the native journal keeps only what checkpoint recovery can read', () => {
  const home = mkdtempSync(join(tmpdir(), 'morrow-prune-'));
  const path = join(home, 'workspace.sqlite');
  let store = new Store(path);
  try {
    const threadId = randomUUID();
    store.put('native_threads', { id: threadId, threadId, ownerClientId: 'client-a', revision: 5 });
    for (const revision of [4, 5, 6])
      store.put('native_events', {
        id: `patch-${revision}`,
        kind: 'native.patch',
        threadId,
        ownerClientId: 'client-a',
        revision,
      });
    store.put('native_events', {
      id: 'other-owner',
      kind: 'native.patch',
      threadId,
      ownerClientId: 'client-b',
      revision: 9,
    });
    // A projection row: written without a `kind`, so no reader ever selected it.
    store.put('native_events', { id: 'projection', threadId, ownerClientId: 'client-a', revision: 9 });
    const orphan = randomUUID();
    store.put('native_events', {
      id: 'no-checkpoint',
      kind: 'native.patch',
      threadId: orphan,
      ownerClientId: 'client-a',
      revision: 1,
    });
    // Rows written after the backfills recorded their markers; a replayed scan would rewrite them.
    store.put('channels', { id: 'c1', projectId: 'p1' });
    store.put('items', { id: 'i1', channelId: 'c1', title: '迁移标记之后写入的事项' });
    store.db.prepare('DELETE FROM migrations WHERE id=?').run('native-events-prune-v1');
    store.close();
    store = new Store(path);
    assert.deepEqual(
      store
        .all<any>('native_events')
        .map((row) => row.id)
        .sort(),
      ['no-checkpoint', 'patch-6']
    );
    assert.equal(store.get<any>('migrations', 'native-events-prune-v1').removed, 4);
    // The index the only reader needs, built over what survived the prune.
    assert.equal(
      (
        store.db
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name='native_events_thread_revision'"
          )
          .get() as any
      ).n,
      1
    );
    for (const marker of ['project-runtime-brief-v1', 'item-number-v1', 'run-project-report-v1', 'event-project-v1'])
      assert(store.get('migrations', marker), marker);
    assert.equal(store.get<any>('items', 'i1').number, undefined);
    // Replaying the events backfill fills a missing project from the row's own channel in one statement.
    store.put('events', { id: 'e1', channelId: 'c1', runId: '', kind: 'assistant', text: '旧事件' });
    store.put('events', { id: 'e2', channelId: 'gone', runId: '', kind: 'assistant', text: '频道已不存在' });
    store.db.prepare('DELETE FROM migrations WHERE id=?').run('event-project-v1');
    store.close();
    store = new Store(path);
    assert.equal(store.get<any>('events', 'e1').projectId, 'p1');
    assert.equal(store.get<any>('events', 'e2').projectId, '');
    // With the marker in place the journal is never swept again.
    store.put('native_events', { id: 'later', threadId, ownerClientId: 'client-a', revision: 1 });
    store.close();
    store = new Store(path);
    assert(store.all<any>('native_events').some((row) => row.id === 'later'));
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('incremental raw output cursors never revise prior chunks, lose suffixes or expose pending token prefixes', () => {
  const home = mkdtempSync(join(tmpdir(), 'morrow-output-cursors-'));
  const path = join(home, 'workspace.sqlite');
  let store = new Store(path);
  const secret = '0123456789abcdef'.repeat(4),
    runId = randomUUID();
  try {
    store.ioStream(runId, 'stdout', 'prefix ' + secret.slice(0, 32), secret);
    const first = store.ioPage(runId, undefined, 100);
    assert.equal(first.chunks.map((chunk) => chunk.text).join(''), 'prefix ');
    assert(!JSON.stringify(first).includes(secret.slice(0, 32)));
    assert.equal(store.get<any>('run_io_pending', `${runId}:stdout`).text, secret.slice(0, 32));
    const frozen = JSON.stringify(first.chunks);
    // Pending bytes survive a restart without publishing incomplete secrets.
    store.close();
    store = new Store(path);
    store.ioStream(runId, 'stdout', secret.slice(32) + ' suffix', secret);
    const next = store.ioPage(runId, first.cursor, 100);
    assert.equal([...first.chunks, ...next.chunks].map((chunk) => chunk.text).join(''), 'prefix [REDACTED] suffix');
    assert.equal(JSON.stringify(store.ioPage(runId, undefined, 1).chunks), frozen);
    assert.equal(store.runText(runId, 'stdout'), 'prefix [REDACTED] suffix');
    for (let split = 1; split < secret.length; split++) {
      const id = randomUUID();
      store.ioStream(id, 'stdout', 'begin ' + secret.slice(0, split), secret);
      const before = store.ioPage(id, undefined, 100);
      assert.equal(before.chunks.map((chunk) => chunk.text).join(''), 'begin ');
      store.ioStream(id, 'stdout', secret.slice(split) + ' end0', secret);
      store.ioStream(id, 'stdout', '', secret, true);
      const after = store.ioPage(id, before.cursor, 100);
      assert.equal([...before.chunks, ...after.chunks].map((chunk) => chunk.text).join(''), 'begin [REDACTED] end0');
      assert.equal(JSON.stringify(store.ioPage(id, undefined, 1).chunks), JSON.stringify(before.chunks));
    }
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

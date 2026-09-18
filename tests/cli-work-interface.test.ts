import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Channel, Run } from '../service/protocol.ts';
import { invocation } from '../service/runtimes.ts';
import { reviewArguments } from '../service/codex-cli-review.ts';
import { claudeReviewArguments } from '../service/claude-cli-review.ts';
import {
  claudeWorkMcpConfig,
  claudeWorkMcpTool,
  handleAgentMessage,
  workMcpLaunch,
  workMcpOverlays,
  workMcpServer,
  workMcpTool,
} from '../service/agent-mcp.ts';
import { startIsolated, stopScheduler } from './harness/service.ts';
import { grantFor } from './harness/grant.ts';
import { startReleaseFixture } from './harness/release.ts';
import { FakeReviewer } from './harness/fake-reviewer.ts';
import { until } from './harness/wait.ts';

const helper = fileURLToPath(new URL('../service/agent-mcp.ts', import.meta.url));
const launch = workMcpLaunch(process.execPath, helper, '/tmp/tool.sh');

test('the host MCP lists call and forwards a launcher result', async () => {
  const listed = (await handleAgentMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, async () => ({
    ok: true,
    text: '',
  }))) as any;
  assert.equal(listed.result.tools[0].name, workMcpTool);
  const called = (await handleAgentMessage(
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: workMcpTool, arguments: { operation: 'context', input: {} } },
    },
    async (operation, input, requestId) => {
      assert.equal(operation, 'context');
      assert.deepEqual(input, {});
      assert.equal(requestId, undefined);
      return { ok: true, text: '{"project":{"id":"p"}}' };
    }
  )) as any;
  assert.equal(called.result.content[0].text, '{"project":{"id":"p"}}');
  assert.equal(called.result.isError, undefined);
});

test('the MCP helper process speaks newline-delimited JSON-RPC and never prints the token', async () => {
  const s = await startIsolated({});
  try {
    const grant = grantFor(s, { projectId: s.project.id, channelId: s.channel.id });
    const launcher = join(s.home, 'runs', grant.run.id, 'tool.sh');
    const child = spawn(process.execPath, [helper, '--launcher', launcher], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const ready = new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk) => {
        chunks.push(chunk);
        if (Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean).length >= 2) resolve();
      });
    });
    try {
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) +
          '\n'
      );
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: workMcpTool, arguments: { operation: 'context' } },
        }) + '\n'
      );
      await Promise.race([
        ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error('mcp stdio timeout')), 8000)),
      ]);
      const lines = Buffer.concat(chunks)
        .toString('utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.equal(lines[0].result.serverInfo.name, 'morrow-work');
      assert.equal(JSON.parse(lines[1].result.content[0].text).project.id, s.project.id);
      assert(!Buffer.concat(chunks).toString('utf8').includes(grant.token));
    } finally {
      child.kill();
    }
  } finally {
    await s.cleanup();
  }
});

test('Codex, Trae and Claude work invocations include Morrow MCP; reviews stay empty', () => {
  const channel = (runtime: Channel['runtime'], extra: Partial<Channel> = {}) =>
    ({
      runtime,
      permission: 'workspace-write',
      model: '',
      sessionId: '',
      ...extra,
    }) as Channel;
  for (const runtime of ['codex', 'trae'] as const) {
    const args = invocation(
      channel(runtime, { transport: runtime === 'codex' ? 'cli' : undefined }),
      'run',
      'out',
      launch
    );
    assert(args.includes('sandbox_workspace_write.network_access=false'));
    assert(args.includes(`mcp_servers.${workMcpServer}.default_tools_approval_mode="approve"`));
    for (const flag of workMcpOverlays(launch)) assert(args.includes(flag));
    assert(!args.some((a) => a.includes('dangerously')));
  }
  const claude = invocation(channel('claude'), 'run-7', 'out', launch);
  assert.equal(claude[claude.indexOf('--setting-sources') + 1], 'user');
  assert(!claude.includes('--safe-mode'));
  assert.equal(claude[claude.indexOf('--mcp-config') + 1], claudeWorkMcpConfig(launch));
  assert(claude[claude.indexOf('--allowedTools') + 1].includes(claudeWorkMcpTool));
  assert.deepEqual(Object.keys(JSON.parse(claude[claude.indexOf('--mcp-config') + 1]).mcpServers), [workMcpServer]);
  const review = reviewArguments();
  assert(review.includes('mcp_servers={}'));
  assert(!review.some((a) => a.includes(`mcp_servers.${workMcpServer}`)));
  const claudeReview = claudeReviewArguments({ id: 'r' });
  assert(claudeReview.includes('--safe-mode'));
  assert.equal(claudeReview[claudeReview.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
});

test('a CLI-direct start mints loop_grants and tool.sh and injects Morrow MCP', async () => {
  const s = await startIsolated({ project: { name: 'CLI grant', goal: 'mint' }, scheduler: false });
  try {
    const cli = await s.api(
      'POST',
      '/api/channels',
      {
        projectId: s.project.id,
        name: 'CLI 直连',
        goal: 'mint grant',
        runtime: 'codex',
        transport: 'cli',
      },
      201
    );
    writeFileSync(join(s.path, '.fixture.json'), JSON.stringify({ sleep: true }));
    await s.api('POST', `/api/channels/${cli.id}/action`, { action: 'run' });
    await until(() => existsSync(join(s.path, '.fixture-capture.json')));
    const run = s.store.all<Run>('runs').find((r) => r.channelId === cli.id)!;
    assert.equal(run.status, 'running');
    const directory = join(s.home, 'runs', run.id);
    assert.equal(existsSync(join(directory, 'tool.sh')), true);
    const context = JSON.parse(readFileSync(join(directory, 'agent-context.json'), 'utf8'));
    assert.equal(typeof context.token, 'string');
    assert(!readFileSync(join(directory, 'tool.sh'), 'utf8').includes(context.token));
    assert(s.store.all<any>('loop_grants').some((row) => row.runId === run.id));
    const prompt = s.store.runText(run.id, 'prompt')!;
    assert(prompt.includes('Morrow MCP'));
    assert(prompt.includes('--operation context'));
    assert(!prompt.includes('nextCheckMinutes'));
    const capture = JSON.parse(readFileSync(join(s.path, '.fixture-capture.json'), 'utf8'));
    assert(capture.args.includes('sandbox_workspace_write.network_access=false'));
    assert(capture.args.includes('mcp_servers.morrow.default_tools_approval_mode="approve"'));
  } finally {
    await s.cleanup();
  }
});

test('a CLI channel grant can propose a release and cannot approve or read the sealed script', async () => {
  const s = await startReleaseFixture();
  try {
    stopScheduler(s);
    s.store.put('runs', { ...s.grant.run, status: 'completed', finishedAt: new Date().toISOString() });
    const cli = await s.api(
      'POST',
      '/api/channels',
      {
        projectId: s.project.id,
        name: 'CLI 直连',
        goal: '用工作接口提议上线',
        runtime: 'codex',
        transport: 'cli',
      },
      201
    );
    const grant = grantFor(s, { projectId: s.project.id, channelId: cli.id });
    await grant.call('evidence.native', {}, 409);
    await grant.call('execution.prepare', { command: 'true' }, 409);
    const release = await grant.call('release.propose', s.local());
    assert.equal(release.status, 'awaiting_approval');
    await grant.call('release.approve', {}, 400);
    await s.api('GET', `/api/releases/${release.id}/script`, undefined, 401, grant.token);
    await s.api(
      'POST',
      `/api/releases/${release.id}/review`,
      { reviewHash: release.reviewHash, decision: 'approve' },
      401,
      grant.token
    );
  } finally {
    await s.cleanup();
  }
});

test('a CLI-only grant proposes a release after item and release reviews with file evidence', async () => {
  const reviewer = new FakeReviewer();
  reviewer.autoComplete = true;
  const s = await startIsolated({
    project: {
      name: 'CLI 发布',
      goal: '让 CLI 频道也能提议上线',
      files: { 'checks.log': '3 tests passed\n', 'release.txt': 'artifact\n' },
    },
    scheduler: false,
  });
  try {
    s.engine.loop.verification.connect(reviewer, (v) => v);
    const cli = await s.api(
      'POST',
      '/api/channels',
      {
        projectId: s.project.id,
        name: 'CLI 直连',
        goal: '用文件证据提议上线',
        runtime: 'codex',
        transport: 'cli',
      },
      201
    );
    const grant = grantFor(s, {
      projectId: s.project.id,
      channelId: cli.id,
      overrides: { sessionId: '', executionOwner: 'codex-cli' },
    });
    await grant.call('evidence.native', {}, 409);
    await grant.call('execution.prepare', { command: 'true' }, 409);
    const item = await grant.call('feature.upsert', {
      title: 'CLI 可提议上线',
      summary: '用采集证据走独立复核',
      kind: 'feature',
      status: 'investigating',
      evidenceIds: [],
      nextStep: '请求独立复核',
    });
    const evidence = await grant.call('evidence.capture', {
      itemId: item.id,
      summary: '检查日志',
      path: 'checks.log',
    });
    const spoken = await grant.call('evidence.record', {
      itemId: item.id,
      summary: '自述检查通过',
      source: 'agent-claim',
      observedAt: new Date().toISOString(),
      data: { passed: true },
    });
    const proposal = {
      itemIds: [item.id],
      title: 'CLI 候选',
      changes: '用文件证据走发布门禁',
      rationale: 'CLI 没有 App 任务',
      expectedBenefit: '预期 CLI 也能提议上线；线上收益尚待验证',
      checks: [{ name: '检查日志', result: 'passed', evidenceIds: [evidence.id] }],
      risks: '影响发布路径',
      rollback: '恢复上一个产物',
      observationPlan: '发布后读取指标文件',
      artifactPath: 'release.txt',
      target: { url: 'http://127.0.0.1:9/deploy', statusUrl: 'http://127.0.0.1:9/status', label: '隔离发布端' },
    };
    const withoutReviews = await grant.call('release.propose', proposal, 409);
    assert.match(withoutReviews.error, /至少需要一次独立复核通过/);
    const itemReview = await grant.call('verification.request', { itemId: item.id, evidenceIds: [evidence.id] });
    await s.engine.loop.verification.start(itemReview.id);
    assert.equal(s.store.get<any>('loop_verifications', itemReview.id).status, 'passed');
    const withoutRelease = await grant.call('release.propose', proposal, 409);
    assert.match(withoutRelease.error, /发布级复核/);
    const agentOnly = await grant.call(
      'verification.request',
      { kind: 'release', itemIds: [item.id], evidenceIds: [spoken.id] },
      400
    );
    assert.match(agentOnly.error, /实际文件或 HTTP 采集证据/);
    const releaseReview = await grant.call('verification.request', {
      kind: 'release',
      itemIds: [item.id],
      evidenceIds: [evidence.id],
    });
    await s.engine.loop.verification.start(releaseReview.id);
    const stored = s.store.get<any>('loop_verifications', releaseReview.id);
    assert.equal(stored.status, 'passed');
    assert.match(stored.prompt, /亲自重跑/);
    const release = await grant.call('release.propose', proposal);
    assert.equal(release.status, 'awaiting_approval');
    assert.equal(release.releaseVerificationId, releaseReview.id);
    await grant.call('release.approve', {}, 400);
    await s.api(
      'POST',
      `/api/releases/${release.id}/review`,
      { reviewHash: release.reviewHash, decision: 'approve' },
      401,
      grant.token
    );
    await grant.call('execution.prepare', { command: 'true' }, 409);
  } finally {
    await s.cleanup();
  }
});

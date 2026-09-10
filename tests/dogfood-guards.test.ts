import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startIsolated } from './harness/service.ts';
import { grantFor } from './harness/grant.ts';
import { startServer } from '../service/server.ts';

test('execution preparation rejects the running service directory and its parents before sealing', async () => {
  const s = await startIsolated();
  try {
    const { call } = grantFor(s, {
      projectId: s.project.id,
      channelId: s.channel.id,
      overrides: { sessionId: 'isolated-thread', nativeTurnId: 'isolated-turn' },
    });
    const service = fileURLToPath(new URL('../service', import.meta.url));
    symlinkSync(service, join(s.root, 'service-alias'));
    for (const path of [service, dirname(service), join(s.root, 'service-alias')]) {
      s.store.put('projects', { ...s.project, path });
      const error = await call('execution.prepare', { command: 'node --version' }, 409);
      assert.match(error.error, /运行中的 Morrow 服务位于项目目录内/);
      assert.equal(s.store.all('loop_executions').length, 0);
    }
    s.store.put('projects', s.project);
    const valid = await call('execution.prepare', { command: 'node --version' });
    assert.equal(valid.status, 'prepared');
  } finally {
    await s.cleanup();
  }
});

test('sandbox-marked main entry refuses implicit data and port before attempting any write', () => {
  const server = fileURLToPath(new URL('../service/server.ts', import.meta.url));
  for (const marker of ['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_SANDBOX_FUTURE_FLAG']) {
    // Even a regression cannot write to the user's default data directory.
    const child = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', server], {
      env: { PATH: process.env.PATH, [marker]: '' },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /检测到 CODEX_SANDBOX 环境.*MORROW_HOME/);
    assert.doesNotMatch(child.stdout, /Morrow listening/);
  }
});

test('sandbox-marked services accept an explicit isolated option or MORROW_HOME', async () => {
  const marker = process.env.CODEX_SANDBOX_TEST;
  const previous = process.env.MORROW_HOME;
  const root = mkdtempSync(join(tmpdir(), 'morrow-guard-home-'));
  try {
    process.env.CODEX_SANDBOX_TEST = '1';
    delete process.env.MORROW_HOME;
    const isolated = await startIsolated();
    await isolated.cleanup();
    process.env.MORROW_HOME = root;
    const service = await startServer({ port: 0 });
    try {
      assert.equal(service.home, root);
      assert.ok(service.port > 0);
    } finally {
      await service.close();
    }
  } finally {
    if (marker === undefined) delete process.env.CODEX_SANDBOX_TEST;
    else process.env.CODEX_SANDBOX_TEST = marker;
    if (previous === undefined) delete process.env.MORROW_HOME;
    else process.env.MORROW_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { startIsolated } from './harness/service.ts';
import { grantFor } from './harness/grant.ts';

const invoke = (script: string, args: string[] = [], input = '') =>
  new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn('/bin/sh', [script, ...args], { cwd: tmpdir() });
    let out = '',
      err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, out, err }));
    child.stdin.end(input);
  });

test('per-run short entry preserves the CLI inputs, idempotency and project/run scope', async () => {
  const root = mkdtempSync(join(tmpdir(), 'morrow-entry-'));
  // Quotes, spaces and shell metacharacters must remain literal in the generated launcher.
  const s = await startIsolated({ home: join(root, "space ' $HOME `literal`", 'home') });
  try {
    const grant = grantFor(s, { projectId: s.project.id, channelId: s.channel.id });
    const entry = s.engine.loop.prepare(grant.run);
    const script = join(s.home, 'runs', grant.run.id, 'tool.sh');
    assert.equal(statSync(script).mode & 0o777, 0o600);
    assert(!readFileSync(script, 'utf8').includes(grant.token));
    assert(entry.includes('--operation context'));
    assert(entry.includes('--operation contract'));
    assert(!entry.includes(grant.token));
    // Execute the exact displayed command, including its shell quoting, from an unrelated cwd.
    const line = entry.trim().split('\n')[0];
    const context = await new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', line], { cwd: tmpdir() });
      let out = '',
        err = '';
      child.stdout.on('data', (chunk) => {
        out += chunk;
      });
      child.stderr.on('data', (chunk) => {
        err += chunk;
      });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, out, err }));
      child.stdin.end();
    });
    assert.equal(context.code, 0, context.err);
    assert.equal(JSON.parse(context.out).project.id, s.project.id);
    const contract = await invoke(script, ['--operation', 'contract']);
    assert.equal(contract.code, 0, contract.err);
    assert(JSON.parse(contract.out).operations['feature.upsert']);
    assert(!JSON.parse(contract.out).operations['release.approve']);
    const input = {
      title: 'quoted "name"\nsecond line',
      summary: '隔离命令输入',
      kind: 'issue',
      status: 'investigating',
      evidenceIds: [],
      nextStep: '核对',
    };
    const args = ['--operation', 'feature.upsert', '--input', '-', '--request-id', 'short-entry-create'];
    const created = await invoke(script, args, JSON.stringify(input));
    assert.equal(created.code, 0, created.err);
    const path = join(root, 'input with space.json');
    writeFileSync(path, JSON.stringify(input));
    const replay = await invoke(script, [
      '--operation',
      'feature.upsert',
      '--input',
      path,
      '--request-id',
      'short-entry-create',
    ]);
    assert.equal(replay.code, 0, replay.err);
    assert.deepEqual(JSON.parse(replay.out), JSON.parse(created.out));
    const conflict = await invoke(script, args, JSON.stringify({ ...input, title: 'different' }));
    assert.equal(conflict.code, 1);
    assert(conflict.err.length > 0);
    const missing = await invoke(script, ['--operation', 'feature.upsert', '--input', path]);
    assert.equal(missing.code, 1);
    assert(missing.err.includes('--request-id'));
    const outside = await invoke(
      script,
      ['--operation', 'feature.upsert', '--input', '-', '--request-id', 'foreign'],
      JSON.stringify({ ...input, id: 'outside-project', revision: 1 })
    );
    assert.equal(outside.code, 1);
    assert(outside.err.includes('不属于当前项目'));
    s.store.put('runs', { ...grant.run, status: 'completed' });
    const ended = await invoke(script, ['--operation', 'context']);
    assert.equal(ended.code, 1);
    assert(ended.err.includes('本轮已结束'));
    const next = grantFor(s, { projectId: s.project.id, channelId: s.channel.id });
    const nextEntry = s.engine.loop.prepare(next.run);
    assert(!nextEntry.includes(grant.run.id));
    const nextContext = await invoke(join(s.home, 'runs', next.run.id, 'tool.sh'));
    assert.equal(nextContext.code, 0, nextContext.err);
    assert(
      ![context, contract, created, replay, conflict, missing, ended, nextContext].some((value) =>
        (value.out + value.err).includes(grant.token)
      )
    );
  } finally {
    await s.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
